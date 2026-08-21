//#region src/yunzai/onebot-ingress.ts
const DEFAULT_DEDUP_TTL = 12e4;
const DEFAULT_MAX_ENTRIES = 2e3;
var OneBotIngressGuard = class {
	ttl;
	maxEntries;
	recent = /* @__PURE__ */ new Map();
	constructor(ttl = DEFAULT_DEDUP_TTL, maxEntries = DEFAULT_MAX_ENTRIES) {
		this.ttl = ttl;
		this.maxEntries = maxEntries;
	}
	/** `true` 表示事件可以进入 Yunzai Worker。 */
	accept(platform, raw, now = Date.now()) {
		if (platform !== "onebot" || !raw || typeof raw !== "object") return true;
		const event = raw;
		if (!this.isMessageEvent(event)) return true;
		if (this.isSelfMessage(event)) return false;
		const key = this.getMessageKey(event);
		if (!key) return true;
		this.prune(now);
		if (this.recent.has(key)) return false;
		this.recent.set(key, now + this.ttl);
		this.trim();
		return true;
	}
	isMessageEvent(event) {
		return event.post_type === "message" || event.type === "message";
	}
	isSelfMessage(event) {
		const selfId = event.self_id ?? event.self?.user_id;
		const userId = event.user_id ?? event.sender?.user_id;
		return selfId !== void 0 && userId !== void 0 && String(selfId) === String(userId);
	}
	getMessageKey(event) {
		const messageId = event.message_id ?? event.id;
		if (messageId === void 0 || messageId === null || messageId === "") return;
		return `${event.self_id ?? event.self?.user_id ?? ""}:${event.message_type ?? event.detail_type ?? ""}:${event.group_id ?? event.user_id ?? ""}:${messageId}`;
	}
	prune(now) {
		for (const [key, expiresAt] of this.recent) if (expiresAt <= now) this.recent.delete(key);
	}
	trim() {
		while (this.recent.size > this.maxEntries) {
			const oldest = this.recent.keys().next().value;
			if (oldest === void 0) return;
			this.recent.delete(oldest);
		}
	}
};

//#endregion
export { OneBotIngressGuard };