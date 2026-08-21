import { ResultCode } from "alemonjs";

//#region src/yunzai/send-result.ts
/**
* AlemonJS 平台适配器常以 Result[] 表示失败，而非 reject Promise。
*
* OneBot 的 sendGroup/sendPrivate 正是这种行为；若不显式检查，Worker 会
* 收到“发送成功”的回执，日志却没有任何可用于排查图片上传失败的线索。
*/
function assertMessageSendSucceeded(result) {
	const summary = getPlatformFailureSummary(result);
	if (!summary) return;
	const failure = (Array.isArray(result) ? result : [result]).find((item) => item && typeof item === "object" && item.code !== ResultCode.Ok && item.data?.oneBotResponse);
	throw Object.assign(/* @__PURE__ */ new Error(`平台消息发送失败 (${summary})`), { oneBotResponse: (failure?.data)?.oneBotResponse });
}
/** 返回平台 Result[] 的失败摘要；不展开 data，避免记录敏感或大体积数据。 */
function getPlatformFailureSummary(result) {
	const entries = (Array.isArray(result) ? result : [result]).filter((item) => Boolean(item) && typeof item === "object" && "code" in item);
	if (entries.length === 0 || entries.some((item) => item.code === ResultCode.Ok)) return;
	return entries.map((item) => `${String(item.code)}:${String(item.message ?? "unknown error")}`).join("; ");
}
/** 只记录类型和大小，禁止把 base64 图片正文写进日志。 */
function summarizeReplyContents(contents) {
	const images = contents.filter((item) => item.type === "image");
	if (images.length === 0) return `segments=${contents.length}`;
	const imageBytes = images.reduce((total, item) => total + Math.floor(item.data.length * 3 / 4), 0);
	return `segments=${contents.length}, images=${images.length}, imageBytes≈${imageBytes}`;
}
function describeValue(value) {
	if (value === null) return "null";
	if (value === void 0) return "undefined";
	if (typeof value === "string") return `${value.startsWith("base64://") || /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? "base64" : value.startsWith("http") ? "url" : "string"}(length=${value.length})`;
	if (Array.isArray(value)) return `array(length=${value.length})`;
	if (typeof value === "object") return `object(keys=${Object.keys(value).sort().join(",") || "none"})`;
	return typeof value;
}
function redactMediaText(value) {
	return String(value ?? "").replace(/(uri\s*=\s*)(?:base64:\/\/)?[A-Za-z0-9+/]{16,}={0,2}/gi, "$1<redacted-base64>");
}
/** 用于排障的回复结构；绝不序列化媒体正文。 */
function describeReplyContents(contents) {
	return contents.map((content, index) => {
		const params = Object.keys(content.params ?? {}).sort();
		return `#${index}:${String(content.type ?? "unknown")}{data=${describeValue(content.data)},params=${params.join(",") || "none"}}`;
	}).join("; ");
}
/** 用于排障的 Format 结构；图片/base64 仅输出长度。 */
function describeFormatContents(contents) {
	return contents.map((content, index) => {
		const options = Object.keys(content.options ?? {}).sort();
		return `#${index}:${String(content.type ?? "unknown")}{value=${describeValue(content.value)},options=${options.join(",") || "none"}}`;
	}).join("; ");
}
/** OneBot 原始响应的安全摘要。 */
function describeOneBotError(error) {
	const response = error?.oneBotResponse;
	if (!response || typeof response !== "object") return redactMediaText(error?.message ?? String(error));
	return `status=${String(response.status ?? "unknown")}, retcode=${String(response.retcode ?? "unknown")}, wording=${redactMediaText(response.wording ?? response.message ?? "none")}, data=${describeValue(response.data)}`;
}

//#endregion
export { assertMessageSendSucceeded, describeFormatContents, describeOneBotError, describeReplyContents, getPlatformFailureSummary, summarizeReplyContents };