/**
 * Yunzai Worker 进程入口
 *
 * 由 manager.ts 通过 child_process.fork() 启动
 *   cwd   = Miao-Yunzai 目录
 *   独立的 V8 堆、全局变量、模块解析
 *
 * 生命周期：
 *   injectGlobals → loadPlugin基类 → loadPluginsLoader → load() → 监听 IPC
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IPCApiResponse, IPCEventMessage, IPCReplyResult, ParentToWorker, ReplyContent } from './protocol';
import { createOneBotRuntime, isOneBotPlatform } from './adapters/onebot-icqq';

// ━━━━━━━━━━━━━━━ IPC 通信 ━━━━━━━━━━━━━━━

function ipcSend(msg: any): void {
  process.send?.(msg);
}

function log(level: string, ...args: string[]): void {
  ipcSend({ type: 'log', level, args });
}

// ━━━━━━━━━━━━━━━ API 调用基础设施 ━━━━━━━━━━━━━━━

/** 等待父进程 API 响应的 Promise map */
// eslint-disable-next-line func-call-spacing
const apiPending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let apiIdCounter = 0;

/** 当前正在处理的事件平台（用于 API 调用路由） */
let currentPlatform = '';

/** 当前正在处理的消息 ID（用于 API 调用精确关联事件上下文） */
let currentMsgId = '';

/** 历史已知平台（定时任务触发时 currentPlatform 可能为空，使用此 fallback） */
let defaultPlatform = '';

// ━━━━━━━━━━━━━━━ Reply 结果追踪 ━━━━━━━━━━━━━━━

/** 等待父进程 reply 发送结果的 Promise map */
// eslint-disable-next-line func-call-spacing
const replyPending = new Map<string, { resolve: (v: any) => void }>();
let replyIdCounter = 0;

/** 处理父进程返回的 reply 结果 */
function handleReplyResult(msg: IPCReplyResult): void {
  const p = replyPending.get(msg.replyId);

  if (!p) {
    return;
  }
  replyPending.delete(msg.replyId);
  p.resolve({ message_id: msg.messageId ?? `reply_${Date.now()}` });
}

/**
 * 向父进程发起 API 调用并等待结果
 * Worker 的 Bot / group / friend 代理对象通过此函数实现真实功能
 */
function callApi(action: string, params: Record<string, any> = {}, timeout = 15_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const reqId = `api_${++apiIdCounter}_${Date.now()}`;

    // 自动附加当前平台信息（定时任务触发时用 defaultPlatform 兜底）
    if (!params.platform && (currentPlatform || defaultPlatform)) {
      params.platform = currentPlatform || defaultPlatform;
    }

    const timer = setTimeout(() => {
      apiPending.delete(reqId);
      reject(new Error(`API 调用超时: ${action}`));
    }, timeout);

    apiPending.set(reqId, {
      resolve: (data: any) => {
        clearTimeout(timer);
        apiPending.delete(reqId);
        resolve(data);
      },
      reject: (err: Error) => {
        clearTimeout(timer);
        apiPending.delete(reqId);
        reject(err);
      }
    });

    ipcSend({ type: 'api', reqId, action, params, msgId: currentMsgId || undefined });
  });
}

/** 处理父进程返回的 API 响应 */
function handleApiResponse(msg: IPCApiResponse): void {
  const pending = apiPending.get(msg.reqId);

  if (!pending) {
    return;
  }

  if (msg.ok) {
    pending.resolve(msg.data);
  } else {
    pending.reject(new Error(msg.error ?? 'API 调用失败'));
  }
}

// ━━━━━━━━━━━━━━━ 全局变量注入 ━━━━━━━━━━━━━━━

class CompatUinList extends Array<number> {
  constructor(initialUin = 10000) {
    super();
    this.setPrimary(initialUin);
  }

  setPrimary(next: number | string | null | undefined): void {
    const normalized = safeInt(next, 10000);

    this.length = 0;
    this.push(normalized);
  }

  get primary(): number {
    return this[0] ?? 10000;
  }

  override toString(): string {
    return String(this.primary);
  }

  override valueOf(): number {
    return this.primary;
  }

  [Symbol.toPrimitive](hint: string): number | string {
    return hint === 'number' ? this.primary : String(this.primary);
  }
}

function createIdentityLogger(identity: (value: any) => string, appendLog: (level: string, ...args: any[]) => void) {
  const levelMethods: Record<string, (...args: any[]) => void> = {
    info: (...a: any[]) => appendLog('info', ...a),
    warn: (...a: any[]) => appendLog('warn', ...a),
    error: (...a: any[]) => appendLog('error', ...a),
    debug: (...a: any[]) => appendLog('debug', ...a),
    mark: (...a: any[]) => appendLog('info', '[MARK]', ...a),
    trace: (...a: any[]) => appendLog('debug', '[TRACE]', ...a),
    fatal: (...a: any[]) => appendLog('error', '[FATAL]', ...a)
  };
  const chalkProxy = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'string') {
          return identity;
        }

        return undefined;
      }
    }
  );

  return new Proxy(
    {
      ...levelMethods,
      chalk: chalkProxy
    },
    {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && !(prop in target)) {
          return identity;
        }

        return Reflect.get(target, prop, receiver);
      }
    }
  );
}

const compatProxyCache = new WeakMap<object, any>();
const compatWarnedKeys = new Set<string>();

function warnCompatMissing(kind: 'get' | 'call' | 'construct', label: string): void {
  const key = `${kind}:${label}`;

  if (compatWarnedKeys.has(key)) {
    return;
  }
  compatWarnedKeys.add(key);
  log('warn', `[compat] 缺失${kind === 'get' ? '属性' : kind === 'call' ? '方法' : '构造器'}: ${label}`);
}

function createNoopCompatProxy(label: string) {
  const emptyArrayMethods = {
    filter: (_fn?: any) => [],
    map: (_fn?: any) => [],
    flatMap: (_fn?: any) => [],
    slice: (..._args: any[]) => [],
    concat: (...args: any[]) => (args.flat ? ([] as any[]).concat(...args) : []),
    includes: (_value?: any) => false,
    indexOf: (_value?: any) => -1,
    find: (_fn?: any) => undefined,
    some: (_fn?: any) => false,
    every: (_fn?: any) => true,
    forEach: (_fn?: any) => undefined,
    reduce: (_fn?: any, initial?: any) => initial,
    join: (sep = ',') => ['', ''].join(sep).slice(0, 0),
    at: (_index: number) => undefined,
    values: function* values() {},
    entries: function* entries() {},
    keys: function* keys() {},
    [Symbol.iterator]: function* iterator() {}
  } as const;

  const fn = (() => undefined) as any;

  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === 'then') {
        return undefined;
      }
      if (prop === Symbol.toPrimitive) {
        return (hint: string) => (hint === 'number' ? 0 : '');
      }
      if (prop === Symbol.iterator) {
        return emptyArrayMethods[Symbol.iterator];
      }
      if (prop === 'toString') {
        return () => '';
      }
      if (prop === 'valueOf') {
        return () => 0;
      }
      if (prop === 'length') {
        return 0;
      }
      if (prop === '__compatLabel') {
        return label;
      }
      if (typeof prop === 'string' && prop in emptyArrayMethods) {
        return (emptyArrayMethods as any)[prop];
      }
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        return undefined;
      }

      warnCompatMissing('get', `${label}.${String(prop)}`);

      return createNoopCompatProxy(`${label}.${String(prop)}`);
    },
    apply() {
      warnCompatMissing('call', label);

      return createNoopCompatProxy(`${label}()`);
    },
    construct() {
      warnCompatMissing('construct', label);

      return createNoopCompatProxy(`new ${label}()`);
    },
    set() {
      return true;
    },
    has() {
      return false;
    },
    ownKeys() {
      return [];
    },
    getOwnPropertyDescriptor() {
      return {
        configurable: true,
        enumerable: false
      };
    }
  });
}

function wrapCompatValue<T>(value: T, label: string): T {
  if (value === null || value === undefined) {
    return createNoopCompatProxy(label) as T;
  }

  const valueType = typeof value;

  if (valueType !== 'object' && valueType !== 'function') {
    return value;
  }

  const objectValue = value as object;

  if (compatProxyCache.has(objectValue)) {
    return compatProxyCache.get(objectValue);
  }

  const proxy = new Proxy(value as any, {
    get(target, prop, receiver) {
      if (!(prop in target)) {
        if (prop === 'then') {
          return undefined;
        }

        warnCompatMissing('get', `${label}.${String(prop)}`);

        return createNoopCompatProxy(`${label}.${String(prop)}`);
      }

      const result = Reflect.get(target, prop, receiver);

      if (typeof result === 'function') {
        return new Proxy(result.bind(target), {
          apply(fnTarget, thisArg, argArray) {
            const called = Reflect.apply(fnTarget, thisArg, argArray);

            return wrapCompatValue(called, `${label}.${String(prop)}()`);
          },
          construct(fnTarget, argArray, newTarget) {
            const constructed = Reflect.construct(fnTarget, argArray, newTarget);

            return wrapCompatValue(constructed, `${label}.${String(prop)}()`);
          },
          get(fnTarget, fnProp, fnReceiver) {
            if (!(fnProp in fnTarget)) {
              if (fnProp === 'then') {
                return undefined;
              }

              warnCompatMissing('get', `${label}.${String(prop)}.${String(fnProp)}`);

              return createNoopCompatProxy(`${label}.${String(prop)}.${String(fnProp)}`);
            }

            return wrapCompatValue(Reflect.get(fnTarget, fnProp, fnReceiver), `${label}.${String(prop)}.${String(fnProp)}`);
          }
        });
      }

      return wrapCompatValue(result, `${label}.${String(prop)}`);
    },
    set(target, prop, nextValue, receiver) {
      return Reflect.set(target, prop, nextValue, receiver);
    }
  });

  compatProxyCache.set(objectValue, proxy);

  return proxy;
}

function injectGlobals(): void {
  const g = globalThis as any;

  // ── logger ──
  const identity = (s: any) => String(s);

  /** 追加日志到当天 command.log 文件（sendLog 插件会读取） */
  const appendLog = (level: string, ...args: any[]) => {
    log(level, ...args.map(String));
    try {
      const cwd = process.cwd();
      const today = new Date().toISOString().slice(0, 10);
      const logFile = path.join(cwd, 'logs', `command.${today}.log`);
      const time = new Date().toTimeString().slice(0, 8);
      const line = `[${time}][${level.toUpperCase().padStart(4)}] ${args.map(String).join(' ')}\n`;

      fs.appendFileSync(logFile, line);
    } catch {
      // 静默忽略
    }
  };

  g.logger = createIdentityLogger(identity, appendLog);

  // ── redis ──
  // 由 Miao-Yunzai 自身的 redisInit() 在 main() 中初始化 global.redis
  // AlemonJS 启动前已将 redis 配置同步到 Miao-Yunzai/config/config/redis.yaml

  // ── Bot 对象 ──
  // 通过 callApi 实现真实的 icqq API 调用，经由 IPC → AlemonJS → 平台适配器
  const uinList = new CompatUinList(10000);
  const botInstance: any = {
    nickname: 'Yunzai',
    /** Yunzai 插件常用的 Bot.logger 全局日志入口 */
    logger: g.logger,
    /** 频道 tiny_id（非频道场景为空字符串） */
    tiny_id: '',
    /** 头像 URL */
    avatar: '',
    fl: new Map(),
    gl: new Map(),
    gml: new Map(),
    /** Bot 状态信息（兼容 icqq Bot.stat） */
    stat: {
      start_time: Math.floor(Date.now() / 1000),
      recv_msg_cnt: 0,
      sent_msg_cnt: 0,
      msg_cnt_per_min: 0,
      recv_pkt_cnt: 0,
      sent_pkt_cnt: 0,
      lost_pkt_cnt: 0
    },
    getFriendMap: () => botInstance.fl,
    getGroupMap: () => botInstance.gl,

    pickFriend: (uid: number) => makeFriendProxy(uid, ''),
    pickGroup: (gid: number) => makeGroupProxy(gid),
    pickUser: (uid: number) => makeFriendProxy(uid, ''),
    /** 快捷获取群成员（等效 pickGroup(gid).pickMember(uid)） */
    pickMember: (gid: number, uid: number) => makeGroupProxy(gid).pickMember(uid),

    /** 发送群消息（部分插件直接调用 Bot.sendGroupMsg） */
    sendGroupMsg: async (gid: number, msg: any) => {
      const contents = await serializeReply(msg);

      return callApi('sendGroupMsg', { group_id: gid, contents }).catch(() => ({}));
    },

    /** 发送私聊消息 */
    sendPrivateMsg: async (uid: number, msg: any) => {
      const contents = await serializeReply(msg);

      return callApi('sendPrivateMsg', { user_id: uid, contents }).catch(() => ({}));
    },

    /** 获取群列表（填充 gl） */
    getGroupList: () => callApi('getGroupList')
        .then((res: any) => {
          if (res?.data && Array.isArray(res.data)) {
            botInstance.gl.clear();
            for (const g of res.data) {
              botInstance.gl.set(g.group_id, g);
            }
          }

          return botInstance.gl;
        })
        .catch(() => botInstance.gl),

    /** 获取好友列表（填充 fl） */
    getFriendList: () => callApi('getFriendList')
        .then((res: any) => {
          if (res?.data && Array.isArray(res.data)) {
            botInstance.fl.clear();
            for (const f of res.data) {
              const nickname = f.nickname ?? f.user_name ?? f.card ?? '';
              const remark = f.remark ?? f.card ?? nickname;

              botInstance.fl.set(f.user_id, {
                ...f,
                nickname,
                card: f.card ?? remark,
                remark
              });
            }
          }

          return botInstance.fl;
        })
        .catch(() => botInstance.fl),

    /** 获取陌生人信息 */
    getStrangerInfo: (uid: number) => callApi('getStrangerInfo', { user_id: uid }).catch(() => ({})),

    /** 获取登录号信息 */
    getLoginInfo: () => callApi('getLoginInfo')
        .then((res: any) => {
          if (res?.data) {
            botInstance.uin = res.data.UserId ?? res.data.user_id ?? botInstance.uin;
            botInstance.nickname = res.data.UserName ?? res.data.nickname ?? botInstance.nickname;
          }

          return { user_id: botInstance.uin, nickname: botInstance.nickname };
        })
        .catch(() => ({ user_id: botInstance.uin, nickname: botInstance.nickname })),

    /** 获取群成员列表（同时填充 gml 缓存） */
    getGroupMemberList: (gid: number) => callApi('getGroupMemberList', { group_id: gid })
        .then((res: any) => {
          if (res?.data && Array.isArray(res.data)) {
            const map = new Map();

            for (const m of res.data) {
              map.set(m.user_id, m);
            }
            botInstance.gml.set(gid, map);

            return map;
          }

          return botInstance.gml.get(gid) ?? new Map();
        })
        .catch(() => botInstance.gml.get(gid) ?? new Map()),

    /** 获取群成员信息 */
    getGroupMemberInfo: (gid: number, uid: number) => callApi('getGroupMemberInfo', { group_id: gid, user_id: uid }).catch(() => ({})),

    /** 获取转发消息（miao-plugin / ZZZ-Plugin 使用） */
    getForwardMsg: (resId: string) => callApi('getForwardMsg', { id: resId }).catch(() => ({ message: [] })),

    /** 获取 Cookies（genshin 插件米游社 Cookie 抓取可能需要） */
    getCookies: (domain?: string) => callApi('getCookies', { domain: domain ?? '' }).catch(() => ({ cookies: '' })),

    /** 获取 CSRF Token */
    getCsrfToken: () => callApi('getCsrfToken').catch(() => ({ token: 0 })),

    /** 点赞（sendLike） */
    sendLike: (uid: number, times = 10) => callApi('sendLike', { user_id: uid, times }).catch(() => false),

    /** 获取陌生人列表 */
    getStrangerList: () => callApi('get_stranger_list').catch(() => []),

    /** 重载好友列表 */
    reloadFriendList: () => botInstance.getFriendList(),

    /** 重载群列表 */
    reloadGroupList: () => botInstance.getGroupList(),

    /** 重载黑名单 */
    reloadBlackList: () => callApi('get_blacklist').catch(() => []),

    /** 设置在线状态 */
    setOnlineStatus: (status: number) => callApi('set_online_status', { status }).catch(() => false),

    /** 设置昵称 */
    setNickname: (nickname: string) => callApi('set_qq_profile', { nickname }).catch(() => false),

    /** 设置性别 0未知 1男 2女 */
    setGender: (gender: number) => callApi('set_qq_profile', { gender }).catch(() => false),

    /** 设置生日 */
    setBirthday: (birthday: string) => callApi('set_qq_profile', { birthday }).catch(() => false),

    /** 设置个人说明 */
    setDescription: (description: string) => callApi('set_qq_profile', { description }).catch(() => false),

    /** 设置个性签名 */
    setSignature: (signature: string) => callApi('set_qq_profile', { signature }).catch(() => false),

    /** 设置头像 */
    setAvatar: (file: any) => callApi('set_qq_avatar', { file: String(file) }).catch(() => false),

    /** 获取个性签名 */
    getSignature: () => callApi('get_qq_profile')
        .then((r: any) => r?.data?.signature ?? '')
        .catch(() => ''),

    /** 图片 OCR */
    imageOcr: (image: string) => callApi('ocr_image', { image }).catch(() => ({ texts: [], language: '' })),

    /** 获取视频下载地址 */
    getVideoUrl: (fid: string, md5: string) => callApi('.get_video_url', { fid, md5 }).catch(() => ''),

    /** 获取系统消息（好友申请、群邀请） */
    getSystemMsg: () => callApi('get_group_system_msg').catch(() => ({ InvitedRequests: [], join_requests: [] })),

    /** 设为精华消息 */
    setEssenceMessage: (messageId: number) => callApi('set_essence_msg', { message_id: messageId }).catch(() => false),

    /** 移除精华消息 */
    removeEssenceMessage: (messageId: number) => callApi('delete_essence_msg', { message_id: messageId }).catch(() => false),

    /** 获取漫游表情 */
    getRoamingStamp: () => callApi('.get_roaming_stamp').catch(() => []),

    /** 删除漫游表情 */
    deleteStamp: (id: string) => callApi('.delete_stamp', { id }).catch(() => false),

    /** 清理缓存 */
    cleanCache: () => callApi('clean_cache').catch(() => false),

    /** 创建好友分组 */
    addClass: (name: string) => callApi('.add_class', { name }).catch(() => false),

    /** 删除好友分组 */
    deleteClass: (id: number) => callApi('.delete_class', { id }).catch(() => false),

    /** 重命名好友分组 */
    renameClass: (id: number, name: string) => callApi('.rename_class', { id, name }).catch(() => false),

    /**
     * 构造合并转发消息（Bot 级别）
     * ZZZ-Plugin / miao-plugin 使用 Bot.makeForwardMsg(msgs)
     * 展平节点为普通消息段数组
     */
    makeForwardMsg: (msgs: any[]) => buildForwardMsgCompat(msgs),

    // ── EventEmitter 兼容（yenai-plugin 等插件在加载时调用 Bot.on） ──
    // eslint-disable-next-line func-call-spacing
    _events: new Map<string, ((...args: any[]) => void)[]>(),
    on(event: string, fn: (...args: any[]) => void) {
      const list = botInstance._events.get(event) ?? [];

      list.push(fn);
      botInstance._events.set(event, list);

      return botInstance;
    },
    addListener(event: string, fn: (...args: any[]) => void) {
      return botInstance.on(event, fn);
    },
    prependListener(event: string, fn: (...args: any[]) => void) {
      const list = botInstance._events.get(event) ?? [];

      list.unshift(fn);
      botInstance._events.set(event, list);

      return botInstance;
    },
    once(event: string, fn: (...args: any[]) => void) {
      const wrapper = (...args: any[]) => {
        botInstance.off(event, wrapper);
        fn(...args);
      };

      return botInstance.on(event, wrapper);
    },
    prependOnceListener(event: string, fn: (...args: any[]) => void) {
      const wrapper = (...args: any[]) => {
        botInstance.off(event, wrapper);
        fn(...args);
      };

      return botInstance.prependListener(event, wrapper);
    },
    off(event: string, fn: (...args: any[]) => void) {
      const list = botInstance._events.get(event);

      if (list) {
        botInstance._events.set(
          event,
          list.filter((f: any) => f !== fn)
        );
      }

      return botInstance;
    },
    removeListener(event: string, fn: (...args: any[]) => void) {
      return botInstance.off(event, fn);
    },
    emit(event: string, ...args: any[]) {
      const list = botInstance._events.get(event);

      if (list) {
        for (const fn of [...list]) {
          try {
            fn(...args);
          } catch {
            /* 静默 */
          }
        }
      }

      return !!list?.length;
    },
    removeAllListeners(event?: string) {
      if (event) {
        botInstance._events.delete(event);
      } else {
        botInstance._events.clear();
      }

      return botInstance;
    },
    listenerCount(event: string) {
      return botInstance._events.get(event)?.length ?? 0;
    },
    listeners(event: string) {
      return [...(botInstance._events.get(event) ?? [])];
    },
    rawListeners(event: string) {
      return [...(botInstance._events.get(event) ?? [])];
    },
    eventNames() {
      return [...botInstance._events.keys()];
    },
    setMaxListeners(_n: number) {
      return botInstance;
    },
    getMaxListeners() {
      return Infinity;
    },

    // ── 配置/状态兼容字段（部分插件访问 Bot.config / Bot.status） ──
    config: {
      platform: 1,
      log_level: 'info',
      data_dir: path.join(process.cwd(), 'data')
    },
    status: 11 // ONLINE
  };

  Object.assign(botInstance, oneBotRuntime.createOneBotBotAdapter(botInstance));

  Object.defineProperty(botInstance, 'uin', {
    get() {
      return uinList;
    },
    set(value: number | string | Array<number | string>) {
      if (Array.isArray(value) && value.length > 0) {
        uinList.setPrimary(value[0]);

        return;
      }

      uinList.setPrimary(value);
    },
    enumerable: true,
    configurable: true
  });

  g.Bot = wrapCompatValue(
    new Proxy(botInstance, {
      get(target, prop) {
        // Bot[uin] → 返回 bot 自身（Yunzai 用 Bot[e.self_id] 取实例）
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          return target;
        }

        return target[prop as keyof typeof target];
      },
      has(target, prop) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          return true;
        }

        return prop in target;
      }
    }),
    'Bot'
  );

  // ── segment (icqq 消息段构造) ──
  g.segment = {
    image: (file: any) => ({ type: 'image', file }),
    at: (qq: string | number, text?: string) => ({ type: 'at', qq, text: text ?? '' }),
    face: (id: number) => ({ type: 'face', id }),
    text: (text: string) => ({ type: 'text', text }),
    record: (file: any) => ({ type: 'record', file }),
    video: (file: any) => ({ type: 'video', file }),
    json: (data: any) => ({ type: 'json', data: typeof data === 'string' ? data : JSON.stringify(data) }),
    xml: (data: string) => ({ type: 'xml', data }),
    poke: (id: number) => ({ type: 'poke', id }),
    reply: (id: any) => ({ type: 'reply', id }),
    share: (url: string, title?: string, content?: string, image?: string) => ({
      type: 'share',
      url,
      title: title ?? '',
      content: content ?? '',
      image: image ?? ''
    }),
    music: (type: string, id: any) => ({ type: 'music', data: { type, id } }),
    forward: (resId: string) => ({ type: 'forward', id: resId }),
    /** 文件消息段 */
    file: (file: any, name?: string) => ({ type: 'file', file, name: name ?? '' }),
    /** 位置消息段 */
    location: (lat: number, lng: number, title?: string, content?: string) => ({
      type: 'location',
      data: { lat, lon: lng, title: title ?? '', content: content ?? '' }
    }),
    /** 骰子 */
    dice: (id?: number) => ({ type: 'dice', id: id ?? 0 }),
    /** 猜拳 */
    rps: (id?: number) => ({ type: 'rps', id: id ?? 0 }),
    /** Markdown 消息 */
    markdown: (content: string) => ({ type: 'markdown', data: { content } }),
    /** mirai 消息透传 */
    mirai: (data: string) => ({ type: 'mirai', data }),
    /** 小表情（已废弃，兼容保留） */
    bface: (file: string, text?: string) => ({ type: 'bface', file, text: text ?? '' }),
    sface: (id: number, text?: string) => ({ type: 'sface', id, text: text ?? '' }),
    /** Yunzai polyfill — 按钮消息（多数平台不支持，返回空字符串） */
    button: () => '',
    /** 转发消息节点（构建合并转发消息时使用） */
    // eslint-disable-next-line camelcase
    node: (user_id: any, nickname: string, content: any) => ({
      type: 'node',
      // eslint-disable-next-line camelcase
      data: { user_id, nickname, content }
    })
  };
}

// ━━━━━━━━━━━━━━━ 合并转发消息构建 ━━━━━━━━━━━━━━━

/**
 * 将转发消息节点展平为普通消息段数组
 * 无法创建真实 QQ 转发卡片时 → 展平为文本+媒体消息
 */
function buildForwardMsgParts(nodes: any[]): any[] {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return [];
  }
  const parts: any[] = [];

  for (const node of nodes) {
    const msg = node.message ?? node;
    const nickname = node.nickname ?? '';

    if (nickname) {
      parts.push({ type: 'text', text: `【${nickname}】\n` });
    }
    if (typeof msg === 'string') {
      parts.push({ type: 'text', text: msg + '\n' });
    } else if (Array.isArray(msg)) {
      parts.push(...msg);
      parts.push({ type: 'text', text: '\n' });
    } else if (msg && typeof msg === 'object') {
      parts.push(msg);
      parts.push({ type: 'text', text: '\n' });
    }
  }

  return parts;
}

function buildForwardMsgCompat(nodes: any[]) {
  const parts = buildForwardMsgParts(nodes);
  const text = parts
    .map(part => {
      if (part?.type === 'text') {
        return String(part.text ?? part.data?.text ?? '');
      }

      return '';
    })
    .join('');

  return {
    type: 'forward',
    data: text,
    file: '',
    id: '',
    resid: '',
    message: parts,
    messages: parts,
    __forwardParts: parts,
    toString: () => text
  };
}

const oneBotRuntime = createOneBotRuntime({
  callApi,
  serializeReply,
  wrapCompatValue,
  safeInt,
  resolveMasterFlag,
  buildForwardMsgCompat
});

// ━━━━━━━━━━━━━━━ 消息序列化 ━━━━━━━━━━━━━━━

async function serializeReply(msg: any): Promise<ReplyContent[]> {
  if (typeof msg === 'string') {
    return [{ type: 'text', data: msg }];
  }
  if (Buffer.isBuffer(msg)) {
    return [{ type: 'image', data: msg.toString('base64') }];
  }
  if (Array.isArray(msg)) {
    const results = await Promise.all(msg.map(serializeReply));

    return results.flat();
  }
  if (msg && typeof msg === 'object') {
    if (Array.isArray(msg.__forwardParts)) {
      return serializeReply(msg.__forwardParts);
    }

    switch (msg.type) {
      case 'image': {
        let file: string;

        if (Buffer.isBuffer(msg.file)) {
          file = msg.file.toString('base64');
        } else {
          const filePath = String(msg.file);

          // file:// 路径 → 异步读取本地文件转 base64（避免阻塞事件循环）
          if (filePath.startsWith('file://')) {
            try {
              const absPath = filePath.replace(/^file:\/\//, '');
              const buf = await fs.promises.readFile(absPath);

              file = buf.toString('base64');
            } catch {
              file = filePath; // 读取失败回退原始路径
            }
          } else if (filePath.startsWith('/') && !filePath.startsWith('http')) {
            // 绝对路径（非 URL）→ 异步读取文件
            try {
              const buf = await fs.promises.readFile(filePath);

              file = buf.toString('base64');
            } catch {
              file = filePath;
            }
          } else {
            file = filePath;
          }
        }

        return [{ type: 'image', data: file }];
      }
      case 'at':
        return [{ type: 'at', data: String(msg.qq ?? msg.data?.qq ?? '') }];
      case 'face':
        return [{ type: 'face', data: String(msg.id) }];
      case 'text':
        return [{ type: 'text', data: msg.text ?? '' }];
      case 'record': {
        const rf = Buffer.isBuffer(msg.file) ? msg.file.toString('base64') : String(msg.file ?? '');

        return [{ type: 'record', data: rf }];
      }
      case 'video': {
        const vf = Buffer.isBuffer(msg.file) ? msg.file.toString('base64') : String(msg.file ?? '');

        return [{ type: 'video', data: vf }];
      }
      case 'json':
        return [{ type: 'text', data: typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data) }];
      case 'xml':
        return [{ type: 'text', data: msg.data ?? '' }];
      case 'share':
        return [{ type: 'text', data: `${msg.title ?? ''} ${msg.url ?? ''}` }];
      case 'reply':
        return []; // 引用回复不作为内容发送
      default:
        return [{ type: 'other', data: JSON.stringify(msg) }];
    }
  }

  return [{ type: 'text', data: String(msg) }];
}

// ━━━━━━━━━━━━━━━ 构建 icqq 事件 ━━━━━━━━━━━━━━━

/** 检测消息段中是否 at 了 self_id */
function detectAtMe(message: any[], selfId: number): boolean {
  return message.some((s: any) => s.type === 'at' && String(s.data?.qq ?? s.qq) === String(selfId));
}

/** 检测消息段中是否 at all */
function detectAtAll(message: any[]): boolean {
  return message.some((s: any) => s.type === 'at' && (s.data?.qq === 'all' || s.qq === 'all'));
}

/**
 * 提取消息段中第一个非自身、非 all 的 at 目标 QQ
 * 用于在 buildEvent 中预填 e.at，作为 dealMsg 的安全兜底
 */
function extractFirstAtTarget(message: any[], selfId: number): string | number | undefined {
  for (const s of message) {
    if (s.type !== 'at') {
      continue;
    }
    const qq = s.data?.qq ?? s.qq;

    if (qq === null || qq === undefined || qq === 'all' || String(qq) === String(selfId)) {
      continue;
    }

    return qq;
  }

  return undefined;
}

/**
 * 将跨平台媒体附件（来自 AlemonJS MessageMedia）转为 icqq 消息段
 * 使得来自 Discord/Telegram 等平台的图片也能被 Yunzai 插件感知
 */
function mediaToSegments(media: IPCEventMessage['data']['media']): any[] {
  if (!Array.isArray(media) || media.length === 0) {
    return [];
  }

  return media.map(m => {
    switch (m.type) {
      case 'image':
      case 'sticker':
        return { type: 'image', file: m.url ?? m.fileId ?? '', url: m.url };
      case 'audio':
        return { type: 'record', file: m.url ?? m.fileId ?? '', url: m.url };
      case 'video':
        return { type: 'video', file: m.url ?? m.fileId ?? '', url: m.url };
      default:
        return { type: 'file', file: m.url ?? m.fileId ?? '', name: m.fileName };
    }
  });
}

/** 安全转 number（非 QQ 平台的 userId 可能是非数字字符串） */
function safeInt(v: any, fallback: number): number {
  const n = parseInt(String(v));

  return Number.isFinite(n) ? n : fallback;
}

/**
 * 创建 e.group 代理对象
 * 通过 callApi 实现真实的群操作（踢人/禁言/撤回等）
 * OneBot 平台下完全兼容 icqq API
 *
 * @param groupId 群号
 * @param opts 可选初始信息（从 raw event 中提取）
 */
function makeGroupProxy(groupId: number, opts?: { name?: string; is_owner?: boolean; is_admin?: boolean }) {
  return oneBotRuntime.createOneBotGroupAdapter(groupId, opts);
}

/**
 * 创建 e.friend 代理对象
 * 通过 callApi 实现真实的私聊操作
 */
function makeFriendProxy(userId: number, userName: string) {
  return oneBotRuntime.createOneBotFriendAdapter(userId, userName);
}

// ━━━━━━━━━━━━━ 非消息事件构建 ━━━━━━━━━━━━━

/** 判断是否是消息类事件名称 */
function isMessageEventName(name: string): boolean {
  return name.includes('message.create') || name.includes('interaction');
}

/** AlemonJS 事件名 → icqq notice 类型映射 */
const EVENT_NOTICE_MAP: Record<string, { notice_type: string; sub_type: string }> = {
  'member.add': { notice_type: 'group_increase', sub_type: 'approve' },
  'member.remove': { notice_type: 'group_decrease', sub_type: 'leave' },
  'member.ban': { notice_type: 'group_ban', sub_type: 'ban' },
  'member.unban': { notice_type: 'group_ban', sub_type: 'lift_ban' },
  'member.update': { notice_type: 'group_admin', sub_type: 'set' },
  'notice.create': { notice_type: 'notify', sub_type: 'poke' },
  'private.notice.create': { notice_type: 'notify', sub_type: 'poke' },
  'message.delete': { notice_type: 'group_recall', sub_type: '' },
  'private.message.delete': { notice_type: 'friend_recall', sub_type: '' }
};

/** AlemonJS 事件名 → icqq request 类型映射 */
const EVENT_REQUEST_MAP: Record<string, { request_type: string; sub_type: string }> = {
  'private.friend.add': { request_type: 'friend', sub_type: 'add' },
  'private.guild.add': { request_type: 'group', sub_type: 'invite' }
};

/**
 * 跨平台降级构建非消息类 icqq 事件
 * 根据 AlemonJS 事件名映射到 icqq notice/request 类型
 */
function buildFallbackNonMessageEvent(
  data: IPCEventMessage['data'],
  selfId: number,
  platformTag: string,
  reply: (msg: any, quote?: boolean) => any,
  eventName: string
) {
  const userId = safeInt(data.userId, 10001);
  const groupId = data.isPrivate ? 0 : safeInt(data.spaceId, 0);
  const masterFlag = resolveMasterFlag(data);

  const e: any = {
    self_id: selfId,
    time: Math.floor(Date.now() / 1000),
    user_id: userId,
    group_id: groupId,

    isMaster: masterFlag,
    isOwner: masterFlag,
    isAdmin: masterFlag,

    reply,
    getMemberMap: () => (groupId ? makeGroupProxy(groupId).getMemberMap() : new Map()),
    getAvatarUrl: (size = 0) => data.userAvatar ?? `https://q1.qlogo.cn/g?b=qq&s=${size}&nk=${userId}`,
    logFnc: ''
  };

  const noticeMap = EVENT_NOTICE_MAP[eventName];
  const requestMap = EVENT_REQUEST_MAP[eventName];

  if (noticeMap) {
    e.post_type = 'notice';
    e.notice_type = noticeMap.notice_type;
    e.sub_type = noticeMap.sub_type;
    e.operator_id = userId;
    e.logText = `${platformTag}[Notice:${noticeMap.notice_type}:${groupId ?? userId}]`;
  } else if (requestMap) {
    e.post_type = 'request';
    e.request_type = requestMap.request_type;
    e.sub_type = requestMap.sub_type;
    e.comment = '';
    e.flag = `${eventName}_${Date.now()}`;
    e.approve = (approve = true) => callApi(requestMap.request_type === 'friend' ? 'setFriendAddRequest' : 'setGroupAddRequest', { flag: e.flag, approve, type: requestMap.sub_type }).catch(
        () => false
      );
    e.reject = (reason = '') => callApi(requestMap.request_type === 'friend' ? 'setFriendAddRequest' : 'setGroupAddRequest', {
        flag: e.flag,
        approve: false,
        reason,
        type: requestMap.sub_type
      }).catch(() => false);
    e.logText = `${platformTag}[Request:${requestMap.request_type}:${userId}]`;
  } else {
    // guild/channel 等无直接对应的事件 → 作为通用 notice 透传
    e.post_type = 'notice';
    e.notice_type = eventName;
    e.sub_type = '';
    e.logText = `${platformTag}[Event:${eventName}:${groupId ?? userId}]`;
  }

  if (groupId) {
    e.group = makeGroupProxy(groupId);
  }
  if (userId) {
    e.friend = makeFriendProxy(userId, data.userName ?? 'User');
    e.member = {
      user_id: userId,
      card: data.userName ?? '',
      nickname: data.userName ?? '',
      role: 'member',
      is_admin: masterFlag,
      is_owner: masterFlag,
      _info: {
        card: data.userName ?? '',
        nickname: data.userName ?? '',
        role: 'member'
      },
      getAvatarUrl: (size = 0) => data.userAvatar ?? `https://q1.qlogo.cn/g?b=qq&s=${size}&nk=${userId}`
    };
  }

  // sender/nickname — dealMsg() 依赖 e.sender 存在
  e.sender = {
    user_id: userId,
    nickname: data.userName ?? 'User',
    card: data.userName ?? '',
    role: 'member'
  };
  e.nickname = data.userName ?? 'User';

  return e;
}

/**
 * 将跨平台 master 用户 ID 注入到 Cfg.masterQQ
 * 使 loader.js dealMsg() 中的 masterQQ.includes() 检查能正确识别
 */
function injectMasterQQ(userId: number | string): void {
  const cfg = (globalThis as any)._yunzaiCfg;

  if (!cfg) {
    return;
  }

  try {
    const masterList: any[] = cfg.masterQQ ?? [];
    const uid = Number(userId) || String(userId);

    if (!masterList.includes(uid)) {
      masterList.push(uid);
    }
  } catch {
    // Cfg 不可用时静默忽略
  }
}

function resolveMasterFlag(data: IPCEventMessage['data']): boolean {
  return data.isMaster ?? data.IsMaster ?? false;
}

function buildEvent(data: IPCEventMessage['data'], msgId: string) {
  const raw = data.rawEvent;
  const masterFlag = resolveMasterFlag(data);
  const botUin = (globalThis as any).Bot?.uin ?? 10000;
  // 优先使用 raw event 的 self_id（真实 Bot QQ 号），其次用 IPC 传入的 botId
  const selfId = raw?.self_id !== null && raw?.self_id !== undefined ? safeInt(raw.self_id, botUin) : safeInt(data.botId, botUin);
  const platformTag = data.platform ? `[${data.platform}]` : '';

  // 首次获知真实 self_id 时更新 Bot.uin（后续事件及 dealMsg 的 atBot 检测依赖此值）
  if (selfId !== 10000 && botUin === 10000) {
    (globalThis as any).Bot.uin = selfId;
  }

  // 跨平台 master 注入：确保 loader 的 cfg.masterQQ.includes() 检查通过
  if (masterFlag && data.userId) {
    injectMasterQQ(data.userId);
  }

  // ── IPC 回复函数（始终覆盖，所有平台通用） ──
  const reply = async (msg: any, _quote = false) => {
    const contents = await serializeReply(msg);
    const replyId = `r_${++replyIdCounter}_${Date.now()}`;

    // 统计发送的消息数
    if ((globalThis as any).Bot?.stat) {
      (globalThis as any).Bot.stat.sent_msg_cnt++;
    }

    log('debug', `[reply] id=${msgId} replyId=${replyId} contents=${JSON.stringify(contents).slice(0, 200)}`);

    // 创建 Promise 等待父进程返回真实 message_id
    const resultPromise = new Promise<any>(resolve => {
      replyPending.set(replyId, { resolve });
      // 超时兜底：8s 后无论如何返回假 ID
      setTimeout(() => {
        if (replyPending.has(replyId)) {
          replyPending.delete(replyId);
          resolve({ message_id: `reply_${Date.now()}` });
        }
      }, 8_000);
    });

    ipcSend({
      type: 'reply',
      id: msgId,
      replyId,
      contents,
      channelId: data.spaceId || undefined,
      userId: data.userId || undefined,
      isPrivate: data.isPrivate
    });

    return resultPromise;
  };

  // ══════════════════════════════════════════
  //  路径 A: 有原始 OneBot 事件 → 真实数据构建
  // ══════════════════════════════════════════
  if (isOneBotPlatform(data.platform) && raw && typeof raw === 'object' && raw.post_type) {
    return oneBotRuntime.buildOneBotEvent({ data, msgId, selfId, reply });
  }

  // 非消息事件 → 跨平台降级构建
  const eventName = data.eventName ?? '';

  if (eventName && !isMessageEventName(eventName)) {
    return buildFallbackNonMessageEvent(data, selfId, platformTag, reply, eventName);
  }

  // ══════════════════════════════════════════
  //  路径 B: 无 rawEvent → 跨平台降级构建
  //  利用 AlemonJS 标准化字段生成最优 icqq 兼容事件
  // ══════════════════════════════════════════
  const isGroup = !data.isPrivate;
  const userId = safeInt(data.userId, 10001);
  const groupId = isGroup ? safeInt(data.spaceId, 10002) : 0;

  // 构建消息段：文本 + 跨平台 at 段 + 跨平台媒体附件
  const messageParts: any[] = [];

  if (data.messageText) {
    messageParts.push({ type: 'text', text: data.messageText });
  }
  // 注入跨平台 at 段（来自 bridge 提取的 atUsers）
  if (Array.isArray(data.atUsers)) {
    for (const u of data.atUsers) {
      const uid = safeInt(u.userId, 0);

      messageParts.push({ type: 'at', qq: uid || u.userId, text: u.userName ?? '' });
    }
  }
  messageParts.push(...mediaToSegments(data.media));
  if (messageParts.length === 0) {
    messageParts.push({ type: 'text', text: '' });
  }

  const e: any = {
    post_type: 'message',
    message_type: isGroup ? 'group' : 'private',
    sub_type: isGroup ? 'normal' : 'friend',
    user_id: userId,
    sender: {
      user_id: userId,
      nickname: data.userName ?? 'User',
      card: data.userName ?? '',
      role: 'member'
    },

    message: messageParts,
    raw_message: data.messageText,
    msg: '',

    group_id: groupId,
    group_name: isGroup ? `Group ${groupId}` : '',

    isMaster: masterFlag,
    isOwner: masterFlag,
    isAdmin: masterFlag,

    message_id: data.messageId ?? `cross_${Date.now()}`,
    seq: Date.now(),
    rand: Math.random(),
    time: Math.floor(Date.now() / 1000),
    self_id: selfId,
    font: '',
    atme: detectAtMe(messageParts, selfId),
    atall: detectAtAll(messageParts),

    // ── at 目标预填（dealMsg 会覆盖，此处作为兜底） ──
    at: extractFirstAtTarget(messageParts, selfId) ?? undefined,

    reply,
    getMemberMap: () => (isGroup ? makeGroupProxy(groupId).getMemberMap() : new Map()),
    getAvatarUrl: (size = 0) => data.userAvatar || `https://q1.qlogo.cn/g?b=qq&s=${size}&nk=${userId}`,
    toString: () => data.messageText,

    // ── group / friend 代理 ──
    ...(isGroup ? { group: makeGroupProxy(groupId), friend: undefined } : { group: undefined, friend: makeFriendProxy(userId, data.userName ?? 'User') }),

    // ── member 信息（filtPermission 需要 is_admin/is_owner/_info） ──
    member: {
      user_id: userId,
      card: data.userName ?? '',
      nickname: data.userName ?? '',
      role: 'member',
      is_admin: masterFlag,
      is_owner: masterFlag,
      _info: {
        card: data.userName ?? '',
        nickname: data.userName ?? '',
        role: 'member'
      },
      getAvatarUrl: (size = 0) => data.userAvatar || `https://q1.qlogo.cn/g?b=qq&s=${size}&nk=${userId}`
    },

    nickname: data.userName ?? 'User',

    /** 便捷方法：构建转发消息 */
    makeForwardMsg: (nodes: any[]) => {
      if (isGroup && groupId) {
        return makeGroupProxy(groupId).makeForwardMsg(nodes);
      }

      return makeFriendProxy(userId, data.userName ?? 'User').makeForwardMsg(nodes);
    }
  };

  e.original_msg = data.messageText;
  e.logText = `${platformTag}[${isGroup ? 'Group' : 'Private'}:${isGroup ? groupId : userId}] ${data.messageText}`;
  e.logFnc = '';

  return e;
}

// ━━━━━━━━━━━━━━━ 主流程 ━━━━━━━━━━━━━━━

let PluginsLoader: any = null;

/**
 * 需要拦截的 Yunzai 内部危险指令（重启/关机/更新会破坏 Worker 生命周期管理）
 * 这些指令应通过 #yz前缀 由 AlemonJS 管理层处理
 */
const BLOCKED_COMMANDS = /^#(重启|停机|关机|(强制)?更新|(静默)?全部(强制)?更新)$/;

/**
 * 在 Bot 上发射 icqq 风格的分层事件
 *
 * icqq 会为一个事件触发多层：
 *   message → message.group → message.group.normal
 *   notice  → notice.group  → notice.group.increase
 *   request → request.friend → request.friend.add
 *
 * yenai-plugin 等插件通过 Bot.on('notice.group.xxx') 监听，
 * 不发射则这些 handler 永远不会被调用。
 */
function emitBotEvent(e: any): void {
  const bot = (globalThis as any).Bot;

  if (!bot?.emit) {
    return;
  }

  const postType = e.post_type;

  if (!postType) {
    return;
  }

  // 第一层：post_type
  bot.emit(postType, e);

  // 第二层：post_type + sub1
  let sub1 = '';

  if (postType === 'message') {
    sub1 = e.message_type ?? '';
  } else if (postType === 'notice') {
    // notice_type 如 group_increase → group.increase
    sub1 = (e.notice_type ?? '').replace(/_/g, '.');
  } else if (postType === 'request') {
    sub1 = (e.request_type ?? '').replace(/_/g, '.');
  }
  if (sub1) {
    bot.emit(`${postType}.${sub1}`, e);
  }

  // 第三层：post_type + sub1 + sub_type
  const sub2 = e.sub_type ?? '';

  if (sub1 && sub2) {
    bot.emit(`${postType}.${sub1}.${sub2}`, e);
  }
}

async function main(): Promise<void> {
  const cwd = process.cwd();

  log('info', `Worker 启动, cwd=${cwd}`);

  // 1. 注入全局变量
  injectGlobals();

  // 2. 确保 config/config 目录存在
  const configDir = path.join(cwd, 'config', 'config');

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // 2.1 确保 logs 目录及当天日志文件存在（sendLog 等插件会 readFileSync 读取）
  const logsDir = path.join(cwd, 'logs');

  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const today = new Date().toISOString().slice(0, 10); // yyyy-MM-dd
  const commandLog = path.join(logsDir, `command.${today}.log`);

  if (!fs.existsSync(commandLog)) {
    fs.writeFileSync(commandLog, '');
  }

  // 2.5 初始化 Redis — 调用 Miao-Yunzai 自身的 redisInit()，读取 config/config/redis.yaml
  try {
    const redisMod = await import(pathToFileURL(path.join(cwd, 'lib', 'config', 'redis.js')).href);
    const redisInit = redisMod.default ?? redisMod.redisInit;

    await redisInit();
    log('info', 'Redis 初始化成功（Miao-Yunzai）');
  } catch (err: any) {
    log('error', `Redis 初始化失败: ${err.message}`);
    ipcSend({ type: 'error', message: `Redis 初始化失败: ${err.message}` });
    process.exit(1);
  }

  // 3. 加载 plugin 基类 → global.plugin
  try {
    const mod = await import(pathToFileURL(path.join(cwd, 'lib', 'plugins', 'plugin.js')).href);

    (globalThis as any).plugin = mod.default ?? mod.plugin;
    log('info', 'plugin 基类加载成功');
  } catch (err: any) {
    log('warn', `plugin 基类加载失败，使用内置空壳: ${err.message}`);
    const stateArr = new Map<string, any>();

    (globalThis as any).plugin = class {
      name = 'plugin';
      dsc = '';
      event = 'message';
      priority = 5000;
      rule: any[] = [];
      task: any = null;
      handler: any = null;
      namespace = '';
      e: any = null;
      constructor(opt: any = {}) {
        Object.assign(this, opt);
      }
      reply(msg: any, quote?: boolean) {
        return this.e?.reply?.(msg, quote);
      }
      conKey(isGroup = false) {
        if (isGroup) {
          return `${this.name}.${this.e?.group_id}`;
        }

        return `${this.name}.${this.e?.user_id}`;
      }
      setContext(type: string, isGroup = false, time = 120) {
        const key = this.conKey(isGroup);

        stateArr.set(key, { type });
        if (time > 0) {
          setTimeout(() => {
            if (stateArr.has(key)) {
              stateArr.delete(key);
              this.e?.reply?.('操作超时已取消');
            }
          }, time * 1000);
        }
      }
      getContext(type?: string, isGroup = false) {
        const key = this.conKey(isGroup);
        const ctx = stateArr.get(key);

        if (type && ctx?.type !== type) {
          return undefined;
        }

        return ctx;
      }
      finish(_type?: string, isGroup = false) {
        const key = this.conKey(isGroup);

        stateArr.delete(key);
      }
      /** 等待上下文回复（Promise 模式） */
      awaitContext(type: string, isGroup = false, time = 120): Promise<any> {
        return new Promise((resolve, reject) => {
          this.setContext(type, isGroup, time);
          const key = this.conKey(isGroup);
          const check = setInterval(() => {
            const ctx = stateArr.get(key);

            if (!ctx) {
              clearInterval(check);
              reject(new Error('上下文已超时'));
            } else if (ctx.resolve) {
              clearInterval(check);
              stateArr.delete(key);
              resolve(ctx.resolve);
            }
          }, 500);

          // 超时后清理 interval
          setTimeout(() => clearInterval(check), (time + 5) * 1000);
        });
      }
      /** 解析上下文（与 awaitContext 配合） */
      resolveContext(e: any) {
        const key = this.conKey(!!e?.isGroup);
        const ctx = stateArr.get(key);

        if (ctx) {
          ctx.resolve = e;
        }
      }
    };
  }

  // 4. 加载 PluginsLoader
  try {
    const mod = await import(pathToFileURL(path.join(cwd, 'lib', 'plugins', 'loader.js')).href);

    PluginsLoader = mod.default;
    log('info', 'PluginsLoader 加载成功');
  } catch (err: any) {
    log('error', `PluginsLoader 加载失败: ${err.message}`);
    ipcSend({ type: 'error', message: `Loader 加载失败: ${err.message}` });
    process.exit(1);
  }

  // 5. 加载全部插件
  try {
    await PluginsLoader.load();
    const count = PluginsLoader.priority?.length ?? 0;

    log('info', `插件加载完成，共 ${count} 个`);

    // 5a. 注入跨平台 master 用户到 Cfg.masterQQ
    //     loader 的 dealMsg 用 cfg.masterQQ.includes() 覆盖 e.isMaster
    //     跨平台用户的 userId 如果不在列表里就会变成非 master
    try {
      const cfgMod = await import(pathToFileURL(path.join(cwd, 'lib', 'config', 'config.js')).href);
      const cfg = cfgMod.default ?? cfgMod.cfg;

      if (cfg) {
        // 保存 cfg 引用供后续新增 master 时注入
        (globalThis as any)._yunzaiCfg = cfg;
        log('info', `Cfg 实例已获取，当前 masterQQ: [${cfg.masterQQ}]`);
      }
    } catch {
      log('warn', '获取 Cfg 实例失败，跨平台 master 需手动配置 masterQQ');
    }

    // 5b. 获取 Bot 登录信息（更新 Bot.uin 为真实 QQ 号，atBot 检测依赖此值）
    void (globalThis as any).Bot?.getLoginInfo?.()?.catch?.(() => {});
    // 预填充 Bot.fl / Bot.gl（定时任务和 relpyPrivate 依赖非空列表）
    void (globalThis as any).Bot?.getGroupList?.()?.catch?.(() => {});
    void (globalThis as any).Bot?.getFriendList?.()?.catch?.(() => {});

    ipcSend({ type: 'ready', pluginCount: count });
  } catch (err: any) {
    log('error', `插件加载失败: ${err.message}`);
    ipcSend({ type: 'error', message: `插件加载失败: ${err.message}` });
    process.exit(1);
  }

  // 6. 监听父进程 IPC 消息
  process.on('message', (msg: ParentToWorker) => {
    if (msg.type === 'event') {
      // 记录当前事件的平台和消息 ID，供 callApi 自动附加
      currentPlatform = msg.data.platform ?? '';
      currentMsgId = msg.id;
      // 记录默认平台（定时任务触发时用此兜底）
      if (currentPlatform) {
        defaultPlatform = currentPlatform;
      }
      // 统计收到的消息数
      if ((globalThis as any).Bot?.stat) {
        (globalThis as any).Bot.stat.recv_msg_cnt++;
      }

      const e = buildEvent(msg.data, msg.id);
      let replied = false;
      const origReply = e.reply;

      e.reply = (m: any, q = false) => {
        replied = true;

        return origReply(m, q);
      };
      void (async () => {
        try {
          // 在 Bot 上发射 icqq 风格事件（供 Bot.on 监听器使用）
          emitBotEvent(e);

          // 拦截 Yunzai 内部的重启/关机/更新指令
          const rawMsg = String(e.msg ?? '').trim();

          if (BLOCKED_COMMANDS.test(rawMsg)) {
            const hint = rawMsg.includes('更新') ? '#yz更新' : rawMsg.includes('重启') ? '#yz重启' : '#yz停止';

            e.reply(`该指令已被接管，请使用 ${hint}`);
            ipcSend({ type: 'done', id: msg.id, replied: true });

            return;
          }
          await PluginsLoader.deal(e);
        } catch (err: any) {
          log('error', `deal 异常: ${err.message}`);
          log('error', err.stack ?? '');
          ipcSend({
            type: 'reply',
            id: msg.id,
            replyId: `r_${++replyIdCounter}_${Date.now()}`,
            contents: [{ type: 'text', data: `[Yunzai 错误] ${err.message}` }]
          });
          replied = true;
        }
        // 通知父进程 deal 已完成
        ipcSend({ type: 'done', id: msg.id, replied });
      })();
    } else if (msg.type === 'api_response') {
      handleApiResponse(msg);
    } else if (msg.type === 'reply_result') {
      handleReplyResult(msg);
    } else if (msg.type === 'shutdown') {
      log('info', 'Worker 收到关闭信号，退出');
      process.exit(0);
    }
  });
}

main().catch(err => {
  log('error', `Worker 启动失败: ${err.message}`);
  process.exit(1);
});
