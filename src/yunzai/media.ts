import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 在文件所属的 Worker 内解析，不能让接收 IPC 的主进程重新解释相对路径。 */
export function resolveReplyMediaPath(file: string, cwd = process.cwd()): string | undefined {
  const isFile = file.startsWith('file://');
  let filePath = isFile ? file.slice('file://'.length) : file;
  const paths = /^(?:[a-z]:[\\/]|\\\\)/i.test(cwd) ? path.win32 : path;

  // 裸 Base64 不能当成本地文件，JPEG 数据也可能以 / 开头。
  if (!isFile && /^[A-Za-z0-9+/_-]+={0,2}$/.test(file) && file.length >= 16 && file.length % 4 === 0 && !fs.existsSync(paths.resolve(cwd, filePath))) {
    return undefined;
  }
  if (isFile && paths === path && /^file:\/\/(?:\/|localhost\/)/i.test(file)) {
    filePath = fileURLToPath(file);
  }

  // URL、显式 base64 等媒体来源直接发送；Windows 盘符不是 URL scheme。
  if (!isFile && /^[a-z][a-z\d+.-]*:/i.test(filePath) && !path.win32.isAbsolute(filePath)) {
    return undefined;
  }
  if (!filePath) {
    return undefined;
  }

  // Windows 的标准 file:///C:/... 比盘符路径多一个前导斜杠。
  const localPath = isFile && paths === path.win32 && /^\/[a-z]:[\\/]/i.test(filePath) ? filePath.slice(1) : filePath;

  return paths.resolve(cwd, localPath);
}

/** 本地媒体在 Worker 中读成 base64，兼容插件的 file://./temp/... 写法。 */
export async function serializeReplyMediaFile(value: unknown): Promise<string> {
  if (Buffer.isBuffer(value)) {
    return value.toString('base64');
  }

  const file = String(value ?? '');
  const filePath = resolveReplyMediaPath(file);

  if (!filePath) {
    return file;
  }

  try {
    return (await fs.promises.readFile(filePath)).toString('base64');
  } catch {
    // 固定 Worker 中解析出的绝对路径，禁止主进程或后端再次解释相对路径。
    return `file://${filePath}`;
  }
}
