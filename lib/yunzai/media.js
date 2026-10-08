import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

//#region src/yunzai/media.ts
/** 在文件所属的 Worker 内解析，不能让接收 IPC 的主进程重新解释相对路径。 */
function resolveReplyMediaPath(file, cwd = process.cwd()) {
	const isFile = file.startsWith("file://");
	let filePath = isFile ? file.slice(7) : file;
	const paths = /^(?:[a-z]:[\\/]|\\\\)/i.test(cwd) ? path.win32 : path;
	if (!isFile && /^[A-Za-z0-9+/_-]+={0,2}$/.test(file) && file.length >= 16 && file.length % 4 === 0 && !fs.existsSync(paths.resolve(cwd, filePath))) return;
	if (isFile && paths === path && /^file:\/\/(?:\/|localhost\/)/i.test(file)) filePath = fileURLToPath(file);
	if (!isFile && /^[a-z][a-z\d+.-]*:/i.test(filePath) && !path.win32.isAbsolute(filePath)) return;
	if (!filePath) return;
	const localPath = isFile && paths === path.win32 && /^\/[a-z]:[\\/]/i.test(filePath) ? filePath.slice(1) : filePath;
	return paths.resolve(cwd, localPath);
}
/** 本地媒体在 Worker 中读成 base64，兼容插件的 file://./temp/... 写法。 */
async function serializeReplyMediaFile(value) {
	if (Buffer.isBuffer(value)) return value.toString("base64");
	const file = String(value ?? "");
	const filePath = resolveReplyMediaPath(file);
	if (!filePath) return file;
	try {
		return (await fs.promises.readFile(filePath)).toString("base64");
	} catch {
		return `file://${filePath}`;
	}
}

//#endregion
export { resolveReplyMediaPath, serializeReplyMediaFile };