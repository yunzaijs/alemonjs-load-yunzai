/**
 * AlemonJS → Yunzai IPC 桥接
 *
 * 1. 捕获 AlemonJS 事件（消息、通知、请求等），提取所有可用字段
 * 2. 区分平台：OneBot 透传 rawEvent，其他平台用通用字段
 * 3. 通过 IPC 发送给 Worker 子进程
 * 4. 异步接收 Worker 回复（支持多次 reply），通过 AlemonJS Format 发送
 * 5. 接收 Worker API 请求，调用 AlemonJS 平台 API 实现双向通信
 */
import { EventsEnum, Format, logger, Next, sendToChannel, sendToUser, useClient, useGuild, useMe, useMember, useMessage, useRequest, useUser } from 'alemonjs';
import { manager } from './manager';
import type { IPCApiRequest, IPCDone, IPCMedia, IPCReply, ReplyContent } from './protocol';

/**
 * 尝试获取 OneBot 平台的原生 API 客户端
 * 仅在 @alemonjs/onebot 已安装且当前事件来自 OneBot 平台时可用
 */
let _oneBotAPI: any = null;

function isOneBotPlatform(platform?: string): boolean {
  return platform === 'onebot';
}

async function loadOneBotClient(): Promise<void> {
  if (_oneBotAPI !== null) {
    return;
  }

  try {
    const { API } = await import('@alemonjs/onebot');

    _oneBotAPI = API;
    logger.info('[bridge] @alemonjs/onebot API 已加载');
  } catch {
    _oneBotAPI = false; // 标记为不可用，避免重复尝试
    logger.debug('[bridge] @alemonjs/onebot 不可用，OneBot 特有 API 将降级处理');
  }
}

/**
 * 通过 OneBot API 客户端执行原生调用
 * 仅 OneBot 平台可用，其他平台返回 null
 */
function getOneBotClient(event: EventsEnum): any {
  if (!isOneBotPlatform(event.Platform)) {
    return null;
  }

  if (!_oneBotAPI || _oneBotAPI === false) {
    return null;
  }

  try {
    const [client] = useClient(event, _oneBotAPI);

    return client;
  } catch {
    return null;
  }
}

/**
 * 待回复的消息上下文
 *
 * 滑动窗口模式：每次收到 reply 重置超时计时器
 * 支持 Yunzai 插件多次调用 e.reply() 的场景
 */
const pending = new Map<
  string,
  {
    message: ReturnType<typeof useMessage>[0];
    timer: ReturnType<typeof setTimeout>;
    maxTimer: ReturnType<typeof setTimeout>;
  }
>();

/** 滑动窗口超时：最后一次 reply 后 8s 清理 */
const REPLY_IDLE_TIMEOUT = 8_000;
/** deal() 完成后的延长超时：插件可能通过定时器/上下文继续 reply（如扫码登录） */
const POST_DONE_TIMEOUT = 5 * 60_000;
/** 绝对超时：消息发出后 8 分钟必须清理，防泄漏 */
const REPLY_MAX_TIMEOUT = 8 * 60_000;

let idCounter = 0;
let listenerBound = false;
let doneListenerBound = false;
let exitListenerBound = false;

/** 绑定 Worker 回复监听（仅一次） */
function bindReplyListener(): void {
  if (listenerBound) {
    return;
  }
  listenerBound = true;

  manager.onReply((reply: IPCReply) => {
    logger.info(`[bridge] 收到 reply id=${reply.id} replyId=${reply.replyId} contents=${reply.contents.length}`);
    let ctx = pending.get(reply.id);

    // pending 已被清理但 msgEvents 仍存在 → 重建发送上下文（支持长时间异步插件如扫码登录）
    if (!ctx) {
      const event = msgEvents.get(reply.id);

      if (event) {
        const [message] = useMessage(event);

        ctx = {
          message,
          timer: setTimeout(() => cleanPending(reply.id), POST_DONE_TIMEOUT),
          maxTimer: setTimeout(() => cleanPending(reply.id), REPLY_MAX_TIMEOUT)
        };
        pending.set(reply.id, ctx);
        logger.info(`[bridge] 从 msgEvents 重建 pending id=${reply.id}`);
      } else {
        // pending 和 msgEvents 均已过期 → 降级使用 sendToChannel / sendToUser
        if (reply.channelId || reply.userId) {
          logger.info(`[bridge] pending/msgEvents 均过期，降级直发 id=${reply.id} private=${reply.isPrivate}`);
          const format = contentsToFormat(reply.contents);
          const targetChannel = reply.channelId ?? '';
          const targetUser = reply.userId ?? '';
          const sendFn = reply.isPrivate ? () => sendToUser(targetUser, format.value) : () => sendToChannel(targetChannel, format.value);

          void sendFn()
            .then((res: any) => {
              manager.sendToWorker({
                type: 'reply_result',
                replyId: reply.replyId,
                messageId: res?.MessageId ?? res?.message_id ?? undefined,
                ok: true
              });
            })
            .catch(() => {
              manager.sendToWorker({
                type: 'reply_result',
                replyId: reply.replyId,
                ok: false
              });
            });
        } else {
          logger.warn(`[bridge] pending/msgEvents 均未找到且无路由信息 id=${reply.id}`);
          manager.sendToWorker({
            type: 'reply_result',
            replyId: reply.replyId,
            ok: false
          });
        }

        return;
      }
    }

    // 重置滑动窗口计时器（支持多次 reply）
    clearTimeout(ctx.timer);
    ctx.timer = setTimeout(() => cleanPending(reply.id), REPLY_IDLE_TIMEOUT);

    const format = contentsToFormat(reply.contents);

    // 发送消息并将真实 message_id 回传给 Worker（用于撤回等操作）
    void ctx.message
      .send({ format })
      .then((res: any) => {
        manager.sendToWorker({
          type: 'reply_result',
          replyId: reply.replyId,
          messageId: res?.MessageId ?? res?.message_id ?? undefined,
          ok: true
        });
      })
      .catch(() => {
        manager.sendToWorker({
          type: 'reply_result',
          replyId: reply.replyId,
          ok: false
        });
      });
  });
}

/** 清理 pending 条目及其所有定时器 */
function cleanPending(id: string): void {
  const ctx = pending.get(id);

  if (!ctx) {
    return;
  }
  clearTimeout(ctx.timer);
  clearTimeout(ctx.maxTimer);
  pending.delete(id);
}

/** 清理 msgEvents 条目 */
function cleanMsgEvent(id: string): void {
  msgEvents.delete(id);
}

/** 清理 pending + msgEvents */
function cleanAll(id: string): void {
  cleanPending(id);
  cleanMsgEvent(id);
}

/** 绑定 Worker done 监听（仅一次） */
function bindDoneListener(): void {
  if (doneListenerBound) {
    return;
  }
  doneListenerBound = true;

  manager.onDone((done: IPCDone) => {
    const ctx = pending.get(done.id);

    if (!ctx) {
      return;
    }

    if (!done.replied) {
      // 无插件匹配 → 立即清理，不再等超时
      cleanAll(done.id);
    } else {
      // 有 reply 的情况：deal() 已返回但插件可能通过定时器继续 reply
      // （如扫码登录：deal()返回 → 等用户扫码 → 20s后继续 reply）
      // 将 idle 超时从 8s 延长到 60s，给异步插件足够时间
      clearTimeout(ctx.timer);
      ctx.timer = setTimeout(() => cleanPending(done.id), POST_DONE_TIMEOUT);
    }
  });
}

/** 绑定 Worker 退出监听 — 批量清理所有 pending 和 msgEvents，防泄漏（仅一次） */
function bindExitListener(): void {
  if (exitListenerBound) {
    return;
  }
  exitListenerBound = true;

  manager.onWorkerExit(() => {
    // Worker 崩溃/退出 → 所有未完成的 pending 不可能再收到 reply/done
    for (const id of pending.keys()) {
      cleanPending(id);
    }
    // 同时清理所有 msgEvents
    msgEvents.clear();
    logger.debug('[bridge] Worker 退出，已清理 pending 和 msgEvents');
  });
}

// ━━━━━━━━━━━ ReplyContent → Format 转换 ━━━━━━━━━━━

/** 将 Worker 的 ReplyContent[] 转为 AlemonJS Format */
function contentsToFormat(contents: ReplyContent[]): InstanceType<typeof Format> {
  const format = Format.create();

  for (const c of contents) {
    switch (c.type) {
      case 'text':
        format.addText(c.data);
        break;
      case 'image':
        if (c.data.startsWith('http') || c.data.startsWith('/')) {
          format.addImage(c.data);
        } else {
          format.addImage(`base64://${c.data}`);
        }
        break;
      case 'at':
        format.addMention(c.data);
        break;
      case 'face':
        format.addText(`[表情${c.data}]`);
        break;
      case 'record':
        // 语音：URL 或 base64
        if (c.data.startsWith('http') || c.data.startsWith('/')) {
          format.addText(`[语音:${c.data}]`);
        } else {
          format.addText('[语音]');
        }
        break;
      case 'video':
        if (c.data.startsWith('http') || c.data.startsWith('/')) {
          format.addText(`[视频:${c.data}]`);
        } else {
          format.addText('[视频]');
        }
        break;
      case 'forward':
        // 转发消息降级：展示为文本（真实转发卡片在多数平台不支持）
        format.addText(c.data || '[转发消息]');
        break;
      default:
        format.addText(c.data);
    }
  }

  return format;
}

// ━━━━━━━━━━━ 平台事件存储 & API 请求处理 ━━━━━━━━━━━

/**
 * 按消息 ID 精确关联的事件引用（处理中的消息）
 * Worker 发起 API 请求时携带 msgId，优先从此 Map 查找
 */
const msgEvents = new Map<string, EventsEnum>();

/**
 * 每个平台最近的 AlemonJS 事件引用（fallback）
 * 仅在 msgId 查找失败时（如定时任务触发）使用
 * 带 TTL：超过 10 分钟未更新的平台事件视为过期，避免引用已断开连接的平台
 */
const LATEST_EVENT_TTL = 10 * 60_000; // 10 分钟
const latestEvents = new Map<string, { event: EventsEnum; time: number }>();

let apiListenerBound = false;

/** 绑定 Worker API 请求监听（仅一次） */
function bindApiRequestListener(): void {
  if (apiListenerBound) {
    return;
  }
  apiListenerBound = true;

  // 预加载 OneBot 客户端（非阻塞）
  void loadOneBotClient();

  manager.onApiRequest((req: IPCApiRequest) => {
    void handleApiRequest(req, req.msgId);
  });
}

/**
 * 处理来自 Worker 的 API 请求
 *
 * 利用 AlemonJS 标准 hooks 实现跨平台兼容：
 * - OneBot 平台：通过 AlemonJS → OneBot 适配器 → icqq 完整 API
 * - 其他平台：通过 AlemonJS 标准化接口降级适配
 */
async function handleApiRequest(req: IPCApiRequest, msgId?: string): Promise<void> {
  const { reqId, action, params } = req;

  try {
    const result = await dispatchApi(action, params, msgId);

    manager.sendToWorker({ type: 'api_response', reqId, ok: true, data: result });
  } catch (err: any) {
    manager.sendToWorker({ type: 'api_response', reqId, ok: false, error: err?.message ?? 'Unknown error' });
  }
}

/**
 * API 分发器 — 将 Yunzai/icqq 风格的 API 调用映射到 AlemonJS 标准 hooks
 *
 * 优先使用 sendToChannel / sendToUser（无需事件上下文）
 * 成员操作等需要事件上下文的，从 latestEvents 获取
 */
async function dispatchApi(action: string, params: Record<string, any>, msgId?: string): Promise<any> {
  // 覆盖 getEventForApi，优先使用 msgId 精确关联的事件
  const getEvent = (platform?: string) => getEventForApi(platform, msgId);

  switch (action) {
    // ─── 消息发送（不需要事件上下文） ───

    case 'sendGroupMsg': {
      const format = contentsToFormat(params.contents ?? []);

      return await sendToChannel(String(params.group_id), format.value);
    }

    case 'sendPrivateMsg': {
      const format = contentsToFormat(params.contents ?? []);

      return await sendToUser(String(params.user_id), format.value);
    }

    // ─── 消息操作（需要事件上下文） ───

    case 'deleteMsg': {
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error('无可用事件上下文');
      }
      const [message] = useMessage(event);

      return await message.delete({ messageId: String(params.message_id) });
    }

    // ─── 群成员操作 ───

    case 'getGroupMemberList': {
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error('无可用事件上下文');
      }
      const [member] = useMember(event);

      return await member.list({ guildId: String(params.group_id) });
    }

    case 'getGroupMemberInfo': {
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error('无可用事件上下文');
      }
      const [member] = useMember(event);

      return await member.info({ userId: String(params.user_id), guildId: String(params.group_id) });
    }

    case 'setGroupKick': {
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error('无可用事件上下文');
      }
      const [member] = useMember(event);

      return await member.kick({ userId: String(params.user_id), guildId: String(params.group_id) });
    }

    case 'setGroupBan': {
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error('无可用事件上下文');
      }
      const [member] = useMember(event);

      return await member.mute({ userId: String(params.user_id), guildId: String(params.group_id), duration: params.duration ?? 0 });
    }

    case 'setGroupCard': {
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error('无可用事件上下文');
      }
      const [member] = useMember(event);

      return await member.card({ userId: String(params.user_id), guildId: String(params.group_id), card: params.card ?? '' });
    }

    case 'setGroupAdmin': {
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error('无可用事件上下文');
      }
      const [member] = useMember(event);

      return await member.admin({ userId: String(params.user_id), guildId: String(params.group_id), enable: params.enable ?? true });
    }

    case 'setGroupSpecialTitle': {
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error('无可用事件上下文');
      }
      const [member] = useMember(event);

      return await member.title({ userId: String(params.user_id), guildId: String(params.group_id), title: params.special_title ?? '' });
    }

    // ─── 群操作 ───

    case 'getGroupInfo': {
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error('无可用事件上下文');
      }
      const [guild] = useGuild(event);

      return await guild.info({ guildId: String(params.group_id) });
    }

    case 'getGroupList': {
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error('无可用事件上下文');
      }
      const [guild] = useGuild(event);

      return await guild.list();
    }

    case 'setGroupLeave': {
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error('无可用事件上下文');
      }
      const [guild] = useGuild(event);

      return await guild.leave({ guildId: String(params.group_id) });
    }

    case 'setGroupName': {
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error('无可用事件上下文');
      }
      const [guild] = useGuild(event);

      return await guild.update({ guildId: String(params.group_id), name: params.group_name ?? '' });
    }

    case 'setGroupWholeBan': {
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error('无可用事件上下文');
      }
      const [guild] = useGuild(event);

      return await guild.mute({ guildId: String(params.group_id), enable: params.enable ?? true });
    }

    // ─── Bot 信息 ───

    case 'getLoginInfo': {
      const [me] = useMe();

      return await me.info();
    }

    case 'getFriendList': {
      const [me] = useMe();

      return await me.friends();
    }

    case 'getStrangerInfo': {
      const [user] = useUser();

      return await user.info({ userId: String(params.user_id) });
    }

    // ─── 请求处理（好友申请 / 入群请求） ───

    case 'setFriendAddRequest': {
      const [request] = useRequest();

      return await request.friend({
        flag: String(params.flag),
        approve: params.approve ?? true,
        remark: params.remark ?? ''
      });
    }

    case 'setGroupAddRequest': {
      const [request] = useRequest();

      return await request.guild({
        flag: String(params.flag),
        subType: params.type ?? 'add',
        approve: params.approve ?? true,
        reason: params.reason ?? ''
      });
    }

    // ─── OneBot 特有 API（需要原生 WebSocket 客户端） ───

    case 'sendLike': {
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error('无可用事件上下文');
      }
      const client = getOneBotClient(event);

      if (!client) {
        throw new Error('sendLike 仅 OneBot 平台可用');
      }

      return await client.sendLike({ user_id: Number(params.user_id), times: params.times ?? 10 });
    }

    case 'pokeMember': {
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error('无可用事件上下文');
      }
      const client = getOneBotClient(event);

      if (!client) {
        throw new Error('pokeMember 仅 OneBot 平台可用');
      }

      return await client.send({
        action: 'group_poke',
        params: { group_id: Number(params.group_id), user_id: Number(params.user_id) }
      });
    }

    case 'pokeFriend': {
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error('无可用事件上下文');
      }
      const client = getOneBotClient(event);

      if (!client) {
        throw new Error('pokeFriend 仅 OneBot 平台可用');
      }

      return await client.send({
        action: 'friend_poke',
        params: { user_id: Number(params.user_id) }
      });
    }

    case 'getCookies': {
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error('无可用事件上下文');
      }
      const client = getOneBotClient(event);

      if (!client) {
        throw new Error('getCookies 仅 OneBot 平台可用');
      }

      return await client.getCookies();
    }

    case 'getCsrfToken': {
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error('无可用事件上下文');
      }
      const client = getOneBotClient(event);

      if (!client) {
        throw new Error('getCsrfToken 仅 OneBot 平台可用');
      }

      return await client.getCsrfToken();
    }

    case 'getMsg': {
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error('无可用事件上下文');
      }
      const client = getOneBotClient(event);

      if (!client) {
        throw new Error('getMsg 仅 OneBot 平台可用');
      }

      return await client.getMsg({ message_id: Number(params.message_id) });
    }

    case 'getForwardMsg': {
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error('无可用事件上下文');
      }
      const client = getOneBotClient(event);

      if (!client) {
        throw new Error('getForwardMsg 仅 OneBot 平台可用');
      }

      return await client.getForwardMsg({ id: String(params.id) });
    }

    case 'getChatHistory': {
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error('无可用事件上下文');
      }
      const client = getOneBotClient(event);

      if (!client) {
        return { messages: [] }; // 非 OneBot 平台降级为空
      }

      // Napcat / go-cqhttp 扩展 API: get_group_msg_history / get_friend_msg_history
      if (params.group_id) {
        return await client.send({
          action: 'get_group_msg_history',
          params: { group_id: Number(params.group_id), message_seq: Number(params.message_seq), count: params.count ?? 1 }
        });
      }

      return await client.send({
        action: 'get_friend_msg_history',
        params: { user_id: Number(params.user_id), message_seq: Number(params.message_seq), count: params.count ?? 1 }
      });
    }

    case 'getGroupFileUrl': {
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error('无可用事件上下文');
      }
      const client = getOneBotClient(event);

      if (!client) {
        return { url: '' };
      }

      return await client.send({
        action: 'get_group_file_url',
        params: { group_id: Number(params.group_id), file_id: String(params.file_id) }
      });
    }

    case 'getPrivateFileUrl': {
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error('无可用事件上下文');
      }
      const client = getOneBotClient(event);

      if (!client) {
        return { url: '' };
      }

      return await client.send({
        action: 'get_private_file_url',
        params: { user_id: Number(params.user_id), file_id: String(params.file_id) }
      });
    }

    default: {
      // ── 通用 OneBot API 透传 ──
      // 所有未显式处理的 API 直接转发给 OneBot 客户端
      // 覆盖 set_group_essence_msg / ocr_image / upload_group_file 等全部扩展 API
      const event = getEvent(params.platform);

      if (!event) {
        throw new Error(`无可用事件上下文: ${action}`);
      }
      const client = getOneBotClient(event);

      if (!client) {
        throw new Error(`${action} 仅 OneBot 平台可用`);
      }

      // 移除内部使用的 platform 字段，避免传给 OneBot
      const { platform: _p, ...apiParams } = params;

      return await client.send({ action, params: apiParams });
    }
  }
}

/** 获取指定平台的事件上下文，优先按 msgId 精确匹配 */
function getEventForApi(platform?: string, msgId?: string): EventsEnum | undefined {
  // 优先按 msgId 精确查找（避免同平台并发消息上下文错乱）
  if (msgId && msgEvents.has(msgId)) {
    return msgEvents.get(msgId);
  }

  const now = Date.now();

  // fallback: 按平台取最新事件（定时任务等无 msgId 场景）
  if (platform && latestEvents.has(platform)) {
    const entry = latestEvents.get(platform)!;

    if (now - entry.time < LATEST_EVENT_TTL) {
      return entry.event;
    }
    // 超过 TTL → 移除过期条目
    latestEvents.delete(platform);
  }
  // 兆底: 取任意一个未过期的可用事件
  for (const [key, entry] of latestEvents) {
    if (now - entry.time < LATEST_EVENT_TTL) {
      return entry.event;
    }
    latestEvents.delete(key);
  }

  return undefined;
}

/** 从 AlemonJS 事件中提取跨平台媒体附件 */
function extractMedia(event: any): IPCMedia[] {
  const items: IPCMedia[] = [];

  if (!Array.isArray(event.MessageMedia)) {
    return items;
  }
  for (const m of event.MessageMedia) {
    items.push({
      type: m.Type === 'sticker' || m.Type === 'animation' ? 'sticker' : (m.Type ?? 'file'),
      url: m.Url ?? undefined,
      fileId: m.FileId ?? undefined,
      fileName: m.FileName ?? undefined
    });
  }

  return items;
}

/**
 * 安全提取原始 OneBot 事件
 * 仅当 value 包含 post_type 字段时才认定为 OneBot 事件
 */
function extractRawEvent(event: any, rawE: any): any {
  if (!isOneBotPlatform(event?.Platform ?? rawE?.Platform)) {
    return undefined;
  }

  try {
    const v = event.value ?? rawE?.value;

    if (v && typeof v === 'object' && v.post_type) {
      return JSON.parse(JSON.stringify(v));
    }
  } catch {
    // 序列化失败 → 降级为无 rawEvent
  }

  return undefined;
}

/**
 * 从 AlemonJS 事件中提取 @提及的用户列表
 * 用于跨平台（无 rawEvent）时在 Worker 侧构建 at 消息段
 * 优先从 value.message（OneBot 消息段）中提取
 */
function extractAtUsers(event: any): { userId: string; userName?: string }[] {
  const users: { userId: string; userName?: string }[] = [];

  try {
    const v = event.value;

    if (v && Array.isArray(v.message)) {
      for (const seg of v.message) {
        if (seg?.type === 'at') {
          const qq = seg.data?.qq ?? seg.qq;

          if (qq !== null && qq !== undefined && qq !== 'all') {
            users.push({ userId: String(qq), userName: seg.data?.text ?? seg.text ?? '' });
          }
        }
      }
    }
  } catch {
    // 提取失败时静默忽略
  }

  return users;
}

export default (e: EventsEnum, next: Next) => {
  if (!manager.isReady) {
    next();

    return;
  }

  const eventName: string = e.name ?? '';

  if (!eventName) {
    next();

    return;
  }

  bindReplyListener();
  bindDoneListener();
  bindApiRequestListener();
  bindExitListener();

  // 存储最新事件（供 Worker API 调用时使用，带时间戳用于 TTL 过期）
  if (e.Platform) {
    latestEvents.set(e.Platform, { event: e, time: Date.now() });
  }

  const id = `msg_${++idCounter}_${Date.now()}`;

  // 按 msgId 精确存储事件引用（解决同平台并发消息上下文错乱）
  msgEvents.set(id, e);
  // msgEvents 独立于 pending 生命周期，用 REPLY_MAX_TIMEOUT 确保不泄漏
  setTimeout(() => cleanMsgEvent(id), REPLY_MAX_TIMEOUT);

  // 为所有事件设置回复上下文
  // useMessage 内部仅检查 event 是对象，平台适配器决定能否实际发送
  const [message] = useMessage(e);

  pending.set(id, {
    message,
    timer: setTimeout(() => cleanPending(id), REPLY_IDLE_TIMEOUT),
    maxTimer: setTimeout(() => cleanPending(id), REPLY_MAX_TIMEOUT)
  });

  // 转发给 Worker — 提取所有 AlemonJS 标准字段
  const _atUsers = extractAtUsers(e);
  const _rawEvent = extractRawEvent(e, e);

  manager.send({
    type: 'event',
    id,
    data: {
      eventName,
      platform: e.Platform ?? '',
      botId: e.BotId ?? '',
      messageText: e.MessageText ?? '',
      messageId: e.MessageId ?? '',
      media: extractMedia(e),
      userId: e.UserId ?? '',
      userName: e.UserName ?? '',
      userAvatar: e.UserAvatar ?? '',
      spaceId: e.GuildId ?? e.ChannelId ?? '',
      isPrivate: !e.GuildId,
      isMaster: e.IsMaster ?? false,
      IsMaster: e.IsMaster ?? false,
      atUsers: _atUsers,
      rawEvent: _rawEvent
    }
  });
};
