import extractZip from 'extract-zip';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PACKAGE_ROOT, getYunzaiDir } from '../path';
import { hasNativeGit } from './git';
import { manager } from './manager';

export type RepositoryArchiveTarget = 'yunzai' | 'miao';

type ArchiveMetadata = {
  originalName: string;
  size: number;
  archiveMtimeMs: number;
  uploadedAt: number;
  extractedAt?: number;
};

export type RepositoryArchiveStatus = {
  target: RepositoryArchiveTarget;
  archive: { name: string; size: number; uploadedAt: number } | null;
  extracted: boolean;
  extractedAt: number | null;
};

const ARCHIVE_DIR = join(PACKAGE_ROOT, 'runtime', 'repository-archives');

function isArchiveTarget(value: unknown): value is RepositoryArchiveTarget {
  return value === 'yunzai' || value === 'miao';
}

function assertArchiveTarget(value: unknown): asserts value is RepositoryArchiveTarget {
  if (!isArchiveTarget(value)) {
    throw new Error('未知压缩包类型');
  }
}

function archivePath(target: RepositoryArchiveTarget): string {
  return join(ARCHIVE_DIR, `${target}.zip`);
}

function metadataPath(target: RepositoryArchiveTarget): string {
  return join(ARCHIVE_DIR, `${target}.json`);
}

function destinationPath(target: RepositoryArchiveTarget): string {
  return target === 'yunzai' ? getYunzaiDir() : join(getYunzaiDir(), 'plugins', 'miao-plugin');
}

function readMetadata(target: RepositoryArchiveTarget): ArchiveMetadata | null {
  try {
    return JSON.parse(readFileSync(metadataPath(target), 'utf-8')) as ArchiveMetadata;
  } catch {
    return null;
  }
}

function writeMetadata(target: RepositoryArchiveTarget, metadata: ArchiveMetadata): void {
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  writeFileSync(metadataPath(target), JSON.stringify(metadata), 'utf-8');
}

function archiveRootLooksValid(dir: string, target: RepositoryArchiveTarget): boolean {
  if (existsSync(join(dir, 'package.json'))) {
    return true;
  }

  return target === 'miao' && (existsSync(join(dir, 'apps')) || existsSync(join(dir, 'lib')) || existsSync(join(dir, 'index.js')));
}

function resolveArchiveRoot(extractDir: string, target: RepositoryArchiveTarget): string {
  if (archiveRootLooksValid(extractDir, target)) {
    return extractDir;
  }

  const entries = readdirSync(extractDir, { withFileTypes: true }).filter(entry => entry.name !== '__MACOSX');

  if (entries.length === 1 && entries[0].isDirectory()) {
    const child = join(extractDir, entries[0].name);

    if (archiveRootLooksValid(child, target)) {
      return child;
    }
  }

  throw new Error(target === 'yunzai' ? 'ZIP 中未识别到 Yunzai 根目录（缺少 package.json）' : 'ZIP 中未识别到 miao-plugin 根目录');
}

export function getRepositoryArchiveStatus(target: RepositoryArchiveTarget): RepositoryArchiveStatus {
  const path = archivePath(target);

  if (!existsSync(path)) {
    return { target, archive: null, extracted: false, extractedAt: null };
  }

  const stat = statSync(path);
  const metadata = readMetadata(target);
  const extracted = Boolean(
    metadata?.size === stat.size && metadata.archiveMtimeMs === stat.mtimeMs && metadata.extractedAt && existsSync(destinationPath(target))
  );

  return {
    target,
    archive: {
      name: metadata?.originalName ?? `${target}.zip`,
      size: stat.size,
      uploadedAt: metadata?.uploadedAt ?? stat.mtimeMs
    },
    extracted,
    extractedAt: extracted ? (metadata?.extractedAt ?? null) : null
  };
}

export function getAllRepositoryArchiveStatuses(): RepositoryArchiveStatus[] {
  return [getRepositoryArchiveStatus('yunzai'), getRepositoryArchiveStatus('miao')];
}

/** 上传会覆盖同类型的已保存 ZIP；新 ZIP 必须再次解压才会生效。 */
export function saveRepositoryArchive(targetValue: unknown, uploadedPath: string, originalName: string): RepositoryArchiveStatus {
  assertArchiveTarget(targetValue);

  if (!/\.zip$/i.test(originalName)) {
    throw new Error('仅支持上传 .zip 压缩包');
  }

  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const destination = archivePath(targetValue);
  const backup = join(ARCHIVE_DIR, `.${targetValue}.upload-backup-${Date.now()}.zip`);
  const hasExistingArchive = existsSync(destination);

  if (hasExistingArchive) {
    renameSync(destination, backup);
  }

  try {
    renameSync(uploadedPath, destination);
  } catch (err) {
    if (hasExistingArchive && existsSync(backup)) {
      renameSync(backup, destination);
    }
    throw err;
  }

  rmSync(backup, { force: true });
  const stat = statSync(destination);

  writeMetadata(targetValue, {
    originalName,
    size: stat.size,
    archiveMtimeMs: stat.mtimeMs,
    uploadedAt: Date.now()
  });

  return getRepositoryArchiveStatus(targetValue);
}

/** 用已保存 ZIP 覆盖目标目录。正在运行时拒绝操作，避免覆盖 Worker 使用中的文件。 */
export async function extractRepositoryArchive(targetValue: unknown): Promise<RepositoryArchiveStatus> {
  assertArchiveTarget(targetValue);

  if (manager.isRunning) {
    throw new Error('Yunzai 正在运行，请先停止后再解压压缩包');
  }

  const sourceArchive = archivePath(targetValue);

  if (!existsSync(sourceArchive)) {
    throw new Error('请先上传压缩包');
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'alemonjs-yunzai-archive-'));
  const extractDir = join(tempRoot, 'extract');
  const destination = destinationPath(targetValue);
  const parent = dirname(destination);
  const name = basename(destination);
  const staging = join(parent, `.${name}.archive-staging-${Date.now()}`);
  const backup = join(parent, `.${name}.archive-backup-${Date.now()}`);
  let movedCurrent = false;

  try {
    mkdirSync(extractDir, { recursive: true });
    await extractZip(sourceArchive, { dir: extractDir });
    const sourceRoot = resolveArchiveRoot(extractDir, targetValue);

    mkdirSync(parent, { recursive: true });
    rmSync(staging, { recursive: true, force: true });
    cpSync(sourceRoot, staging, { recursive: true });

    if (existsSync(destination)) {
      rmSync(backup, { recursive: true, force: true });
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
    const metadata = readMetadata(targetValue);
    const stat = statSync(sourceArchive);

    writeMetadata(targetValue, {
      originalName: metadata?.originalName ?? `${targetValue}.zip`,
      size: stat.size,
      archiveMtimeMs: stat.mtimeMs,
      uploadedAt: metadata?.uploadedAt ?? stat.mtimeMs,
      extractedAt: Date.now()
    });

    return getRepositoryArchiveStatus(targetValue);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

/** 为 ZIP 解压出的目录补回 Git 元数据与 origin，不拉取远程内容也不覆盖当前文件。 */
export async function repairRepositoryArchiveOrigin(targetValue: unknown, repoUrl: string): Promise<RepositoryArchiveStatus> {
  assertArchiveTarget(targetValue);

  if (manager.isRunning) {
    throw new Error('Yunzai 正在运行，请先停止后再修复仓库来源');
  }

  const targetDir = destinationPath(targetValue);

  if (!existsSync(targetDir)) {
    throw new Error('请先解压对应压缩包');
  }
  if (!repoUrl.trim()) {
    throw new Error('请先填写 Git 仓库地址并保存');
  }

  if (hasNativeGit()) {
    execFileSync('git', ['init'], { cwd: targetDir, timeout: 30_000, stdio: 'ignore' });
    try {
      execFileSync('git', ['remote', 'remove', 'origin'], { cwd: targetDir, timeout: 30_000, stdio: 'ignore' });
    } catch {}
    execFileSync('git', ['remote', 'add', 'origin', repoUrl.trim()], { cwd: targetDir, timeout: 30_000, stdio: 'ignore' });
  } else {
    const git = await import('isomorphic-git');

    await git.init({ fs, dir: targetDir });
    try {
      await git.deleteRemote({ fs, dir: targetDir, remote: 'origin' });
    } catch {}
    await git.addRemote({ fs, dir: targetDir, remote: 'origin', url: repoUrl.trim() });
  }

  return getRepositoryArchiveStatus(targetValue);
}
