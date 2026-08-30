import { getAllPlugins, getPluginInfo, getYunzaiDir } from "../path.js";
import { manager } from "./manager.js";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

//#region src/yunzai/control.ts
function getInstalledPlugins() {
	const pluginsDir = join(getYunzaiDir(), "plugins");
	if (!existsSync(pluginsDir)) return [];
	return readdirSync(pluginsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
		const pluginDir = join(pluginsDir, d.name);
		return {
			name: d.name,
			installed: true,
			isGit: existsSync(join(pluginDir, ".git"))
		};
	});
}
function getLogCount() {
	const logsDir = join(getYunzaiDir(), "logs");
	if (!existsSync(logsDir)) return 0;
	return readdirSync(logsDir).filter((f) => f.endsWith(".log")).length;
}
function readPureEdition() {
	const yunzaiDir = getYunzaiDir();
	const pkgPath = join(yunzaiDir, "package.json");
	if (!existsSync(pkgPath)) return false;
	try {
		return JSON.parse(readFileSync(pkgPath, "utf-8"))?.pureEdition === true;
	} catch {
		return false;
	}
}
function getStatusSnapshotLocal() {
	const installedPlugins = manager.isInstalled ? getInstalledPlugins() : [];
	const installedSet = new Set(installedPlugins.map((p) => p.name));
	const catalog = getAllPlugins(manager.variant).map((p) => ({
		dirName: p.dirName,
		label: p.label,
		aliases: p.aliases,
		repoUrl: p.repoUrl,
		installed: installedSet.has(p.dirName)
	}));
	return {
		status: manager.getStatus(),
		packageName: manager.packageName,
		variant: manager.variant,
		installed: manager.isInstalled,
		pureEdition: readPureEdition(),
		running: manager.isRunning,
		busy: manager.isBusy,
		busyTask: manager.busyTaskName,
		plugins: installedPlugins,
		catalog,
		logCount: manager.isInstalled ? getLogCount() : 0,
		updatedAt: Date.now()
	};
}
async function executeYunzaiActionLocal(data) {
	const action = String(data.action ?? "");
	const plugin = typeof data.plugin === "string" ? data.plugin : "";
	switch (action) {
		case "install":
			await manager.install();
			return { message: "Yunzai 源码安装完成，请继续执行“安装依赖”" };
		case "uninstall":
			await manager.uninstall();
			return { message: "Yunzai 已卸载" };
		case "start":
			await manager.start();
			return { message: "Yunzai 已启动" };
		case "stop":
			await manager.stop();
			return { message: "Yunzai 已停止" };
		case "restart":
			await manager.restart();
			return { message: "Yunzai 已重启" };
		case "update":
			await manager.updateAll();
			return { message: "Yunzai 更新完成" };
		case "force_update":
			await manager.updateAll(true);
			return { message: "Yunzai 强制更新完成" };
		case "install_deps":
			await manager.installDeps();
			return { message: "依赖安装完成" };
		case "cancel":
			if (manager.isBusy) {
				const taskName = manager.busyTaskName;
				manager.cancelTask();
				return { message: `已取消: ${taskName}` };
			}
			return { message: "当前没有正在执行的任务" };
		case "clean_logs": {
			const logsDir = join(getYunzaiDir(), "logs");
			if (!existsSync(logsDir)) return { message: "日志目录不存在" };
			const files = readdirSync(logsDir).filter((f) => f.endsWith(".log"));
			for (const file of files) rmSync(join(logsDir, file), { force: true });
			return { message: `已清理 ${files.length} 个日志文件` };
		}
		case "install_plugin": {
			if (!plugin) return { message: "请输入插件别名或仓库地址" };
			const info = getPluginInfo(plugin);
			if (info) {
				await manager.installPlugin(info);
				return { message: `${info.label} 安装完成` };
			}
			if (/^(https?:\/\/|git@)/.test(plugin)) {
				const dirName = plugin.replace(/\.git$/, "").split("/").pop() ?? "unknown-plugin";
				await manager.installPlugin({
					dirName,
					repoUrl: plugin,
					label: dirName
				});
				return { message: `${dirName} 安装完成` };
			}
			return { message: `未知插件「${plugin}」，请使用别名或完整仓库地址` };
		}
		case "update_plugin": {
			if (!plugin) return { message: "缺少插件参数" };
			const info = getPluginInfo(plugin) ?? {
				dirName: plugin,
				repoUrl: "",
				label: plugin
			};
			await manager.updatePlugin(info);
			return { message: `${info.label} 更新完成` };
		}
		case "force_update_plugin": {
			if (!plugin) return { message: "缺少插件参数" };
			const info = getPluginInfo(plugin) ?? {
				dirName: plugin,
				repoUrl: "",
				label: plugin
			};
			await manager.updatePlugin(info, true);
			return { message: `${info.label} 强制更新完成` };
		}
		case "uninstall_plugin": {
			if (!plugin) return { message: "缺少插件参数" };
			const info = getPluginInfo(plugin) ?? {
				dirName: plugin,
				repoUrl: "",
				label: plugin
			};
			manager.uninstallPlugin(info);
			return { message: `${info.label} 已卸载` };
		}
		default: return { message: `未知操作: ${action}` };
	}
}
async function installPluginArchiveLocal(filePath, options) {
	return { message: `${(await manager.installPluginArchive(filePath, options)).label} 安装完成` };
}

//#endregion
export { executeYunzaiActionLocal, getStatusSnapshotLocal, installPluginArchiveLocal };