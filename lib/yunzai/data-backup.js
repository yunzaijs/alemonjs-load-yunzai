import extractZip from 'extract-zip';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, mkdirSync, rmSync, mkdtempSync, cpSync, renameSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { PACKAGE_ROOT, getYunzaiDir } from '../path.js';
import { manager } from './manager.js';

const BACKUP_DIR = join(PACKAGE_ROOT, 'runtime', 'data-backups');
const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
function dataPath() {
    return join(getYunzaiDir(), 'data');
}
function metadataPath(id) {
    return join(BACKUP_DIR, `${id}.json`);
}
function backupPath(id) {
    return join(BACKUP_DIR, `${id}.zip`);
}
function assertBackupId(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value) || !existsSync(backupPath(value))) {
        throw new Error('未找到指定数据备份');
    }
}
function readMetadata(id) {
    try {
        return JSON.parse(readFileSync(metadataPath(id), 'utf-8'));
    }
    catch {
        return null;
    }
}
function writeMetadata(id, metadata) {
    writeFileSync(metadataPath(id), JSON.stringify(metadata), 'utf-8');
}
function createBackupId() {
    return `data-${new Date()
        .toISOString()
        .replace(/[-:.TZ]/g, '')
        .slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
}
function toItem(id) {
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
function assertStopped(action) {
    if (manager.isRunning) {
        throw new Error(`Yunzai 正在运行，请先停止后再${action}`);
    }
}
function resolveDataRoot(extractDir) {
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
    if (entries.length > 0) {
        return extractDir;
    }
    throw new Error('ZIP 中未识别到 data 目录或有效的数据文件');
}
function getDataBackups() {
    if (!existsSync(BACKUP_DIR)) {
        return [];
    }
    return readdirSync(BACKUP_DIR)
        .filter(name => name.endsWith('.zip'))
        .map(name => toItem(name.slice(0, -4)))
        .filter((item) => Boolean(item))
        .sort((a, b) => b.createdAt - a.createdAt);
}
function createDataBackup() {
    const source = dataPath();
    if (!existsSync(source) || !statSync(source).isDirectory()) {
        throw new Error('未找到 Miao-Yunzai/data 目录');
    }
    mkdirSync(BACKUP_DIR, { recursive: true });
    const id = createBackupId();
    const destination = backupPath(id);
    try {
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
    }
    catch (err) {
        rmSync(destination, { force: true });
        throw err;
    }
}
function saveUploadedDataBackup(uploadedPath, originalName) {
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
async function restoreDataBackup(idValue) {
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
        }
        catch (err) {
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
    }
    finally {
        rmSync(staging, { recursive: true, force: true });
        rmSync(tempRoot, { recursive: true, force: true });
    }
}

export { createDataBackup, getDataBackups, restoreDataBackup, saveUploadedDataBackup };
