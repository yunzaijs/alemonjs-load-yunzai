import { syncBuiltinESMExports } from "node:module";
import { existsSync } from "node:fs";
import { join, win32 } from "node:path";
import childProcess from "node:child_process";
import { promisify } from "node:util";

//#region src/yunzai/command-output.ts
/** 优先保留 UTF-8；简体 Windows 的旧命令输出才回退到 GB18030。 */
function decodeCommandOutput(value, platform = process.platform) {
	if (typeof value === "string") return value;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(value);
	} catch {
		return platform === "win32" ? new TextDecoder("gb18030").decode(value) : value.toString("utf8");
	}
}
function decodeCommandError(error, stderr, platform = process.platform) {
	if (!error || !Buffer.isBuffer(stderr) || !stderr.length) return;
	const oldMessage = error.message;
	error.message = oldMessage.replace(stderr.toString("utf8"), () => decodeCommandOutput(stderr, platform));
	if (error.stack) error.stack = error.stack.replace(oldMessage, () => error.message);
}
/**
* 修复被宿主启动器裁剪的 Windows PATH。
*
* System32 中的网络诊断命令和 Windows PowerShell 是系统组件；Git 目录则仅在
* 实际存在时加入，避免凭空声明 Git 已安装。该函数原地修改 env，因此随后创建的
* 所有子进程都会继承修复后的环境。
*/
function repairWindowsCommandPath(platform = process.platform, env = process.env, directoryExists = existsSync) {
	if (platform !== "win32") return [];
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
	const current = env[pathKey] ?? "";
	const systemRoot = env.SystemRoot ?? env.WINDIR ?? "C:\\Windows";
	const pathJoin = platform === "win32" ? win32.join : join;
	const candidates = [
		pathJoin(systemRoot, "System32"),
		systemRoot,
		pathJoin(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
		env.ProgramFiles ? pathJoin(env.ProgramFiles, "Git", "cmd") : "",
		env["ProgramFiles(x86)"] ? pathJoin(env["ProgramFiles(x86)"], "Git", "cmd") : "",
		env.LOCALAPPDATA ? pathJoin(env.LOCALAPPDATA, "Programs", "Git", "cmd") : ""
	].filter((value) => Boolean(value) && directoryExists(value));
	const existing = new Set(current.split(";").filter(Boolean).map((value) => value.replace(/[\\/]+$/, "").toLowerCase()));
	const additions = candidates.filter((value) => !existing.has(value.replace(/[\\/]+$/, "").toLowerCase()));
	if (additions.length > 0) env[pathKey] = [...current.split(";").filter(Boolean), ...additions].join(";");
	return additions;
}
/** 在插件加载前安装，覆盖直接调用和 promisify 调用，保留显式二进制输出。 */
function installWindowsCommandDecoding(platform = process.platform) {
	if (platform !== "win32") return () => {};
	const originals = {
		exec: childProcess.exec,
		execFile: childProcess.execFile,
		execSync: childProcess.execSync,
		execFileSync: childProcess.execFileSync
	};
	for (const name of ["exec", "execFile"]) {
		const original = originals[name];
		const wrapped = (...input) => {
			const args = [...input];
			const callback = typeof args.at(-1) === "function" ? args.pop() : void 0;
			const optionIndex = name === "execFile" && Array.isArray(args[1]) ? 2 : 1;
			const options = args[optionIndex] ?? {};
			const encoding = options.encoding;
			if (!callback || encoding !== void 0 && encoding !== "utf8" && encoding !== "utf-8") return original(...input);
			args[optionIndex] = {
				...options,
				encoding: "buffer"
			};
			return original(...args, (error, stdout, stderr) => {
				const out = decodeCommandOutput(stdout, platform);
				const err = decodeCommandOutput(stderr, platform);
				decodeCommandError(error, stderr, platform);
				callback(error, out, err);
			});
		};
		Object.defineProperty(wrapped, promisify.custom, { value: (...args) => {
			let child;
			const promise = new Promise((resolve, reject) => {
				child = wrapped(...args, (error, stdout, stderr) => {
					if (error) {
						Object.assign(error, {
							stdout,
							stderr
						});
						reject(error);
					} else resolve({
						stdout,
						stderr
					});
				});
			});
			return Object.assign(promise, { child });
		} });
		childProcess[name] = wrapped;
	}
	for (const name of ["execSync", "execFileSync"]) {
		const original = originals[name];
		const wrapped = (...input) => {
			const args = [...input];
			const optionIndex = name === "execFileSync" && Array.isArray(args[1]) ? 2 : 1;
			const options = args[optionIndex] ?? {};
			const encoding = options.encoding;
			if (encoding !== void 0 && encoding !== "utf8" && encoding !== "utf-8") return original(...input);
			args[optionIndex] = {
				...options,
				encoding: "buffer"
			};
			try {
				return decodeCommandOutput(original(...args), platform);
			} catch (error) {
				const stderr = error?.stderr;
				const stdout = error?.stdout;
				if (Buffer.isBuffer(stderr)) {
					decodeCommandError(error, stderr, platform);
					error.stderr = decodeCommandOutput(stderr, platform);
				}
				if (Buffer.isBuffer(stdout)) error.stdout = decodeCommandOutput(stdout, platform);
				throw error;
			}
		};
		childProcess[name] = wrapped;
	}
	syncBuiltinESMExports();
	return () => {
		Object.assign(childProcess, originals);
		syncBuiltinESMExports();
	};
}

//#endregion
export { decodeCommandError, decodeCommandOutput, installWindowsCommandDecoding, repairWindowsCommandPath };