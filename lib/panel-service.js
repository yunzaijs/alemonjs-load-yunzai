import { getGhProxy, getYunzaiDir } from "./path.js";
import { executeYunzaiActionLocal, getStatusSnapshotLocal, installPluginArchiveLocal } from "./yunzai/control.js";
import { createDataBackup, getDataBackups, restoreDataBackup, saveUploadedDataBackup } from "./yunzai/data-backup.js";
import { deletePluginArchiveEntry, extractPluginArchiveEntry, getPluginArchiveEntries, savePluginArchive } from "./yunzai/plugin-archive.js";
import { extractRepositoryArchive, getAllRepositoryArchiveStatuses, repairRepositoryArchiveOrigin, saveRepositoryArchive } from "./yunzai/repository-archive.js";
import { getConfig, getConfigValue } from "alemonjs";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import YAML from "yaml";

//#region src/panel-service.ts
const ONLINE_INDEX_URLS = [
	{
		category: "推荐插件",
		url: "https://raw.githubusercontent.com/yhArcadia/Yunzai-Bot-plugins-index/main/README.md"
	},
	{
		category: "功能类插件",
		url: "https://raw.githubusercontent.com/yhArcadia/Yunzai-Bot-plugins-index/main/Function-Plugin.md"
	},
	{
		category: "游戏IP类插件",
		url: "https://raw.githubusercontent.com/yhArcadia/Yunzai-Bot-plugins-index/main/Game-Plugin.md"
	},
	{
		category: "文游类插件",
		url: "https://raw.githubusercontent.com/yhArcadia/Yunzai-Bot-plugins-index/main/WordGame-Plugin.md"
	},
	{
		category: "单JS类插件",
		url: "https://raw.githubusercontent.com/yhArcadia/Yunzai-Bot-plugins-index/main/JS-Plugin.md"
	}
];
const ONLINE_INDEX_CACHE_TTL = 6e5;
const onlineIndexCache = {
	fetchedAt: 0,
	data: []
};
function withGitHubProxy(url) {
	if (!/^https:\/\/(raw\.githubusercontent\.com|github\.com)\//.test(url)) return url;
	const proxy = getGhProxy();
	if (!proxy || url.startsWith(proxy)) return url;
	return `${proxy}${url}`;
}
function normalizeMarkdown(value) {
	return value.replace(/<details[\s\S]*?<\/details>/g, " ").replace(/\r/g, "").replace(/\n/g, " ").replace(/\s+/g, " ").trim();
}
function textFromMarkdown(value) {
	return value.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
}
function repoDirNameFromUrl(repoUrl) {
	return (repoUrl.replace(/\/+$/, "").replace(/\.git$/, "").split("/").pop() ?? "unknown-plugin").trim();
}
function parseOnlineCatalogRows(markdown, category) {
	const rows = [];
	const source = normalizeMarkdown(markdown);
	const rowReg = /\|\s*\[([^\]]+)\]\((https?:\/\/[^)]+)\)\s*\|\s*(.*?)\s*\|\s*([^|]+?)\s*\|/g;
	const seen = /* @__PURE__ */ new Set();
	let match = null;
	while (match = rowReg.exec(source)) {
		const [, labelRaw, repoUrlRaw, authorRaw, descriptionRaw] = match;
		const repoUrl = repoUrlRaw.trim();
		const dirName = repoDirNameFromUrl(repoUrl);
		const dedupeKey = `${category}:${repoUrl}`;
		if (!repoUrl || seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		rows.push({
			dirName,
			label: textFromMarkdown(labelRaw),
			repoUrl,
			author: textFromMarkdown(authorRaw),
			description: textFromMarkdown(descriptionRaw),
			category,
			installed: false
		});
	}
	return rows;
}
async function fetchOnlineCatalog() {
	const responses = await Promise.all(ONLINE_INDEX_URLS.map(async (item) => {
		const response = await fetch(withGitHubProxy(item.url));
		if (!response.ok) throw new Error(`在线插件索引加载失败: ${item.url}`);
		return {
			category: item.category,
			markdown: await response.text()
		};
	}));
	const merged = /* @__PURE__ */ new Map();
	for (const item of responses) {
		const rows = parseOnlineCatalogRows(item.markdown, item.category);
		for (const row of rows) {
			const key = `${row.repoUrl}::${row.dirName}`;
			if (!merged.has(key)) merged.set(key, row);
		}
	}
	return Array.from(merged.values());
}
async function getOnlineCatalogData(forceRefresh = false) {
	const now = Date.now();
	if (!forceRefresh && onlineIndexCache.data.length > 0 && now - onlineIndexCache.fetchedAt < ONLINE_INDEX_CACHE_TTL) return onlineIndexCache.data;
	if (!forceRefresh && onlineIndexCache.pending) return onlineIndexCache.pending;
	onlineIndexCache.pending = (async () => {
		const installedPlugins = getStatusSnapshotLocal().plugins;
		const installedSet = new Set(installedPlugins.map((p) => p.name));
		const data = (await fetchOnlineCatalog()).map((item) => ({
			...item,
			installed: installedSet.has(item.dirName)
		}));
		onlineIndexCache.data = data;
		onlineIndexCache.fetchedAt = Date.now();
		return data;
	})();
	try {
		return await onlineIndexCache.pending;
	} finally {
		delete onlineIndexCache.pending;
	}
}
function getLogViewerData(fileName, maxLines = 400) {
	const logsDir = join(getYunzaiDir(), "logs");
	if (!existsSync(logsDir)) return {
		files: [],
		activeFile: "",
		content: "",
		truncated: false,
		updatedAt: Date.now()
	};
	const files = readdirSync(logsDir).filter((file) => file.endsWith(".log")).map((file) => {
		const fullPath = join(logsDir, file);
		const stat = statSync(fullPath);
		return {
			name: file,
			size: stat.size,
			updatedAt: stat.mtimeMs
		};
	}).sort((a, b) => b.updatedAt - a.updatedAt);
	const activeFile = fileName && files.some((file) => file.name === fileName) ? fileName : files[0]?.name ?? "";
	if (!activeFile) return {
		files,
		activeFile: "",
		content: "",
		truncated: false,
		updatedAt: Date.now()
	};
	const raw = readFileSync(join(logsDir, activeFile), "utf-8").replace(/\r\n/g, "\n");
	const lines = raw.split("\n");
	const truncated = lines.length > maxLines;
	return {
		files,
		activeFile,
		content: truncated ? lines.slice(-maxLines).join("\n") : raw,
		truncated,
		updatedAt: Date.now()
	};
}
function deleteLogFile(fileName) {
	const safeName = fileName.trim();
	if (!/^[\w.-]+\.log$/i.test(safeName) || safeName === "." || safeName === "..") throw new Error("日志文件名无效");
	const logsDir = join(getYunzaiDir(), "logs");
	const filePath = join(logsDir, safeName);
	if (!existsSync(filePath)) throw new Error("日志文件不存在");
	rmSync(filePath, { force: true });
	return getLogViewerData();
}
function getConfigDir() {
	return join(getYunzaiDir(), "config", "config");
}
function readYaml(name) {
	const file = join(getConfigDir(), `${name}.yaml`);
	if (!existsSync(file)) return {};
	try {
		return YAML.parse(readFileSync(file, "utf-8")) ?? {};
	} catch {
		return {};
	}
}
function writeYaml(name, data) {
	const dir = getConfigDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(data), "utf-8");
}
function csv2arr(v) {
	if (!v) return null;
	const arr = String(v).split(",").map((s) => s.trim()).filter(Boolean);
	return arr.length > 0 ? arr : null;
}
function csv2numArr(v) {
	const arr = csv2arr(v);
	if (!arr) return null;
	const nums = arr.map(Number).filter((n) => !Number.isNaN(n));
	return nums.length > 0 ? nums : null;
}
function getYunzaiFormData() {
	const bot = readYaml("bot");
	const other = readYaml("other");
	const qq = readYaml("qq");
	const redis = readYaml("redis");
	const groupDef = readYaml("group").default ?? {};
	const notice = readYaml("notice");
	return {
		log_level: bot.log_level ?? "info",
		resend: bot.resend ?? false,
		online_msg: bot.online_msg ?? true,
		online_msg_exp: bot.online_msg_exp ?? 86400,
		chromium_path: bot.chromium_path ?? "",
		puppeteer_ws: bot.puppeteer_ws ?? "",
		puppeteer_timeout: bot.puppeteer_timeout ?? "",
		proxyAddress: bot.proxyAddress ?? "",
		sign_api_addr: bot.sign_api_addr ?? "",
		autoFriend: other.autoFriend ?? 1,
		autoQuit: other.autoQuit ?? 50,
		masterQQ: other.masterQQ,
		disablePrivate: other.disablePrivate ?? false,
		disableGuildMsg: other.disableGuildMsg ?? true,
		disableMsg: other.disableMsg ?? "",
		whiteGroup: other.whiteGroup,
		whiteQQ: other.whiteQQ,
		blackGroup: other.blackGroup,
		blackQQ: other.blackQQ,
		qq: qq.qq ?? "",
		pwd: qq.pwd ?? "",
		platform: qq.platform ?? 6,
		redis_host: redis.host ?? "127.0.0.1",
		redis_port: redis.port ?? 6379,
		redis_username: redis.username ?? "",
		redis_password: redis.password ?? "",
		redis_db: redis.db ?? 0,
		groupGlobalCD: groupDef.groupGlobalCD ?? 0,
		singleCD: groupDef.singleCD ?? 1e3,
		onlyReplyAt: groupDef.onlyReplyAt ?? 0,
		botAlias: groupDef.botAlias,
		imgAddLimit: groupDef.imgAddLimit ?? 0,
		imgMaxSize: groupDef.imgMaxSize ?? 2,
		addPrivate: groupDef.addPrivate ?? 1,
		iyuu: notice.iyuu ?? "",
		sct: notice.sct ?? "",
		feishu_webhook: notice.feishu_webhook ?? ""
	};
}
function saveYunzaiFormData(db) {
	const bot = readYaml("bot");
	bot.log_level = db.log_level ?? "info";
	bot.resend = db.resend === true || db.resend === "true";
	bot.online_msg = db.online_msg !== false && db.online_msg !== "false";
	bot.online_msg_exp = Number(db.online_msg_exp) || 86400;
	bot.chromium_path = db.chromium_path ?? "";
	bot.puppeteer_ws = db.puppeteer_ws ?? "";
	bot.puppeteer_timeout = db.puppeteer_timeout ? Number(db.puppeteer_timeout) : "";
	bot.proxyAddress = db.proxyAddress ?? "";
	bot.sign_api_addr = db.sign_api_addr ?? "";
	writeYaml("bot", bot);
	const other = readYaml("other");
	other.autoFriend = Number(db.autoFriend) || 0;
	other.autoQuit = Number(db.autoQuit) || 0;
	other.masterQQ = csv2numArr(db.masterQQ);
	other.disablePrivate = db.disablePrivate === true || db.disablePrivate === "true";
	other.disableGuildMsg = db.disableGuildMsg !== false && db.disableGuildMsg !== "false";
	other.disableMsg = db.disableMsg ?? "";
	other.whiteGroup = csv2numArr(db.whiteGroup);
	other.whiteQQ = csv2numArr(db.whiteQQ);
	other.blackGroup = csv2numArr(db.blackGroup);
	other.blackQQ = csv2numArr(db.blackQQ);
	writeYaml("other", other);
	const qq = readYaml("qq");
	qq.qq = db.qq ? Number(db.qq) || db.qq : "";
	qq.pwd = db.pwd ?? "";
	qq.platform = Number(db.platform) || 6;
	writeYaml("qq", qq);
	writeYaml("redis", {
		host: db.redis_host ?? "127.0.0.1",
		port: Number(db.redis_port) || 6379,
		username: db.redis_username ?? "",
		password: db.redis_password ?? "",
		db: Number(db.redis_db) || 0
	});
	const group = readYaml("group");
	const groupDefault = group.default ?? {};
	groupDefault.groupGlobalCD = Number(db.groupGlobalCD) || 0;
	groupDefault.singleCD = Number(db.singleCD) || 0;
	groupDefault.onlyReplyAt = Number(db.onlyReplyAt) || 0;
	groupDefault.botAlias = csv2arr(db.botAlias);
	groupDefault.imgAddLimit = Number(db.imgAddLimit) || 0;
	groupDefault.imgMaxSize = Number(db.imgMaxSize) || 2;
	groupDefault.addPrivate = Number(db.addPrivate);
	group.default = groupDefault;
	writeYaml("group", group);
	writeYaml("notice", {
		iyuu: db.iyuu ?? "",
		sct: db.sct ?? "",
		feishu_webhook: db.feishu_webhook ?? ""
	});
}
function getRepoData() {
	let config = getConfigValue();
	if (!config) config = {};
	const qqBotCfg = config["qq-bot"] ?? {};
	const qqCfg = config.qq ?? {};
	const pkgCfg = config["alemonjs-load-yunzai"] ?? {};
	return {
		master_key: config.master_key ?? qqBotCfg.master_key ?? qqCfg.master_key,
		master_id: config.master_id ?? qqBotCfg.master_id ?? qqCfg.master_id,
		gh_proxy: pkgCfg.gh_proxy ? String(pkgCfg.gh_proxy) : "https://ghfast.top/",
		yunzai_repo: pkgCfg.yunzai_repo ? String(pkgCfg.yunzai_repo) : "https://github.com/TimeRainStarSky/Yunzai.git",
		miao_plugin_repo: pkgCfg.miao_plugin_repo ? String(pkgCfg.miao_plugin_repo) : "https://github.com/yoimiya-kokomi/miao-plugin.git",
		plugins: pkgCfg.plugins ?? {}
	};
}
function saveRepoData(db) {
	const config = getConfig();
	const value = config.value ?? {};
	const masterKey = csv2arr(db.master_key);
	const masterId = csv2arr(db.master_id);
	value.master_key = masterKey;
	value.master_id = masterId;
	if (value["qq-bot"] && typeof value["qq-bot"] === "object") value["qq-bot"] = {
		...value["qq-bot"],
		master_key: masterKey,
		master_id: masterId
	};
	if (value.qq && typeof value.qq === "object") value.qq = {
		...value.qq,
		master_key: masterKey,
		master_id: masterId
	};
	const pkg = value["alemonjs-load-yunzai"] ?? {};
	pkg.gh_proxy = db.gh_proxy ?? "";
	pkg.yunzai_repo = db.yunzai_repo ?? "";
	pkg.miao_plugin_repo = db.miao_plugin_repo ?? "";
	if (db.plugins && typeof db.plugins === "object") pkg.plugins = db.plugins;
	value["alemonjs-load-yunzai"] = pkg;
	config.saveValue(value);
}
async function getStatusData() {
	const onlineCatalog = await getOnlineCatalogData().catch(() => []);
	const snapshot = getStatusSnapshotLocal();
	const isMiao = snapshot.variant === "miao";
	return {
		...snapshot,
		onlineCatalog,
		help: {
			installFlow: [
				{
					step: "①",
					label: "安装Yunzai",
					cmd: "#yz安装",
					desc: "克隆 Yunzai 仓库"
				},
				{
					step: "②",
					label: "安装依赖",
					cmd: "#yz安装依赖",
					desc: "安装当前发行版依赖"
				},
				{
					step: "③",
					label: "安装插件",
					cmd: isMiao ? "#yz安装插件miao" : "#yz安装插件<别名或仓库地址>",
					desc: isMiao ? "按需安装游戏插件" : "按需安装 Yunzai 插件"
				},
				{
					step: "④",
					label: "启动",
					cmd: "#yz启动",
					desc: "启动 Worker 进程"
				}
			],
			controls: [
				{
					cmd: "#yz安装",
					desc: "安装 Yunzai 框架",
					color: "green"
				},
				{
					cmd: "#yz安装插件",
					desc: "安装指定插件",
					color: "green"
				},
				{
					cmd: "#yz安装依赖",
					desc: "重新安装所有依赖",
					color: "blue"
				},
				{
					cmd: "#yz启动",
					desc: "启动 Worker",
					color: "green"
				},
				{
					cmd: "#yz停止",
					desc: "停止 Worker",
					color: "orange"
				},
				{
					cmd: "#yz重启",
					desc: "停止后重新启动",
					color: "blue"
				},
				{
					cmd: "#yz更新",
					desc: "拉取代码+装依赖+重启",
					color: "blue"
				},
				{
					cmd: "#yz强制更新",
					desc: "重置本地+更新+装依赖",
					color: "red"
				},
				{
					cmd: "#yz更新插件",
					desc: "更新指定插件",
					color: "blue"
				},
				{
					cmd: "#yz强制更新插件",
					desc: "重置+更新指定插件",
					color: "red"
				}
			],
			tools: [
				{
					cmd: "#yz状态",
					desc: "查看当前运行状态",
					color: "orange"
				},
				{
					cmd: "#yz取消",
					desc: "取消正在执行的任务",
					color: "orange"
				},
				{
					cmd: "#yz插件帮助",
					desc: "查看插件列表",
					color: "green"
				},
				{
					cmd: "#yz插件说明",
					desc: "查看插件 README",
					color: "green"
				},
				{
					cmd: "#yz日志清理",
					desc: "清理所有日志文件",
					color: "orange"
				},
				{
					cmd: "#yz卸载插件",
					desc: "卸载指定插件",
					color: "red"
				},
				{
					cmd: "#yz卸载",
					desc: "停止并删除 Yunzai",
					color: "red"
				},
				{
					cmd: "#yz帮助",
					desc: "查看本帮助图",
					color: "orange"
				}
			]
		}
	};
}
function runYunzaiAction(data) {
	return executeYunzaiActionLocal(data);
}
function uploadYunzaiPluginArchive(filePath, options) {
	return installPluginArchiveLocal(filePath, options);
}
function getPluginArchiveData() {
	return getPluginArchiveEntries();
}
function uploadPluginArchive(filePath, originalName, dirName) {
	return savePluginArchive(filePath, originalName, dirName);
}
function extractPluginArchive(id) {
	return extractPluginArchiveEntry(id);
}
function deletePluginArchive(id) {
	return deletePluginArchiveEntry(id);
}
function getRepositoryArchiveData() {
	return getAllRepositoryArchiveStatuses();
}
function uploadRepositoryArchive(target, filePath, originalName) {
	return saveRepositoryArchive(target, filePath, originalName);
}
function unpackRepositoryArchive(target) {
	return extractRepositoryArchive(target);
}
function repairRepositoryArchiveSource(target, repoUrl) {
	return repairRepositoryArchiveOrigin(target, repoUrl);
}
function getDataBackupList() {
	return getDataBackups();
}
function backupYunzaiData() {
	return createDataBackup();
}
function uploadDataBackup(filePath, originalName) {
	return saveUploadedDataBackup(filePath, originalName);
}
function restoreYunzaiDataBackup(id) {
	return restoreDataBackup(id);
}

//#endregion
export { backupYunzaiData, deleteLogFile, deletePluginArchive, extractPluginArchive, getDataBackupList, getLogViewerData, getOnlineCatalogData, getPluginArchiveData, getRepoData, getRepositoryArchiveData, getStatusData, getYunzaiFormData, repairRepositoryArchiveSource, restoreYunzaiDataBackup, runYunzaiAction, saveRepoData, saveYunzaiFormData, unpackRepositoryArchive, uploadDataBackup, uploadPluginArchive, uploadRepositoryArchive, uploadYunzaiPluginArchive };