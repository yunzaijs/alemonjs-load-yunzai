import { getConfigValue } from "alemonjs";
import { existsSync, renameSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

//#region src/path.ts
/**
* 路径配置
*
* 配置相关的值通过函数导出，每次调用时从 getConfigValue() 实时读取，
* 支持 AlemonJS 动态修改配置后立即生效。
*/
const __dirname = dirname(fileURLToPath(import.meta.url));
/** 插件包根目录 (alemonjs-load-yunzai/) */
const PACKAGE_ROOT = join(__dirname, "..");
/** Worker 脚本路径 (编译后位于 lib/yunzai/worker.js) */
const WORKER_PATH = join(__dirname, "yunzai", "worker.js");
/** 内置 yarn 入口脚本路径 */
const YARN_PATH = join(PACKAGE_ROOT, "runtime", "yarn", "yarn.cjs");
const DEFAULT_GH_PROXY = "https://ghfast.top/";
const YUNZAI_DIRECTORY_NAME = "Yunzai";
const DEFAULT_YUNZAI_REPO = "https://github.com/TimeRainStarSky/Yunzai.git";
const DEFAULT_MIAO_PLUGIN_REPO = "https://github.com/yoimiya-kokomi/miao-plugin.git";
const DEFAULT_EVENT_CONCURRENCY = 1;
function getConfig$1() {
	return (getConfigValue() ?? {})["alemonjs-load-yunzai"] ?? {};
}
/** GitHub 代理前缀 */
function getGhProxy() {
	const configured = getConfig$1()?.gh_proxy;
	const proxy = configured === void 0 ? DEFAULT_GH_PROXY : String(configured).trim();
	if (!proxy) return "";
	return proxy.endsWith("/") ? proxy : `${proxy}/`;
}
/** 默认 Yunzai 仓库地址 */
function getDefaultRepo() {
	const repo = getConfig$1()?.yunzai_repo ?? DEFAULT_YUNZAI_REPO;
	return `${getGhProxy()}${repo}`;
}
/** miao-plugin 仓库地址 */
function getMiaoPluginRepo() {
	const repo = getConfig$1()?.miao_plugin_repo ?? DEFAULT_MIAO_PLUGIN_REPO;
	return `${getGhProxy()}${repo}`;
}
/**
* 同时交给 Yunzai Worker 处理的事件数。
*
* Yunzai 的 Puppeteer 后端使用单个共享 Chromium，默认串行可避免任一渲染
* 失败时重启浏览器、连带中断其他截图任务。需要更高吞吐时可显式调大。
*/
function getYunzaiEventConcurrency() {
	const value = Number(getConfig$1()?.event_concurrency ?? DEFAULT_EVENT_CONCURRENCY);
	if (!Number.isFinite(value)) return DEFAULT_EVENT_CONCURRENCY;
	return Math.min(4, Math.max(1, Math.floor(value)));
}
function repoDirName(repoUrl) {
	return (repoUrl.trim().replace(/\/+$/, "").replace(/\.git$/i, "").split(/[/:]/).pop()?.trim() ?? "") || "unknown-plugin";
}
function resolvePluginDirName(plugin) {
	return plugin.dirName?.trim() ?? repoDirName(plugin.repoUrl);
}
/** 内置插件列表（每个插件只定义一次） */
const BUILTIN_PLUGINS = [
	{
		aliases: [
			"miao",
			"miaomiao",
			"原神"
		],
		repoUrl: "https://github.com/yoimiya-kokomi/miao-plugin.git",
		label: "miao-plugin",
		variants: ["miao", "trss"]
	},
	{
		aliases: [
			"trss原神",
			"trssgenshin",
			"genshin"
		],
		dirName: "genshin",
		repoUrl: "https://github.com/TimeRainStarSky/Yunzai-genshin.git",
		label: "Yunzai-genshin",
		requires: ["miao-plugin"],
		variants: ["trss"]
	},
	{
		aliases: ["starrail", "星铁"],
		repoUrl: "https://gitee.com/hewang1an/StarRail-plugin.git",
		label: "StarRail-plugin"
	},
	{
		aliases: ["zzz"],
		repoUrl: "https://gitee.com/bietiaop/ZZZ-Plugin.git",
		label: "ZZZ-Plugin"
	},
	{
		aliases: ["图鉴"],
		repoUrl: "https://cnb.cool/tar/xiaoyao-cvs-plugin.git",
		label: "xiaoyao-cvs-plugin"
	},
	{
		aliases: ["锅巴", "guoba"],
		repoUrl: "https://gitee.com/guoba-yunzai/guoba-plugin.git",
		label: "guoba-plugin"
	},
	{
		aliases: ["喵喵扩展", "liangshi"],
		repoUrl: "https://gitee.com/liangshi233/liangshi-calc.git",
		label: "liangshi-calc"
	},
	{
		aliases: [
			"明日方舟",
			"方舟",
			"endfield"
		],
		repoUrl: "https://github.com/yoshino-xiao7/endfield-suzuki-plugin.git",
		label: "endfield-suzuki-plugin"
	},
	{
		aliases: ["终末地", "zmd"],
		repoUrl: "https://github.com/Anon-deisu/zmd-plugin.git",
		label: "zmd-plugin"
	},
	{
		aliases: ["三角洲", "delta"],
		repoUrl: "https://github.com/Dnyo666/delta-force-plugin.git",
		label: "delta-force-plugin"
	},
	{
		aliases: ["王者荣耀", "王者"],
		repoUrl: "https://gitee.com/Tloml-Starry/GloryOfKings-Plugin.git",
		label: "GloryOfKings-Plugin"
	},
	{
		aliases: ["尘白禁区", "尘白"],
		repoUrl: "https://github.com/Sakura1618/cb-plugin.git",
		label: "cb-plugin"
	},
	{
		aliases: ["鸣潮", "waves"],
		repoUrl: "https://github.com/erzaozi/waves-plugin.git",
		label: "waves-plugin"
	},
	{
		aliases: ["重返未来", "1999"],
		repoUrl: "https://gitee.com/fantasy-hx/1999-plugin.git",
		label: "1999-plugin"
	},
	{
		aliases: ["库洛", "kuro"],
		repoUrl: "https://github.com/TomyJan/Yunzai-Kuro-Plugin.git",
		label: "Yunzai-Kuro-Plugin"
	},
	{
		aliases: ["光遇", "sky"],
		repoUrl: "https://gitee.com/Tloml-Starry/Tlon-Sky.git",
		label: "Tlon-Sky"
	}
];
/** 展开别名数组为 alias → PluginInfo 的扁平映射 */
function buildAliasMap(plugins) {
	const map = {};
	for (const plugin of plugins) {
		const { aliases, repoUrl, label } = plugin;
		const info = {
			dirName: resolvePluginDirName(plugin),
			repoUrl,
			label
		};
		for (const alias of aliases) map[alias] = info;
	}
	return map;
}
const BUILTIN_PLUGIN_MAP = buildAliasMap(BUILTIN_PLUGINS);
/**
* 合并内置插件与用户自定义插件配置
* 用户可在 alemon.config.yaml 的 alemonjs-load-yunzai.plugins 中添加：
* ```yaml
* alemonjs-load-yunzai:
*   plugins:
*     别名:
*       dirName: 插件目录名（可选，省略时使用仓库名）
*       repoUrl: git仓库地址
*       label: 显示名称
*       aliases:          # 可选，额外别名
*         - 别名2
*         - 别名3
* ```
*/
function getPluginAliasMap() {
	const custom = getConfig$1()?.plugins ?? {};
	const merged = { ...BUILTIN_PLUGIN_MAP };
	for (const [alias, raw] of Object.entries(custom)) if (raw && typeof raw === "object" && raw.repoUrl) {
		const repoUrl = String(raw.repoUrl);
		const dirName = resolvePluginDirName({
			dirName: typeof raw.dirName === "string" ? raw.dirName : void 0,
			repoUrl
		});
		const info = {
			dirName,
			repoUrl,
			label: raw.label ?? dirName
		};
		merged[alias.toLowerCase()] = info;
		const extraAliases = Array.isArray(raw.aliases) ? raw.aliases : [];
		for (const a of extraAliases) if (typeof a === "string" && a) merged[a.toLowerCase()] = info;
	}
	return merged;
}
/**
* 返回所有可用插件（内置 + 用户自定义），按 dirName 去重
*/
function getAllPlugins(variant) {
	const result = BUILTIN_PLUGINS.filter((plugin) => !variant || !plugin.variants || plugin.variants.includes(variant)).map((plugin) => ({
		...plugin,
		dirName: resolvePluginDirName(plugin)
	}));
	const seen = new Set(result.map((p) => resolvePluginDirName(p)));
	const custom = getConfig$1()?.plugins ?? {};
	for (const [alias, raw] of Object.entries(custom)) if (raw && typeof raw === "object" && raw.repoUrl) {
		const repoUrl = String(raw.repoUrl);
		const dirName = resolvePluginDirName({
			dirName: typeof raw.dirName === "string" ? raw.dirName : void 0,
			repoUrl
		});
		if (seen.has(dirName)) continue;
		seen.add(dirName);
		const extraAliases = Array.isArray(raw.aliases) ? raw.aliases : [];
		result.push({
			dirName,
			repoUrl,
			label: raw.label ?? dirName,
			aliases: [alias, ...extraAliases]
		});
	}
	return result;
}
/** 根据用户输入的别名查找插件信息（大小写不敏感） */
function getPluginInfo(alias) {
	return getPluginAliasMap()[alias.toLowerCase()];
}
/** Yunzai 安装目录（固定名称；发行版身份读取 package.json.name） */
function getYunzaiDir() {
	return join(process.cwd(), YUNZAI_DIRECTORY_NAME);
}
/**
* 迁移旧版本可配置目录名。
* 只在新目录不存在时执行，且只处理旧配置中的目录名和历史默认名，避免覆盖数据。
*/
function migrateLegacyYunzaiDir() {
	const target = getYunzaiDir();
	if (existsSync(target)) return {
		migrated: false,
		target
	};
	const configuredName = getConfig$1()?.bot_name;
	const candidates = /* @__PURE__ */ new Set(["Miao-Yunzai"]);
	if (typeof configuredName === "string" && /^[^\\/:*?"<>|]+$/.test(configuredName.trim())) candidates.add(configuredName.trim());
	for (const name of candidates) {
		const source = join(process.cwd(), name);
		if (source === target || !existsSync(source)) continue;
		renameSync(source, target);
		return {
			migrated: true,
			source,
			target
		};
	}
	return {
		migrated: false,
		target
	};
}

//#endregion
export { PACKAGE_ROOT, WORKER_PATH, YARN_PATH, getAllPlugins, getDefaultRepo, getGhProxy, getMiaoPluginRepo, getPluginInfo, getYunzaiDir, getYunzaiEventConcurrency, migrateLegacyYunzaiDir };