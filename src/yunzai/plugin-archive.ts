import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../path';

export interface PluginArchiveEntry {
  id: string;
  originalName: string;
  size: number;
  uploadedAt: number;
  /** 解压安装时使用的插件目录名；留空表示解压时自动识别 */
  dirName: string;
  extracted: boolean;
  extractedAt: number | null;
}

const ARCHIVE_DIR = join(PACKAGE_ROOT, 'runtime', 'plugin-archives');
const INDEX_PATH = join(ARCHIVE_DIR, 'index.json');

function readEntries(): PluginArchiveEntry[] {
  try {
    const raw = JSON.parse(readFileSync(INDEX_PATH, 'utf-8')) as PluginArchiveEntry[];

    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeEntries(entries: PluginArchiveEntry[]): void {
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  writeFileSync(INDEX_PATH, JSON.stringify(entries, null, 2), 'utf-8');
}

function archiveFilePath(id: string): string {
  return join(ARCHIVE_DIR, `${id}.zip`);
}

/** 已上传的插件压缩包列表（最新在前） */
export function getPluginArchiveEntries(): PluginArchiveEntry[] {
  return readEntries();
}

/** 保存上传的插件压缩包到本地存储，仅存档不立即安装 */
export function savePluginArchive(uploadedPath: string, originalName: string, dirName?: string): PluginArchiveEntry[] {
  if (!/\.zip$/i.test(originalName)) {
    throw new Error('仅支持上传 .zip 压缩包');
  }

  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const destination = archiveFilePath(id);

  renameSync(uploadedPath, destination);

  const stat = statSync(destination);
  const entry: PluginArchiveEntry = {
    id,
    originalName,
    size: stat.size,
    uploadedAt: Date.now(),
    dirName: (dirName ?? '').trim(),
    extracted: false,
    extractedAt: null
  };
  const entries = readEntries();

  entries.unshift(entry);
  writeEntries(entries);

  return entries;
}

/** 解压安装指定压缩包到 plugins/，成功后更新记录状态 */
export async function extractPluginArchiveEntry(idValue: unknown): Promise<PluginArchiveEntry[]> {
  const id = String(idValue ?? '');
  const entries = readEntries();
  const index = entries.findIndex(entry => entry.id === id);

  if (index === -1) {
    throw new Error('未找到该压缩包记录');
  }

  const archivePath = archiveFilePath(id);

  if (!existsSync(archivePath)) {
    throw new Error('压缩包文件不存在，请重新上传');
  }

  const { manager } = await import('./manager');
  const installed = await manager.extractPluginArchiveFromFile(archivePath, {
    dirName: entries[index].dirName || undefined,
    originalName: entries[index].originalName
  });

  entries[index] = {
    ...entries[index],
    dirName: installed.dirName,
    extracted: true,
    extractedAt: Date.now()
  };
  writeEntries(entries);

  return entries;
}

/** 删除压缩包文件与列表记录 */
export function deletePluginArchiveEntry(idValue: unknown): PluginArchiveEntry[] {
  const id = String(idValue ?? '');
  const entries = readEntries().filter(entry => entry.id !== id);

  rmSync(archiveFilePath(id), { force: true });
  writeEntries(entries);

  return entries;
}
