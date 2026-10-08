import path from "node:path";
import fs from "node:fs/promises";

//#region src/yunzai/web-capabilities.ts
/** 只读取源码中的凭据依赖，不导入或改写插件。动态域名仍可经 getCookies 显式查询。 */
function inspectQQWebCapabilities(source) {
	const domains = /* @__PURE__ */ new Set();
	for (const pattern of [/\bcookies\s*\[\s*['"`]([^'"`]+)['"`]\s*\]/g, /\b(?:getCookies|getck)\s*\(\s*['"`]([^'"`]*)['"`]/g]) for (const match of source.matchAll(pattern)) {
		const domain = match[1].toLowerCase();
		if (domain === "" || /^(?:[a-z0-9-]+\.)+qq\.com$/.test(domain) || domain === "qq.com") domains.add(domain);
	}
	return {
		domains: [...domains].sort(),
		csrf: /\b(?:bkn|getCsrfToken)\b/.test(source)
	};
}
async function discoverQQWebCapabilities(directory) {
	const domains = /* @__PURE__ */ new Set();
	let csrf = false;
	async function visit(dir) {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith(".") || [
				"node_modules",
				"resources",
				"data",
				"temp"
			].includes(entry.name)) continue;
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) await visit(file);
			else if (entry.isFile() && /\.(?:[cm]?js|ts)$/.test(entry.name)) {
				if ((await fs.stat(file)).size > 2097152) continue;
				const capabilities = inspectQQWebCapabilities(await fs.readFile(file, "utf8"));
				capabilities.domains.forEach((domain) => domains.add(domain));
				csrf ||= capabilities.csrf;
			}
		}
	}
	await visit(directory);
	return {
		domains: [...domains].sort(),
		csrf
	};
}

//#endregion
export { discoverQQWebCapabilities, inspectQQWebCapabilities };