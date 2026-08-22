//#region src/yunzai/forward.ts
/**
* Yunzai/icqq 的转发节点一般是 { user_id, nickname, message }，而 OneBot
* send_*_forward_msg 要求 messages 中每项都是 { type: 'node', data: { ..., content } }。
* 不能把前者原样透传，否则 OneBot 会以参数错误拒绝私聊合并转发。
*/
function toOneBotForwardNode(node) {
	const source = node?.type === "node" && node?.data && typeof node.data === "object" ? node.data : node ?? {};
	if (source.id !== void 0 && source.id !== null && source.id !== "") return {
		type: "node",
		data: { id: String(source.id) }
	};
	const rawUserId = source.user_id ?? source.userId;
	const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;
	const content = source.content ?? source.message ?? "";
	const data = {
		user_id: userId ?? "",
		nickname: String(source.nickname ?? source.name ?? ""),
		content
	};
	if (source.time !== void 0 && source.time !== null) data.time = Number(source.time);
	return {
		type: "node",
		data
	};
}
/**
* 原生动作诊断摘要。绝不输出媒体数据本身，避免 base64 图片进入日志。
*/
function summarizeNativeOneBotRequest(request) {
	const segments = "message" in request.params ? request.params.message : request.params.messages;
	const summary = (Array.isArray(segments) ? segments : []).map((segment) => {
		const type = String(segment?.type ?? "unknown");
		const file = segment?.data?.file;
		if (typeof file === "string" && file.startsWith("base64://")) return `${type}(base64≈${Math.floor((file.length - 9) * 3 / 4)}B)`;
		return type;
	});
	const target = request.action.includes("_group_") ? "group" : "private";
	return `action=${request.action}, target=${target}, segments=${summary.join(",") || "none"}`;
}
function getTargetId(value) {
	if (value === void 0 || value === null || String(value) === "") return;
	return String(value);
}
/**
* 将转发消息节点展平为普通消息段数组。
* 非 OneBot 平台和原生 API 不可用时使用该结果作为可读降级内容。
*/
function buildForwardMsgParts(nodes) {
	if (!Array.isArray(nodes) || nodes.length === 0) return [];
	const parts = [];
	for (const node of nodes) {
		const nodeData = node?.data && node.type === "node" ? node.data : node;
		const msg = nodeData?.message ?? nodeData?.content ?? node;
		const nickname = nodeData?.nickname ?? node?.nickname ?? "";
		if (nickname) parts.push({
			type: "text",
			text: `【${nickname}】\n`
		});
		if (typeof msg === "string") parts.push({
			type: "text",
			text: msg + "\n"
		});
		else if (Array.isArray(msg)) {
			parts.push(...msg);
			parts.push({
				type: "text",
				text: "\n"
			});
		} else if (msg && typeof msg === "object") {
			parts.push(msg);
			parts.push({
				type: "text",
				text: "\n"
			});
		}
	}
	return parts;
}
/**
* 构造 icqq 兼容的合并转发对象：保留原始 nodes 用于 OneBot 原生发送，
* 同时保存展平消息段供跨平台降级。
*/
function buildForwardMsgCompat(nodes) {
	const forwardNodes = Array.isArray(nodes) ? nodes : [];
	const parts = buildForwardMsgParts(forwardNodes);
	const text = parts.map((part) => {
		if (part?.type === "text") return String(part.text ?? part.data?.text ?? "");
		return "";
	}).join("");
	return {
		type: "forward",
		data: text,
		file: "",
		id: "",
		resid: "",
		message: parts,
		messages: parts,
		__forwardNodes: forwardNodes,
		__forwardParts: parts,
		toString: () => text
	};
}
/** 单个原生合并转发才可映射到 OneBot 的整条消息发送动作。 */
function getNativeForwardRequest(contents, target) {
	if (contents.length !== 1) return null;
	const forward = contents[0];
	if (forward?.type !== "forward" || forward.quoteMessageId || !Array.isArray(forward.nodes) || forward.nodes.length === 0) return null;
	if (target.isPrivate) {
		const userId = getTargetId(target.userId);
		if (!userId) return null;
		return {
			action: "send_private_forward_msg",
			params: {
				user_id: userId,
				messages: forward.nodes.map(toOneBotForwardNode)
			}
		};
	}
	const groupId = getTargetId(target.groupId);
	if (!groupId) return null;
	return {
		action: "send_group_forward_msg",
		params: {
			group_id: groupId,
			messages: forward.nodes.map(toOneBotForwardNode)
		}
	};
}
/**
* 部分 OneBot 实现（尤其私聊）没有实现 send_*_forward_msg。动作被服务端明确
* 拒绝后，用 Worker 已构建好的完整展平内容发送普通消息：登录链接、图片等业务
* 数据仍可到达，只缺失服务端本来就不支持的“合并转发展示容器”。
*/
function getNativeForwardFallbackRequest(contents, target) {
	if (contents.length !== 1 || contents[0]?.type !== "forward" || contents[0].quoteMessageId) return null;
	const forward = contents[0];
	return getNativeMessageRequest(forward.fallback?.length ? forward.fallback : forward.data ? [{
		type: "text",
		data: forward.data
	}] : [], target);
}
/**
* 规范化媒体来源，使原生 OneBot 与 Format → OneBot 的输入含义一致。
*
* JPEG 的 base64 常以 /9j/ 开头，不能按“以 / 开头即本地路径”处理；data URI
* 也必须剥掉头部后再交给 OneBot。这里绝不记录原始媒体内容。
*/
function normalizeOneBotMediaSource(value) {
	const data = String(value ?? "");
	const dataUri = data.match(/^data:[^;,]+;base64,([A-Za-z0-9+/_-]+={0,2})$/i);
	if (dataUri) return `base64://${dataUri[1].replace(/-/g, "+").replace(/_/g, "/")}`;
	if (data.startsWith("base64://")) return data;
	if (data.startsWith("buffer://")) return `base64://${data.slice(9)}`;
	if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(data) && data.length >= 16 && data.length % 4 === 0) return `base64://${data.replace(/-/g, "+").replace(/_/g, "/")}`;
	if (/^https?:\/\//.test(data) || data.startsWith("file://") || data.startsWith("/")) return data;
	return `base64://${data}`;
}
function toOneBotFile(data) {
	return normalizeOneBotMediaSource(data);
}
/**
* 仅当 Format 通用接口能不丢失 OneBot 段语义时，才允许原生动作失败后重试。
* 引用、合并转发、表情、JSON/XML，以及媒体控制参数均没有等价的 Format 表示，
* 因此不能悄悄降成文本或普通消息。
*/
function canUseGenericOneBotFallback(contents) {
	const directlyRepresentable = /* @__PURE__ */ new Set([
		"text",
		"at",
		"image",
		"record",
		"video"
	]);
	return contents.length > 0 && contents.every((content) => directlyRepresentable.has(content.type) && !content.quoteMessageId && Object.keys(content.params ?? {}).length === 0);
}
function withSegmentParams(params, required, segmentType) {
	return {
		...Object.fromEntries(Object.entries(params ?? {}).filter(([key, value]) => key !== "type" || value !== segmentType)),
		...required
	};
}
function toOneBotSegments(contents) {
	const result = [];
	for (const content of contents) {
		if (content.type === "quote") continue;
		if (content.type === "forward") {
			if (content.fallback?.length) result.push(...toOneBotSegments(content.fallback));
			else if (content.data) result.push({
				type: "text",
				data: { text: content.data }
			});
			continue;
		}
		switch (content.type) {
			case "text":
				result.push({
					type: "text",
					data: { text: content.data }
				});
				break;
			case "at":
				result.push({
					type: "at",
					data: { qq: content.data }
				});
				break;
			case "image":
			case "record":
			case "video":
				result.push({
					type: content.type,
					data: withSegmentParams(content.params, { file: toOneBotFile(content.data) }, content.type)
				});
				break;
			case "face":
				result.push({
					type: "face",
					data: { id: content.data }
				});
				break;
			case "json":
			case "xml":
				result.push({
					type: content.type,
					data: { data: content.data }
				});
				break;
			case "raw":
				if (content.nativeType && content.nativeData) result.push({
					type: content.nativeType,
					data: content.nativeData
				});
				break;
			default: result.push({
				type: "text",
				data: { text: content.data }
			});
		}
	}
	return result;
}
/** 没有转发或引用时，标准 OneBot 段可直接发送，避免经 Format 丢失段语义。 */
function getNativeMessageRequest(contents, target) {
	const supportedTypes = /* @__PURE__ */ new Set([
		"text",
		"at",
		"image",
		"record",
		"video",
		"face",
		"json",
		"xml",
		"raw"
	]);
	if (contents.length === 0 || contents.some((content) => content.quoteMessageId ?? (content.type === "raw" && (!content.nativeType || !content.nativeData))) || !contents.every((content) => supportedTypes.has(content.type))) return null;
	const message = toOneBotSegments(contents);
	if (target.isPrivate) {
		const userId = getTargetId(target.userId);
		return userId ? {
			action: "send_private_msg",
			params: {
				user_id: userId,
				message
			}
		} : null;
	}
	const groupId = getTargetId(target.groupId);
	return groupId ? {
		action: "send_group_msg",
		params: {
			group_id: groupId,
			message
		}
	} : null;
}
/** 引用消息使用标准 send_*_msg 动作；携带转发时改发可读 fallback，确保引用不丢失。 */
function getNativeQuoteRequest(contents, target) {
	const quoteMessageId = contents.find((content) => content.quoteMessageId)?.quoteMessageId;
	if (!quoteMessageId) return null;
	const message = [{
		type: "reply",
		data: { id: quoteMessageId }
	}, ...toOneBotSegments(contents)];
	if (target.isPrivate) {
		const userId = getTargetId(target.userId);
		return userId ? {
			action: "send_private_msg",
			params: {
				user_id: userId,
				message
			}
		} : null;
	}
	const groupId = getTargetId(target.groupId);
	return groupId ? {
		action: "send_group_msg",
		params: {
			group_id: groupId,
			message
		}
	} : null;
}
/**
* OneBot 的“引用”和“合并转发”分别是不同动作，无法装入同一条消息。此前会把
* 转发摊成文本来保留引用，导致合并转发体验丢失；现在拆成一条引用正文和一条
* 原生合并转发，两个语义均可保留。
*/
function getNativeQuotedForwardRequests(contents, target) {
	const forwards = contents.filter((content) => content.type === "forward");
	const quoteMessageId = contents.find((content) => content.quoteMessageId)?.quoteMessageId;
	if (forwards.length !== 1 || !quoteMessageId) return null;
	const forward = forwards[0];
	const forwardRequest = getNativeForwardRequest([{
		...forward,
		quoteMessageId: void 0
	}], target);
	if (!forwardRequest) return null;
	const quoteBody = contents.filter((content) => content !== forward);
	const quoteRequest = getNativeQuoteRequest(quoteBody.length > 0 ? [{
		...quoteBody[0],
		quoteMessageId
	}, ...quoteBody.slice(1)] : [{
		type: "text",
		data: "[转发消息]",
		quoteMessageId
	}], target);
	return quoteRequest ? [quoteRequest, forwardRequest] : null;
}
function getNativeOneBotRequest(contents, target) {
	return getNativeForwardRequest(contents, target) ?? getNativeQuoteRequest(contents, target) ?? getNativeMessageRequest(contents, target);
}
/** 只对明确的“该动作/参数不被实现支持”错误进行降级，避免超时后重复发送。 */
function isUnsupportedOneBotActionError(error) {
	const value = error;
	const message = [
		value?.message,
		value?.wording,
		value?.error,
		typeof error === "string" ? error : ""
	].filter(Boolean).join(" ");
	return [
		/(unsupported|not\s+support(?:ed)?|not\s+implemented|不支持|未实现)/i,
		/(unknown\s+action|action\s+not\s+found|未知(?:动作|接口))/i,
		/(invalid\s+(?:param|parameter)|参数(?:错误|不支持))/i
	].some((pattern) => pattern.test(message));
}
function getReplyMessageId(result) {
	const messageId = result?.MessageId ?? result?.message_id ?? result?.data?.MessageId ?? result?.data?.message_id;
	return messageId === void 0 || messageId === null ? void 0 : String(messageId);
}
/** 将 OneBot failed 响应提升为 Error，便于按错误确定性决定是否降级。 */
function assertOneBotActionSucceeded(result) {
	if (Array.isArray(result)) {
		const success = result.find((item) => item?.code === 2e3);
		if (success) return success.data;
		const failure = result.find((item) => item && typeof item === "object" && "code" in item);
		if (failure) {
			const response = failure.data?.oneBotResponse;
			throw Object.assign(/* @__PURE__ */ new Error(`OneBot action failed (${String(failure.code)}: ${String(failure.message ?? "unknown error")})`), {
				oneBotActionRejected: true,
				oneBotResultCode: failure.code,
				oneBotResponse: response
			});
		}
	}
	if (result?.status === "failed" || typeof result?.retcode === "number" && result.retcode !== 0) throw Object.assign(new Error(result?.wording ?? result?.message ?? `OneBot action failed (retcode=${result?.retcode ?? "unknown"})`), result);
	return result;
}
async function getOneBotActiveVersion(client) {
	if (!client.getConnectionStatus) return;
	try {
		const status = assertOneBotActionSucceeded(await client.getConnectionStatus());
		const version = Number(status?.activeVersion);
		return version === 11 || version === 12 ? version : void 0;
	} catch {
		return;
	}
}
function getV12UploadParams(file) {
	const input = String(file ?? "");
	if (/^https?:\/\//.test(input)) return {
		type: "url",
		url: input
	};
	if (input.startsWith("file://")) return {
		type: "path",
		path: input.slice(7)
	};
	if (input.startsWith("base64://") || input.startsWith("buffer://")) return {
		type: "data",
		data: input.slice(input.indexOf("://") + 3)
	};
	return {
		type: "data",
		data: input
	};
}
async function toV12Message(client, message) {
	const sendV12Action = client.sendV12Action;
	if (!sendV12Action) throw new Error("OneBot v12 原生动作不可用");
	return await Promise.all(message.map(async (segment) => {
		const type = segment?.type;
		if (type === "text") return {
			type: "text",
			data: { text: String(segment?.data?.text ?? "") }
		};
		if (type === "at") {
			const qq = String(segment?.data?.qq ?? "");
			return qq === "all" ? {
				type: "mention_all",
				data: {}
			} : {
				type: "mention",
				data: { user_id: qq }
			};
		}
		if ([
			"image",
			"record",
			"video"
		].includes(type)) {
			const uploaded = assertOneBotActionSucceeded(await sendV12Action("upload_file", getV12UploadParams(segment?.data?.file)));
			const fileId = uploaded?.file_id ?? uploaded?.id;
			if (!fileId) throw new Error(`OneBot v12 upload_file 未返回 file_id (${type})`);
			return {
				type: type === "record" ? "voice" : type,
				data: { file_id: String(fileId) }
			};
		}
		return segment;
	}));
}
async function sendV12Message(client, request) {
	if (!client.sendV12Action) throw new Error("OneBot v12 原生动作不可用");
	const message = await toV12Message(client, request.params.message);
	const params = request.action === "send_group_msg" ? {
		detail_type: "group",
		group_id: request.params.group_id,
		message
	} : {
		detail_type: "private",
		user_id: request.params.user_id,
		message
	};
	return assertOneBotActionSucceeded(await client.sendV12Action("send_message", params));
}
/**
* 普通消息使用与 OneBot 通用消息适配器相同的语义方法；该适配器内部也是
* sendGroupMessage/sendPrivateMessage。只有合并转发没有对应语义方法时才透传 action。
*/
async function sendNativeForward(client, request) {
	if ((request.action === "send_group_msg" || request.action === "send_private_msg") && await getOneBotActiveVersion(client) === 12) return sendV12Message(client, request);
	if (request.action === "send_group_msg" && client.sendGroupMessage) return assertOneBotActionSucceeded(await client.sendGroupMessage(request.params));
	if (request.action === "send_private_msg" && client.sendPrivateMessage) return assertOneBotActionSucceeded(await client.sendPrivateMessage(request.params));
	return assertOneBotActionSucceeded(await client.send(request));
}

//#endregion
export { assertOneBotActionSucceeded, buildForwardMsgCompat, buildForwardMsgParts, canUseGenericOneBotFallback, getNativeForwardFallbackRequest, getNativeForwardRequest, getNativeMessageRequest, getNativeOneBotRequest, getNativeQuoteRequest, getNativeQuotedForwardRequests, getReplyMessageId, isUnsupportedOneBotActionError, normalizeOneBotMediaSource, sendNativeForward, summarizeNativeOneBotRequest };