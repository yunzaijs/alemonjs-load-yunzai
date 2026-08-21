import { logger, getConfigValue } from 'alemonjs';
import extractZip from 'extract-zip';
import { fork, execFile } from 'node:child_process';
import { existsSync, rmSync, writeFileSync, mkdirSync, readFileSync, mkdtempSync, renameSync, cpSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getYunzaiDir, getDefaultRepo, WORKER_PATH, YARN_PATH, getGhProxy } from '../path.js';
import { gitClone, gitFetchAll, gitResetHard, gitPull } from './git.js';

function getStartFailedPath() {
    return join(getYunzaiDir(), '.last_start_failed');
}
function readGitBranchName(repoDir) {
    try {
        const gitPath = join(repoDir, '.git');
        let headPath = join(gitPath, 'HEAD');
        try {
            const gitFile = readFileSync(gitPath, 'utf-8').trim();
            const gitdir = gitFile.match(/^gitdir:\s*(.+)$/i)?.[1];
            if (gitdir) {
                headPath = join(repoDir, gitdir, 'HEAD');
            }
        }
        catch { }
        const head = readFileSync(headPath, 'utf-8').trim();
        return head.match(/^ref:\s+refs\/heads\/(.+)$/)?.[1] ?? '';
    }
    catch {
        return '';
    }
}
function isPureEditionPackage(pkg, repoDir) {
    if (pkg?.pureEdition === true) {
        return true;
    }
    return /pure/i.test(readGitBranchName(repoDir));
}
function sanitizePluginDirName(name) {
    return name
        .trim()
        .replace(/\.zip$/i, '')
        .replace(/[\\/:"*?<>|]+/g, '-')
        .replace(/\s+/g, '-')
        .replace(/^-+|-+$/g, '');
}
function pluginLooksValid(dir) {
    return existsSync(join(dir, 'package.json')) || existsSync(join(dir, 'apps')) || existsSync(join(dir, 'lib')) || existsSync(join(dir, 'index.js'));
}
function getPluginCandidateEntries(dir) {
    return readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.name !== '__MACOSX')
        .map(entry => entry.name);
}
function resolveArchivePluginRoot(extractDir) {
    if (pluginLooksValid(extractDir)) {
        return { pluginRoot: extractDir, suggestedDirName: null };
    }
    const entries = getPluginCandidateEntries(extractDir);
    if (entries.length === 1) {
        const singleEntryDir = join(extractDir, entries[0]);
        if (pluginLooksValid(singleEntryDir)) {
            return {
                pluginRoot: singleEntryDir,
                suggestedDirName: sanitizePluginDirName(entries[0])
            };
        }
    }
    throw new Error('ZIP 中未识别到有效插件目录，请确认压缩包内包含 package.json、apps、lib 或 index.js');
}
class YunzaiManager {
    worker = null;
    ready = false;
    replyHandlers = new Set();
    doneHandlers = new Set();
    apiRequestHandlers = new Set();
    exitHandlers = new Set();
    readyHandlers = new Set();
    restartCount = 0;
    maxRestarts = 3;
    restartTimer = null;
    taskName = null;
    taskProcess = null;
    taskCancelled = false;
    get isInstalled() {
        return existsSync(getYunzaiDir());
    }
    get isRunning() {
        return this.worker !== null && !this.worker.killed;
    }
    get isReady() {
        return this.ready;
    }
    getStatus() {
        if (this.taskName) {
            return `正在${this.taskName}`;
        }
        if (!this.isInstalled) {
            return '未安装';
        }
        if (!this.isRunning) {
            return '已停止';
        }
        if (!this.ready) {
            return '启动中';
        }
        return '运行中';
    }
    get isBusy() {
        return this.taskName !== null;
    }
    get busyTaskName() {
        return this.taskName ?? '';
    }
    get lastStartOk() {
        try {
            return !existsSync(getStartFailedPath());
        }
        catch {
            return true;
        }
    }
    markStartOk() {
        try {
            if (existsSync(getStartFailedPath())) {
                rmSync(getStartFailedPath());
            }
        }
        catch { }
    }
    markStartFailed() {
        try {
            writeFileSync(getStartFailedPath(), String(Date.now()), 'utf-8');
        }
        catch { }
    }
    cancelTask() {
        if (!this.taskName) {
            return false;
        }
        this.taskCancelled = true;
        if (this.taskProcess) {
            this.taskProcess.kill('SIGTERM');
        }
        if (this.worker && !this.ready) {
            this.worker.kill('SIGTERM');
        }
        logger.info(`[Yunzai] 用户取消任务: ${this.taskName}`);
        return true;
    }
    async install(repoUrl = getDefaultRepo()) {
        const yunzaiDir = getYunzaiDir();
        if (this.isInstalled) {
            throw new Error(`Yunzai 已安装在 ${yunzaiDir}`);
        }
        this.beginTask('安装');
        try {
            logger.info(`[Yunzai] 正在克隆 ${repoUrl} ...`);
            await this.execGit(gitClone(repoUrl, yunzaiDir));
            this.throwIfCancelled();
            this.ensureWorkspaces();
            this.throwIfCancelled();
            logger.info('[Yunzai] 克隆完成，正在安装依赖...');
            await this.npmInstall(yunzaiDir);
            this.throwIfCancelled();
            logger.info('[Yunzai] 依赖安装完成');
        }
        catch (err) {
            if (existsSync(yunzaiDir)) {
                try {
                    rmSync(yunzaiDir, { recursive: true, force: true });
                    logger.info('[Yunzai] 安装失败，已清理残留目录');
                }
                catch (rmErr) {
                    logger.warn(`[Yunzai] 清理残留目录失败: ${rmErr.message}`);
                }
            }
            throw err;
        }
        finally {
            this.endTask();
        }
    }
    async update(force = false) {
        if (!this.isInstalled) {
            throw new Error('Yunzai 未安装');
        }
        this.beginTask('更新');
        try {
            const dir = getYunzaiDir();
            if (force) {
                logger.info('[Yunzai] 强制重置本地更改...');
                await this.execGit(gitFetchAll(dir));
                this.throwIfCancelled();
                await this.execGit(gitResetHard(dir));
                this.throwIfCancelled();
            }
            logger.info('[Yunzai] 正在拉取更新...');
            const out = await this.execGit(gitPull(dir));
            this.throwIfCancelled();
            logger.info('[Yunzai] 更新完成');
            return out;
        }
        finally {
            this.endTask();
        }
    }
    async updateAll(force = false) {
        if (!this.isInstalled) {
            throw new Error('Yunzai 未安装');
        }
        this.beginTask('更新');
        try {
            const wasRunning = this.isRunning;
            if (wasRunning) {
                await this.stopInternal();
            }
            this.throwIfCancelled();
            const dir = getYunzaiDir();
            if (force) {
                logger.info('[Yunzai] 强制重置本地更改...');
                await this.execGit(gitFetchAll(dir));
                this.throwIfCancelled();
                await this.execGit(gitResetHard(dir));
                this.throwIfCancelled();
            }
            logger.info('[Yunzai] 正在拉取更新...');
            const out = await this.execGit(gitPull(dir));
            this.throwIfCancelled();
            this.ensureWorkspaces();
            this.throwIfCancelled();
            logger.info('[Yunzai] 正在安装依赖...');
            await this.npmInstall(getYunzaiDir());
            this.throwIfCancelled();
            logger.info('[Yunzai] 更新完成，依赖已重装');
            if (wasRunning) {
                await this.startInternal();
                logger.info('[Yunzai] Worker 已自动重启');
            }
            return out;
        }
        finally {
            this.endTask();
        }
    }
    async start() {
        this.beginTask('启动');
        try {
            await this.startInternal();
        }
        finally {
            this.endTask();
        }
    }
    async stop() {
        this.beginTask('停止');
        try {
            await this.stopInternal();
        }
        finally {
            this.endTask();
        }
    }
    async restart() {
        this.beginTask('重启');
        try {
            this.restartCount = 0;
            await this.stopInternal();
            this.throwIfCancelled();
            await this.startInternal();
        }
        finally {
            this.endTask();
        }
    }
    async installAndStart(repoUrl = getDefaultRepo()) {
        const yunzaiDir = getYunzaiDir();
        if (this.isInstalled) {
            throw new Error(`Yunzai 已安装在 ${yunzaiDir}`);
        }
        this.beginTask('安装');
        try {
            try {
                logger.info(`[Yunzai] 正在克隆 ${repoUrl} ...`);
                await this.execGit(gitClone(repoUrl, yunzaiDir));
                this.throwIfCancelled();
                this.ensureWorkspaces();
                this.throwIfCancelled();
                logger.info('[Yunzai] 克隆完成，正在安装依赖...');
                await this.npmInstall(yunzaiDir);
                this.throwIfCancelled();
                logger.info('[Yunzai] 依赖安装完成');
            }
            catch (err) {
                if (existsSync(yunzaiDir)) {
                    try {
                        rmSync(yunzaiDir, { recursive: true, force: true });
                    }
                    catch { }
                    logger.info('[Yunzai] 安装失败，已清理残留目录');
                }
                throw err;
            }
            await this.startInternal();
        }
        finally {
            this.endTask();
        }
    }
    async uninstall() {
        if (!this.isInstalled) {
            throw new Error('Yunzai 未安装');
        }
        this.beginTask('卸载');
        try {
            if (this.isRunning) {
                await this.stopInternal();
            }
            rmSync(getYunzaiDir(), { recursive: true, force: true });
            logger.info('[Yunzai] Yunzai 已卸载');
        }
        finally {
            this.endTask();
        }
    }
    syncRedisConfig() {
        try {
            const values = getConfigValue() ?? {};
            const rc = values.redis;
            if (!rc || typeof rc !== 'object') {
                logger.info('[Yunzai] 未找到 AlemonJS redis 配置，Miao-Yunzai 将使用自身默认配置');
                return;
            }
            const yunzaiDir = getYunzaiDir();
            const cfgDir = join(yunzaiDir, 'config', 'config');
            if (!existsSync(cfgDir)) {
                mkdirSync(cfgDir, { recursive: true });
            }
            const host = rc.host ?? '127.0.0.1';
            const port = rc.port ?? 6379;
            const username = rc.username ?? '';
            const password = rc.password ?? '';
            const db = rc.db ?? 0;
            const yaml = [`host: ${host}`, `port: ${port}`, `username: ${username}`, `password: ${password}`, `db: ${db}`].join('\n') + '\n';
            writeFileSync(join(cfgDir, 'redis.yaml'), yaml, 'utf-8');
            logger.info(`[Yunzai] Redis 配置已同步 → ${host}:${port}/${db}`);
        }
        catch (err) {
            logger.warn(`[Yunzai] Redis 配置同步失败: ${err.message}`);
        }
    }
    validateRequiredPlugins() {
        const yunzaiDir = getYunzaiDir();
        const pkgPath = join(yunzaiDir, 'package.json');
        if (!existsSync(pkgPath)) {
            return;
        }
        let pkg;
        try {
            pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        }
        catch (err) {
            logger.warn(`[Yunzai] 启动前检查跳过: package.json 解析失败: ${err.message}`);
            return;
        }
        const pkgName = String(pkg?.name ?? '').toLowerCase();
        const pureEdition = isPureEditionPackage(pkg, yunzaiDir);
        const isMiaoVariant = pkgName === 'miao-yunzai' ||
            pkgName === 'miao_yunzai' ||
            typeof pkg?.imports?.['#miao'] === 'string' ||
            typeof pkg?.imports?.['#miao.models'] === 'string' ||
            typeof pkg?.scripts?.ksr === 'string';
        const missing = [];
        if (!pureEdition && isMiaoVariant) {
            const miaoPluginDir = join(yunzaiDir, 'plugins', 'miao-plugin');
            const miaoPluginEntry = join(miaoPluginDir, 'components', 'index.js');
            if (!existsSync(miaoPluginDir) || !existsSync(miaoPluginEntry)) {
                missing.push('miao-plugin');
            }
        }
        if (missing.length > 0) {
            throw new Error(`当前为 Miao-Yunzai，缺少必要插件: ${missing.join(', ')}。请先发送 #yz安装插件miao，安装完成后再发送 #yz启动`);
        }
    }
    async startInternal() {
        if (this.isRunning) {
            throw new Error('Worker 已在运行');
        }
        if (!this.isInstalled) {
            logger.warn('[Yunzai] 未安装，跳过启动');
            return;
        }
        this.ready = false;
        this.validateRequiredPlugins();
        this.syncRedisConfig();
        this.worker = fork(WORKER_PATH, [], {
            cwd: getYunzaiDir(),
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
            env: { ...process.env, YUNZAI_DIR: getYunzaiDir() }
        });
        this.worker.stdout?.on('data', (buf) => {
            for (const line of buf.toString().split('\n').filter(Boolean)) {
                logger.info(`[Yunzai:out] ${line}`);
            }
        });
        this.worker.stderr?.on('data', (buf) => {
            for (const line of buf.toString().split('\n').filter(Boolean)) {
                logger.warn(`[Yunzai:err] ${line}`);
            }
        });
        this.worker.on('message', (msg) => {
            this.handleMessage(msg);
        });
        this.worker.on('exit', (code, signal) => {
            logger.info(`[Yunzai] Worker 退出 code=${code} signal=${signal}`);
            this.worker = null;
            this.ready = false;
            for (const h of this.exitHandlers) {
                try {
                    h(code);
                }
                catch { }
            }
            if (code !== 0 && this.restartCount < this.maxRestarts && !this.isBusy) {
                this.restartCount++;
                logger.info(`[Yunzai] 自动重启 (${this.restartCount}/${this.maxRestarts})...`);
                this.restartTimer = setTimeout(() => {
                    this.restartTimer = null;
                    this.start().catch(err => {
                        logger.error(`[Yunzai] 自动重启失败: ${err.message}`);
                    });
                }, 3000);
            }
            else if (code !== 0 && this.restartCount >= this.maxRestarts) {
                this.markStartFailed();
                logger.error('[Yunzai] 自动重启次数耗尽，下次启动将不会自动启动。请排查问题后发送 #yz启动');
            }
        });
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error('Worker 启动超时 (30s)'));
            }, 30_000);
            const handler = (msg) => {
                if (msg.type === 'ready') {
                    cleanup();
                    this.ready = true;
                    this.restartCount = 0;
                    this.markStartOk();
                    logger.info(`[Yunzai] Worker 就绪，已加载 ${msg.pluginCount} 个插件`);
                    for (const readyHandler of this.readyHandlers) {
                        try {
                            readyHandler();
                        }
                        catch (err) {
                            logger.warn(`[Yunzai] Worker 就绪回调失败: ${err?.message ?? String(err)}`);
                        }
                    }
                    resolve();
                }
                else if (msg.type === 'error') {
                    cleanup();
                    reject(new Error(msg.message));
                }
            };
            const exitHandler = (code) => {
                cleanup();
                reject(new Error(`Worker 启动时退出 (code=${code})`));
            };
            const cleanup = () => {
                clearTimeout(timeout);
                this.worker?.removeListener('message', handler);
                this.worker?.removeListener('exit', exitHandler);
            };
            this.worker.on('message', handler);
            this.worker.once('exit', exitHandler);
        });
    }
    async stopInternal() {
        if (!this.isRunning || !this.worker) {
            return;
        }
        this.ready = false;
        this.restartCount = this.maxRestarts;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        this.send({ type: 'shutdown' });
        await new Promise(resolve => {
            const timeout = setTimeout(() => {
                this.worker?.kill('SIGKILL');
                resolve();
            }, 5000);
            this.worker.once('exit', () => {
                clearTimeout(timeout);
                resolve();
            });
        });
        this.worker = null;
    }
    send(msg) {
        if (!this.worker || !this.isRunning) {
            return;
        }
        try {
            this.worker.send(msg);
        }
        catch (err) {
            logger.warn(`[Yunzai] IPC 发送失败: ${err.message}`);
        }
    }
    onReply(handler) {
        this.replyHandlers.add(handler);
        return () => this.replyHandlers.delete(handler);
    }
    onDone(handler) {
        this.doneHandlers.add(handler);
        return () => this.doneHandlers.delete(handler);
    }
    onApiRequest(handler) {
        this.apiRequestHandlers.add(handler);
        return () => this.apiRequestHandlers.delete(handler);
    }
    onWorkerExit(handler) {
        this.exitHandlers.add(handler);
        return () => this.exitHandlers.delete(handler);
    }
    onReady(handler) {
        this.readyHandlers.add(handler);
        return () => this.readyHandlers.delete(handler);
    }
    sendToWorker(msg) {
        this.send(msg);
    }
    handleMessage(msg) {
        switch (msg.type) {
            case 'reply':
                for (const h of this.replyHandlers) {
                    h(msg);
                }
                break;
            case 'done':
                for (const h of this.doneHandlers) {
                    h(msg);
                }
                break;
            case 'api':
                for (const h of this.apiRequestHandlers) {
                    h(msg);
                }
                break;
            case 'error':
                logger.error(`[Yunzai:worker] ${msg.message}`);
                break;
            case 'log': {
                const fn = logger[msg.level];
                if (typeof fn === 'function') {
                    fn.call(logger, `[Yunzai] ${msg.args.join(' ')}`);
                }
                break;
            }
        }
    }
    beginTask(name) {
        if (this.taskName) {
            throw new Error(`正在${this.taskName}，请等待完成或发送 #yz取消`);
        }
        this.taskName = name;
        this.taskCancelled = false;
    }
    endTask() {
        this.taskName = null;
        this.taskProcess = null;
        this.taskCancelled = false;
    }
    throwIfCancelled() {
        if (this.taskCancelled) {
            throw new Error('操作已取消');
        }
    }
    async execGit(result) {
        this.taskProcess = result.process;
        try {
            return await result.promise;
        }
        finally {
            this.taskProcess = null;
        }
    }
    npmInstall(cwd) {
        return new Promise((resolve, reject) => {
            const restorePackageJson = this.patchPackageJsonForInstall(cwd);
            try {
                const cp = execFile(process.execPath, [YARN_PATH, 'install', '--production=false'], { cwd, timeout: 1_800_000 }, (err, stdout, stderr) => {
                    this.taskProcess = null;
                    restorePackageJson();
                    if (err) {
                        const hint = err.killed ? ' (超时)' : '';
                        const detail = stderr?.trim() ? `${stderr.trim()}\n${err.message}` : err.message;
                        reject(new Error(`${detail}${hint}`));
                    }
                    else {
                        resolve(stdout);
                    }
                });
                this.taskProcess = cp;
            }
            catch (err) {
                this.taskProcess = null;
                restorePackageJson();
                reject(err);
            }
        });
    }
    async installPlugin(plugin) {
        if (!this.isInstalled) {
            throw new Error('Yunzai 未安装');
        }
        const pluginDir = `${getYunzaiDir()}/plugins/${plugin.dirName}`;
        if (existsSync(pluginDir)) {
            throw new Error(`${plugin.label} 已安装`);
        }
        this.beginTask('安装插件');
        try {
            const repoUrl = plugin.repoUrl.startsWith('https://github.com/') ? `${getGhProxy()}${plugin.repoUrl}` : plugin.repoUrl;
            logger.info(`[Yunzai] 正在安装 ${plugin.label}...`);
            await this.execGit(gitClone(repoUrl, pluginDir));
            this.throwIfCancelled();
            this.ensureWorkspaces();
            logger.info('[Yunzai] 正在安装插件依赖...');
            await this.npmInstall(getYunzaiDir());
            this.throwIfCancelled();
            logger.info(`[Yunzai] ${plugin.label} 安装完成`);
        }
        catch (err) {
            if (existsSync(pluginDir)) {
                try {
                    rmSync(pluginDir, { recursive: true, force: true });
                }
                catch { }
            }
            throw err;
        }
        finally {
            this.endTask();
        }
    }
    async installPluginArchive(archivePath, options) {
        if (!this.isInstalled) {
            throw new Error('Yunzai 未安装');
        }
        const tempRoot = mkdtempSync(join(tmpdir(), 'alemonjs-yunzai-plugin-'));
        const extractDir = join(tempRoot, 'extract');
        let pluginDir = '';
        this.beginTask('安装插件压缩包');
        try {
            mkdirSync(extractDir, { recursive: true });
            await extractZip(archivePath, { dir: extractDir });
            this.throwIfCancelled();
            const { pluginRoot, suggestedDirName } = resolveArchivePluginRoot(extractDir);
            const baseName = options?.dirName ?? suggestedDirName ?? options?.originalName ?? 'uploaded-plugin';
            const dirName = sanitizePluginDirName(baseName);
            if (!dirName) {
                throw new Error('无法确定插件目录名，请重新命名 ZIP 文件后再上传');
            }
            pluginDir = join(getYunzaiDir(), 'plugins', dirName);
            if (existsSync(pluginDir)) {
                throw new Error(`${dirName} 已安装`);
            }
            mkdirSync(join(getYunzaiDir(), 'plugins'), { recursive: true });
            if (pluginRoot === extractDir) {
                mkdirSync(pluginDir, { recursive: true });
                for (const entry of getPluginCandidateEntries(pluginRoot)) {
                    renameSync(join(pluginRoot, entry), join(pluginDir, entry));
                }
            }
            else {
                cpSync(pluginRoot, pluginDir, { recursive: true });
            }
            this.throwIfCancelled();
            this.ensureWorkspaces();
            logger.info(`[Yunzai] 正在为 ${dirName} 安装依赖...`);
            await this.npmInstall(getYunzaiDir());
            this.throwIfCancelled();
            logger.info(`[Yunzai] ${dirName} 安装完成`);
            return {
                dirName,
                repoUrl: '',
                label: dirName
            };
        }
        catch (err) {
            if (pluginDir && existsSync(pluginDir)) {
                try {
                    rmSync(pluginDir, { recursive: true, force: true });
                }
                catch { }
            }
            throw err;
        }
        finally {
            try {
                rmSync(tempRoot, { recursive: true, force: true });
            }
            catch { }
            this.endTask();
        }
    }
    async extractPluginArchiveFromFile(archivePath, options) {
        if (!this.isInstalled) {
            throw new Error('Yunzai 未安装');
        }
        if (this.isRunning) {
            throw new Error('Yunzai 正在运行，请先停止后再解压插件压缩包');
        }
        const tempRoot = mkdtempSync(join(tmpdir(), 'alemonjs-yunzai-plugin-'));
        const extractDir = join(tempRoot, 'extract');
        let targetDir = '';
        let backupDir = '';
        let movedCurrent = false;
        this.beginTask('解压安装插件');
        try {
            mkdirSync(extractDir, { recursive: true });
            await extractZip(archivePath, { dir: extractDir });
            this.throwIfCancelled();
            const { pluginRoot, suggestedDirName } = resolveArchivePluginRoot(extractDir);
            const baseName = options?.dirName ?? suggestedDirName ?? options?.originalName ?? 'uploaded-plugin';
            const dirName = sanitizePluginDirName(baseName);
            if (!dirName) {
                throw new Error('无法确定插件目录名，请重新命名 ZIP 文件后再上传');
            }
            const pluginsDir = join(getYunzaiDir(), 'plugins');
            targetDir = join(pluginsDir, dirName);
            backupDir = join(pluginsDir, `.${dirName}.archive-backup-${Date.now()}`);
            const staging = join(pluginsDir, `.${dirName}.archive-staging-${Date.now()}`);
            mkdirSync(pluginsDir, { recursive: true });
            rmSync(staging, { recursive: true, force: true });
            if (pluginRoot === extractDir) {
                mkdirSync(staging, { recursive: true });
                for (const entry of getPluginCandidateEntries(pluginRoot)) {
                    renameSync(join(pluginRoot, entry), join(staging, entry));
                }
            }
            else {
                cpSync(pluginRoot, staging, { recursive: true });
            }
            if (existsSync(targetDir)) {
                rmSync(backupDir, { recursive: true, force: true });
                renameSync(targetDir, backupDir);
                movedCurrent = true;
            }
            try {
                renameSync(staging, targetDir);
            }
            catch (err) {
                if (movedCurrent && existsSync(backupDir)) {
                    renameSync(backupDir, targetDir);
                }
                throw err;
            }
            this.throwIfCancelled();
            this.ensureWorkspaces();
            logger.info(`[Yunzai] 正在为 ${dirName} 安装依赖...`);
            await this.npmInstall(getYunzaiDir());
            this.throwIfCancelled();
            rmSync(backupDir, { recursive: true, force: true });
            logger.info(`[Yunzai] ${dirName} 解压安装完成`);
            return {
                dirName,
                repoUrl: '',
                label: dirName
            };
        }
        catch (err) {
            try {
                if (backupDir && existsSync(backupDir)) {
                    rmSync(targetDir, { recursive: true, force: true });
                    renameSync(backupDir, targetDir);
                }
                else if (targetDir && !movedCurrent && existsSync(targetDir)) {
                    rmSync(targetDir, { recursive: true, force: true });
                }
            }
            catch { }
            throw err;
        }
        finally {
            try {
                rmSync(tempRoot, { recursive: true, force: true });
            }
            catch { }
            this.endTask();
        }
    }
    async updatePlugin(plugin, force = false) {
        if (!this.isInstalled) {
            throw new Error('Yunzai 未安装');
        }
        const pluginDir = `${getYunzaiDir()}/plugins/${plugin.dirName}`;
        if (!existsSync(pluginDir)) {
            throw new Error(`${plugin.label} 未安装`);
        }
        this.beginTask('更新插件');
        try {
            if (force) {
                logger.info(`[Yunzai] 强制重置 ${plugin.label} 本地更改...`);
                await this.execGit(gitFetchAll(pluginDir));
                this.throwIfCancelled();
                await this.execGit(gitResetHard(pluginDir));
                this.throwIfCancelled();
            }
            logger.info(`[Yunzai] 正在更新 ${plugin.label}...`);
            const out = await this.execGit(gitPull(pluginDir));
            this.throwIfCancelled();
            this.ensureWorkspaces();
            logger.info('[Yunzai] 正在安装插件依赖...');
            await this.npmInstall(getYunzaiDir());
            this.throwIfCancelled();
            logger.info(`[Yunzai] ${plugin.label} 更新完成`);
            return out;
        }
        finally {
            this.endTask();
        }
    }
    uninstallPlugin(plugin) {
        if (!this.isInstalled) {
            throw new Error('Yunzai 未安装');
        }
        const pluginDir = `${getYunzaiDir()}/plugins/${plugin.dirName}`;
        if (!existsSync(pluginDir)) {
            throw new Error(`${plugin.label} 未安装`);
        }
        this.beginTask('卸载插件');
        try {
            logger.info(`[Yunzai] 正在卸载 ${plugin.label}...`);
            rmSync(pluginDir, { recursive: true, force: true });
            logger.info(`[Yunzai] ${plugin.label} 已卸载`);
        }
        finally {
            this.endTask();
        }
    }
    async installDeps() {
        if (!this.isInstalled) {
            throw new Error('Yunzai 未安装');
        }
        this.beginTask('安装依赖');
        try {
            this.ensureWorkspaces();
            this.throwIfCancelled();
            logger.info('[Yunzai] 正在安装依赖...');
            const out = await this.npmInstall(getYunzaiDir());
            this.throwIfCancelled();
            logger.info('[Yunzai] 依赖安装完成');
            return out;
        }
        finally {
            this.endTask();
        }
    }
    async installBrowser() {
        if (!this.isInstalled) {
            throw new Error('Yunzai 未安装');
        }
        this.beginTask('安装浏览器');
        try {
            logger.info('[Yunzai] 正在安装 Puppeteer Chrome 浏览器...');
            const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
            const output = await new Promise((resolve, reject) => {
                try {
                    const cp = execFile(command, ['puppeteer', 'browsers', 'install', 'chrome'], { cwd: getYunzaiDir(), timeout: 1_800_000 }, (err, stdout, stderr) => {
                        this.taskProcess = null;
                        if (err) {
                            const hint = err.killed ? ' (超时)' : '';
                            const detail = stderr?.trim() ? `${stderr.trim()}\n${err.message}` : err.message;
                            reject(new Error(`${detail}${hint}`));
                            return;
                        }
                        resolve(stdout);
                    });
                    this.taskProcess = cp;
                }
                catch (err) {
                    this.taskProcess = null;
                    reject(err);
                }
            });
            this.throwIfCancelled();
            logger.info('[Yunzai] Puppeteer Chrome 浏览器安装完成');
            return output;
        }
        finally {
            this.endTask();
        }
    }
    patchPackageJsonForInstall(cwd) {
        const pkgPath = join(cwd, 'package.json');
        const backupPath = join(cwd, 'package.json.text');
        if (!existsSync(pkgPath)) {
            return () => { };
        }
        let raw = '';
        let pkg;
        try {
            raw = readFileSync(pkgPath, 'utf-8');
            pkg = JSON.parse(raw);
        }
        catch (err) {
            logger.warn(`[Yunzai] package.json 解析失败: ${err.message}`);
            return () => { };
        }
        let modified = false;
        if (pkg.private !== true) {
            pkg.private = true;
            modified = true;
            logger.info('[Yunzai] 依赖安装前临时补充 private: true');
        }
        const workspaces = Array.isArray(pkg.workspaces) ? [...pkg.workspaces] : [];
        if (!workspaces.includes('plugins/*')) {
            pkg.workspaces = [...workspaces, 'plugins/*'];
            modified = true;
            logger.info('[Yunzai] 依赖安装前临时补充 workspaces: ["plugins/*"]');
        }
        if (typeof pkg.name !== 'string' || !pkg.name.startsWith('@')) {
            pkg.name = '@alemonjs/yunzai-workspace';
            modified = true;
            logger.info('[Yunzai] 依赖安装前临时补充私有命名空间包名: @alemonjs/yunzai-workspace');
        }
        if (modified) {
            writeFileSync(backupPath, raw, 'utf-8');
            writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
        }
        return () => {
            if (!modified) {
                return;
            }
            try {
                if (existsSync(backupPath)) {
                    writeFileSync(pkgPath, readFileSync(backupPath, 'utf-8'), 'utf-8');
                    rmSync(backupPath, { force: true });
                }
                logger.info('[Yunzai] 依赖安装完成，已恢复 package.json 原始字段');
            }
            catch (err) {
                logger.warn(`[Yunzai] 恢复 package.json 失败: ${err.message}`);
            }
        };
    }
    ensureWorkspaces() {
        const pkgPath = `${getYunzaiDir()}/package.json`;
        if (!existsSync(pkgPath)) {
            return;
        }
        try {
            JSON.parse(readFileSync(pkgPath, 'utf-8'));
        }
        catch (err) {
            logger.warn(`[Yunzai] package.json 解析失败: ${err.message}`);
        }
    }
}
const manager = new YunzaiManager();

export { manager };
