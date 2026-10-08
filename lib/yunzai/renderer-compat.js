//#region src/yunzai/renderer-compat.ts
const installed = /* @__PURE__ */ new WeakSet();
/** 为只有模板截图接口的渲染器补齐浏览器接口，真实页面操作交给 Puppeteer 后端。 */
function installRendererBrowserCompat(loader, report) {
	if (!loader || typeof loader.getRenderer !== "function" || installed.has(loader)) return;
	installed.add(loader);
	const patched = /* @__PURE__ */ new WeakSet();
	const original = loader.getRenderer;
	function patch(renderer) {
		if (!renderer || typeof renderer !== "object" || typeof renderer.browserInit === "function" || patched.has(renderer)) return renderer;
		patched.add(renderer);
		let pending;
		let reportedUnavailable = false;
		let previousCount = Number(renderer.renderNum) || 0;
		const backend = () => Array.from(loader.renderers?.values?.() ?? []).find((candidate) => candidate !== renderer && typeof candidate?.browserInit === "function" && !patched.has(candidate));
		if (renderer.renderNum === void 0) renderer.renderNum = 0;
		Object.defineProperty(renderer, "browser", {
			configurable: true,
			get: () => backend()?.browser ?? false
		});
		renderer.browserInit = () => {
			const target = backend();
			if (!target) {
				if (!reportedUnavailable) {
					reportedUnavailable = true;
					report("当前渲染器需要浏览器接口，但没有可用的 Puppeteer 后端");
				}
				return Promise.resolve(false);
			}
			if (pending) return pending;
			pending = Promise.resolve().then(() => target.browserInit()).catch(() => {
				report("Puppeteer 浏览器初始化失败，网页功能将使用插件原有降级流程");
				return false;
			}).finally(() => {
				pending = void 0;
			});
			return pending;
		};
		if (typeof renderer.restart !== "function") renderer.restart = (...args) => {
			const target = backend();
			if (!target || typeof target.restart !== "function") return;
			const count = Number(renderer.renderNum) || 0;
			target.renderNum = (Number(target.renderNum) || 0) + Math.max(0, count - previousCount);
			previousCount = count;
			return Promise.resolve().then(() => target.restart(...args)).catch(() => {
				report("Puppeteer 浏览器重启失败，下次调用将重新初始化");
				return false;
			});
		};
		return renderer;
	}
	loader.getRenderer = function(...args) {
		return patch(Reflect.apply(original, this, args));
	};
}

//#endregion
export { installRendererBrowserCompat };