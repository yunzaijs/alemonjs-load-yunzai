import { getDefaultRepo, getPluginInfo, getYunzaiDir } from "../path.js";
import { manager } from "../yunzai/manager.js";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Format, createEvent, useMessage } from "alemonjs";

//#region src/response/admin.ts
/**
* Yunzai 管理指令（仅限主人使用）
*/
/** 移除文本中的 URL（QQ Bot 平台不允许发送含链接的消息） */
function stripUrls(text) {
	return text.replace(/https?:\/\/\S+/g, "").replace(/\n{2,}/g, "\n").trim();
}
var admin_default = async (e, next) => {
	const event = createEvent({
		event: e,
		selects: ["message.create", "private.message.create"]
	});
	if (!event.selects) {
		next();
		return;
	}
	if (!(event.IsMaster || event.isMaster)) {
		next();
		return;
	}
	const [message] = useMessage(event);
	const cmd = event.MessageText.replace(/^(\/|#|＃)(yz|云崽)\s*/, "").trim();
	const isQQBot = e.Platform === "qq-bot";
	/** 安全发送文本（QQ Bot 自动过滤 URL） */
	const reply = (text) => {
		message.send({ format: Format.create().addText(isQQBot ? stripUrls(text) : text) });
	};
	try {
		if (cmd.startsWith("取消")) {
			if (!manager.isBusy) {
				reply("当前没有正在执行的任务");
				return;
			}
			const taskName = manager.busyTaskName;
			manager.cancelTask();
			reply(`已取消: ${taskName}`);
			return;
		}
		if (manager.isBusy) {
			reply(`正在${manager.busyTaskName}，请等待完成或发送 #yz取消`);
			return;
		}
		if (cmd.startsWith("安装插件")) {
			const arg = cmd.replace("安装插件", "").trim();
			if (!arg) {
				reply("用法: #yz安装插件<别名或仓库地址>\n例: #yz安装插件miao\n例: #yz安装插件https://github.com/xxx/my-plugin.git");
				return;
			}
			const plugin = getPluginInfo(arg);
			if (plugin) {
				reply(`正在安装插件 ${plugin.label}...`);
				await manager.installPlugin(plugin);
				reply(`${plugin.label} 安装完成（含依赖）。如需生效请发送 #yz重启`);
			} else if (/^(https?:\/\/|git@)/.test(arg)) {
				const dirName = arg.replace(/\.git$/, "").split("/").pop() ?? "unknown-plugin";
				reply(isQQBot ? `正在安装插件 ${dirName}...` : `正在安装插件 ${dirName}...\n仓库: ${arg}`);
				await manager.installPlugin({
					dirName,
					repoUrl: arg,
					label: dirName
				});
				reply(`${dirName} 安装完成（含依赖）。如需生效请发送 #yz重启`);
			} else reply(`未知插件「${arg}」，请使用别名或完整仓库地址`);
		} else if (cmd.startsWith("安装依赖")) {
			reply("正在安装 Yunzai 依赖（含插件子包）...");
			await manager.installDeps();
			reply("依赖安装完成。如需生效请发送 #yz重启");
		} else if (cmd.startsWith("安装浏览器")) {
			reply("正在安装 Puppeteer Chrome 浏览器，下载可能需要几分钟...");
			await manager.installBrowser();
			reply("Puppeteer Chrome 浏览器安装完成，现在可重新发送原指令");
		} else if (cmd.startsWith("安装")) {
			const repo = cmd.replace("安装", "").trim() || getDefaultRepo();
			reply(isQQBot ? "正在安装 Yunzai..." : `正在安装 Yunzai...\n仓库: ${repo}`);
			await manager.install(repo);
			reply("Yunzai 源码安装完成。请发送 #yz安装依赖，完成后再发送 #yz启动");
		} else if (cmd.startsWith("更新插件")) {
			const arg = cmd.replace("更新插件", "").trim();
			if (!arg) {
				reply("用法: #yz更新插件<别名> 或 #yz强制更新插件<别名>\n例: #yz更新插件miao");
				return;
			}
			const plugin = getPluginInfo(arg);
			if (!plugin) {
				reply(`未知插件「${arg}」`);
				return;
			}
			reply(`正在更新插件 ${plugin.label}...`);
			const out = await manager.updatePlugin(plugin);
			reply(`${plugin.label} 更新完成。如需生效请发送 #yz重启\n${out.slice(0, 200)}`);
		} else if (cmd.startsWith("强制更新插件")) {
			const arg = cmd.replace("强制更新插件", "").trim();
			if (!arg) {
				reply("用法: #yz强制更新插件<别名>\n例: #yz强制更新插件miao");
				return;
			}
			const plugin = getPluginInfo(arg);
			if (!plugin) {
				reply(`未知插件「${arg}」`);
				return;
			}
			reply(`正在强制更新插件 ${plugin.label}...`);
			const out = await manager.updatePlugin(plugin, true);
			reply(`${plugin.label} 强制更新完成。如需生效请发送 #yz重启\n${out.slice(0, 200)}`);
		} else if (cmd.startsWith("强制更新")) {
			reply("正在强制更新 Yunzai...");
			reply(`强制更新完成\n${(await manager.updateAll(true)).slice(0, 200)}`);
		} else if (cmd.startsWith("更新")) {
			reply("正在更新 Yunzai...");
			reply(`更新完成\n${(await manager.updateAll()).slice(0, 200)}`);
		} else if (cmd.startsWith("启动")) {
			reply("正在启动 Yunzai...");
			await manager.start();
			reply("Yunzai 已启动");
		} else if (cmd.startsWith("停止")) {
			await manager.stop();
			reply("Yunzai 已停止");
		} else if (cmd.startsWith("重启")) {
			reply("正在重启 Yunzai...");
			await manager.restart();
			reply("Yunzai 已重启");
		} else if (cmd.startsWith("日志清理")) {
			const logsDir = join(getYunzaiDir(), "logs");
			if (!existsSync(logsDir)) {
				reply("日志目录不存在");
				return;
			}
			const files = readdirSync(logsDir).filter((f) => f.endsWith(".log"));
			if (files.length === 0) {
				reply("没有可清理的日志文件");
				return;
			}
			for (const f of files) rmSync(join(logsDir, f), { force: true });
			reply(`已清理 ${files.length} 个日志文件`);
		} else if (cmd.startsWith("状态")) reply(`Yunzai 状态: ${manager.getStatus()}`);
		else if (cmd.startsWith("卸载插件")) {
			const arg = cmd.replace("卸载插件", "").trim();
			if (!arg) {
				reply("用法: #yz卸载插件<别名>\n例: #yz卸载插件miao");
				return;
			}
			const plugin = getPluginInfo(arg);
			if (!plugin) {
				reply(`未知插件「${arg}」`);
				return;
			}
			reply(`正在卸载插件 ${plugin.label}...`);
			manager.uninstallPlugin(plugin);
			reply(`${plugin.label} 已卸载。如需生效请发送 #yz重启`);
		} else if (cmd.startsWith("卸载")) {
			reply("正在卸载 Yunzai...");
			await manager.uninstall();
			reply("Yunzai 已卸载");
		} else next();
	} catch (err) {
		const msg = err.message ?? "未知错误";
		if (msg === "操作已取消") reply("操作已取消");
		else reply(`操作失败: ${msg}`);
	}
};

//#endregion
export { admin_default as default };