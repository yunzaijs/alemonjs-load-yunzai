import { mkdirSync, renameSync, statSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../path.js';

const ARCHIVE_DIR = join(PACKAGE_ROOT, 'runtime', 'plugin-archives');
const INDEX_PATH = join(ARCHIVE_DIR, 'index.json');
function readEntries() {
    try {
        const raw = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));
        return Array.isArray(raw) ? raw : [];
    }
    catch {
        return [];
    }
}
function writeEntries(entries) {
    mkdirSync(ARCHIVE_DIR, { recursive: true });
    writeFileSync(INDEX_PATH, JSON.stringify(entries, null, 2), 'utf-8');
}
function archiveFilePath(id) {
    return join(ARCHIVE_DIR, `${id}.zip`);
}
function getPluginArchiveEntries() {
    return readEntries();
}
function savePluginArchive(uploadedPath, originalName, dirName) {
    if (!/\.zip$/i.test(originalName)) {
        throw new Error('仅支持上传 .zip 压缩包');
    }
    mkdirSync(ARCHIVE_DIR, { recursive: true });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const destination = archiveFilePath(id);
    renameSync(uploadedPath, destination);
    const stat = statSync(destination);
    const entry = {
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
async function extractPluginArchiveEntry(idValue) {
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
    const { manager } = await import('./manager.js');
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
function deletePluginArchiveEntry(idValue) {
    const id = String(idValue ?? '');
    const entries = readEntries().filter(entry => entry.id !== id);
    rmSync(archiveFilePath(id), { force: true });
    writeEntries(entries);
    return entries;
}

export { deletePluginArchiveEntry, extractPluginArchiveEntry, getPluginArchiveEntries, savePluginArchive };
