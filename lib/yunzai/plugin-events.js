//#region src/yunzai/plugin-events.ts
const compatibleFilters = /* @__PURE__ */ new WeakSet();
/** 兼容 icqq 点号通知名与 OneBot 下划线通知名，不改写原始事件或插件配置。 */
function installPluginEventCompatibility(loader) {
	const original = loader?.filtEvent;
	if (typeof original !== "function" || compatibleFilters.has(original)) return;
	const aliases = /* @__PURE__ */ new WeakMap();
	const filter = function(e, rule) {
		if (original.call(this, e, rule)) return true;
		if (e?.post_type !== "notice" || typeof e.notice_type !== "string" || typeof rule?.event !== "string") return false;
		const prefix = `notice.${e.notice_type.replace(/_/g, ".")}`;
		if (!e.notice_type.includes("_") || rule.event !== prefix && !rule.event.startsWith(`${prefix}.`)) return false;
		let cached = aliases.get(rule);
		if (!cached || cached.source !== rule.event || cached.noticeType !== e.notice_type) {
			cached = {
				source: rule.event,
				noticeType: e.notice_type,
				rule: { event: `notice.${e.notice_type}${rule.event.slice(prefix.length)}` }
			};
			aliases.set(rule, cached);
		}
		return original.call(this, e, cached.rule);
	};
	compatibleFilters.add(filter);
	loader.filtEvent = filter;
}

//#endregion
export { installPluginEventCompatibility };