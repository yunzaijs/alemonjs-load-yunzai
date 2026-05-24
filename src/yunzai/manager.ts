/**
 * Yunzai 进程管理器
 *
 * 职责：
 * 1. Git 操作 — clone / pull Miao-Yunzai 仓库
 * 2. 子进程生命周期 — fork / stop / restart Worker
 * 3. IPC 通信 — 父子进程消息收发
 */
import { getConfigValue, logger } from 'alemonjs';
import extractZip from 'extract-zip';
import type { ChildProcess } from 'node:child_process';
import { execFile, fork } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginInfo } from '../path';
import { getDefaultRepo, getGhProxy, getYunzaiDir, WORKER_PATH, YARN_PATH } from '../path';
import type { GitResult } from './git';
import { gitClone, gitFetchAll, gitPull, gitResetHard } from './git';
import type { IPCApiRequest, IPCReply, ParentToWorker, WorkerToParent } from './protocol';

type ReplyHandler = (reply: IPCReply) => void;
type ApiRequestHandler = (req: IPCApiRequest) => void;

/** 启动失败标记文件路径（存在 = 上次反复崩溃） */
function getStartFailedPath(): string {
  return join(getYunzaiDir(), '.last_start_failed');
}

function readGitBranchName(repoDir: string): string {
  try {
    const gitPath = join(repoDir, '.git');
    let headPath = join(gitPath, 'HEAD');

    try {
      const gitFile = readFileSync(gitPath, 'utf-8').trim();
      const gitdir = gitFile.match(/^gitdir:\s*(.+)$/i)?.[1];

      if (gitdir) {
        headPath = join(repoDir, gitdir, 'HEAD');
      }
    } catch {}

    const head = readFileSync(headPath, 'utf-8').trim();

    return head.match(/^ref:\s+refs\/heads\/(.+)$/)?.[1] ?? '';
  } catch {
    return '';
  }
}

function isPureEditionPackage(pkg: any, repoDir: string): boolean {
  if (pkg?.pureEdition === true) {
    return true;
  }

  return /pure/i.test(readGitBranchName(repoDir));
}

function sanitizePluginDirName(name: string): string {
  return name
    .trim()
    .replace(/\.zip$/i, '')
    .replace(/[\\/:"*?<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function pluginLooksValid(dir: string): boolean {
  return existsSync(join(dir, 'package.json')) || existsSync(join(dir, 'apps')) || existsSync(join(dir, 'lib')) || existsSync(join(dir, 'index.js'));
}

function getPluginCandidateEntries(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.name !== '__MACOSX')
    .map(entry => entry.name);
}

function resolveArchivePluginRoot(extractDir: string): { pluginRoot: string; suggestedDirName: string | null } {
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
  private worker: ChildProcess | null = null;
  private ready = false;
  private replyHandlers = new Set<ReplyHandler>();
  private doneHandlers = new Set<(done: any) => void>();
  private apiRequestHandlers = new Set<ApiRequestHandler>();
  private exitHandlers = new Set<(code: number | null) => void>();
  private restartCount = 0;
  private maxRestarts = 3;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  /** 当前正在执行的长时间任务名称 */
  private taskName: string | null = null;
  /** 当前长时间任务的子进程（用于取消） */
  private taskProcess: ChildProcess | null = null;
  /** 任务是否被用户取消 */
  private taskCancelled = false;

  // ─── 状态查询 ───

  get isInstalled(): boolean {
    return existsSync(getYunzaiDir());
  }

  get isRunning(): boolean {
    return this.worker !== null && !this.worker.killed;
  }

  get isReady(): boolean {
    return this.ready;
  }

  getStatus(): string {
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

  /** 是否有长时间任务正在执行 */
  get isBusy(): boolean {
    return this.taskName !== null;
  }

  /** 当前任务名称 */
  get busyTaskName(): string {
    return this.taskName ?? '';
  }

  /**
   * 上次启动是否成功
   * 用于决定 onCreated 是否自动启动：如果上次反复崩溃则跳过
   * 首次安装（无标记文件）视为可启动
   */
  get lastStartOk(): boolean {
    try {
      return !existsSync(getStartFailedPath());
    } catch {
      return true;
    }
  }

  /** 标记启动成功（移除失败标记） */
  private markStartOk(): void {
    try {
      if (existsSync(getStartFailedPath())) {
        rmSync(getStartFailedPath());
      }
    } catch {}
  }

  /** 标记启动失败（写入失败标记） */
  private markStartFailed(): void {
    try {
      writeFileSync(getStartFailedPath(), String(Date.now()), 'utf-8');
    } catch {}
  }

  /** 取消当前正在执行的任务 */
  cancelTask(): boolean {
    if (!this.taskName) {
      return false;
    }
    this.taskCancelled = true;
    if (this.taskProcess) {
      this.taskProcess.kill('SIGTERM');
    }
    // 启动/重启过程中取消 → 杀死正在等待 ready 的 Worker
    if (this.worker && !this.ready) {
      this.worker.kill('SIGTERM');
    }
    logger.info(`[Yunzai] 用户取消任务: ${this.taskName}`);

    return true;
  }

  // ─── Git 操作 ───

  async install(repoUrl = getDefaultRepo()): Promise<void> {
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
    } catch (err) {
      // 安装失败/取消 → 清理残留目录，避免 isInstalled 死锁
      if (existsSync(yunzaiDir)) {
        try {
          rmSync(yunzaiDir, { recursive: true, force: true });
          logger.info('[Yunzai] 安装失败，已清理残留目录');
        } catch (rmErr: any) {
          logger.warn(`[Yunzai] 清理残留目录失败: ${rmErr.message}`);
        }
      }
      throw err;
    } finally {
      this.endTask();
    }
  }

  async update(force = false): Promise<string> {
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
    } finally {
      this.endTask();
    }
  }

  /** 更新代码 + 重装依赖（如正在运行则先停后启，全程单锁） */
  async updateAll(force = false): Promise<string> {
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
    } finally {
      this.endTask();
    }
  }

  // ─── 进程控制（公开方法，带任务锁） ───

  async start(): Promise<void> {
    this.beginTask('启动');
    try {
      await this.startInternal();
    } finally {
      this.endTask();
    }
  }

  async stop(): Promise<void> {
    this.beginTask('停止');
    try {
      await this.stopInternal();
    } finally {
      this.endTask();
    }
  }

  async restart(): Promise<void> {
    this.beginTask('重启');
    try {
      this.restartCount = 0;
      await this.stopInternal();
      this.throwIfCancelled();
      await this.startInternal();
    } finally {
      this.endTask();
    }
  }

  /** 安装并自动启动（原子操作，单锁覆盖完整流程） */
  async installAndStart(repoUrl = getDefaultRepo()): Promise<void> {
    const yunzaiDir = getYunzaiDir();

    if (this.isInstalled) {
      throw new Error(`Yunzai 已安装在 ${yunzaiDir}`);
    }
    this.beginTask('安装');
    try {
      // 安装阶段
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
      } catch (err) {
        // 安装失败 → 清理残留目录
        if (existsSync(yunzaiDir)) {
          try {
            rmSync(yunzaiDir, { recursive: true, force: true });
          } catch {}
          logger.info('[Yunzai] 安装失败，已清理残留目录');
        }
        throw err;
      }
      // 启动阶段（安装成功后才执行）
      await this.startInternal();
    } finally {
      this.endTask();
    }
  }

  /** 卸载 Yunzai（删除整个安装目录） */
  async uninstall(): Promise<void> {
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
    } finally {
      this.endTask();
    }
  }

  // ─── 进程控制（内部方法，无锁） ───

  /** 将 AlemonJS 的 Redis 配置同步到 Miao-Yunzai 的 config/config/redis.yaml */
  private syncRedisConfig(): void {
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
    } catch (err: any) {
      logger.warn(`[Yunzai] Redis 配置同步失败: ${err.message}`);
    }
  }

  /** 启动前检查框架必要插件，优先给出明确提示而不是等 Worker 报模块错误 */
  private validateRequiredPlugins(): void {
    const yunzaiDir = getYunzaiDir();
    const pkgPath = join(yunzaiDir, 'package.json');

    if (!existsSync(pkgPath)) {
      return;
    }

    let pkg: any;

    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    } catch (err: any) {
      logger.warn(`[Yunzai] 启动前检查跳过: package.json 解析失败: ${err.message}`);

      return;
    }

    const pkgName = String(pkg?.name ?? '').toLowerCase();
    const pureEdition = isPureEditionPackage(pkg, yunzaiDir);
    const isMiaoVariant =
      pkgName === 'miao-yunzai' ||
      pkgName === 'miao_yunzai' ||
      typeof pkg?.imports?.['#miao'] === 'string' ||
      typeof pkg?.imports?.['#miao.models'] === 'string' ||
      typeof pkg?.scripts?.ksr === 'string';
    const missing: string[] = [];

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

  private async startInternal(): Promise<void> {
    if (this.isRunning) {
      throw new Error('Worker 已在运行');
    }
    if (!this.isInstalled) {
      logger.warn('[Yunzai] 未安装，跳过启动');

      return;
    }

    this.ready = false;

    // ── 启动前检查必要插件（如 Miao-Yunzai 依赖 miao-plugin） ──
    this.validateRequiredPlugins();

    // ── 同步 AlemonJS 的 Redis 配置到 Miao-Yunzai ──
    this.syncRedisConfig();

    this.worker = fork(WORKER_PATH, [], {
      cwd: getYunzaiDir(),
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, YUNZAI_DIR: getYunzaiDir() }
    });

    // 转发子进程标准输出
    this.worker.stdout?.on('data', (buf: Buffer) => {
      for (const line of buf.toString().split('\n').filter(Boolean)) {
        logger.info(`[Yunzai:out] ${line}`);
      }
    });
    this.worker.stderr?.on('data', (buf: Buffer) => {
      for (const line of buf.toString().split('\n').filter(Boolean)) {
        logger.warn(`[Yunzai:err] ${line}`);
      }
    });

    // IPC 消息路由
    this.worker.on('message', (msg: WorkerToParent) => {
      this.handleMessage(msg);
    });

    // 退出监听 & 自动重启（仅在正常运行时触发，任务进行中跳过）
    this.worker.on('exit', (code, signal) => {
      logger.info(`[Yunzai] Worker 退出 code=${code} signal=${signal}`);
      this.worker = null;
      this.ready = false;

      // 通知所有退出监听器（bridge 用于清理 pending）
      for (const h of this.exitHandlers) {
        try {
          h(code);
        } catch {}
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
      } else if (code !== 0 && this.restartCount >= this.maxRestarts) {
        // 自动重启耗尽 → 标记失败，下次启动不自动启动
        this.markStartFailed();
        logger.error('[Yunzai] 自动重启次数耗尽，下次启动将不会自动启动。请排查问题后发送 #yz启动');
      }
    });

    // 阻塞等待 ready 信号（同时监听 exit 避免 Worker 崩溃后挂起 30s）
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Worker 启动超时 (30s)'));
      }, 30_000);

      const handler = (msg: WorkerToParent) => {
        if (msg.type === 'ready') {
          cleanup();
          this.ready = true;
          this.restartCount = 0;
          this.markStartOk();
          logger.info(`[Yunzai] Worker 就绪，已加载 ${msg.pluginCount} 个插件`);
          resolve();
        } else if (msg.type === 'error') {
          cleanup();
          reject(new Error(msg.message));
        }
      };

      const exitHandler = (code: number | null) => {
        cleanup();
        reject(new Error(`Worker 启动时退出 (code=${code})`));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.worker?.removeListener('message', handler);
        this.worker?.removeListener('exit', exitHandler);
      };

      this.worker!.on('message', handler);
      this.worker!.once('exit', exitHandler);
    });
  }

  private async stopInternal(): Promise<void> {
    if (!this.isRunning || !this.worker) {
      return;
    }

    this.ready = false;
    this.restartCount = this.maxRestarts; // 阻止自动重启

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    this.send({ type: 'shutdown' });

    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        this.worker?.kill('SIGKILL');
        resolve();
      }, 5000);

      this.worker!.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    this.worker = null;
  }

  // ─── IPC 通信 ───

  send(msg: ParentToWorker): void {
    if (!this.worker || !this.isRunning) {
      return;
    }
    try {
      this.worker.send(msg);
    } catch (err: any) {
      logger.warn(`[Yunzai] IPC 发送失败: ${err.message}`);
    }
  }

  /** 注册回复处理器，返回取消函数 */
  onReply(handler: ReplyHandler): () => void {
    this.replyHandlers.add(handler);

    return () => this.replyHandlers.delete(handler);
  }

  /** 注册 done 处理器（Worker deal() 完成时回调） */
  onDone(handler: (done: any) => void): () => void {
    this.doneHandlers.add(handler);

    return () => this.doneHandlers.delete(handler);
  }

  /** 注册 API 请求处理器（Worker 发起 API 调用时回调） */
  onApiRequest(handler: ApiRequestHandler): () => void {
    this.apiRequestHandlers.add(handler);

    return () => this.apiRequestHandlers.delete(handler);
  }

  /** 注册 Worker 退出处理器（用于清理 pending 状态） */
  onWorkerExit(handler: (code: number | null) => void): () => void {
    this.exitHandlers.add(handler);

    return () => this.exitHandlers.delete(handler);
  }

  /** 发送任意消息给 Worker（用于 API 响应等） */
  sendToWorker(msg: ParentToWorker): void {
    this.send(msg);
  }

  // ─── 内部方法 ───

  private handleMessage(msg: WorkerToParent): void {
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
      // 'ready' 在 start() 的 Promise handler 中处理
    }
  }

  private beginTask(name: string): void {
    if (this.taskName) {
      throw new Error(`正在${this.taskName}，请等待完成或发送 #yz取消`);
    }
    this.taskName = name;
    this.taskCancelled = false;
  }

  private endTask(): void {
    this.taskName = null;
    this.taskProcess = null;
    this.taskCancelled = false;
  }

  private throwIfCancelled(): void {
    if (this.taskCancelled) {
      throw new Error('操作已取消');
    }
  }

  /** 执行 git 操作并跟踪子进程（用于取消） */
  private async execGit(result: GitResult): Promise<string> {
    this.taskProcess = result.process;
    try {
      return await result.promise;
    } finally {
      this.taskProcess = null;
    }
  }

  /** 使用内置 yarn 安装依赖（原生支持 workspaces，插件子包依赖一并安装） */
  private npmInstall(cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const restorePackageJson = this.patchPackageJsonForInstall(cwd);

      try {
        const cp = execFile(process.execPath, [YARN_PATH, 'install', '--production=false'], { cwd, timeout: 1_800_000 }, (err, stdout, stderr) => {
          this.taskProcess = null;
          restorePackageJson();
          if (err) {
            const hint = (err as any).killed ? ' (超时)' : '';
            const detail = stderr?.trim() ? `${stderr.trim()}\n${err.message}` : err.message;

            reject(new Error(`${detail}${hint}`));
          } else {
            resolve(stdout);
          }
        });

        this.taskProcess = cp;
      } catch (err) {
        this.taskProcess = null;
        restorePackageJson();
        reject(err);
      }
    });
  }

  /** 安装插件到 plugins 目录 */
  async installPlugin(plugin: PluginInfo): Promise<void> {
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
    } catch (err) {
      if (existsSync(pluginDir)) {
        try {
          rmSync(pluginDir, { recursive: true, force: true });
        } catch {}
      }
      throw err;
    } finally {
      this.endTask();
    }
  }

  async installPluginArchive(archivePath: string, options?: { dirName?: string; originalName?: string }): Promise<PluginInfo> {
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
      } else {
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
    } catch (err) {
      if (pluginDir && existsSync(pluginDir)) {
        try {
          rmSync(pluginDir, { recursive: true, force: true });
        } catch {}
      }
      throw err;
    } finally {
      try {
        rmSync(tempRoot, { recursive: true, force: true });
      } catch {}
      this.endTask();
    }
  }

  /** 更新指定插件（git pull） */
  async updatePlugin(plugin: PluginInfo, force = false): Promise<string> {
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
    } finally {
      this.endTask();
    }
  }

  /** 卸载指定插件 */
  uninstallPlugin(plugin: PluginInfo): void {
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
    } finally {
      this.endTask();
    }
  }

  /** 重新安装依赖（用于依赖缺失后修复） */
  async installDeps(): Promise<string> {
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
    } finally {
      this.endTask();
    }
  }

  /**
   * 安装依赖前临时补齐 package.json 字段，安装后恢复原样。
   * 目的：
   * 1. Yarn 1.x 需要 private: true 才能启用 workspaces
   * 2. 某些 Yunzai 分支未做命名空间隔离，临时补一个私有 scoped name 能降低依赖解析异常
   */
  private patchPackageJsonForInstall(cwd: string): () => void {
    const pkgPath = join(cwd, 'package.json');
    const backupPath = join(cwd, 'package.json.text');

    if (!existsSync(pkgPath)) {
      return () => {};
    }

    let raw = '';
    let pkg: any;

    try {
      raw = readFileSync(pkgPath, 'utf-8');
      pkg = JSON.parse(raw);
    } catch (err: any) {
      logger.warn(`[Yunzai] package.json 解析失败: ${err.message}`);

      return () => {};
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
      } catch (err: any) {
        logger.warn(`[Yunzai] 恢复 package.json 失败: ${err.message}`);
      }
    };
  }

  /**
   * 预检查 package.json 是否存在并可解析。
   * 真正的临时补字段在 npmInstall() 内执行并自动恢复。
   */
  private ensureWorkspaces(): void {
    const pkgPath = `${getYunzaiDir()}/package.json`;

    if (!existsSync(pkgPath)) {
      return;
    }

    try {
      JSON.parse(readFileSync(pkgPath, 'utf-8'));
    } catch (err: any) {
      logger.warn(`[Yunzai] package.json 解析失败: ${err.message}`);
    }
  }
}

export const manager = new YunzaiManager();
