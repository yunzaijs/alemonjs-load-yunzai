import fs__default from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isOneBotPlatform, createOneBotRuntime } from './adapters/onebot-icqq.js';

function ipcSend(msg) {
    process.send?.(msg);
}
function log(level, ...args) {
    ipcSend({ type: 'log', level, args });
}
const apiPending = new Map();
let apiIdCounter = 0;
let currentPlatform = '';
let currentMsgId = '';
let defaultPlatform = '';
const replyPending = new Map();
let replyIdCounter = 0;
function handleReplyResult(msg) {
    const p = replyPending.get(msg.replyId);
    if (!p) {
        return;
    }
    replyPending.delete(msg.replyId);
    p.resolve({ message_id: msg.messageId ?? `reply_${Date.now()}` });
}
function callApi(action, params = {}, timeout = 15_000) {
    return new Promise((resolve, reject) => {
        const reqId = `api_${++apiIdCounter}_${Date.now()}`;
        if (!params.platform && (currentPlatform || defaultPlatform)) {
            params.platform = currentPlatform || defaultPlatform;
        }
        const timer = setTimeout(() => {
            apiPending.delete(reqId);
            reject(new Error(`API 调用超时: ${action}`));
        }, timeout);
        apiPending.set(reqId, {
            resolve: (data) => {
                clearTimeout(timer);
                apiPending.delete(reqId);
                resolve(data);
            },
            reject: (err) => {
                clearTimeout(timer);
                apiPending.delete(reqId);
                reject(err);
            }
        });
        ipcSend({ type: 'api', reqId, action, params, msgId: currentMsgId || undefined });
    });
}
function handleApiResponse(msg) {
    const pending = apiPending.get(msg.reqId);
    if (!pending) {
        return;
    }
    if (msg.ok) {
        pending.resolve(msg.data);
    }
    else {
        pending.reject(new Error(msg.error ?? 'API 调用失败'));
    }
}
class CompatUinList extends Array {
    constructor(initialUin = 10000) {
        super();
        this.setPrimary(initialUin);
    }
    setPrimary(next) {
        const normalized = safeInt(next, 10000);
        this.length = 0;
        this.push(normalized);
    }
    get primary() {
        return this[0] ?? 10000;
    }
    toString() {
        return String(this.primary);
    }
    valueOf() {
        return this.primary;
    }
    [Symbol.toPrimitive](hint) {
        return hint === 'number' ? this.primary : String(this.primary);
    }
}
function createIdentityLogger(identity, appendLog) {
    const levelMethods = {
        info: (...a) => appendLog('info', ...a),
        warn: (...a) => appendLog('warn', ...a),
        error: (...a) => appendLog('error', ...a),
        debug: (...a) => appendLog('debug', ...a),
        mark: (...a) => appendLog('info', '[MARK]', ...a),
        trace: (...a) => appendLog('debug', '[TRACE]', ...a),
        fatal: (...a) => appendLog('error', '[FATAL]', ...a)
    };
    const chalkProxy = new Proxy({}, {
        get(_target, prop) {
            if (typeof prop === 'string') {
                return identity;
            }
            return undefined;
        }
    });
    return new Proxy({
        ...levelMethods,
        chalk: chalkProxy
    }, {
        get(target, prop, receiver) {
            if (typeof prop === 'string' && !(prop in target)) {
                return identity;
            }
            return Reflect.get(target, prop, receiver);
        }
    });
}
const compatProxyCache = new WeakMap();
const compatWarnedKeys = new Set();
function warnCompatMissing(kind, label) {
    const key = `${kind}:${label}`;
    if (compatWarnedKeys.has(key)) {
        return;
    }
    compatWarnedKeys.add(key);
    log('warn', `[compat] 缺失${kind === 'get' ? '属性' : kind === 'call' ? '方法' : '构造器'}: ${label}`);
}
function createNoopCompatProxy(label) {
    const emptyArrayMethods = {
        filter: (_fn) => [],
        map: (_fn) => [],
        flatMap: (_fn) => [],
        slice: (..._args) => [],
        concat: (...args) => (args.flat ? [].concat(...args) : []),
        includes: (_value) => false,
        indexOf: (_value) => -1,
        find: (_fn) => undefined,
        some: (_fn) => false,
        every: (_fn) => true,
        forEach: (_fn) => undefined,
        reduce: (_fn, initial) => initial,
        join: (sep = ',') => ['', ''].join(sep).slice(0, 0),
        at: (_index) => undefined,
        values: function* values() { },
        entries: function* entries() { },
        keys: function* keys() { },
        [Symbol.iterator]: function* iterator() { }
    };
    const fn = (() => undefined);
    return new Proxy(fn, {
        get(_target, prop) {
            if (prop === 'then') {
                return undefined;
            }
            if (prop === Symbol.toPrimitive) {
                return (hint) => (hint === 'number' ? 0 : '');
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
                return emptyArrayMethods[prop];
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
function wrapCompatValue(value, label) {
    if (value === null || value === undefined) {
        return createNoopCompatProxy(label);
    }
    const valueType = typeof value;
    if (valueType !== 'object' && valueType !== 'function') {
        return value;
    }
    const objectValue = value;
    if (compatProxyCache.has(objectValue)) {
        return compatProxyCache.get(objectValue);
    }
    const proxy = new Proxy(value, {
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
function injectGlobals() {
    const g = globalThis;
    const identity = (s) => String(s);
    const appendLog = (level, ...args) => {
        log(level, ...args.map(String));
        try {
            const cwd = process.cwd();
            const today = new Date().toISOString().slice(0, 10);
            const logFile = path.join(cwd, 'logs', `command.${today}.log`);
            const time = new Date().toTimeString().slice(0, 8);
            const line = `[${time}][${level.toUpperCase().padStart(4)}] ${args.map(String).join(' ')}\n`;
            fs__default.appendFileSync(logFile, line);
        }
        catch {
        }
    };
    g.logger = createIdentityLogger(identity, appendLog);
    const uinList = new CompatUinList(10000);
    const botInstance = {
        nickname: 'Yunzai',
        logger: g.logger,
        tiny_id: '',
        avatar: '',
        fl: new Map(),
        gl: new Map(),
        gml: new Map(),
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
        pickFriend: (uid) => makeFriendProxy(uid, ''),
        pickGroup: (gid) => makeGroupProxy(gid),
        pickUser: (uid) => makeFriendProxy(uid, ''),
        pickMember: (gid, uid) => makeGroupProxy(gid).pickMember(uid),
        sendGroupMsg: async (gid, msg) => {
            const contents = await serializeReply(msg);
            return callApi('sendGroupMsg', { group_id: gid, contents }).catch(() => ({}));
        },
        sendPrivateMsg: async (uid, msg) => {
            const contents = await serializeReply(msg);
            return callApi('sendPrivateMsg', { user_id: uid, contents }).catch(() => ({}));
        },
        getGroupList: () => callApi('getGroupList')
            .then((res) => {
            if (res?.data && Array.isArray(res.data)) {
                botInstance.gl.clear();
                for (const g of res.data) {
                    botInstance.gl.set(g.group_id, g);
                }
            }
            return botInstance.gl;
        })
            .catch(() => botInstance.gl),
        getFriendList: () => callApi('getFriendList')
            .then((res) => {
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
        getStrangerInfo: (uid) => callApi('getStrangerInfo', { user_id: uid }).catch(() => ({})),
        getLoginInfo: () => callApi('getLoginInfo')
            .then((res) => {
            if (res?.data) {
                botInstance.uin = res.data.UserId ?? res.data.user_id ?? botInstance.uin;
                botInstance.nickname = res.data.UserName ?? res.data.nickname ?? botInstance.nickname;
            }
            return { user_id: botInstance.uin, nickname: botInstance.nickname };
        })
            .catch(() => ({ user_id: botInstance.uin, nickname: botInstance.nickname })),
        getGroupMemberList: (gid) => callApi('getGroupMemberList', { group_id: gid })
            .then((res) => {
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
        getGroupMemberInfo: (gid, uid) => callApi('getGroupMemberInfo', { group_id: gid, user_id: uid }).catch(() => ({})),
        getForwardMsg: (resId) => callApi('getForwardMsg', { id: resId }).catch(() => ({ message: [] })),
        getCookies: (domain) => callApi('getCookies', { domain: domain ?? '' }).catch(() => ({ cookies: '' })),
        getCsrfToken: () => callApi('getCsrfToken').catch(() => ({ token: 0 })),
        sendLike: (uid, times = 10) => callApi('sendLike', { user_id: uid, times }).catch(() => false),
        getStrangerList: () => callApi('get_stranger_list').catch(() => []),
        reloadFriendList: () => botInstance.getFriendList(),
        reloadGroupList: () => botInstance.getGroupList(),
        reloadBlackList: () => callApi('get_blacklist').catch(() => []),
        setOnlineStatus: (status) => callApi('set_online_status', { status }).catch(() => false),
        setNickname: (nickname) => callApi('set_qq_profile', { nickname }).catch(() => false),
        setGender: (gender) => callApi('set_qq_profile', { gender }).catch(() => false),
        setBirthday: (birthday) => callApi('set_qq_profile', { birthday }).catch(() => false),
        setDescription: (description) => callApi('set_qq_profile', { description }).catch(() => false),
        setSignature: (signature) => callApi('set_qq_profile', { signature }).catch(() => false),
        setAvatar: (file) => callApi('set_qq_avatar', { file: String(file) }).catch(() => false),
        getSignature: () => callApi('get_qq_profile')
            .then((r) => r?.data?.signature ?? '')
            .catch(() => ''),
        imageOcr: (image) => callApi('ocr_image', { image }).catch(() => ({ texts: [], language: '' })),
        getVideoUrl: (fid, md5) => callApi('.get_video_url', { fid, md5 }).catch(() => ''),
        getSystemMsg: () => callApi('get_group_system_msg').catch(() => ({ InvitedRequests: [], join_requests: [] })),
        setEssenceMessage: (messageId) => callApi('set_essence_msg', { message_id: messageId }).catch(() => false),
        removeEssenceMessage: (messageId) => callApi('delete_essence_msg', { message_id: messageId }).catch(() => false),
        getRoamingStamp: () => callApi('.get_roaming_stamp').catch(() => []),
        deleteStamp: (id) => callApi('.delete_stamp', { id }).catch(() => false),
        cleanCache: () => callApi('clean_cache').catch(() => false),
        addClass: (name) => callApi('.add_class', { name }).catch(() => false),
        deleteClass: (id) => callApi('.delete_class', { id }).catch(() => false),
        renameClass: (id, name) => callApi('.rename_class', { id, name }).catch(() => false),
        makeForwardMsg: (msgs) => buildForwardMsgCompat(msgs),
        _events: new Map(),
        on(event, fn) {
            const list = botInstance._events.get(event) ?? [];
            list.push(fn);
            botInstance._events.set(event, list);
            return botInstance;
        },
        addListener(event, fn) {
            return botInstance.on(event, fn);
        },
        prependListener(event, fn) {
            const list = botInstance._events.get(event) ?? [];
            list.unshift(fn);
            botInstance._events.set(event, list);
            return botInstance;
        },
        once(event, fn) {
            const wrapper = (...args) => {
                botInstance.off(event, wrapper);
                fn(...args);
            };
            return botInstance.on(event, wrapper);
        },
        prependOnceListener(event, fn) {
            const wrapper = (...args) => {
                botInstance.off(event, wrapper);
                fn(...args);
            };
            return botInstance.prependListener(event, wrapper);
        },
        off(event, fn) {
            const list = botInstance._events.get(event);
            if (list) {
                botInstance._events.set(event, list.filter((f) => f !== fn));
            }
            return botInstance;
        },
        removeListener(event, fn) {
            return botInstance.off(event, fn);
        },
        emit(event, ...args) {
            const list = botInstance._events.get(event);
            if (list) {
                for (const fn of [...list]) {
                    try {
                        fn(...args);
                    }
                    catch {
                    }
                }
            }
            return !!list?.length;
        },
        removeAllListeners(event) {
            if (event) {
                botInstance._events.delete(event);
            }
            else {
                botInstance._events.clear();
            }
            return botInstance;
        },
        listenerCount(event) {
            return botInstance._events.get(event)?.length ?? 0;
        },
        listeners(event) {
            return [...(botInstance._events.get(event) ?? [])];
        },
        rawListeners(event) {
            return [...(botInstance._events.get(event) ?? [])];
        },
        eventNames() {
            return [...botInstance._events.keys()];
        },
        setMaxListeners(_n) {
            return botInstance;
        },
        getMaxListeners() {
            return Infinity;
        },
        config: {
            platform: 1,
            log_level: 'info',
            data_dir: path.join(process.cwd(), 'data')
        },
        status: 11
    };
    Object.assign(botInstance, oneBotRuntime.createOneBotBotAdapter(botInstance));
    Object.defineProperty(botInstance, 'uin', {
        get() {
            return uinList;
        },
        set(value) {
            if (Array.isArray(value) && value.length > 0) {
                uinList.setPrimary(value[0]);
                return;
            }
            uinList.setPrimary(value);
        },
        enumerable: true,
        configurable: true
    });
    g.Bot = wrapCompatValue(new Proxy(botInstance, {
        get(target, prop) {
            if (typeof prop === 'string' && /^\d+$/.test(prop)) {
                return target;
            }
            return target[prop];
        },
        has(target, prop) {
            if (typeof prop === 'string' && /^\d+$/.test(prop)) {
                return true;
            }
            return prop in target;
        }
    }), 'Bot');
    g.segment = {
        image: (file) => ({ type: 'image', file }),
        at: (qq, text) => ({ type: 'at', qq, text: text ?? '' }),
        face: (id) => ({ type: 'face', id }),
        text: (text) => ({ type: 'text', text }),
        record: (file) => ({ type: 'record', file }),
        video: (file) => ({ type: 'video', file }),
        json: (data) => ({ type: 'json', data: typeof data === 'string' ? data : JSON.stringify(data) }),
        xml: (data) => ({ type: 'xml', data }),
        poke: (id) => ({ type: 'poke', id }),
        reply: (id) => ({ type: 'reply', id }),
        share: (url, title, content, image) => ({
            type: 'share',
            url,
            title: title ?? '',
            content: content ?? '',
            image: image ?? ''
        }),
        music: (type, id) => ({ type: 'music', data: { type, id } }),
        forward: (resId) => ({ type: 'forward', id: resId }),
        file: (file, name) => ({ type: 'file', file, name: name ?? '' }),
        location: (lat, lng, title, content) => ({
            type: 'location',
            data: { lat, lon: lng, title: title ?? '', content: content ?? '' }
        }),
        dice: (id) => ({ type: 'dice', id: id ?? 0 }),
        rps: (id) => ({ type: 'rps', id: id ?? 0 }),
        markdown: (content) => ({ type: 'markdown', data: { content } }),
        mirai: (data) => ({ type: 'mirai', data }),
        bface: (file, text) => ({ type: 'bface', file, text: text ?? '' }),
        sface: (id, text) => ({ type: 'sface', id, text: text ?? '' }),
        button: () => '',
        node: (user_id, nickname, content) => ({
            type: 'node',
            data: { user_id, nickname, content }
        })
    };
}
function buildForwardMsgParts(nodes) {
    if (!Array.isArray(nodes) || nodes.length === 0) {
        return [];
    }
    const parts = [];
    for (const node of nodes) {
        const msg = node.message ?? node;
        const nickname = node.nickname ?? '';
        if (nickname) {
            parts.push({ type: 'text', text: `【${nickname}】\n` });
        }
        if (typeof msg === 'string') {
            parts.push({ type: 'text', text: msg + '\n' });
        }
        else if (Array.isArray(msg)) {
            parts.push(...msg);
            parts.push({ type: 'text', text: '\n' });
        }
        else if (msg && typeof msg === 'object') {
            parts.push(msg);
            parts.push({ type: 'text', text: '\n' });
        }
    }
    return parts;
}
function buildForwardMsgCompat(nodes) {
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
async function serializeReply(msg) {
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
                let file;
                if (Buffer.isBuffer(msg.file)) {
                    file = msg.file.toString('base64');
                }
                else {
                    const filePath = String(msg.file);
                    if (filePath.startsWith('file://')) {
                        try {
                            const absPath = filePath.replace(/^file:\/\//, '');
                            const buf = await fs__default.promises.readFile(absPath);
                            file = buf.toString('base64');
                        }
                        catch {
                            file = filePath;
                        }
                    }
                    else if (filePath.startsWith('/') && !filePath.startsWith('http')) {
                        try {
                            const buf = await fs__default.promises.readFile(filePath);
                            file = buf.toString('base64');
                        }
                        catch {
                            file = filePath;
                        }
                    }
                    else {
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
                return [];
            default:
                return [{ type: 'other', data: JSON.stringify(msg) }];
        }
    }
    return [{ type: 'text', data: String(msg) }];
}
function detectAtMe(message, selfId) {
    return message.some((s) => s.type === 'at' && String(s.data?.qq ?? s.qq) === String(selfId));
}
function detectAtAll(message) {
    return message.some((s) => s.type === 'at' && (s.data?.qq === 'all' || s.qq === 'all'));
}
function extractFirstAtTarget(message, selfId) {
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
function mediaToSegments(media) {
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
function safeInt(v, fallback) {
    const n = parseInt(String(v));
    return Number.isFinite(n) ? n : fallback;
}
function makeGroupProxy(groupId, opts) {
    return oneBotRuntime.createOneBotGroupAdapter(groupId, opts);
}
function makeFriendProxy(userId, userName) {
    return oneBotRuntime.createOneBotFriendAdapter(userId, userName);
}
function isMessageEventName(name) {
    return name.includes('message.create') || name.includes('interaction');
}
const EVENT_NOTICE_MAP = {
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
const EVENT_REQUEST_MAP = {
    'private.friend.add': { request_type: 'friend', sub_type: 'add' },
    'private.guild.add': { request_type: 'group', sub_type: 'invite' }
};
function buildFallbackNonMessageEvent(data, selfId, platformTag, reply, eventName) {
    const userId = safeInt(data.userId, 10001);
    const groupId = data.isPrivate ? 0 : safeInt(data.spaceId, 0);
    const masterFlag = resolveMasterFlag(data);
    const e = {
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
    }
    else if (requestMap) {
        e.post_type = 'request';
        e.request_type = requestMap.request_type;
        e.sub_type = requestMap.sub_type;
        e.comment = '';
        e.flag = `${eventName}_${Date.now()}`;
        e.approve = (approve = true) => callApi(requestMap.request_type === 'friend' ? 'setFriendAddRequest' : 'setGroupAddRequest', { flag: e.flag, approve, type: requestMap.sub_type }).catch(() => false);
        e.reject = (reason = '') => callApi(requestMap.request_type === 'friend' ? 'setFriendAddRequest' : 'setGroupAddRequest', {
            flag: e.flag,
            approve: false,
            reason,
            type: requestMap.sub_type
        }).catch(() => false);
        e.logText = `${platformTag}[Request:${requestMap.request_type}:${userId}]`;
    }
    else {
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
    e.sender = {
        user_id: userId,
        nickname: data.userName ?? 'User',
        card: data.userName ?? '',
        role: 'member'
    };
    e.nickname = data.userName ?? 'User';
    return e;
}
function injectMasterQQ(userId) {
    const cfg = globalThis._yunzaiCfg;
    if (!cfg) {
        return;
    }
    try {
        const masterList = cfg.masterQQ ?? [];
        const uid = Number(userId) || String(userId);
        if (!masterList.includes(uid)) {
            masterList.push(uid);
        }
    }
    catch {
    }
}
function resolveMasterFlag(data) {
    return data.isMaster ?? data.IsMaster ?? false;
}
function buildEvent(data, msgId) {
    const raw = data.rawEvent;
    const masterFlag = resolveMasterFlag(data);
    const botUin = globalThis.Bot?.uin ?? 10000;
    const selfId = raw?.self_id !== null && raw?.self_id !== undefined ? safeInt(raw.self_id, botUin) : safeInt(data.botId, botUin);
    const platformTag = data.platform ? `[${data.platform}]` : '';
    if (selfId !== 10000 && botUin === 10000) {
        globalThis.Bot.uin = selfId;
    }
    if (masterFlag && data.userId) {
        injectMasterQQ(data.userId);
    }
    const reply = async (msg, _quote = false) => {
        const contents = await serializeReply(msg);
        const replyId = `r_${++replyIdCounter}_${Date.now()}`;
        if (globalThis.Bot?.stat) {
            globalThis.Bot.stat.sent_msg_cnt++;
        }
        log('debug', `[reply] id=${msgId} replyId=${replyId} contents=${JSON.stringify(contents).slice(0, 200)}`);
        const resultPromise = new Promise(resolve => {
            replyPending.set(replyId, { resolve });
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
    if (isOneBotPlatform(data.platform) && raw && typeof raw === 'object' && raw.post_type) {
        return oneBotRuntime.buildOneBotEvent({ data, msgId, selfId, reply });
    }
    const eventName = data.eventName ?? '';
    if (eventName && !isMessageEventName(eventName)) {
        return buildFallbackNonMessageEvent(data, selfId, platformTag, reply, eventName);
    }
    const isGroup = !data.isPrivate;
    const userId = safeInt(data.userId, 10001);
    const groupId = isGroup ? safeInt(data.spaceId, 10002) : 0;
    const messageParts = [];
    if (data.messageText) {
        messageParts.push({ type: 'text', text: data.messageText });
    }
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
    const e = {
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
        at: extractFirstAtTarget(messageParts, selfId) ?? undefined,
        reply,
        getMemberMap: () => (isGroup ? makeGroupProxy(groupId).getMemberMap() : new Map()),
        getAvatarUrl: (size = 0) => data.userAvatar || `https://q1.qlogo.cn/g?b=qq&s=${size}&nk=${userId}`,
        toString: () => data.messageText,
        ...(isGroup ? { group: makeGroupProxy(groupId), friend: undefined } : { group: undefined, friend: makeFriendProxy(userId, data.userName ?? 'User') }),
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
        makeForwardMsg: (nodes) => {
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
let PluginsLoader = null;
const BLOCKED_COMMANDS = /^#(重启|停机|关机|(强制)?更新|(静默)?全部(强制)?更新)$/;
function emitBotEvent(e) {
    const bot = globalThis.Bot;
    if (!bot?.emit) {
        return;
    }
    const postType = e.post_type;
    if (!postType) {
        return;
    }
    bot.emit(postType, e);
    let sub1 = '';
    if (postType === 'message') {
        sub1 = e.message_type ?? '';
    }
    else if (postType === 'notice') {
        sub1 = (e.notice_type ?? '').replace(/_/g, '.');
    }
    else if (postType === 'request') {
        sub1 = (e.request_type ?? '').replace(/_/g, '.');
    }
    if (sub1) {
        bot.emit(`${postType}.${sub1}`, e);
    }
    const sub2 = e.sub_type ?? '';
    if (sub1 && sub2) {
        bot.emit(`${postType}.${sub1}.${sub2}`, e);
    }
}
async function main() {
    const cwd = process.cwd();
    log('info', `Worker 启动, cwd=${cwd}`);
    injectGlobals();
    const configDir = path.join(cwd, 'config', 'config');
    if (!fs__default.existsSync(configDir)) {
        fs__default.mkdirSync(configDir, { recursive: true });
    }
    const logsDir = path.join(cwd, 'logs');
    if (!fs__default.existsSync(logsDir)) {
        fs__default.mkdirSync(logsDir, { recursive: true });
    }
    const today = new Date().toISOString().slice(0, 10);
    const commandLog = path.join(logsDir, `command.${today}.log`);
    if (!fs__default.existsSync(commandLog)) {
        fs__default.writeFileSync(commandLog, '');
    }
    try {
        const redisMod = await import(pathToFileURL(path.join(cwd, 'lib', 'config', 'redis.js')).href);
        const redisInit = redisMod.default ?? redisMod.redisInit;
        await redisInit();
        log('info', 'Redis 初始化成功（Miao-Yunzai）');
    }
    catch (err) {
        log('error', `Redis 初始化失败: ${err.message}`);
        ipcSend({ type: 'error', message: `Redis 初始化失败: ${err.message}` });
        process.exit(1);
    }
    try {
        const mod = await import(pathToFileURL(path.join(cwd, 'lib', 'plugins', 'plugin.js')).href);
        globalThis.plugin = mod.default ?? mod.plugin;
        log('info', 'plugin 基类加载成功');
    }
    catch (err) {
        log('warn', `plugin 基类加载失败，使用内置空壳: ${err.message}`);
        const stateArr = new Map();
        globalThis.plugin = class {
            name = 'plugin';
            dsc = '';
            event = 'message';
            priority = 5000;
            rule = [];
            task = null;
            handler = null;
            namespace = '';
            e = null;
            constructor(opt = {}) {
                Object.assign(this, opt);
            }
            reply(msg, quote) {
                return this.e?.reply?.(msg, quote);
            }
            conKey(isGroup = false) {
                if (isGroup) {
                    return `${this.name}.${this.e?.group_id}`;
                }
                return `${this.name}.${this.e?.user_id}`;
            }
            setContext(type, isGroup = false, time = 120) {
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
            getContext(type, isGroup = false) {
                const key = this.conKey(isGroup);
                const ctx = stateArr.get(key);
                if (type && ctx?.type !== type) {
                    return undefined;
                }
                return ctx;
            }
            finish(_type, isGroup = false) {
                const key = this.conKey(isGroup);
                stateArr.delete(key);
            }
            awaitContext(type, isGroup = false, time = 120) {
                return new Promise((resolve, reject) => {
                    this.setContext(type, isGroup, time);
                    const key = this.conKey(isGroup);
                    const check = setInterval(() => {
                        const ctx = stateArr.get(key);
                        if (!ctx) {
                            clearInterval(check);
                            reject(new Error('上下文已超时'));
                        }
                        else if (ctx.resolve) {
                            clearInterval(check);
                            stateArr.delete(key);
                            resolve(ctx.resolve);
                        }
                    }, 500);
                    setTimeout(() => clearInterval(check), (time + 5) * 1000);
                });
            }
            resolveContext(e) {
                const key = this.conKey(!!e?.isGroup);
                const ctx = stateArr.get(key);
                if (ctx) {
                    ctx.resolve = e;
                }
            }
        };
    }
    try {
        const mod = await import(pathToFileURL(path.join(cwd, 'lib', 'plugins', 'loader.js')).href);
        PluginsLoader = mod.default;
        log('info', 'PluginsLoader 加载成功');
    }
    catch (err) {
        log('error', `PluginsLoader 加载失败: ${err.message}`);
        ipcSend({ type: 'error', message: `Loader 加载失败: ${err.message}` });
        process.exit(1);
    }
    try {
        await PluginsLoader.load();
        const count = PluginsLoader.priority?.length ?? 0;
        log('info', `插件加载完成，共 ${count} 个`);
        try {
            const cfgMod = await import(pathToFileURL(path.join(cwd, 'lib', 'config', 'config.js')).href);
            const cfg = cfgMod.default ?? cfgMod.cfg;
            if (cfg) {
                globalThis._yunzaiCfg = cfg;
                log('info', `Cfg 实例已获取，当前 masterQQ: [${cfg.masterQQ}]`);
            }
        }
        catch {
            log('warn', '获取 Cfg 实例失败，跨平台 master 需手动配置 masterQQ');
        }
        void globalThis.Bot?.getLoginInfo?.()?.catch?.(() => { });
        void globalThis.Bot?.getGroupList?.()?.catch?.(() => { });
        void globalThis.Bot?.getFriendList?.()?.catch?.(() => { });
        ipcSend({ type: 'ready', pluginCount: count });
    }
    catch (err) {
        log('error', `插件加载失败: ${err.message}`);
        ipcSend({ type: 'error', message: `插件加载失败: ${err.message}` });
        process.exit(1);
    }
    process.on('message', (msg) => {
        if (msg.type === 'event') {
            currentPlatform = msg.data.platform ?? '';
            currentMsgId = msg.id;
            if (currentPlatform) {
                defaultPlatform = currentPlatform;
            }
            if (globalThis.Bot?.stat) {
                globalThis.Bot.stat.recv_msg_cnt++;
            }
            const e = buildEvent(msg.data, msg.id);
            let replied = false;
            const origReply = e.reply;
            e.reply = (m, q = false) => {
                replied = true;
                return origReply(m, q);
            };
            void (async () => {
                try {
                    emitBotEvent(e);
                    const rawMsg = String(e.msg ?? '').trim();
                    if (BLOCKED_COMMANDS.test(rawMsg)) {
                        const hint = rawMsg.includes('更新') ? '#yz更新' : rawMsg.includes('重启') ? '#yz重启' : '#yz停止';
                        e.reply(`该指令已被接管，请使用 ${hint}`);
                        ipcSend({ type: 'done', id: msg.id, replied: true });
                        return;
                    }
                    await PluginsLoader.deal(e);
                }
                catch (err) {
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
                ipcSend({ type: 'done', id: msg.id, replied });
            })();
        }
        else if (msg.type === 'api_response') {
            handleApiResponse(msg);
        }
        else if (msg.type === 'reply_result') {
            handleReplyResult(msg);
        }
        else if (msg.type === 'shutdown') {
            log('info', 'Worker 收到关闭信号，退出');
            process.exit(0);
        }
    });
}
main().catch(err => {
    log('error', `Worker 启动失败: ${err.message}`);
    process.exit(1);
});
