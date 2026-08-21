import { logger, useMessage, sendToUser, sendToChannel, Format, useRequest, useUser, useMe, useGuild, useMember, useClient } from 'alemonjs';
import { getYunzaiEventConcurrency } from '../path.js';
import { WorkerEventQueue } from './event-queue.js';
import { manager } from './manager.js';
import { OneBotIngressGuard } from './onebot-ingress.js';
import { assertMessageSendSucceeded, summarizeReplyContents } from './send-result.js';
import { getReplyMessageId, getNativeOneBotRequest, sendNativeForward, isUnsupportedOneBotActionError } from './forward.js';

let _oneBotAPI = null;
function isOneBotPlatform(platform) {
    return platform === 'onebot';
}
async function loadOneBotClient() {
    if (_oneBotAPI !== null) {
        return;
    }
    try {
        const { API } = await import('@alemonjs/onebot');
        _oneBotAPI = API;
        logger.info('[bridge] @alemonjs/onebot API 已加载');
    }
    catch {
        _oneBotAPI = false;
        logger.debug('[bridge] @alemonjs/onebot 不可用，OneBot 特有 API 将降级处理');
    }
}
function getOneBotClient(event) {
    if (!isOneBotPlatform(event.Platform)) {
        return null;
    }
    if (!_oneBotAPI || _oneBotAPI === false) {
        return null;
    }
    try {
        const [client] = useClient(event, _oneBotAPI);
        return client;
    }
    catch {
        return null;
    }
}
const pending = new Map();
const REPLY_IDLE_TIMEOUT = 8_000;
const POST_DONE_TIMEOUT = 5 * 60_000;
const REPLY_MAX_TIMEOUT = 8 * 60_000;
let idCounter = 0;
let listenerBound = false;
let doneListenerBound = false;
let exitListenerBound = false;
let queueListenerBound = false;
const workerEventQueue = new WorkerEventQueue(getYunzaiEventConcurrency(), () => manager.isReady);
const oneBotIngressGuard = new OneBotIngressGuard();
function bindReplyListener() {
    if (listenerBound) {
        return;
    }
    listenerBound = true;
    manager.onReply((reply) => {
        logger.info(`[bridge] 收到 reply id=${reply.id} replyId=${reply.replyId} contents=${reply.contents.length}`);
        let ctx = pending.get(reply.id);
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
            }
            else {
                if (reply.channelId || reply.userId) {
                    logger.info(`[bridge] pending/msgEvents 均过期，降级直发 id=${reply.id} private=${reply.isPrivate}`);
                    const targetChannel = reply.channelId ?? '';
                    const targetUser = reply.userId ?? '';
                    const sendFn = () => {
                        return sendDirectContents(reply.contents, reply.isPrivate ? { isPrivate: true, userId: targetUser } : { isPrivate: false, groupId: targetChannel });
                    };
                    void sendFn()
                        .then(res => sendReplyResult(reply, true, res))
                        .catch(() => sendReplyResult(reply, false));
                }
                else {
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
        clearTimeout(ctx.timer);
        ctx.timer = setTimeout(() => cleanPending(reply.id), REPLY_IDLE_TIMEOUT);
        void sendReplyWithContext(reply, ctx, msgEvents.get(reply.id));
    });
}
function sendReplyResult(reply, ok, result) {
    manager.sendToWorker({
        type: 'reply_result',
        replyId: reply.replyId,
        messageId: ok ? getReplyMessageId(result) : undefined,
        ok
    });
}
function getNativeForwardTarget(event, reply) {
    const raw = event.value;
    return {
        isPrivate: reply.isPrivate ?? !event.GuildId,
        groupId: raw?.group_id ?? reply.channelId ?? event.GuildId ?? event.ChannelId,
        userId: raw?.user_id ?? reply.userId ?? event.UserId
    };
}
async function trySendNativeOneBot(event, contents, target) {
    if (!event || !isOneBotPlatform(event.Platform)) {
        return { handled: false };
    }
    const request = getNativeOneBotRequest(contents, target);
    if (!request) {
        return { handled: false };
    }
    await loadOneBotClient();
    const client = getOneBotClient(event);
    if (!client) {
        return { handled: false };
    }
    try {
        return { handled: true, result: await sendNativeForward(client, request) };
    }
    catch (err) {
        if (isUnsupportedOneBotActionError(err)) {
            logger.warn(`[bridge] OneBot 不支持 ${request.action}，已降级为普通消息: ${err?.message ?? String(err)}`);
            return { handled: false };
        }
        logger.error(`[bridge] OneBot 原生消息发送结果不确定，未降级: ${err?.message ?? String(err)}`);
        throw err;
    }
}
async function sendDirectContents(contents, target, event) {
    const native = await trySendNativeOneBot(event, contents, target);
    if (native.handled) {
        return native.result;
    }
    const format = contentsToFormat(contents);
    const result = target.isPrivate ? await sendToUser(String(target.userId), format.value) : await sendToChannel(String(target.groupId), format.value);
    assertMessageSendSucceeded(result);
    return result;
}
async function sendReplyWithContext(reply, ctx, event) {
    try {
        const native = await trySendNativeOneBot(event, reply.contents, event
            ? getNativeForwardTarget(event, reply)
            : {
                isPrivate: reply.isPrivate ?? true,
                groupId: reply.channelId,
                userId: reply.userId
            });
        if (native.handled) {
            sendReplyResult(reply, true, native.result);
            return;
        }
        const format = contentsToFormat(reply.contents);
        const result = await ctx.message.send({ format });
        assertMessageSendSucceeded(result);
        sendReplyResult(reply, true, result);
    }
    catch (err) {
        logger.error(`[bridge] 回复发送失败 id=${reply.id} ${summarizeReplyContents(reply.contents)}: ${err?.message ?? String(err)}`);
        sendReplyResult(reply, false);
    }
}
function cleanPending(id) {
    const ctx = pending.get(id);
    if (!ctx) {
        return;
    }
    clearTimeout(ctx.timer);
    clearTimeout(ctx.maxTimer);
    pending.delete(id);
}
function cleanMsgEvent(id) {
    msgEvents.delete(id);
}
function cleanAll(id) {
    cleanPending(id);
    cleanMsgEvent(id);
}
function bindDoneListener() {
    if (doneListenerBound) {
        return;
    }
    doneListenerBound = true;
    manager.onDone((done) => {
        workerEventQueue.complete(done.id);
        const ctx = pending.get(done.id);
        if (!ctx) {
            return;
        }
        if (!done.replied) {
            cleanAll(done.id);
        }
        else {
            clearTimeout(ctx.timer);
            ctx.timer = setTimeout(() => cleanPending(done.id), POST_DONE_TIMEOUT);
        }
    });
}
function bindExitListener() {
    if (exitListenerBound) {
        return;
    }
    exitListenerBound = true;
    manager.onWorkerExit(() => {
        workerEventQueue.abortActive();
        for (const id of pending.keys()) {
            cleanPending(id);
        }
        msgEvents.clear();
        logger.debug('[bridge] Worker 退出，已清理 pending 和 msgEvents');
    });
}
function bindQueueListener() {
    if (queueListenerBound) {
        return;
    }
    queueListenerBound = true;
    manager.onReady(() => workerEventQueue.resume());
}
function appendContentsToFormat(format, contents) {
    for (const c of contents) {
        switch (c.type) {
            case 'text':
                format.addText(c.data);
                break;
            case 'image':
                if (c.data.startsWith('http') || c.data.startsWith('/')) {
                    format.addImage(c.data);
                }
                else {
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
                if (c.data.startsWith('http') || c.data.startsWith('/')) {
                    format.addText(`[语音:${c.data}]`);
                }
                else {
                    format.addText('[语音]');
                }
                break;
            case 'video':
                if (c.data.startsWith('http') || c.data.startsWith('/')) {
                    format.addText(`[视频:${c.data}]`);
                }
                else {
                    format.addText('[视频]');
                }
                break;
            case 'forward':
                if (c.fallback?.length) {
                    appendContentsToFormat(format, c.fallback);
                }
                else {
                    format.addText(c.data || '[转发消息]');
                }
                break;
            case 'quote':
                break;
            default:
                format.addText(c.data);
        }
    }
}
function contentsToFormat(contents) {
    const format = Format.create();
    appendContentsToFormat(format, contents);
    return format;
}
const msgEvents = new Map();
let apiListenerBound = false;
function bindApiRequestListener() {
    if (apiListenerBound) {
        return;
    }
    apiListenerBound = true;
    void loadOneBotClient();
    manager.onApiRequest((req) => {
        void handleApiRequest(req, req.msgId);
    });
}
async function handleApiRequest(req, msgId) {
    const { reqId, action, params } = req;
    try {
        const result = await dispatchApi(action, params, msgId);
        manager.sendToWorker({ type: 'api_response', reqId, ok: true, data: result });
    }
    catch (err) {
        manager.sendToWorker({ type: 'api_response', reqId, ok: false, error: err?.message ?? 'Unknown error' });
    }
}
async function dispatchApi(action, params, msgId) {
    const getEvent = (_platform) => getEventForApi(msgId);
    switch (action) {
        case 'sendGroupMsg': {
            return await sendDirectContents(params.contents ?? [], { isPrivate: false, groupId: params.group_id }, getEvent());
        }
        case 'sendPrivateMsg': {
            return await sendDirectContents(params.contents ?? [], { isPrivate: true, userId: params.user_id }, getEvent());
        }
        case 'deleteMsg': {
            const event = getEvent();
            if (!event) {
                throw new Error('无可用事件上下文');
            }
            const [message] = useMessage(event);
            return await message.delete({ messageId: String(params.message_id) });
        }
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
                return { messages: [] };
            }
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
            const event = getEvent(params.platform);
            if (!event) {
                throw new Error(`无可用事件上下文: ${action}`);
            }
            const client = getOneBotClient(event);
            if (!client) {
                throw new Error(`${action} 仅 OneBot 平台可用`);
            }
            const { platform: _p, ...apiParams } = params;
            return await client.send({ action, params: apiParams });
        }
    }
}
function getEventForApi(msgId) {
    return msgId ? msgEvents.get(msgId) : undefined;
}
function extractMedia(event) {
    const items = [];
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
function extractRawEvent(event, rawE) {
    if (!isOneBotPlatform(event?.Platform ?? rawE?.Platform)) {
        return undefined;
    }
    try {
        const v = event.value ?? rawE?.value;
        if (v && typeof v === 'object' && v.post_type) {
            return JSON.parse(JSON.stringify(v));
        }
    }
    catch {
    }
    return undefined;
}
function extractAtUsers(event) {
    const users = [];
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
    }
    catch {
    }
    return users;
}
function dispatchEventToWorker(id, e) {
    msgEvents.set(id, e);
    setTimeout(() => cleanMsgEvent(id), REPLY_MAX_TIMEOUT);
    const [message] = useMessage(e);
    pending.set(id, {
        message,
        timer: setTimeout(() => cleanPending(id), REPLY_IDLE_TIMEOUT),
        maxTimer: setTimeout(() => cleanPending(id), REPLY_MAX_TIMEOUT)
    });
    const atUsers = extractAtUsers(e);
    const rawEvent = extractRawEvent(e, e);
    manager.send({
        type: 'event',
        id,
        data: {
            eventName: e.name ?? '',
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
            atUsers,
            rawEvent
        }
    });
}
var bridge = (e, next) => {
    if (!manager.isReady) {
        next();
        return;
    }
    const eventName = e.name ?? '';
    if (!eventName) {
        next();
        return;
    }
    if (!oneBotIngressGuard.accept(e.Platform, e.value)) {
        logger.debug(`[bridge] 忽略 OneBot 回声或重复消息 id=${e.MessageId ?? ''}`);
        return;
    }
    bindReplyListener();
    bindDoneListener();
    bindApiRequestListener();
    bindExitListener();
    bindQueueListener();
    const id = `msg_${++idCounter}_${Date.now()}`;
    workerEventQueue.setConcurrency(getYunzaiEventConcurrency());
    workerEventQueue.enqueue(id, () => dispatchEventToWorker(id, e));
};

export { bridge as default };
