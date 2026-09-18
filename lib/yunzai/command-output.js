import { syncBuiltinESMExports } from "node:module";
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
/** 在插件加载前安装，覆盖直接调用和 promisify 调用，保留显式二进制输出。 */
function installWindowsCommandDecoding(platform = process.platform) {
	if (platform !== "win32") return () => {};
	const originals = {
		exec: childProcess.exec,
		execFile: childProcess.execFile
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
	syncBuiltinESMExports();
	return () => {
		Object.assign(childProcess, originals);
		syncBuiltinESMExports();
	};
}

//#endregion
export { decodeCommandError, decodeCommandOutput, installWindowsCommandDecoding };