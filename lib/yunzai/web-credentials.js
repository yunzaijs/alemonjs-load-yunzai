//#region src/yunzai/web-credentials.ts
/** QQ 网页凭据只保存在 Worker 内存，按真实账号隔离，不输出或持久化。 */
var OneBotWebCredentials = class {
	callApi;
	currentBotId;
	now;
	entries = /* @__PURE__ */ new Map();
	constructor(callApi, currentBotId, now = Date.now) {
		this.callApi = callApi;
		this.currentBotId = currentBotId;
		this.now = now;
	}
	entry(botId = this.currentBotId()) {
		let value = this.entries.get(botId);
		if (!value) {
			value = {
				cookies: Object.create(null),
				requests: /* @__PURE__ */ new Map()
			};
			this.entries.set(botId, value);
		}
		return value;
	}
	clearExpired(entry) {
		for (const [key, request] of entry.requests) {
			if (request.until > this.now()) continue;
			if (key === "csrf") entry.bkn = void 0;
			else Reflect.deleteProperty(entry.cookies, key.slice(7));
		}
	}
	get cookies() {
		const entry = this.entry();
		this.clearExpired(entry);
		return entry.cookies;
	}
	get bkn() {
		const entry = this.entry();
		this.clearExpired(entry);
		return entry.bkn;
	}
	load(entry, key, read, fetch) {
		this.clearExpired(entry);
		const cached = entry.requests.get(key);
		if (cached?.pending) return cached.pending;
		if (cached && cached.until > this.now()) return cached.error ? Promise.reject(cached.error) : Promise.resolve(read());
		const request = { until: 0 };
		entry.requests.set(key, request);
		request.pending = Promise.resolve().then(fetch).then((value) => {
			request.until = this.now() + 3e5;
			return value;
		}, () => {
			request.error = /* @__PURE__ */ new Error(key === "csrf" ? "OneBot 未提供可用的 QQ 网页 CSRF token" : "OneBot 未提供可用的 QQ 网页 Cookie");
			request.until = this.now() + 3e4;
			throw request.error;
		}).finally(() => {
			request.pending = void 0;
		});
		return request.pending;
	}
	getCookies(domain = "") {
		const entry = this.entry();
		return this.load(entry, `cookie:${domain}`, () => entry.cookies[domain], async () => {
			const response = await this.callApi("getCookies", { domain });
			const payload = response?.data ?? response;
			const cookie = typeof payload === "string" ? payload : payload?.cookies;
			if (typeof cookie !== "string" || !cookie.trim()) throw new Error("OneBot 未提供可用的 QQ 网页 Cookie");
			entry.cookies[domain] = cookie;
			return cookie;
		});
	}
	getCsrfToken() {
		const entry = this.entry();
		return this.load(entry, "csrf", () => entry.bkn, async () => {
			const response = await this.callApi("getCsrfToken");
			const payload = response?.data ?? response;
			const token = payload?.token ?? payload;
			if (typeof token !== "number" || !Number.isSafeInteger(token) || token < 0) throw new Error("OneBot 未提供可用的 QQ 网页 CSRF token");
			entry.bkn = token;
			return token;
		});
	}
	/** 同步读取 cookies/bkn 的插件运行前，在其事件上下文中准备凭据。 */
	async prepare(domains = ["qun.qq.com"], csrf = true) {
		const failure = (await Promise.allSettled([...Array.from(new Set(domains), (domain) => this.getCookies(domain)), ...csrf ? [this.getCsrfToken()] : []])).find((result) => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
	}
};
function needsQQWebCredentials(message) {
	return /^#(?:(?:查|发|删)群?公告|今日打卡)/.test(message.trim());
}

//#endregion
export { OneBotWebCredentials, needsQQWebCredentials };