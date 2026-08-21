import { buildForwardMsgCompat, buildForwardMsgParts } from "./forward.js";
import { createCompatValueWrapper } from "./compat.js";
import { getExecutionContextForAction, runWithExecutionContext } from "./execution-context.js";
import { createOneBotRuntime, isOneBotPlatform } from "./adapters/onebot-icqq.js";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

//#region src/yunzai/worker.ts
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
function ipcSend(msg) {
	process.send?.(msg);
}
function log(level, ...args) {
	ipcSend({
		type: "log",
		level,
		args
	});
}
/** 等待父进程 API 响应的 Promise map */
const apiPending = /* @__PURE__ */ new Map();
let apiIdCounter = 0;
/** 等待父进程 reply 发送结果的 Promise map */
const replyPending = /* @__PURE__ */ new Map();
let replyIdCounter = 0;
/** 处理父进程返回的 reply 结果 */
function handleReplyResult(msg) {
	const p = replyPending.get(msg.replyId);
	if (!p) return;
	replyPending.delete(msg.replyId);
	p.resolve({ message_id: msg.messageId ?? `reply_${Date.now()}` });
}
/**
* 向父进程发起 API 调用并等待结果
* Worker 的 Bot / group / friend 代理对象通过此函数实现真实功能
*/
function callApi(action, params = {}, timeout = 15e3) {
	let context;
	try {
		context = getExecutionContextForAction(action);
	} catch (err) {
		return Promise.reject(err);
	}
	return new Promise((resolve, reject) => {
		const reqId = `api_${++apiIdCounter}_${Date.now()}`;
		const requestParams = { ...params };
		if (!requestParams.platform && context?.platform) requestParams.platform = context.platform;
		const timer = setTimeout(() => {
			apiPending.delete(reqId);
			reject(/* @__PURE__ */ new Error(`API 调用超时: ${action}`));
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
		ipcSend({
			type: "api",
			reqId,
			action,
			params: requestParams,
			msgId: context?.msgId
		});
	});
}
/** 处理父进程返回的 API 响应 */
function handleApiResponse(msg) {
	const pending = apiPending.get(msg.reqId);
	if (!pending) return;
	if (msg.ok) pending.resolve(msg.data);
	else pending.reject(new Error(msg.error ?? "API 调用失败"));
}
var CompatUinList = class extends Array {
	constructor(initialUin = 1e4) {
		super();
		this.setPrimary(initialUin);
	}
	setPrimary(next) {
		const normalized = safeInt(next, 1e4);
		this.length = 0;
		this.push(normalized);
	}
	get primary() {
		return this[0] ?? 1e4;
	}
	toString() {
		return String(this.primary);
	}
	valueOf() {
		return this.primary;
	}
	[Symbol.toPrimitive](hint) {
		return hint === "number" ? this.primary : String(this.primary);
	}
};
function createIdentityLogger(identity, appendLog) {
	const levelMethods = {
		info: (...a) => appendLog("info", ...a),
		warn: (...a) => appendLog("warn", ...a),
		error: (...a) => appendLog("error", ...a),
		debug: (...a) => appendLog("debug", ...a),
		mark: (...a) => appendLog("info", "[MARK]", ...a),
		trace: (...a) => appendLog("debug", "[TRACE]", ...a),
		fatal: (...a) => appendLog("error", "[FATAL]", ...a)
	};
	const chalkProxy = new Proxy({}, { get(_target, prop) {
		if (typeof prop === "string") return identity;
	} });
	return new Proxy({
		...levelMethods,
		chalk: chalkProxy
	}, { get(target, prop, receiver) {
		if (typeof prop === "string" && !(prop in target)) return identity;
		return Reflect.get(target, prop, receiver);
	} });
}
const compatWarnedKeys = /* @__PURE__ */ new Set();
function warnCompatMissing(kind, label) {
	const key = `${kind}:${label}`;
	if (compatWarnedKeys.has(key)) return;
	compatWarnedKeys.add(key);
	log("warn", `[compat] 缺失${kind === "get" ? "属性" : kind === "call" ? "方法" : "构造器"}: ${label}`);
}
const wrapCompatValue = createCompatValueWrapper(warnCompatMissing);
function injectGlobals() {
	const g = globalThis;
	const identity = (s) => String(s);
	/** 追加日志到当天 command.log 文件（sendLog 插件会读取） */
	const appendLog = (level, ...args) => {
		log(level, ...args.map(String));
		try {
			const cwd = process.cwd();
			const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
			const logFile = path.join(cwd, "logs", `command.${today}.log`);
			const line = `[${(/* @__PURE__ */ new Date()).toTimeString().slice(0, 8)}][${level.toUpperCase().padStart(4)}] ${args.map(String).join(" ")}\n`;
			fs.appendFileSync(logFile, line);
		} catch {}
	};
	g.logger = createIdentityLogger(identity, appendLog);
	const uinList = new CompatUinList(1e4);
	const botInstance = {
		nickname: "Yunzai",
		/** Yunzai 插件常用的 Bot.logger 全局日志入口 */
		logger: g.logger,
		/** 频道 tiny_id（非频道场景为空字符串） */
		tiny_id: "",
		/** 头像 URL */
		avatar: "",
		fl: /* @__PURE__ */ new Map(),
		gl: /* @__PURE__ */ new Map(),
		gml: /* @__PURE__ */ new Map(),
		/** Bot 状态信息（兼容 icqq Bot.stat） */
		stat: {
			start_time: Math.floor(Date.now() / 1e3),
			recv_msg_cnt: 0,
			sent_msg_cnt: 0,
			msg_cnt_per_min: 0,
			recv_pkt_cnt: 0,
			sent_pkt_cnt: 0,
			lost_pkt_cnt: 0
		},
		getFriendMap: () => botInstance.fl,
		getGroupMap: () => botInstance.gl,
		pickFriend: (uid) => makeFriendProxy(uid, ""),
		pickGroup: (gid) => makeGroupProxy(gid),
		pickUser: (uid) => makeFriendProxy(uid, ""),
		/** 快捷获取群成员（等效 pickGroup(gid).pickMember(uid)） */
		pickMember: (gid, uid) => makeGroupProxy(gid).pickMember(uid),
		/** 发送群消息（部分插件直接调用 Bot.sendGroupMsg） */
		sendGroupMsg: async (gid, msg) => {
			return callApi("sendGroupMsg", {
				group_id: gid,
				contents: await serializeReply(msg)
			});
		},
		/** 发送私聊消息 */
		sendPrivateMsg: async (uid, msg) => {
			return callApi("sendPrivateMsg", {
				user_id: uid,
				contents: await serializeReply(msg)
			});
		},
		/** 获取群列表（填充 gl） */
		getGroupList: () => callApi("getGroupList").then((res) => {
			if (res?.data && Array.isArray(res.data)) {
				botInstance.gl.clear();
				for (const g of res.data) botInstance.gl.set(g.group_id, g);
			}
			return botInstance.gl;
		}).catch(() => botInstance.gl),
		/** 获取好友列表（填充 fl） */
		getFriendList: () => callApi("getFriendList").then((res) => {
			if (res?.data && Array.isArray(res.data)) {
				botInstance.fl.clear();
				for (const f of res.data) {
					const nickname = f.nickname ?? f.user_name ?? f.card ?? "";
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
		}).catch(() => botInstance.fl),
		/** 获取陌生人信息 */
		getStrangerInfo: (uid) => callApi("getStrangerInfo", { user_id: uid }).catch(() => ({})),
		/** 获取登录号信息 */
		getLoginInfo: () => callApi("getLoginInfo").then((res) => {
			if (res?.data) {
				botInstance.uin = res.data.UserId ?? res.data.user_id ?? botInstance.uin;
				botInstance.nickname = res.data.UserName ?? res.data.nickname ?? botInstance.nickname;
			}
			return {
				user_id: botInstance.uin,
				nickname: botInstance.nickname
			};
		}).catch(() => ({
			user_id: botInstance.uin,
			nickname: botInstance.nickname
		})),
		/** 获取群成员列表（同时填充 gml 缓存） */
		getGroupMemberList: (gid) => callApi("getGroupMemberList", { group_id: gid }).then((res) => {
			if (res?.data && Array.isArray(res.data)) {
				const map = /* @__PURE__ */ new Map();
				for (const m of res.data) map.set(m.user_id, m);
				botInstance.gml.set(gid, map);
				return map;
			}
			return botInstance.gml.get(gid) ?? /* @__PURE__ */ new Map();
		}).catch(() => botInstance.gml.get(gid) ?? /* @__PURE__ */ new Map()),
		/** 获取群成员信息 */
		getGroupMemberInfo: (gid, uid) => callApi("getGroupMemberInfo", {
			group_id: gid,
			user_id: uid
		}).catch(() => ({})),
		/** 获取转发消息（miao-plugin / ZZZ-Plugin 使用） */
		getForwardMsg: (resId) => callApi("getForwardMsg", { id: resId }).catch(() => ({ message: [] })),
		/** 获取 Cookies（genshin 插件米游社 Cookie 抓取可能需要） */
		getCookies: (domain) => callApi("getCookies", { domain: domain ?? "" }).catch(() => ({ cookies: "" })),
		/** 获取 CSRF Token */
		getCsrfToken: () => callApi("getCsrfToken").catch(() => ({ token: 0 })),
		/** 点赞（sendLike） */
		sendLike: (uid, times = 10) => callApi("sendLike", {
			user_id: uid,
			times
		}).catch(() => false),
		/** 获取陌生人列表 */
		getStrangerList: () => callApi("get_stranger_list").catch(() => []),
		/** 重载好友列表 */
		reloadFriendList: () => botInstance.getFriendList(),
		/** 重载群列表 */
		reloadGroupList: () => botInstance.getGroupList(),
		/** 重载黑名单 */
		reloadBlackList: () => callApi("get_blacklist").catch(() => []),
		/** 设置在线状态 */
		setOnlineStatus: (status) => callApi("set_online_status", { status }).catch(() => false),
		/** 设置昵称 */
		setNickname: (nickname) => callApi("set_qq_profile", { nickname }).catch(() => false),
		/** 设置性别 0未知 1男 2女 */
		setGender: (gender) => callApi("set_qq_profile", { gender }).catch(() => false),
		/** 设置生日 */
		setBirthday: (birthday) => callApi("set_qq_profile", { birthday }).catch(() => false),
		/** 设置个人说明 */
		setDescription: (description) => callApi("set_qq_profile", { description }).catch(() => false),
		/** 设置个性签名 */
		setSignature: (signature) => callApi("set_qq_profile", { signature }).catch(() => false),
		/** 设置头像 */
		setAvatar: (file) => callApi("set_qq_avatar", { file: String(file) }).catch(() => false),
		/** 获取个性签名 */
		getSignature: () => callApi("get_qq_profile").then((r) => r?.data?.signature ?? "").catch(() => ""),
		/** 图片 OCR */
		imageOcr: (image) => callApi("ocr_image", { image }).catch(() => ({
			texts: [],
			language: ""
		})),
		/** 获取视频下载地址 */
		getVideoUrl: (fid, md5) => callApi(".get_video_url", {
			fid,
			md5
		}).catch(() => ""),
		/** 获取系统消息（好友申请、群邀请） */
		getSystemMsg: () => callApi("get_group_system_msg").catch(() => ({
			InvitedRequests: [],
			join_requests: []
		})),
		/** 设为精华消息 */
		setEssenceMessage: (messageId) => callApi("set_essence_msg", { message_id: messageId }).catch(() => false),
		/** 移除精华消息 */
		removeEssenceMessage: (messageId) => callApi("delete_essence_msg", { message_id: messageId }).catch(() => false),
		/** 获取漫游表情 */
		getRoamingStamp: () => callApi(".get_roaming_stamp").catch(() => []),
		/** 删除漫游表情 */
		deleteStamp: (id) => callApi(".delete_stamp", { id }).catch(() => false),
		/** 清理缓存 */
		cleanCache: () => callApi("clean_cache").catch(() => false),
		/** 创建好友分组 */
		addClass: (name) => callApi(".add_class", { name }).catch(() => false),
		/** 删除好友分组 */
		deleteClass: (id) => callApi(".delete_class", { id }).catch(() => false),
		/** 重命名好友分组 */
		renameClass: (id, name) => callApi(".rename_class", {
			id,
			name
		}).catch(() => false),
		/**
		* 构造合并转发消息（Bot 级别）
		* ZZZ-Plugin / miao-plugin 使用 Bot.makeForwardMsg(msgs)
		* 展平节点为普通消息段数组
		*/
		makeForwardMsg: (msgs) => buildForwardMsgCompat(msgs),
		_events: /* @__PURE__ */ new Map(),
		on(event, fn) {
			const list = botInstance._events.get(event) ?? [];
			list.push(fn);
			botInstance._events.set(event, list);
			return this;
		},
		addListener(event, fn) {
			return this.on(event, fn);
		},
		prependListener(event, fn) {
			const list = botInstance._events.get(event) ?? [];
			list.unshift(fn);
			botInstance._events.set(event, list);
			return this;
		},
		once(event, fn) {
			const wrapper = (...args) => {
				this.off(event, wrapper);
				fn(...args);
			};
			return this.on(event, wrapper);
		},
		prependOnceListener(event, fn) {
			const wrapper = (...args) => {
				this.off(event, wrapper);
				fn(...args);
			};
			return this.prependListener(event, wrapper);
		},
		off(event, fn) {
			const list = botInstance._events.get(event);
			if (list) botInstance._events.set(event, list.filter((f) => f !== fn));
			return this;
		},
		removeListener(event, fn) {
			return this.off(event, fn);
		},
		emit(event, ...args) {
			const list = botInstance._events.get(event);
			if (list) for (const fn of [...list]) try {
				fn(...args);
			} catch {}
			return !!list?.length;
		},
		removeAllListeners(event) {
			if (event) botInstance._events.delete(event);
			else botInstance._events.clear();
			return this;
		},
		listenerCount(event) {
			return botInstance._events.get(event)?.length ?? 0;
		},
		listeners(event) {
			return [...botInstance._events.get(event) ?? []];
		},
		rawListeners(event) {
			return [...botInstance._events.get(event) ?? []];
		},
		eventNames() {
			return [...botInstance._events.keys()];
		},
		setMaxListeners(_n) {
			return this;
		},
		getMaxListeners() {
			return Infinity;
		},
		config: {
			platform: 1,
			log_level: "info",
			data_dir: path.join(process.cwd(), "data")
		},
		status: 11
	};
	Object.assign(botInstance, oneBotRuntime.createOneBotBotAdapter(botInstance));
	Object.defineProperty(botInstance, "uin", {
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
		get(target, prop, receiver) {
			if (typeof prop === "string" && /^\d+$/.test(prop)) return receiver;
			return target[prop];
		},
		has(target, prop) {
			if (typeof prop === "string" && /^\d+$/.test(prop)) return true;
			return prop in target;
		}
	}), "Bot");
	g.segment = {
		image: (file) => ({
			type: "image",
			file
		}),
		at: (qq, text) => ({
			type: "at",
			qq,
			text: text ?? ""
		}),
		face: (id) => ({
			type: "face",
			id
		}),
		text: (text) => ({
			type: "text",
			text
		}),
		record: (file) => ({
			type: "record",
			file
		}),
		video: (file) => ({
			type: "video",
			file
		}),
		json: (data) => ({
			type: "json",
			data: typeof data === "string" ? data : JSON.stringify(data)
		}),
		xml: (data) => ({
			type: "xml",
			data
		}),
		poke: (id) => ({
			type: "poke",
			id
		}),
		reply: (id) => ({
			type: "reply",
			id
		}),
		share: (url, title, content, image) => ({
			type: "share",
			url,
			title: title ?? "",
			content: content ?? "",
			image: image ?? ""
		}),
		music: (type, id) => ({
			type: "music",
			data: {
				type,
				id
			}
		}),
		forward: (resId) => ({
			type: "forward",
			id: resId
		}),
		/** 文件消息段 */
		file: (file, name) => ({
			type: "file",
			file,
			name: name ?? ""
		}),
		/** 位置消息段 */
		location: (lat, lng, title, content) => ({
			type: "location",
			data: {
				lat,
				lon: lng,
				title: title ?? "",
				content: content ?? ""
			}
		}),
		/** 骰子 */
		dice: (id) => ({
			type: "dice",
			id: id ?? 0
		}),
		/** 猜拳 */
		rps: (id) => ({
			type: "rps",
			id: id ?? 0
		}),
		/** Markdown 消息 */
		markdown: (content) => ({
			type: "markdown",
			data: { content }
		}),
		/** mirai 消息透传 */
		mirai: (data) => ({
			type: "mirai",
			data
		}),
		/** 小表情（已废弃，兼容保留） */
		bface: (file, text) => ({
			type: "bface",
			file,
			text: text ?? ""
		}),
		sface: (id, text) => ({
			type: "sface",
			id,
			text: text ?? ""
		}),
		/** Yunzai polyfill — 按钮消息（多数平台不支持，返回空字符串） */
		button: () => "",
		/** 转发消息节点（构建合并转发消息时使用） */
		node: (user_id, nickname, content) => ({
			type: "node",
			data: {
				user_id,
				nickname,
				content
			}
		})
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
function normalizeReplyContents(contents) {
	const quote = contents.find((content) => content.type === "quote")?.data;
	const body = contents.filter((content) => content.type !== "quote");
	if (!quote) return body;
	if (body.length === 0) return [{
		type: "text",
		data: "",
		quoteMessageId: quote
	}];
	return [{
		...body[0],
		quoteMessageId: body[0].quoteMessageId ?? quote
	}, ...body.slice(1)];
}
function addQuote(contents, messageId) {
	if (!messageId || contents.some((content) => content.quoteMessageId)) return contents;
	if (contents.length === 0) return [{
		type: "text",
		data: "",
		quoteMessageId: messageId
	}];
	return [{
		...contents[0],
		quoteMessageId: messageId
	}, ...contents.slice(1)];
}
function pickSegmentParams(msg, keys) {
	const hasNestedData = msg?.data && typeof msg.data === "object";
	const source = hasNestedData ? msg.data : msg;
	const params = Object.fromEntries(keys.map((key) => [key, source?.[key]]).filter(([key, value]) => {
		return !(key === "type" && !hasNestedData && value === msg?.type) && [
			"string",
			"number",
			"boolean"
		].includes(typeof value);
	}));
	return Object.keys(params).length > 0 ? params : void 0;
}
/**
* Format 无法表达但 OneBot 常见的结构化段，保留其原生 data 交给父进程发送。
* 不把它们 JSON.stringify 成文本，避免 OneBot 本身支持时也被桥接层丢失功能。
*/
function serializeNativeOnlySegment(msg) {
	const nativeData = msg?.data && typeof msg.data === "object" && !Array.isArray(msg.data) ? msg.data : Object.fromEntries(Object.entries(msg ?? {}).filter(([key]) => key !== "type"));
	return {
		type: "raw",
		data: "",
		nativeType: String(msg?.type ?? ""),
		nativeData
	};
}
/**
* Worker 与 OneBot 服务可能不在同一台机器；本地媒体路径必须在 Worker 侧读成
* base64 后跨 IPC 发送，不能把 file:// 或绝对路径交给远端 OneBot 去猜。
*/
async function serializeReplyMediaFile(value) {
	if (Buffer.isBuffer(value)) return value.toString("base64");
	const file = String(value ?? "");
	const filePath = file.startsWith("file://") ? file.slice(7) : file;
	if (!filePath.startsWith("/")) return file;
	try {
		return (await fs.promises.readFile(filePath)).toString("base64");
	} catch {
		return file;
	}
}
async function serializeReplyContent(msg) {
	if (typeof msg === "string") return [{
		type: "text",
		data: msg
	}];
	if (Buffer.isBuffer(msg)) return [{
		type: "image",
		data: msg.toString("base64")
	}];
	if (Array.isArray(msg)) return (await Promise.all(msg.map(serializeReplyContent))).flat();
	if (msg && typeof msg === "object") {
		if (Array.isArray(msg.__forwardNodes)) {
			const fallback = normalizeReplyContents(await serializeReplyContent(msg.__forwardParts ?? buildForwardMsgParts(msg.__forwardNodes)));
			return [{
				type: "forward",
				data: String(msg.data ?? msg.toString?.() ?? ""),
				nodes: msg.__forwardNodes,
				fallback
			}];
		}
		if (Array.isArray(msg.__forwardParts)) return serializeReplyContent(msg.__forwardParts);
		switch (msg.type) {
			case "image": return [{
				type: "image",
				data: await serializeReplyMediaFile(msg.file),
				params: pickSegmentParams(msg, [
					"cache",
					"proxy",
					"timeout",
					"type",
					"subType",
					"summary"
				])
			}];
			case "at": return [{
				type: "at",
				data: String(msg.qq ?? msg.data?.qq ?? "")
			}];
			case "face": return [{
				type: "face",
				data: String(msg.id)
			}];
			case "text": return [{
				type: "text",
				data: msg.text ?? ""
			}];
			case "record": return [{
				type: "record",
				data: await serializeReplyMediaFile(msg.file),
				params: pickSegmentParams(msg, [
					"cache",
					"proxy",
					"timeout",
					"magic"
				])
			}];
			case "video": return [{
				type: "video",
				data: await serializeReplyMediaFile(msg.file),
				params: pickSegmentParams(msg, [
					"cache",
					"proxy",
					"timeout"
				])
			}];
			case "json": return [{
				type: "json",
				data: typeof msg.data === "string" ? msg.data : JSON.stringify(msg.data)
			}];
			case "xml": return [{
				type: "xml",
				data: msg.data ?? ""
			}];
			case "share":
			case "poke":
			case "music":
			case "file":
			case "location":
			case "dice":
			case "rps":
			case "markdown":
			case "mirai":
			case "bface":
			case "sface": return [serializeNativeOnlySegment(msg)];
			case "reply": return [{
				type: "quote",
				data: String(msg.id ?? msg.data?.id ?? "")
			}];
			default: return [{
				type: "other",
				data: JSON.stringify(msg)
			}];
		}
	}
	return [{
		type: "text",
		data: String(msg)
	}];
}
async function serializeReply(msg) {
	return normalizeReplyContents(await serializeReplyContent(msg));
}
/** 检测消息段中是否 at 了 self_id */
function detectAtMe(message, selfId) {
	return message.some((s) => s.type === "at" && String(s.data?.qq ?? s.qq) === String(selfId));
}
/** 检测消息段中是否 at all */
function detectAtAll(message) {
	return message.some((s) => s.type === "at" && (s.data?.qq === "all" || s.qq === "all"));
}
/**
* 提取消息段中第一个非自身、非 all 的 at 目标 QQ
* 用于在 buildEvent 中预填 e.at，作为 dealMsg 的安全兜底
*/
function extractFirstAtTarget(message, selfId) {
	for (const s of message) {
		if (s.type !== "at") continue;
		const qq = s.data?.qq ?? s.qq;
		if (qq === null || qq === void 0 || qq === "all" || String(qq) === String(selfId)) continue;
		return qq;
	}
}
/**
* 将跨平台媒体附件（来自 AlemonJS MessageMedia）转为 icqq 消息段
* 使得来自 Discord/Telegram 等平台的图片也能被 Yunzai 插件感知
*/
function mediaToSegments(media) {
	if (!Array.isArray(media) || media.length === 0) return [];
	return media.map((m) => {
		switch (m.type) {
			case "image":
			case "sticker": return {
				type: "image",
				file: m.url ?? m.fileId ?? "",
				url: m.url
			};
			case "audio": return {
				type: "record",
				file: m.url ?? m.fileId ?? "",
				url: m.url
			};
			case "video": return {
				type: "video",
				file: m.url ?? m.fileId ?? "",
				url: m.url
			};
			default: return {
				type: "file",
				file: m.url ?? m.fileId ?? "",
				name: m.fileName
			};
		}
	});
}
/** 安全转 number（非 QQ 平台的 userId 可能是非数字字符串） */
function safeInt(v, fallback) {
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
function makeGroupProxy(groupId, opts) {
	return oneBotRuntime.createOneBotGroupAdapter(groupId, opts);
}
/**
* 创建 e.friend 代理对象
* 通过 callApi 实现真实的私聊操作
*/
function makeFriendProxy(userId, userName) {
	return oneBotRuntime.createOneBotFriendAdapter(userId, userName);
}
/** 判断是否是消息类事件名称 */
function isMessageEventName(name) {
	return name.includes("message.create") || name.includes("interaction");
}
/** AlemonJS 事件名 → icqq notice 类型映射 */
const EVENT_NOTICE_MAP = {
	"member.add": {
		notice_type: "group_increase",
		sub_type: "approve"
	},
	"member.remove": {
		notice_type: "group_decrease",
		sub_type: "leave"
	},
	"member.ban": {
		notice_type: "group_ban",
		sub_type: "ban"
	},
	"member.unban": {
		notice_type: "group_ban",
		sub_type: "lift_ban"
	},
	"member.update": {
		notice_type: "group_admin",
		sub_type: "set"
	},
	"notice.create": {
		notice_type: "notify",
		sub_type: "poke"
	},
	"private.notice.create": {
		notice_type: "notify",
		sub_type: "poke"
	},
	"message.delete": {
		notice_type: "group_recall",
		sub_type: ""
	},
	"private.message.delete": {
		notice_type: "friend_recall",
		sub_type: ""
	}
};
/** AlemonJS 事件名 → icqq request 类型映射 */
const EVENT_REQUEST_MAP = {
	"private.friend.add": {
		request_type: "friend",
		sub_type: "add"
	},
	"private.guild.add": {
		request_type: "group",
		sub_type: "invite"
	}
};
/**
* 跨平台降级构建非消息类 icqq 事件
* 根据 AlemonJS 事件名映射到 icqq notice/request 类型
*/
function buildFallbackNonMessageEvent(data, selfId, platformTag, reply, eventName) {
	const userId = safeInt(data.userId, 10001);
	const groupId = data.isPrivate ? 0 : safeInt(data.spaceId, 0);
	const masterFlag = resolveMasterFlag(data);
	const e = {
		self_id: selfId,
		time: Math.floor(Date.now() / 1e3),
		user_id: userId,
		group_id: groupId,
		isMaster: masterFlag,
		isOwner: masterFlag,
		isAdmin: masterFlag,
		reply,
		getMemberMap: () => groupId ? makeGroupProxy(groupId).getMemberMap() : /* @__PURE__ */ new Map(),
		getAvatarUrl: (size = 0) => data.userAvatar ?? `https://q1.qlogo.cn/g?b=qq&s=${size}&nk=${userId}`,
		logFnc: ""
	};
	const noticeMap = EVENT_NOTICE_MAP[eventName];
	const requestMap = EVENT_REQUEST_MAP[eventName];
	if (noticeMap) {
		e.post_type = "notice";
		e.notice_type = noticeMap.notice_type;
		e.sub_type = noticeMap.sub_type;
		e.operator_id = userId;
		e.logText = `${platformTag}[Notice:${noticeMap.notice_type}:${groupId ?? userId}]`;
	} else if (requestMap) {
		e.post_type = "request";
		e.request_type = requestMap.request_type;
		e.sub_type = requestMap.sub_type;
		e.comment = "";
		e.flag = `${eventName}_${Date.now()}`;
		e.approve = (approve = true) => callApi(requestMap.request_type === "friend" ? "setFriendAddRequest" : "setGroupAddRequest", {
			flag: e.flag,
			approve,
			type: requestMap.sub_type
		}).catch(() => false);
		e.reject = (reason = "") => callApi(requestMap.request_type === "friend" ? "setFriendAddRequest" : "setGroupAddRequest", {
			flag: e.flag,
			approve: false,
			reason,
			type: requestMap.sub_type
		}).catch(() => false);
		e.logText = `${platformTag}[Request:${requestMap.request_type}:${userId}]`;
	} else {
		e.post_type = "notice";
		e.notice_type = eventName;
		e.sub_type = "";
		e.logText = `${platformTag}[Event:${eventName}:${groupId ?? userId}]`;
	}
	if (groupId) e.group = makeGroupProxy(groupId);
	if (userId) {
		e.friend = makeFriendProxy(userId, data.userName ?? "User");
		e.member = {
			user_id: userId,
			card: data.userName ?? "",
			nickname: data.userName ?? "",
			role: "member",
			is_admin: masterFlag,
			is_owner: masterFlag,
			_info: {
				card: data.userName ?? "",
				nickname: data.userName ?? "",
				role: "member"
			},
			getAvatarUrl: (size = 0) => data.userAvatar ?? `https://q1.qlogo.cn/g?b=qq&s=${size}&nk=${userId}`
		};
	}
	e.sender = {
		user_id: userId,
		nickname: data.userName ?? "User",
		card: data.userName ?? "",
		role: "member"
	};
	e.nickname = data.userName ?? "User";
	return e;
}
/**
* 将跨平台 master 用户 ID 注入到 Cfg.masterQQ
* 使 loader.js dealMsg() 中的 masterQQ.includes() 检查能正确识别
*/
function injectMasterQQ(userId) {
	const cfg = globalThis._yunzaiCfg;
	if (!cfg) return;
	try {
		const masterList = cfg.masterQQ ?? [];
		const uid = Number(userId) || String(userId);
		if (!masterList.includes(uid)) masterList.push(uid);
	} catch {}
}
function resolveMasterFlag(data) {
	return data.isMaster ?? data.IsMaster ?? false;
}
function buildEvent(data, msgId) {
	const raw = data.rawEvent;
	const masterFlag = resolveMasterFlag(data);
	const botUin = globalThis.Bot?.uin ?? 1e4;
	const selfId = raw?.self_id !== null && raw?.self_id !== void 0 ? safeInt(raw.self_id, botUin) : safeInt(data.botId, botUin);
	const platformTag = data.platform ? `[${data.platform}]` : "";
	if (selfId !== 1e4 && botUin === 1e4) globalThis.Bot.uin = selfId;
	if (masterFlag && data.userId) injectMasterQQ(data.userId);
	const reply = async (msg, quote = false) => {
		const contents = addQuote(await serializeReply(msg), quote ? String(raw?.message_id ?? data.messageId ?? "") : void 0);
		const replyId = `r_${++replyIdCounter}_${Date.now()}`;
		if (globalThis.Bot?.stat) globalThis.Bot.stat.sent_msg_cnt++;
		log("debug", `[reply] id=${msgId} replyId=${replyId} contents=${JSON.stringify(contents).slice(0, 200)}`);
		const resultPromise = new Promise((resolve) => {
			replyPending.set(replyId, { resolve });
			setTimeout(() => {
				if (replyPending.has(replyId)) {
					replyPending.delete(replyId);
					resolve({ message_id: `reply_${Date.now()}` });
				}
			}, 8e3);
		});
		ipcSend({
			type: "reply",
			id: msgId,
			replyId,
			contents,
			channelId: data.spaceId || void 0,
			userId: data.userId || void 0,
			isPrivate: data.isPrivate
		});
		return resultPromise;
	};
	if (isOneBotPlatform(data.platform) && raw && typeof raw === "object" && raw.post_type) return oneBotRuntime.buildOneBotEvent({
		data,
		msgId,
		selfId,
		reply
	});
	const eventName = data.eventName ?? "";
	if (eventName && !isMessageEventName(eventName)) return buildFallbackNonMessageEvent(data, selfId, platformTag, reply, eventName);
	const isGroup = !data.isPrivate;
	const userId = safeInt(data.userId, 10001);
	const groupId = isGroup ? safeInt(data.spaceId, 10002) : 0;
	const messageParts = [];
	if (data.messageText) messageParts.push({
		type: "text",
		text: data.messageText
	});
	if (Array.isArray(data.atUsers)) for (const u of data.atUsers) {
		const uid = safeInt(u.userId, 0);
		messageParts.push({
			type: "at",
			qq: uid || u.userId,
			text: u.userName ?? ""
		});
	}
	messageParts.push(...mediaToSegments(data.media));
	if (messageParts.length === 0) messageParts.push({
		type: "text",
		text: ""
	});
	const e = {
		post_type: "message",
		message_type: isGroup ? "group" : "private",
		sub_type: isGroup ? "normal" : "friend",
		user_id: userId,
		sender: {
			user_id: userId,
			nickname: data.userName ?? "User",
			card: data.userName ?? "",
			role: "member"
		},
		message: messageParts,
		raw_message: data.messageText,
		msg: "",
		group_id: groupId,
		group_name: isGroup ? `Group ${groupId}` : "",
		isMaster: masterFlag,
		isOwner: masterFlag,
		isAdmin: masterFlag,
		message_id: data.messageId ?? `cross_${Date.now()}`,
		seq: Date.now(),
		rand: Math.random(),
		time: Math.floor(Date.now() / 1e3),
		self_id: selfId,
		font: "",
		atme: detectAtMe(messageParts, selfId),
		atall: detectAtAll(messageParts),
		at: extractFirstAtTarget(messageParts, selfId) ?? void 0,
		reply,
		getMemberMap: () => isGroup ? makeGroupProxy(groupId).getMemberMap() : /* @__PURE__ */ new Map(),
		getAvatarUrl: (size = 0) => data.userAvatar || `https://q1.qlogo.cn/g?b=qq&s=${size}&nk=${userId}`,
		toString: () => data.messageText,
		...isGroup ? {
			group: makeGroupProxy(groupId),
			friend: void 0
		} : {
			group: void 0,
			friend: makeFriendProxy(userId, data.userName ?? "User")
		},
		member: {
			user_id: userId,
			card: data.userName ?? "",
			nickname: data.userName ?? "",
			role: "member",
			is_admin: masterFlag,
			is_owner: masterFlag,
			_info: {
				card: data.userName ?? "",
				nickname: data.userName ?? "",
				role: "member"
			},
			getAvatarUrl: (size = 0) => data.userAvatar || `https://q1.qlogo.cn/g?b=qq&s=${size}&nk=${userId}`
		},
		nickname: data.userName ?? "User",
		/** 便捷方法：构建转发消息 */
		makeForwardMsg: (nodes) => {
			if (isGroup && groupId) return makeGroupProxy(groupId).makeForwardMsg(nodes);
			return makeFriendProxy(userId, data.userName ?? "User").makeForwardMsg(nodes);
		}
	};
	e.original_msg = data.messageText;
	e.logText = `${platformTag}[${isGroup ? "Group" : "Private"}:${isGroup ? groupId : userId}] ${data.messageText}`;
	e.logFnc = "";
	return e;
}
let PluginsLoader = null;
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
function emitBotEvent(e) {
	const bot = globalThis.Bot;
	if (!bot?.emit) return;
	const postType = e.post_type;
	if (!postType) return;
	bot.emit(postType, e);
	let sub1 = "";
	if (postType === "message") sub1 = e.message_type ?? "";
	else if (postType === "notice") sub1 = (e.notice_type ?? "").replace(/_/g, ".");
	else if (postType === "request") sub1 = (e.request_type ?? "").replace(/_/g, ".");
	if (sub1) bot.emit(`${postType}.${sub1}`, e);
	const sub2 = e.sub_type ?? "";
	if (sub1 && sub2) bot.emit(`${postType}.${sub1}.${sub2}`, e);
}
async function main() {
	const cwd = process.cwd();
	log("info", `Worker 启动, cwd=${cwd}`);
	injectGlobals();
	const configDir = path.join(cwd, "config", "config");
	if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
	const logsDir = path.join(cwd, "logs");
	if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
	const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
	const commandLog = path.join(logsDir, `command.${today}.log`);
	if (!fs.existsSync(commandLog)) fs.writeFileSync(commandLog, "");
	try {
		const redisMod = await import(pathToFileURL(path.join(cwd, "lib", "config", "redis.js")).href);
		await (redisMod.default ?? redisMod.redisInit)();
		log("info", "Redis 初始化成功（Miao-Yunzai）");
	} catch (err) {
		log("error", `Redis 初始化失败: ${err.message}`);
		ipcSend({
			type: "error",
			message: `Redis 初始化失败: ${err.message}`
		});
		process.exit(1);
	}
	try {
		const mod = await import(pathToFileURL(path.join(cwd, "lib", "plugins", "plugin.js")).href);
		globalThis.plugin = mod.default ?? mod.plugin;
		log("info", "plugin 基类加载成功");
	} catch (err) {
		log("warn", `plugin 基类加载失败，使用内置空壳: ${err.message}`);
		const stateArr = /* @__PURE__ */ new Map();
		globalThis.plugin = class {
			name = "plugin";
			dsc = "";
			event = "message";
			priority = 5e3;
			rule = [];
			task = null;
			handler = null;
			namespace = "";
			e = null;
			constructor(opt = {}) {
				Object.assign(this, opt);
			}
			reply(msg, quote) {
				return this.e?.reply?.(msg, quote);
			}
			conKey(isGroup = false) {
				if (isGroup) return `${this.name}.${this.e?.group_id}`;
				return `${this.name}.${this.e?.user_id}`;
			}
			setContext(type, isGroup = false, time = 120) {
				const key = this.conKey(isGroup);
				stateArr.set(key, { type });
				if (time > 0) setTimeout(() => {
					if (stateArr.has(key)) {
						stateArr.delete(key);
						this.e?.reply?.("操作超时已取消");
					}
				}, time * 1e3);
			}
			getContext(type, isGroup = false) {
				const key = this.conKey(isGroup);
				const ctx = stateArr.get(key);
				if (type && ctx?.type !== type) return;
				return ctx;
			}
			finish(_type, isGroup = false) {
				const key = this.conKey(isGroup);
				stateArr.delete(key);
			}
			/** 等待上下文回复（Promise 模式） */
			awaitContext(type, isGroup = false, time = 120) {
				return new Promise((resolve, reject) => {
					this.setContext(type, isGroup, time);
					const key = this.conKey(isGroup);
					const check = setInterval(() => {
						const ctx = stateArr.get(key);
						if (!ctx) {
							clearInterval(check);
							reject(/* @__PURE__ */ new Error("上下文已超时"));
						} else if (ctx.resolve) {
							clearInterval(check);
							stateArr.delete(key);
							resolve(ctx.resolve);
						}
					}, 500);
					setTimeout(() => clearInterval(check), (time + 5) * 1e3);
				});
			}
			/** 解析上下文（与 awaitContext 配合） */
			resolveContext(e) {
				const key = this.conKey(!!e?.isGroup);
				const ctx = stateArr.get(key);
				if (ctx) ctx.resolve = e;
			}
		};
	}
	try {
		PluginsLoader = (await import(pathToFileURL(path.join(cwd, "lib", "plugins", "loader.js")).href)).default;
		log("info", "PluginsLoader 加载成功");
	} catch (err) {
		log("error", `PluginsLoader 加载失败: ${err.message}`);
		ipcSend({
			type: "error",
			message: `Loader 加载失败: ${err.message}`
		});
		process.exit(1);
	}
	try {
		await PluginsLoader.load();
		const count = PluginsLoader.priority?.length ?? 0;
		log("info", `插件加载完成，共 ${count} 个`);
		try {
			const cfgMod = await import(pathToFileURL(path.join(cwd, "lib", "config", "config.js")).href);
			const cfg = cfgMod.default ?? cfgMod.cfg;
			if (cfg) {
				globalThis._yunzaiCfg = cfg;
				log("info", `Cfg 实例已获取，当前 masterQQ: [${cfg.masterQQ}]`);
			}
		} catch {
			log("warn", "获取 Cfg 实例失败，跨平台 master 需手动配置 masterQQ");
		}
		globalThis.Bot?.getLoginInfo?.()?.catch?.(() => {});
		globalThis.Bot?.getGroupList?.()?.catch?.(() => {});
		globalThis.Bot?.getFriendList?.()?.catch?.(() => {});
		ipcSend({
			type: "ready",
			pluginCount: count
		});
	} catch (err) {
		log("error", `插件加载失败: ${err.message}`);
		ipcSend({
			type: "error",
			message: `插件加载失败: ${err.message}`
		});
		process.exit(1);
	}
	process.on("message", (msg) => {
		if (msg.type === "event") runWithExecutionContext({
			msgId: msg.id,
			platform: msg.data.platform ?? ""
		}, async () => {
			if (globalThis.Bot?.stat) globalThis.Bot.stat.recv_msg_cnt++;
			const e = buildEvent(msg.data, msg.id);
			let replied = false;
			const origReply = e.reply;
			e.reply = (m, q = false) => {
				replied = true;
				return origReply(m, q);
			};
			try {
				emitBotEvent(e);
				const rawMsg = String(e.msg ?? "").trim();
				if (BLOCKED_COMMANDS.test(rawMsg)) {
					const hint = rawMsg.includes("更新") ? "#yz更新" : rawMsg.includes("重启") ? "#yz重启" : "#yz停止";
					e.reply(`该指令已被接管，请使用 ${hint}`);
					ipcSend({
						type: "done",
						id: msg.id,
						replied: true
					});
					return;
				}
				await PluginsLoader.deal(e);
			} catch (err) {
				log("error", `deal 异常: ${err.message}`);
				log("error", err.stack ?? "");
				ipcSend({
					type: "reply",
					id: msg.id,
					replyId: `r_${++replyIdCounter}_${Date.now()}`,
					contents: [{
						type: "text",
						data: `[Yunzai 错误] ${err.message}`
					}]
				});
				replied = true;
			}
			ipcSend({
				type: "done",
				id: msg.id,
				replied
			});
		});
		else if (msg.type === "api_response") handleApiResponse(msg);
		else if (msg.type === "reply_result") handleReplyResult(msg);
		else if (msg.type === "shutdown") {
			log("info", "Worker 收到关闭信号，退出");
			process.exit(0);
		}
	});
}
main().catch((err) => {
	log("error", `Worker 启动失败: ${err.message}`);
	process.exit(1);
});

//#endregion
export {  };