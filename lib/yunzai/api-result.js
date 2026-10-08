//#region src/yunzai/api-result.ts
function isPlatformResult(value) {
	return value && typeof value === "object" && typeof value.code === "number" && value.code >= 2e3 && value.code < 6e3 && ("message" in value || "data" in value);
}
/** 只移除 AlemonJS Result 包装，普通消息/成员数组仍保持数组。 */
function unwrapOneBotResult(result) {
	const entries = Array.isArray(result) && result.length > 0 && result.every(isPlatformResult) ? result : isPlatformResult(result) ? [result] : void 0;
	if (entries) {
		const success = entries.find((item) => item.code === 2e3);
		if (!success) {
			const failure = entries[0];
			const detail = failure.data;
			const response = detail?.oneBotResponse ?? (detail && (detail.retcode !== void 0 || detail.status === "failed") ? detail : void 0);
			const message = response?.wording ?? response?.message ?? detail?.message ?? failure.message ?? "unknown error";
			const legacyNativeRejection = failure.code === 4e3 && failure.message === "请求失败" && detail === null;
			throw Object.assign(/* @__PURE__ */ new Error(`OneBot action failed (${failure.code}: ${message})`), {
				oneBotResultCode: failure.code,
				oneBotResponse: response,
				oneBotActionRejected: legacyNativeRejection || Boolean(response && (response.status === "failed" || Number(response.retcode) > 1))
			});
		}
		result = success.data;
	}
	if (result?.status === "failed" || result?.retcode !== void 0 && ![0, 1].includes(Number(result.retcode))) throw Object.assign(new Error(result.wording ?? result.message ?? `OneBot action failed (retcode=${result.retcode})`), {
		oneBotResponse: result,
		oneBotActionRejected: true
	});
	return result;
}
/** useClient 是深代理，每个方法都返回 Result[]，不是原生 OneBot data。 */
function createOneBotClientCompat(client) {
	return new Proxy(client, { get(target, key) {
		const method = Reflect.get(target, key);
		if (typeof method !== "function" || key === "then") return method;
		return async (...args) => unwrapOneBotResult(await Reflect.apply(method, target, args));
	} });
}
/** Bot.sendApi 的插件契约为 OneBot response，不能泄露宿主 Result[] 包装。 */
function toOneBotApiResponse(result) {
	const payload = unwrapOneBotResult(result);
	if (payload && typeof payload === "object" && ("retcode" in payload || "status" in payload) && "data" in payload) return payload;
	return {
		status: "ok",
		retcode: 0,
		data: payload
	};
}
/** 标准 hooks 结果保留 data 访问方式，兼容现有 Worker 查询适配器。 */
function normalizeWorkerApiResult(result) {
	if (Array.isArray(result) && result.length > 0 && result.every(isPlatformResult) || isPlatformResult(result)) return { data: unwrapOneBotResult(result) };
	return result;
}

//#endregion
export { createOneBotClientCompat, normalizeWorkerApiResult, toOneBotApiResponse, unwrapOneBotResult };