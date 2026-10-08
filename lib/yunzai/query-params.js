//#region src/yunzai/query-params.ts
/** QQ 查询参数必须是有效的正整数，不能把插件残余文本发给 OneBot。 */
function requireOneBotUserId(value) {
	const text = String(value ?? "");
	const id = Number(text);
	if (!/^\d+$/.test(text) || !Number.isSafeInteger(id) || id <= 0) throw new Error("无效的 OneBot 用户 ID：需要正整数 QQ 号");
	return id;
}
/** 保留负数 ID 和不透明字符串；禁止 Number() 把 ID 转成 NaN 或丢失精度。 */
function normalizeOneBotMessageId(value) {
	if (typeof value === "number" && Number.isSafeInteger(value)) return value;
	if (typeof value === "string" && value.trim()) {
		if (/^-?\d+$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
		return value;
	}
	throw new Error("无效的 OneBot 消息 ID");
}

//#endregion
export { normalizeOneBotMessageId, requireOneBotUserId };