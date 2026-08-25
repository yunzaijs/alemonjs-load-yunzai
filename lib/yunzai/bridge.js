import { getYunzaiEventConcurrency } from "../path.js";
import { manager } from "./manager.js";
import { WorkerEventQueue } from "./event-queue.js";
import { canUseGenericOneBotFallback, getNativeForwardFallbackRequest, getNativeOneBotRequest, getNativeQuotedForwardRequests, getReplyMessageId, isUnsupportedOneBotActionError, normalizeOneBotMediaSource, sendNativeForward, summarizeNativeOneBotRequest } from "./forward.js";
import { OneBotIngressGuard } from "./onebot-ingress.js";
import { assertMessageSendSucceeded, describeFormatContents, describeOneBotError, describeReplyContents, getPlatformFailureSummary, summarizeReplyContents } from "./send-result.js";
import { Format, logger, sendToChannel, sendToUser, useClient, useGuild, useMe, useMember, useMessage, useRequest, useUser } from "alemonjs";

//#region src/yunzai/bridge.ts
/**
* AlemonJS → Yunzai IPC 桥接
*
* 1. 捕获 AlemonJS 事件（消息、通知、请求等），提取所有可用字段
* 2. 区分平台：OneBot 透传 rawEvent，其他平台用通用字段
* 3. 通过 IPC 发送给 Worker 子进程
* 4. 异步接收 Worker 回复（支持多次 reply），通过 AlemonJS Format 发送
* 5. 接收 Worker API 请求，调用 AlemonJS 平台 API 实现双向通信
*/
/**
* 尝试获取 OneBot 平台的原生 API 客户端
* 仅在 @alemonjs/onebot 已安装且当前事件来自 OneBot 平台时可用
*/
let _oneBotAPI = null;
function oneBotTrace(message) {
	if (process.env.YUNZAI_ONEBOT_TRACE === "1") logger.info(`[bridge][onebot-trace] ${message}`);
}
function isOneBotPlatform(platform) {
	return platform === "onebot";
}
async function loadOneBotClient() {
	if (_oneBotAPI !== null) return;
	try {
		const { API } = await import("@alemonjs/onebot");
		_oneBotAPI = API;
		logger.info("[bridge] @alemonjs/onebot API 已加载");
	} catch {
		_oneBotAPI = false;
		logger.debug("[bridge] @alemonjs/onebot 不可用，OneBot 特有 API 将降级处理");
	}
}
/**
* 通过 OneBot API 客户端执行原生调用
* 仅 OneBot 平台可用，其他平台返回 null
*/
function getOneBotClient(event) {
	if (!isOneBotPlatform(event.Platform)) return null;
	if (!_oneBotAPI || _oneBotAPI === false) return null;
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
const pending = /* @__PURE__ */ new Map();
/** 滑动窗口超时：最后一次 reply 后 8s 清理 */
const REPLY_IDLE_TIMEOUT = 8e3;
/** deal() 完成后的延长超时：插件可能通过定时器/上下文继续 reply（如扫码登录） */
const POST_DONE_TIMEOUT = 3e5;
/** 绝对超时：消息发出后 8 分钟必须清理，防泄漏 */
const REPLY_MAX_TIMEOUT = 48e4;
let idCounter = 0;
let listenerBound = false;
let doneListenerBound = false;
let exitListenerBound = false;
let queueListenerBound = false;
/**
* 事件进入 Worker 前的 load 层背压。
*
* 默认只允许一个事件在 Worker 内执行。这样即使多个 OneBot 消息同时到达，
* 也不会并发触发 Miao-Yunzai 的共享 Puppeteer 渲染器。
*/
const workerEventQueue = new WorkerEventQueue(getYunzaiEventConcurrency(), () => manager.isReady);
const oneBotIngressGuard = new OneBotIngressGuard();
/** 绑定 Worker 回复监听（仅一次） */
function bindReplyListener() {
	if (listenerBound) return;
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
			} else {
				if (reply.channelId || reply.userId) {
					logger.info(`[bridge] pending/msgEvents 均过期，降级直发 id=${reply.id} private=${reply.isPrivate}`);
					const targetChannel = reply.channelId ?? "";
					const targetUser = reply.userId ?? "";
					const sendFn = () => {
						return sendDirectContents(reply.contents, reply.isPrivate ? {
							isPrivate: true,
							userId: targetUser
						} : {
							isPrivate: false,
							groupId: targetChannel
						});
					};
					sendFn().then((res) => sendReplyResult(reply, true, res)).catch(() => sendReplyResult(reply, false));
				} else {
					logger.warn(`[bridge] pending/msgEvents 均未找到且无路由信息 id=${reply.id}`);
					manager.sendToWorker({
						type: "reply_result",
						replyId: reply.replyId,
						ok: false
					});
				}
				return;
			}
		}
		clearTimeout(ctx.timer);
		ctx.timer = setTimeout(() => cleanPending(reply.id), REPLY_IDLE_TIMEOUT);
		sendReplyWithContext(reply, ctx, msgEvents.get(reply.id));
	});
}
function sendReplyResult(reply, ok, result) {
	manager.sendToWorker({
		type: "reply_result",
		replyId: reply.replyId,
		messageId: ok ? getReplyMessageId(result) : void 0,
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
/**
* 原生 OneBot 消息仅能使用精确关联事件的客户端；无上下文时回退到跨平台发送，
* 绝不借用“最近事件”执行原生动作。
*/
async function trySendNativeOneBot(event, contents, target) {
	if (!event || !isOneBotPlatform(event.Platform)) return { handled: false };
	const quotedForwardRequests = getNativeQuotedForwardRequests(contents, target);
	const request = getNativeOneBotRequest(contents, target);
	const requests = quotedForwardRequests ?? (request ? [request] : []);
	if (requests.length === 0) return { handled: false };
	await loadOneBotClient();
	const client = getOneBotClient(event);
	if (!client) return { handled: false };
	if (process.env.YUNZAI_ONEBOT_TRACE === "1") try {
		const status = await client.getConnectionStatus();
		const value = Array.isArray(status) ? status.find((item) => item?.code === 2e3)?.data : status;
		oneBotTrace(`connection activeVersion=${String(value?.activeVersion ?? "unknown")}, requestedVersion=${String(value?.requestedVersion ?? "unknown")}, state=${String(value?.state ?? "unknown")}`);
	} catch (error) {
		oneBotTrace(`connection query failed: ${describeOneBotError(error)}`);
	}
	for (const request of requests) oneBotTrace(`native request ${summarizeNativeOneBotRequest(request)}`);
	let activeRequest = requests[0];
	try {
		let result;
		for (const request of requests) {
			activeRequest = request;
			result = await sendNativeForward(client, request);
		}
		oneBotTrace(`native result success type=${Array.isArray(result) ? "array" : typeof result}`);
		return {
			handled: true,
			result
		};
	} catch (err) {
		const fallbackIsLossless = requests.length === 1 && canUseGenericOneBotFallback(contents);
		const forwardFallback = requests.length === 1 && activeRequest.action.includes("_forward_msg") ? getNativeForwardFallbackRequest(contents, target) : null;
		if ((isUnsupportedOneBotActionError(err) || err?.oneBotActionRejected === true) && forwardFallback) {
			logger.warn(`[bridge] OneBot 拒绝 ${activeRequest.action}，转用完整展开的原生普通消息: ${describeOneBotError(err)}`);
			try {
				const result = await sendNativeForward(client, forwardFallback);
				oneBotTrace(`forward fallback success ${summarizeNativeOneBotRequest(forwardFallback)}`);
				return {
					handled: true,
					result
				};
			} catch (fallbackError) {
				logger.error(`[bridge] OneBot 转发展开消息发送失败: ${summarizeNativeOneBotRequest(forwardFallback)}; ${describeOneBotError(fallbackError)}`);
				throw fallbackError;
			}
		}
		if (isUnsupportedOneBotActionError(err)) {
			if (fallbackIsLossless) {
				logger.warn(`[bridge] OneBot 不支持 ${activeRequest.action}，转用等价通用发送: ${err?.message ?? String(err)}`);
				return { handled: false };
			}
			logger.error(`[bridge] OneBot 不支持 ${activeRequest.action}，通用接口无法保留段语义，未降级: ${describeOneBotError(err)}`);
			throw err;
		}
		if (err?.oneBotActionRejected === true) {
			if (fallbackIsLossless) {
				logger.warn(`[bridge] OneBot 原生动作被拒绝，转用等价通用发送: ${summarizeNativeOneBotRequest(activeRequest)}; ${describeOneBotError(err)}`);
				return { handled: false };
			}
			logger.error(`[bridge] OneBot 原生动作被拒绝，通用接口无法保留段语义，未降级: ${summarizeNativeOneBotRequest(activeRequest)}; ${describeOneBotError(err)}`);
			throw err;
		}
		logger.error(`[bridge] OneBot 原生消息发送结果不确定，未降级: ${summarizeNativeOneBotRequest(activeRequest)}; ${describeOneBotError(err)}`);
		throw err;
	}
}
async function sendDirectContents(contents, target, event) {
	const native = await trySendNativeOneBot(event, contents, target);
	if (native.handled) return native.result;
	const format = contentsToFormat(contents, event?.Platform);
	const result = target.isPrivate ? await sendToUser(String(target.userId), format.value) : await sendToChannel(String(target.groupId), format.value);
	assertMessageSendSucceeded(result);
	return result;
}
async function sendReplyWithContext(reply, ctx, event) {
	try {
		if (event && isOneBotPlatform(event.Platform)) oneBotTrace(`worker reply id=${reply.id}, ${describeReplyContents(reply.contents)}`);
		const native = await trySendNativeOneBot(event, reply.contents, event ? getNativeForwardTarget(event, reply) : {
			isPrivate: reply.isPrivate ?? true,
			groupId: reply.channelId,
			userId: reply.userId
		});
		if (native.handled) {
			sendReplyResult(reply, true, native.result);
			return;
		}
		const format = contentsToFormat(reply.contents, event?.Platform);
		if (event && isOneBotPlatform(event.Platform)) oneBotTrace(`generic format ${describeFormatContents(format.value)}`);
		const result = await ctx.message.send({ format });
		assertMessageSendSucceeded(result);
		if (event && isOneBotPlatform(event.Platform)) oneBotTrace(`generic result success ${getPlatformFailureSummary(result) ?? "ok"}`);
		sendReplyResult(reply, true, result);
	} catch (err) {
		if (event && isOneBotPlatform(event.Platform)) oneBotTrace(`send failed ${describeOneBotError(err)}`);
		logger.error(`[bridge] 回复发送失败 id=${reply.id} ${summarizeReplyContents(reply.contents)}: ${describeOneBotError(err)}`);
		sendReplyResult(reply, false);
	}
}
/** 清理 pending 条目及其所有定时器 */
function cleanPending(id) {
	const ctx = pending.get(id);
	if (!ctx) return;
	clearTimeout(ctx.timer);
	clearTimeout(ctx.maxTimer);
	pending.delete(id);
}
/** 清理 msgEvents 条目 */
function cleanMsgEvent(id) {
	msgEvents.delete(id);
}
/** 清理 pending + msgEvents */
function cleanAll(id) {
	cleanPending(id);
	cleanMsgEvent(id);
}
/** 绑定 Worker done 监听（仅一次） */
function bindDoneListener() {
	if (doneListenerBound) return;
	doneListenerBound = true;
	manager.onDone((done) => {
		workerEventQueue.complete(done.id);
		const ctx = pending.get(done.id);
		if (!ctx) return;
		if (!done.replied) cleanAll(done.id);
		else {
			clearTimeout(ctx.timer);
			ctx.timer = setTimeout(() => cleanPending(done.id), POST_DONE_TIMEOUT);
		}
	});
}
/** 绑定 Worker 退出监听 — 批量清理所有 pending 和 msgEvents，防泄漏（仅一次） */
function bindExitListener() {
	if (exitListenerBound) return;
	exitListenerBound = true;
	manager.onWorkerExit(() => {
		workerEventQueue.abortActive();
		for (const id of pending.keys()) cleanPending(id);
		msgEvents.clear();
		logger.debug("[bridge] Worker 退出，已清理 pending 和 msgEvents");
	});
}
/** 绑定 Worker 就绪回调，使重启期间积压的事件继续由 load 层调度。 */
function bindQueueListener() {
	if (queueListenerBound) return;
	queueListenerBound = true;
	manager.onReady(() => workerEventQueue.resume());
}
function normalizeButtonSpecs(value) {
	const source = Array.isArray(value) ? value : [value];
	return (source.length > 0 && source.every((item) => Array.isArray(item)) ? source : [source]).map((row) => row.flatMap((item) => {
		if (item && typeof item === "object" && Array.isArray(item.buttons)) return item.buttons;
		return [item];
	}).map((item) => {
		if (!item || typeof item !== "object") return {
			title: String(item ?? ""),
			data: String(item ?? "")
		};
		const title = String(item.title ?? item.label ?? item.text ?? item.render_data?.label ?? item.value ?? "按钮");
		const actionData = item.data ?? item.action?.data ?? item.options?.data ?? title;
		const actionType = item.type ?? item.action?.type;
		const type = actionType === 1 || actionType === "link" ? "link" : actionType === 0 || actionType === "call" ? "call" : "command";
		const options = {
			...item.options ?? {},
			...item.render_data?.style !== void 0 ? { style: item.render_data.style } : {},
			...item.action?.enter !== void 0 ? { autoEnter: item.action.enter } : {},
			...item.action?.reply !== void 0 ? { reply: item.action.reply } : {},
			type
		};
		return {
			title,
			data: typeof actionData === "string" ? actionData : JSON.stringify(actionData),
			options
		};
	}));
}
function appendButtonToFormat(format, value, platform) {
	const rows = normalizeButtonSpecs(value);
	if (platform !== "qq-bot") {
		const text = rows.map((row) => row.map((button) => `[${button.title}]`).join(" ")).filter(Boolean).join("\n");
		if (text) format.addText(text);
		return;
	}
	const group = Format.createButtonGroup();
	for (const row of rows) {
		group.addRow();
		for (const button of row) group.addButton(button.title, button.data, button.options);
	}
	if (group.value.value.length > 0) format.addButtonGroup(group);
}
function appendContentsToFormat(format, contents, platform) {
	for (const c of contents) switch (c.type) {
		case "text":
			format.addText(c.data);
			break;
		case "image":
			format.addImage(normalizeOneBotMediaSource(c.data));
			break;
		case "at":
			format.addMention(c.data);
			break;
		case "face":
			format.addText(`[表情${c.data}]`);
			break;
		case "record":
			format.addAudio(normalizeOneBotMediaSource(c.data));
			break;
		case "video":
			format.addVideo(normalizeOneBotMediaSource(c.data));
			break;
		case "forward":
			if (c.fallback?.length) appendContentsToFormat(format, c.fallback, platform);
			else format.addText(c.data || "[转发消息]");
			break;
		case "button":
			appendButtonToFormat(format, c.buttonData, platform);
			break;
		case "markdown":
			if (platform === "qq-bot") format.addMarkdownOriginal(c.data);
			else format.addText(c.data);
			break;
		case "quote": break;
		case "raw":
			format.addText(c.data || `[OneBot 原生消息:${c.nativeType ?? "unknown"}]`);
			break;
		default: format.addText(c.data);
	}
}
/** 将 Worker 的 ReplyContent[] 转为 AlemonJS Format */
function contentsToFormat(contents, platform) {
	const format = Format.create();
	appendContentsToFormat(format, contents, platform);
	return format;
}
/**
* 按消息 ID 精确关联的事件引用（处理中的消息）
* Worker 发起 API 请求时携带 msgId，优先从此 Map 查找
*/
const msgEvents = /* @__PURE__ */ new Map();
let apiListenerBound = false;
/** 绑定 Worker API 请求监听（仅一次） */
function bindApiRequestListener() {
	if (apiListenerBound) return;
	apiListenerBound = true;
	loadOneBotClient();
	manager.onApiRequest((req) => {
		handleApiRequest(req, req.msgId);
	});
}
/**
* 处理来自 Worker 的 API 请求
*
* 利用 AlemonJS 标准 hooks 实现跨平台兼容：
* - OneBot 平台：通过 AlemonJS → OneBot 适配器 → icqq 完整 API
* - 其他平台：通过 AlemonJS 标准化接口降级适配
*/
async function handleApiRequest(req, msgId) {
	const { reqId, action, params } = req;
	try {
		const result = await dispatchApi(action, params, msgId, req.rawOneBot === true);
		const failure = getPlatformFailureSummary(result);
		if (failure) logger.warn(`[bridge] Worker API 返回失败 action=${action} msgId=${msgId ?? "-"}: ${failure}`);
		manager.sendToWorker({
			type: "api_response",
			reqId,
			ok: true,
			data: result
		});
	} catch (err) {
		logger.warn(`[bridge] Worker API 调用异常 action=${action} msgId=${msgId ?? "-"}: ${err?.message ?? String(err)}`);
		manager.sendToWorker({
			type: "api_response",
			reqId,
			ok: false,
			error: err?.message ?? "Unknown error"
		});
	}
}
/**
* API 分发器 — 将 Yunzai/icqq 风格的 API 调用映射到 AlemonJS 标准 hooks
*
* 普通消息可跨平台直发；管理与 OneBot 原生动作必须拥有精确 msgId 上下文。
*/
async function dispatchApi(action, params, msgId, rawOneBot = false) {
	const getEvent = (_platform) => getEventForApi(msgId);
	if (rawOneBot) {
		const event = getEvent(params.platform);
		if (!event) throw new Error(`无可用事件上下文: ${action}`);
		const client = getOneBotClient(event);
		if (!client) throw new Error(`${action} 仅 OneBot v11 平台可用`);
		const { platform: _platform, ...apiParams } = params;
		return await client.send({
			action,
			params: apiParams
		});
	}
	switch (action) {
		case "sendGroupMsg": return await sendDirectContents(params.contents ?? [], {
			isPrivate: false,
			groupId: params.group_id
		}, getEvent());
		case "sendPrivateMsg": return await sendDirectContents(params.contents ?? [], {
			isPrivate: true,
			userId: params.user_id
		}, getEvent());
		case "deleteMsg": {
			const event = getEvent();
			if (!event) throw new Error("无可用事件上下文");
			const [message] = useMessage(event);
			return await message.delete({ messageId: String(params.message_id) });
		}
		case "getGroupMemberList": {
			const event = getEvent(params.platform);
			if (!event) throw new Error("无可用事件上下文");
			const [member] = useMember(event);
			return await member.list({ guildId: String(params.group_id) });
		}
		case "getGroupMemberInfo": {
			const event = getEvent(params.platform);
			if (!event) throw new Error("无可用事件上下文");
			const [member] = useMember(event);
			return await member.info({
				userId: String(params.user_id),
				guildId: String(params.group_id)
			});
		}
		case "setGroupKick": {
			const event = getEvent(params.platform);
			if (!event) throw new Error("无可用事件上下文");
			const [member] = useMember(event);
			return await member.kick({
				userId: String(params.user_id),
				guildId: String(params.group_id)
			});
		}
		case "setGroupBan": {
			const event = getEvent(params.platform);
			if (!event) throw new Error("无可用事件上下文");
			const [member] = useMember(event);
			return await member.mute({
				userId: String(params.user_id),
				guildId: String(params.group_id),
				duration: params.duration ?? 0
			});
		}
		case "setGroupCard": {
			const event = getEvent(params.platform);
			if (!event) throw new Error("无可用事件上下文");
			const [member] = useMember(event);
			return await member.card({
				userId: String(params.user_id),
				guildId: String(params.group_id),
				card: params.card ?? ""
			});
		}
		case "setGroupAdmin": {
			const event = getEvent(params.platform);
			if (!event) throw new Error("无可用事件上下文");
			const [member] = useMember(event);
			return await member.admin({
				userId: String(params.user_id),
				guildId: String(params.group_id),
				enable: params.enable ?? true
			});
		}
		case "setGroupSpecialTitle": {
			const event = getEvent(params.platform);
			if (!event) throw new Error("无可用事件上下文");
			const [member] = useMember(event);
			return await member.title({
				userId: String(params.user_id),
				guildId: String(params.group_id),
				title: params.special_title ?? ""
			});
		}
		case "getGroupInfo": {
			const event = getEvent(params.platform);
			if (!event) throw new Error("无可用事件上下文");
			const [guild] = useGuild(event);
			return await guild.info({ guildId: String(params.group_id) });
		}
		case "getGroupList": {
			const event = getEvent(params.platform);
			if (!event) throw new Error("无可用事件上下文");
			const [guild] = useGuild(event);
			return await guild.list();
		}
		case "setGroupLeave": {
			const event = getEvent(params.platform);
			if (!event) throw new Error("无可用事件上下文");
			const [guild] = useGuild(event);
			return await guild.leave({ guildId: String(params.group_id) });
		}
		case "setGroupName": {
			const event = getEvent(params.platform);
			if (!event) throw new Error("无可用事件上下文");
			const [guild] = useGuild(event);
			return await guild.update({
				guildId: String(params.group_id),
				name: params.group_name ?? ""
			});
		}
		case "setGroupWholeBan": {
			const event = getEvent(params.platform);
			if (!event) throw new Error("无可用事件上下文");
			const [guild] = useGuild(event);
			return await guild.mute({
				guildId: String(params.group_id),
				enable: params.enable ?? true
			});
		}
		case "getLoginInfo": {
			const [me] = useMe();
			return await me.info();
		}
		case "getFriendList": {
			const [me] = useMe();
			return await me.friends();
		}
		case "getStrangerInfo": {
			const [user] = useUser();
			return await user.info({ userId: String(params.user_id) });
		}
		case "setFriendAddRequest": {
			const [request] = useRequest();
			return await request.friend({
				flag: String(params.flag),
				approve: params.approve ?? true,
				remark: params.remark ?? ""
			});
		}
		case "setGroupAddRequest": {
			const [request] = useRequest();
			return await request.guild({
				flag: String(params.flag),
				subType: params.type ?? "add",
				approve: params.approve ?? true,
				reason: params.reason ?? ""
			});
		}
		case "sendLike": {
			const event = getEvent(params.platform);
			if (!event) throw new Error("无可用事件上下文");
			const client = getOneBotClient(event);
			if (!client) throw new Error("sendLike 仅 OneBot 平台可用");
			return await client.sendLike({
				user_id: Number(params.user_id),
				times: params.times ?? 10
			});
		}
		case "pokeMember": {
			const event = getEvent(params.platform);
			if (!event) throw new Error("无可用事件上下文");
			const client = getOneBotClient(event);
			if (!client) throw new Error("pokeMember 仅 OneBot 平台可用");
			return await client.send({
				action: "group_poke",
				params: {
					group_id: Number(params.group_id),
					user_id: Number(params.user_id)
				}
			});
		}
		case "pokeFriend": {
			const event = getEvent(params.platform);
			if (!event) throw new Error("无可用事件上下文");
			const client = getOneBotClient(event);
			if (!client) throw new Error("pokeFriend 仅 OneBot 平台可用");
			return await client.send({
				action: "friend_poke",
				params: { user_id: Number(params.user_id) }
			});
		}
		case "getCookies": {
			const event = getEvent(params.platform);
			if (!event) throw new Error("无可用事件上下文");
			const client = getOneBotClient(event);
			if (!client) throw new Error("getCookies 仅 OneBot 平台可用");
			return await client.getCookies();
		}
		case "getCsrfToken": {
			const event = getEvent(params.platform);
			if (!event) throw new Error("无可用事件上下文");
			const client = getOneBotClient(event);
			if (!client) throw new Error("getCsrfToken 仅 OneBot 平台可用");
			return await client.getCsrfToken();
		}
		case "getMsg": {
			const event = getEvent(params.platform);
			if (!event) throw new Error("无可用事件上下文");
			const client = getOneBotClient(event);
			if (!client) throw new Error("getMsg 仅 OneBot 平台可用");
			return await client.getMsg({ message_id: Number(params.message_id) });
		}
		case "getForwardMsg": {
			const event = getEvent(params.platform);
			if (!event) throw new Error("无可用事件上下文");
			const client = getOneBotClient(event);
			if (!client) throw new Error("getForwardMsg 仅 OneBot 平台可用");
			return await client.getForwardMsg({ id: String(params.id) });
		}
		case "getChatHistory": {
			const event = getEvent(params.platform);
			if (!event) throw new Error("无可用事件上下文");
			const client = getOneBotClient(event);
			if (!client) return { messages: [] };
			if (params.group_id) return await client.send({
				action: "get_group_msg_history",
				params: {
					group_id: Number(params.group_id),
					message_seq: Number(params.message_seq),
					count: params.count ?? 1
				}
			});
			return await client.send({
				action: "get_friend_msg_history",
				params: {
					user_id: Number(params.user_id),
					message_seq: Number(params.message_seq),
					count: params.count ?? 1
				}
			});
		}
		case "getGroupFileUrl": {
			const event = getEvent(params.platform);
			if (!event) throw new Error("无可用事件上下文");
			const client = getOneBotClient(event);
			if (!client) return { url: "" };
			return await client.send({
				action: "get_group_file_url",
				params: {
					group_id: Number(params.group_id),
					file_id: String(params.file_id)
				}
			});
		}
		case "getPrivateFileUrl": {
			const event = getEvent(params.platform);
			if (!event) throw new Error("无可用事件上下文");
			const client = getOneBotClient(event);
			if (!client) return { url: "" };
			return await client.send({
				action: "get_private_file_url",
				params: {
					user_id: Number(params.user_id),
					file_id: String(params.file_id)
				}
			});
		}
		default: {
			const event = getEvent(params.platform);
			if (!event) throw new Error(`无可用事件上下文: ${action}`);
			const client = getOneBotClient(event);
			if (!client) throw new Error(`${action} 仅 OneBot 平台可用`);
			const { platform: _p, ...apiParams } = params;
			return await client.send({
				action,
				params: apiParams
			});
		}
	}
}
/** 仅返回 IPC msgId 精确关联的事件，禁止后台任务借用最近事件。 */
function getEventForApi(msgId) {
	return msgId ? msgEvents.get(msgId) : void 0;
}
/** 从 AlemonJS 事件中提取跨平台媒体附件 */
function extractMedia(event) {
	const items = [];
	if (!Array.isArray(event.MessageMedia)) return items;
	for (const m of event.MessageMedia) items.push({
		type: m.Type === "sticker" || m.Type === "animation" ? "sticker" : m.Type ?? "file",
		url: m.Url ?? void 0,
		fileId: m.FileId ?? void 0,
		fileName: m.FileName ?? void 0
	});
	return items;
}
/**
* 安全提取原始 OneBot 事件
* 仅当 value 包含 post_type 字段时才认定为 OneBot 事件
*/
function extractRawEvent(event, rawE) {
	if (!isOneBotPlatform(event?.Platform ?? rawE?.Platform)) return;
	try {
		const v = event.value ?? rawE?.value;
		if (v && typeof v === "object" && v.post_type) return JSON.parse(JSON.stringify(v));
	} catch {}
}
/**
* 从 AlemonJS 事件中提取 @提及的用户列表
* 用于跨平台（无 rawEvent）时在 Worker 侧构建 at 消息段
* 优先从 value.message（OneBot 消息段）中提取
*/
function extractAtUsers(event) {
	const users = [];
	try {
		const v = event.value;
		if (v && Array.isArray(v.message)) {
			for (const seg of v.message) if (seg?.type === "at") {
				const qq = seg.data?.qq ?? seg.qq;
				if (qq !== null && qq !== void 0 && qq !== "all") users.push({
					userId: String(qq),
					userName: seg.data?.text ?? seg.text ?? ""
				});
			}
		}
	} catch {}
	return users;
}
/** 将事件送入 Worker；仅由 load 层队列在获得槽位后调用。 */
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
	const interactionId = e.InteractionId ?? e.interactionId ?? "";
	const interactionData = e.InteractionData ?? e.interactionData;
	const interactionTarget = e.Target ?? e.InteractionTarget ?? e.interactionTarget;
	manager.send({
		type: "event",
		id,
		data: {
			eventName: e.name ?? "",
			platform: e.Platform ?? "",
			botId: e.BotId ?? "",
			messageText: e.MessageText ?? "",
			messageId: e.MessageId ?? "",
			media: extractMedia(e),
			userId: e.UserId ?? "",
			userName: e.UserName ?? "",
			userAvatar: e.UserAvatar ?? "",
			spaceId: e.GuildId ?? e.ChannelId ?? "",
			isPrivate: !e.GuildId,
			isMaster: e.IsMaster ?? false,
			IsMaster: e.IsMaster ?? false,
			atUsers,
			interactionId: interactionId ? String(interactionId) : void 0,
			interactionData,
			interactionTarget,
			rawEvent
		}
	});
}
var bridge_default = (e, next) => {
	if (!manager.isReady) {
		next();
		return;
	}
	if (!(e.name ?? "")) {
		next();
		return;
	}
	if (!oneBotIngressGuard.accept(e.Platform, e.value)) {
		logger.debug(`[bridge] 忽略 OneBot 回声或重复消息 id=${e.MessageId ?? ""}`);
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

//#endregion
export { bridge_default as default };