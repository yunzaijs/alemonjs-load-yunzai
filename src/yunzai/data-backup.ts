import extractZip from 'extract-zip';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PACKAGE_ROOT, getYunzaiDir } from '../path';
import { manager } from './manager';

type BackupMetadata = {
  name: string;
  uploadedAt: number;
  source: 'created' | 'uploaded';
};

export type DataBackupItem = {
  id: string;
  name: string;
  size: number;
  createdAt: number;
  source: 'created' | 'uploaded';
};

const BACKUP_DIR = join(PACKAGE_ROOT, 'runtime', 'data-backups');
const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;

function dataPath(): string {
  return join(getYunzaiDir(), 'data');
}

function metadataPath(id: string): string {
  return join(BACKUP_DIR, `${id}.json`);
}

function backupPath(id: string): string {
  return join(BACKUP_DIR, `${id}.zip`);
}

function assertBackupId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value) || !existsSync(backupPath(value))) {
    throw new Error('未找到指定数据备份');
  }
}

function readMetadata(id: string): BackupMetadata | null {
  try {
    return JSON.parse(readFileSync(metadataPath(id), 'utf-8')) as BackupMetadata;
  } catch {
    return null;
  }
}

function writeMetadata(id: string, metadata: BackupMetadata): void {
  writeFileSync(metadataPath(id), JSON.stringify(metadata), 'utf-8');
}

function createBackupId(): string {
  return `data-${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toItem(id: string): DataBackupItem | null {
  const path = backupPath(id);

  if (!existsSync(path)) {
    return null;
  }

  const stat = statSync(path);
  const metadata = readMetadata(id);

  return {
    id,
    name: metadata?.name ?? `${id}.zip`,
    size: stat.size,
    createdAt: metadata?.uploadedAt ?? stat.mtimeMs,
    source: metadata?.source ?? 'uploaded'
  };
}

function assertStopped(action: string): void {
  if (manager.isRunning) {
    throw new Error(`Yunzai 正在运行，请先停止后再${action}`);
  }
}

function resolveDataRoot(extractDir: string): string {
  const nestedData = join(extractDir, 'data');

  if (existsSync(nestedData) && statSync(nestedData).isDirectory()) {
    return nestedData;
  }

  const entries = readdirSync(extractDir).filter(name => name !== '__MACOSX');

  if (entries.length === 1) {
    const child = join(extractDir, entries[0]);

    if (existsSync(child) && statSync(child).isDirectory() && basename(child).toLowerCase() === 'data') {
      return child;
    }
  }

  // 也兼容直接打包 data 目录内容的 ZIP，但不接受完全空的未知压缩包，防止误清空数据目录。
  if (entries.length > 0) {
    return extractDir;
  }

  throw new Error('ZIP 中未识别到 data 目录或有效的数据文件');
}

/** 返回本地所有数据备份，最新的排在最前。 */
export function getDataBackups(): DataBackupItem[] {
  if (!existsSync(BACKUP_DIR)) {
    return [];
  }

  return readdirSync(BACKUP_DIR)
    .filter(name => name.endsWith('.zip'))
    .map(name => toItem(name.slice(0, -4)))
    .filter((item): item is DataBackupItem => Boolean(item))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** 将 Yunzai/data 打成独立 ZIP。 */
export function createDataBackup(): DataBackupItem {
  const source = dataPath();

  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error('未找到 Yunzai/data 目录');
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  const id = createBackupId();
  const destination = backupPath(id);

  try {
    // 从 data 的父目录打包，以保证 ZIP 中保留 data 根目录（含隐藏文件）。
    execFileSync('zip', ['-rq', destination, 'data'], { cwd: dirname(source), timeout: 10 * 60_000, stdio: 'ignore' });
    const stat = statSync(destination);

    if (stat.size > MAX_BACKUP_BYTES) {
      throw new Error(`备份文件超过 ${MAX_BACKUP_BYTES / 1024 / 1024}MB 限制`);
    }

    writeMetadata(id, { name: `${id}.zip`, uploadedAt: Date.now(), source: 'created' });
    const result = toItem(id);

    if (!result) {
      throw new Error('备份文件创建失败');
    }

    return result;
  } catch (err) {
    rmSync(destination, { force: true });
    throw err;
  }
}

/** 上传的 ZIP 会作为新的备份加入列表，不覆盖既有备份。 */
export function saveUploadedDataBackup(uploadedPath: string, originalName: string): DataBackupItem {
  if (!/\.zip$/i.test(originalName)) {
    throw new Error('仅支持上传 .zip 数据备份');
  }

  const uploadedStat = statSync(uploadedPath);

  if (uploadedStat.size > MAX_BACKUP_BYTES) {
    throw new Error(`上传文件超过 ${MAX_BACKUP_BYTES / 1024 / 1024}MB 限制`);
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  const id = createBackupId();

  copyFileSync(uploadedPath, backupPath(id));
  writeMetadata(id, { name: originalName, uploadedAt: Date.now(), source: 'uploaded' });
  const result = toItem(id);

  if (!result) {
    throw new Error('数据备份保存失败');
  }

  return result;
}

/** 将备份解压到临时目录，校验完成后以目录替换方式覆盖 Yunzai/data。 */
export async function restoreDataBackup(idValue: unknown): Promise<DataBackupItem> {
  assertStopped('恢复数据备份');
  assertBackupId(idValue);

  const tempRoot = mkdtempSync(join(tmpdir(), 'alemonjs-yunzai-data-restore-'));
  const extractDir = join(tempRoot, 'extract');
  const destination = dataPath();
  const parent = dirname(destination);
  const restoreToken = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const staging = join(parent, `.data-restore-staging-${restoreToken}`);
  const backup = join(parent, `.data-restore-backup-${restoreToken}`);
  let movedCurrent = false;

  try {
    mkdirSync(extractDir, { recursive: true });
    await extractZip(backupPath(idValue), { dir: extractDir });
    const source = resolveDataRoot(extractDir);

    mkdirSync(parent, { recursive: true });
    rmSync(staging, { recursive: true, force: true });
    cpSync(source, staging, { recursive: true });

    if (existsSync(destination)) {
      renameSync(destination, backup);
      movedCurrent = true;
    }

    try {
      renameSync(staging, destination);
    } catch (err) {
      if (movedCurrent && existsSync(backup)) {
        renameSync(backup, destination);
      }
      throw err;
    }

    rmSync(backup, { recursive: true, force: true });
    const result = toItem(idValue);

    if (!result) {
      throw new Error('数据备份不存在');
    }

    return result;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
