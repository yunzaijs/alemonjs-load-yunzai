import { PACKAGE_ROOT, WORKER_PATH, YARN_PATH, getDefaultRepo, getGhProxy, getYunzaiDir } from "../path.js";
import { gitClone, gitFetchAll, gitPull, gitResetHard } from "./git.js";
import { detectYunzaiVariant, readYunzaiPackage } from "./variant.js";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigValue, logger } from "alemonjs";
import extractZip from "extract-zip";
import { execFile, fork } from "node:child_process";
import { tmpdir } from "node:os";

//#region src/yunzai/manager.ts
/**
* Yunzai 进程管理器
*
* 职责：
* 1. Git 操作 — clone / pull 当前 Yunzai 发行版仓库
* 2. 子进程生命周期 — fork / stop / restart Worker
* 3. IPC 通信 — 父子进程消息收发
*/
/** 启动失败标记文件路径（存在 = 上次反复崩溃） */
function getStartFailedPath() {
	return join(getYunzaiDir(), ".last_start_failed");
}
function readGitBranchName(repoDir) {
	try {
		const gitPath = join(repoDir, ".git");
		let headPath = join(gitPath, "HEAD");
		try {
			const gitdir = readFileSync(gitPath, "utf-8").trim().match(/^gitdir:\s*(.+)$/i)?.[1];
			if (gitdir) headPath = join(repoDir, gitdir, "HEAD");
		} catch {}
		return readFileSync(headPath, "utf-8").trim().match(/^ref:\s+refs\/heads\/(.+)$/)?.[1] ?? "";
	} catch {
		return "";
	}
}
function isPureEditionPackage(pkg, repoDir) {
	if (pkg?.pureEdition === true) return true;
	return /pure/i.test(readGitBranchName(repoDir));
}
function sanitizePluginDirName(name) {
	return name.trim().replace(/\.zip$/i, "").replace(/[\\/:"*?<>|]+/g, "-").replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
}
function pluginLooksValid(dir) {
	return existsSync(join(dir, "package.json")) || existsSync(join(dir, "apps")) || existsSync(join(dir, "lib")) || existsSync(join(dir, "index.js"));
}
function getPluginCandidateEntries(dir) {
	return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.name !== "__MACOSX").map((entry) => entry.name);
}
function resolveArchivePluginRoot(extractDir) {
	if (pluginLooksValid(extractDir)) return {
		pluginRoot: extractDir,
		suggestedDirName: null
	};
	const entries = getPluginCandidateEntries(extractDir);
	if (entries.length === 1) {
		const singleEntryDir = join(extractDir, entries[0]);
		if (pluginLooksValid(singleEntryDir)) return {
			pluginRoot: singleEntryDir,
			suggestedDirName: sanitizePluginDirName(entries[0])
		};
	}
	throw new Error("ZIP 中未识别到有效插件目录，请确认压缩包内包含 package.json、apps、lib 或 index.js");
}
var YunzaiManager = class {
	worker = null;
	ready = false;
	replyHandlers = /* @__PURE__ */ new Set();
	doneHandlers = /* @__PURE__ */ new Set();
	apiRequestHandlers = /* @__PURE__ */ new Set();
	exitHandlers = /* @__PURE__ */ new Set();
	readyHandlers = /* @__PURE__ */ new Set();
	restartCount = 0;
	maxRestarts = 3;
	restartTimer = null;
	/** 当前正在执行的长时间任务名称 */
	taskName = null;
	/** 当前长时间任务的子进程（用于取消） */
	taskProcess = null;
	/** 任务是否被用户取消 */
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
		if (this.taskName) return `正在${this.taskName}`;
		if (!this.isInstalled) return "未安装";
		if (!this.isRunning) return "已停止";
		if (!this.ready) return "启动中";
		return "运行中";
	}
	/** 是否有长时间任务正在执行 */
	get isBusy() {
		return this.taskName !== null;
	}
	/** 当前安装的 Yunzai 发行版；安装前返回 unknown。 */
	get variant() {
		return detectYunzaiVariant(readYunzaiPackage(getYunzaiDir()));
	}
	/** package.json 中声明的机器人/发行版身份。 */
	get packageName() {
		return String(readYunzaiPackage(getYunzaiDir())?.name ?? "");
	}
	/** 当前任务名称 */
	get busyTaskName() {
		return this.taskName ?? "";
	}
	/**
	* 上次启动是否成功
	* 用于决定 onCreated 是否自动启动：如果上次反复崩溃则跳过
	* 首次安装（无标记文件）视为可启动
	*/
	get lastStartOk() {
		try {
			return !existsSync(getStartFailedPath());
		} catch {
			return true;
		}
	}
	/** 标记启动成功（移除失败标记） */
	markStartOk() {
		try {
			if (existsSync(getStartFailedPath())) rmSync(getStartFailedPath());
		} catch {}
	}
	/** 标记启动失败（写入失败标记） */
	markStartFailed() {
		try {
			writeFileSync(getStartFailedPath(), String(Date.now()), "utf-8");
		} catch {}
	}
	/** 取消当前正在执行的任务 */
	cancelTask() {
		if (!this.taskName) return false;
		this.taskCancelled = true;
		if (this.taskProcess) this.taskProcess.kill("SIGTERM");
		if (this.worker && !this.ready) this.worker.kill("SIGTERM");
		logger.info(`[Yunzai] 用户取消任务: ${this.taskName}`);
		return true;
	}
	async install(repoUrl = getDefaultRepo()) {
		const yunzaiDir = getYunzaiDir();
		if (this.isInstalled) throw new Error(`Yunzai 已安装在 ${yunzaiDir}`);
		this.beginTask("安装");
		try {
			logger.info(`[Yunzai] 正在克隆 ${repoUrl} ...`);
			await this.execGit(gitClone(repoUrl, yunzaiDir));
			this.throwIfCancelled();
			logger.info("[Yunzai] 克隆完成。请单独执行“安装依赖”后再启动");
		} catch (err) {
			logger.error(`[Yunzai] 安装失败: ${err?.message ?? String(err)}`);
			if (existsSync(yunzaiDir)) try {
				rmSync(yunzaiDir, {
					recursive: true,
					force: true
				});
				logger.info("[Yunzai] 安装失败，已清理残留目录");
			} catch (rmErr) {
				logger.warn(`[Yunzai] 清理残留目录失败: ${rmErr.message}`);
			}
			throw err;
		} finally {
			this.endTask();
		}
	}
	async update(force = false) {
		if (!this.isInstalled) throw new Error("Yunzai 未安装");
		this.beginTask("更新");
		try {
			const dir = getYunzaiDir();
			if (force) {
				logger.info("[Yunzai] 强制重置本地更改...");
				await this.execGit(gitFetchAll(dir));
				this.throwIfCancelled();
				await this.execGit(gitResetHard(dir));
				this.throwIfCancelled();
			}
			logger.info("[Yunzai] 正在拉取更新...");
			const out = await this.execGit(gitPull(dir));
			this.throwIfCancelled();
			logger.info("[Yunzai] 更新完成");
			return out;
		} finally {
			this.endTask();
		}
	}
	/** 更新代码 + 重装依赖（如正在运行则先停后启，全程单锁） */
	async updateAll(force = false) {
		if (!this.isInstalled) throw new Error("Yunzai 未安装");
		this.beginTask("更新");
		try {
			const wasRunning = this.isRunning;
			if (wasRunning) await this.stopInternal();
			this.throwIfCancelled();
			const dir = getYunzaiDir();
			if (force) {
				logger.info("[Yunzai] 强制重置本地更改...");
				await this.execGit(gitFetchAll(dir));
				this.throwIfCancelled();
				await this.execGit(gitResetHard(dir));
				this.throwIfCancelled();
			}
			logger.info("[Yunzai] 正在拉取更新...");
			const out = await this.execGit(gitPull(dir));
			this.throwIfCancelled();
			this.ensureWorkspaces();
			this.throwIfCancelled();
			logger.info("[Yunzai] 正在安装依赖...");
			await this.npmInstall(getYunzaiDir());
			this.throwIfCancelled();
			logger.info("[Yunzai] 更新完成，依赖已重装");
			if (wasRunning) {
				await this.startInternal();
				logger.info("[Yunzai] Worker 已自动重启");
			}
			return out;
		} finally {
			this.endTask();
		}
	}
	async start() {
		this.beginTask("启动");
		try {
			await this.startInternal();
		} finally {
			this.endTask();
		}
	}
	async stop() {
		this.beginTask("停止");
		try {
			await this.stopInternal();
		} finally {
			this.endTask();
		}
	}
	async restart() {
		this.beginTask("重启");
		try {
			this.restartCount = 0;
			await this.stopInternal();
			this.throwIfCancelled();
			await this.startInternal();
		} finally {
			this.endTask();
		}
	}
	/**
	* 兼容保留的一键安装入口；普通安装流程应依次调用 install、installDeps、start。
	* 该方法只在调用方明确要求“一键安装并启动”时组合执行，不改变 install 的职责。
	*/
	async installAndStart(repoUrl = getDefaultRepo()) {
		const yunzaiDir = getYunzaiDir();
		if (this.isInstalled) throw new Error(`Yunzai 已安装在 ${yunzaiDir}`);
		this.beginTask("安装");
		try {
			try {
				logger.info(`[Yunzai] 正在克隆 ${repoUrl} ...`);
				await this.execGit(gitClone(repoUrl, yunzaiDir));
				this.throwIfCancelled();
				this.ensureWorkspaces();
				this.throwIfCancelled();
				logger.info("[Yunzai] 克隆完成，正在安装依赖...");
				await this.npmInstall(yunzaiDir);
				this.throwIfCancelled();
				logger.info("[Yunzai] 依赖安装完成");
			} catch (err) {
				if (existsSync(yunzaiDir)) {
					try {
						rmSync(yunzaiDir, {
							recursive: true,
							force: true
						});
					} catch {}
					logger.info("[Yunzai] 安装失败，已清理残留目录");
				}
				throw err;
			}
			await this.startInternal();
		} finally {
			this.endTask();
		}
	}
	/** 卸载 Yunzai（删除整个安装目录） */
	async uninstall() {
		if (!this.isInstalled) throw new Error("Yunzai 未安装");
		this.beginTask("卸载");
		try {
			if (this.isRunning) await this.stopInternal();
			rmSync(getYunzaiDir(), {
				recursive: true,
				force: true
			});
			logger.info("[Yunzai] Yunzai 已卸载");
		} finally {
			this.endTask();
		}
	}
	/** 将 AlemonJS 的 Redis 配置同步到对应 Yunzai 的 config/config/redis.yaml */
	syncRedisConfig() {
		try {
			const rc = (getConfigValue() ?? {}).redis;
			if (!rc || typeof rc !== "object") {
				logger.info(`[Yunzai] 未找到 AlemonJS redis 配置，${this.variant} 将使用自身默认配置`);
				return;
			}
			const yunzaiDir = getYunzaiDir();
			const cfgDir = join(yunzaiDir, "config", "config");
			if (!existsSync(cfgDir)) mkdirSync(cfgDir, { recursive: true });
			const host = rc.host ?? "127.0.0.1";
			const port = rc.port ?? 6379;
			const username = rc.username ?? "";
			const password = rc.password ?? "";
			const db = rc.db ?? 0;
			const yaml = [
				`host: ${host}`,
				`port: ${port}`,
				`username: ${username}`,
				`password: ${password}`,
				`db: ${db}`
			].join("\n") + "\n";
			writeFileSync(join(cfgDir, "redis.yaml"), yaml, "utf-8");
			logger.info(`[Yunzai] Redis 配置已同步 → ${host}:${port}/${db}`);
		} catch (err) {
			logger.warn(`[Yunzai] Redis 配置同步失败: ${err.message}`);
		}
	}
	/** 启动前检查框架必要插件，优先给出明确提示而不是等 Worker 报模块错误 */
	validateRequiredPlugins() {
		const yunzaiDir = getYunzaiDir();
		const pkgPath = join(yunzaiDir, "package.json");
		if (!existsSync(pkgPath)) return;
		let pkg;
		try {
			pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		} catch (err) {
			logger.warn(`[Yunzai] 启动前检查跳过: package.json 解析失败: ${err.message}`);
			return;
		}
		const pureEdition = isPureEditionPackage(pkg, yunzaiDir);
		const missing = [];
		if (!pureEdition && detectYunzaiVariant(pkg) === "miao") {
			const miaoPluginDir = join(yunzaiDir, "plugins", "miao-plugin");
			const miaoPluginEntry = join(miaoPluginDir, "components", "index.js");
			if (!existsSync(miaoPluginDir) || !existsSync(miaoPluginEntry)) missing.push("miao-plugin");
		}
		if (missing.length > 0) throw new Error(`当前为 Miao-Yunzai，缺少必要插件: ${missing.join(", ")}。请先发送 #yz安装插件miao，安装完成后再发送 #yz启动`);
	}
	async startInternal() {
		if (this.isRunning) throw new Error("Worker 已在运行");
		if (!this.isInstalled) {
			logger.warn("[Yunzai] 未安装，跳过启动");
			return;
		}
		this.ready = false;
		this.normalizeKnownPluginDirectories();
		this.validateRequiredPlugins();
		this.syncRedisConfig();
		this.worker = fork(WORKER_PATH, [], {
			cwd: getYunzaiDir(),
			stdio: [
				"pipe",
				"pipe",
				"pipe",
				"ipc"
			],
			env: {
				...process.env,
				YUNZAI_DIR: getYunzaiDir()
			}
		});
		this.worker.stdout?.on("data", (buf) => {
			for (const line of buf.toString().split("\n").filter(Boolean)) logger.info(`[Yunzai:out] ${line}`);
		});
		this.worker.stderr?.on("data", (buf) => {
			for (const line of buf.toString().split("\n").filter(Boolean)) logger.warn(`[Yunzai:err] ${line}`);
		});
		this.worker.on("message", (msg) => {
			this.handleMessage(msg);
		});
		this.worker.on("exit", (code, signal) => {
			logger.info(`[Yunzai] Worker 退出 code=${code} signal=${signal}`);
			this.worker = null;
			this.ready = false;
			for (const h of this.exitHandlers) try {
				h(code);
			} catch {}
			if (code !== 0 && this.restartCount < this.maxRestarts && !this.isBusy) {
				this.restartCount++;
				logger.info(`[Yunzai] 自动重启 (${this.restartCount}/${this.maxRestarts})...`);
				this.restartTimer = setTimeout(() => {
					this.restartTimer = null;
					this.start().catch((err) => {
						logger.error(`[Yunzai] 自动重启失败: ${err.message}`);
					});
				}, 3e3);
			} else if (code !== 0 && this.restartCount >= this.maxRestarts) {
				this.markStartFailed();
				logger.error("[Yunzai] 自动重启次数耗尽，下次启动将不会自动启动。请排查问题后发送 #yz启动");
			}
		});
		await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				reject(/* @__PURE__ */ new Error("Worker 启动超时 (30s)"));
			}, 3e4);
			const handler = (msg) => {
				if (msg.type === "ready") {
					cleanup();
					this.ready = true;
					this.restartCount = 0;
					this.markStartOk();
					logger.info(`[Yunzai] Worker 就绪，已加载 ${msg.pluginCount} 个插件`);
					for (const readyHandler of this.readyHandlers) try {
						readyHandler();
					} catch (err) {
						logger.warn(`[Yunzai] Worker 就绪回调失败: ${err?.message ?? String(err)}`);
					}
					resolve();
				} else if (msg.type === "error") {
					cleanup();
					reject(new Error(msg.message));
				}
			};
			const exitHandler = (code) => {
				cleanup();
				reject(/* @__PURE__ */ new Error(`Worker 启动时退出 (code=${code})`));
			};
			const cleanup = () => {
				clearTimeout(timeout);
				this.worker?.removeListener("message", handler);
				this.worker?.removeListener("exit", exitHandler);
			};
			this.worker.on("message", handler);
			this.worker.once("exit", exitHandler);
		});
	}
	/** 兼容旧版本把 Yunzai-genshin 安装到错误目录名的情况。 */
	normalizeKnownPluginDirectories() {
		const pluginsDir = join(getYunzaiDir(), "plugins");
		const legacyDir = join(pluginsDir, "Yunzai-genshin");
		const canonicalDir = join(pluginsDir, "genshin");
		if (!existsSync(legacyDir) || existsSync(canonicalDir)) return;
		renameSync(legacyDir, canonicalDir);
		logger.info("[Yunzai] 已将 Yunzai-genshin 目录修正为 genshin");
	}
	async stopInternal() {
		if (!this.isRunning || !this.worker) return;
		this.ready = false;
		this.restartCount = this.maxRestarts;
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		this.send({ type: "shutdown" });
		await new Promise((resolve) => {
			const timeout = setTimeout(() => {
				this.worker?.kill("SIGKILL");
				resolve();
			}, 5e3);
			this.worker.once("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});
		this.worker = null;
	}
	send(msg) {
		if (!this.worker || !this.isRunning) return;
		try {
			this.worker.send(msg);
		} catch (err) {
			logger.warn(`[Yunzai] IPC 发送失败: ${err.message}`);
		}
	}
	/** 注册回复处理器，返回取消函数 */
	onReply(handler) {
		this.replyHandlers.add(handler);
		return () => this.replyHandlers.delete(handler);
	}
	/** 注册 done 处理器（Worker deal() 完成时回调） */
	onDone(handler) {
		this.doneHandlers.add(handler);
		return () => this.doneHandlers.delete(handler);
	}
	/** 注册 API 请求处理器（Worker 发起 API 调用时回调） */
	onApiRequest(handler) {
		this.apiRequestHandlers.add(handler);
		return () => this.apiRequestHandlers.delete(handler);
	}
	/** 注册 Worker 退出处理器（用于清理 pending 状态） */
	onWorkerExit(handler) {
		this.exitHandlers.add(handler);
		return () => this.exitHandlers.delete(handler);
	}
	/** Worker 就绪通知（桥接层恢复排队事件使用） */
	onReady(handler) {
		this.readyHandlers.add(handler);
		return () => this.readyHandlers.delete(handler);
	}
	/** 发送任意消息给 Worker（用于 API 响应等） */
	sendToWorker(msg) {
		this.send(msg);
	}
	handleMessage(msg) {
		switch (msg.type) {
			case "reply":
				for (const h of this.replyHandlers) h(msg);
				break;
			case "done":
				for (const h of this.doneHandlers) h(msg);
				break;
			case "api":
				for (const h of this.apiRequestHandlers) h(msg);
				break;
			case "error":
				logger.error(`[Yunzai:worker] ${msg.message}`);
				break;
			case "log": {
				const fn = logger[msg.level];
				if (typeof fn === "function") fn.call(logger, `[Yunzai] ${msg.args.join(" ")}`);
				break;
			}
		}
	}
	beginTask(name) {
		if (this.taskName) throw new Error(`正在${this.taskName}，请等待完成或发送 #yz取消`);
		this.taskName = name;
		this.taskCancelled = false;
	}
	endTask() {
		this.taskName = null;
		this.taskProcess = null;
		this.taskCancelled = false;
	}
	throwIfCancelled() {
		if (this.taskCancelled) throw new Error("操作已取消");
	}
	/** 执行 git 操作并跟踪子进程（用于取消） */
	async execGit(result) {
		this.taskProcess = result.process;
		try {
			return await result.promise;
		} finally {
			this.taskProcess = null;
		}
	}
	/**
	* 按发行版安装依赖。
	* TRSS-Yunzai 的 package.json 使用 `link:` 依赖，Yarn 1 无法解析；
	* Miao/原版 Yunzai 仍保留 Yarn 工作区兼容流程。
	*/
	npmInstall(cwd) {
		if (detectYunzaiVariant(readYunzaiPackage(cwd)) === "trss") return this.pnpmInstall(cwd);
		return new Promise((resolve, reject) => {
			const restorePackageJson = this.patchPackageJsonForInstall(cwd);
			try {
				const cp = execFile(process.execPath, [
					YARN_PATH,
					"install",
					"--production=false"
				], {
					cwd,
					timeout: 18e5
				}, (err, stdout, stderr) => {
					this.taskProcess = null;
					restorePackageJson();
					if (err) {
						const hint = err.killed ? " (超时)" : "";
						const detail = stderr?.trim() ? `${stderr.trim()}\n${err.message}` : err.message;
						logger.error(`[Yunzai] Yarn 依赖安装失败: ${detail}`);
						reject(/* @__PURE__ */ new Error(`${detail}${hint}`));
					} else resolve(stdout);
				});
				this.taskProcess = cp;
			} catch (err) {
				this.taskProcess = null;
				restorePackageJson();
				reject(err);
			}
		});
	}
	getManagedPnpmPath() {
		const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
		return join(PACKAGE_ROOT, "runtime", "pnpm", "bin", executable);
	}
	/**
	* 使用插件内置 Yarn 引导一份私有 pnpm，避免要求用户预先全局安装。
	* 该目录不属于 Yunzai 仓库，更新/重装机器人时不会被覆盖。
	*/
	bootstrapManagedPnpm() {
		const pnpmPath = this.getManagedPnpmPath();
		if (existsSync(pnpmPath)) return Promise.resolve(pnpmPath);
		const prefix = join(PACKAGE_ROOT, "runtime", "pnpm");
		mkdirSync(prefix, { recursive: true });
		logger.info("[Yunzai] 未检测到 pnpm，正在通过内置 Yarn 准备私有 pnpm...");
		return new Promise((resolve, reject) => {
			try {
				const cp = execFile(process.execPath, [
					YARN_PATH,
					"global",
					"add",
					"pnpm@10",
					"--prefix",
					prefix
				], {
					cwd: PACKAGE_ROOT,
					timeout: 18e5
				}, (err, _stdout, stderr) => {
					this.taskProcess = null;
					if (err || !existsSync(pnpmPath)) {
						const stderrText = stderr?.trim();
						const detail = stderrText ? stderrText : err?.message ?? "pnpm 可执行文件未生成";
						logger.error(`[Yunzai] 私有 pnpm 准备失败: ${detail}`);
						reject(/* @__PURE__ */ new Error(`无法自动准备 pnpm: ${detail}`));
						return;
					}
					logger.info("[Yunzai] 私有 pnpm 已准备完成");
					resolve(pnpmPath);
				});
				this.taskProcess = cp;
			} catch (err) {
				this.taskProcess = null;
				logger.error(`[Yunzai] 私有 pnpm 无法启动: ${err?.message ?? String(err)}`);
				reject(/* @__PURE__ */ new Error(`无法自动准备 pnpm: ${err?.message ?? String(err)}`));
			}
		});
	}
	/** TRSS-Yunzai 使用 pnpm，保留它的 link: 依赖和原始 package.json。 */
	pnpmInstall(cwd) {
		return new Promise((resolve, reject) => {
			const systemCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
			const runInstall = (command, retriedWithManagedPnpm = false) => {
				try {
					const cp = execFile(command, ["install", "--prod=false"], {
						cwd,
						timeout: 18e5
					}, (err, stdout, stderr) => {
						this.taskProcess = null;
						if (err) {
							if (err.code === "ENOENT" && !retriedWithManagedPnpm) {
								this.bootstrapManagedPnpm().then((pnpmPath) => runInstall(pnpmPath, true)).catch(reject);
								return;
							}
							const hint = err.killed ? " (超时)" : "";
							const detail = stderr?.trim() ? `${stderr.trim()}\n${err.message}` : err.message;
							logger.error(`[Yunzai] TRSS pnpm 依赖安装失败: ${detail}${hint}`);
							reject(/* @__PURE__ */ new Error(`${detail}${hint}`));
							return;
						}
						resolve(stdout);
					});
					this.taskProcess = cp;
				} catch (err) {
					this.taskProcess = null;
					if (err?.code === "ENOENT" && !retriedWithManagedPnpm) {
						this.bootstrapManagedPnpm().then((pnpmPath) => runInstall(pnpmPath, true)).catch(reject);
						return;
					}
					logger.error(`[Yunzai] TRSS pnpm 无法启动: ${err?.message ?? String(err)}`);
					reject(new Error(err?.message ?? String(err)));
				}
			};
			runInstall(systemCommand);
		});
	}
	/** 安装插件到 plugins 目录 */
	async installPlugin(plugin) {
		if (!this.isInstalled) throw new Error("Yunzai 未安装");
		this.normalizeKnownPluginDirectories();
		const dirName = plugin.dirName.trim();
		if (!dirName || dirName === "." || dirName === ".." || /[\\/:"*?<>|]/.test(dirName)) throw new Error(`插件目录名无效：${plugin.dirName}`);
		const pluginDir = join(getYunzaiDir(), "plugins", dirName);
		if (existsSync(pluginDir)) throw new Error(`${plugin.label} 已安装`);
		this.beginTask("安装插件");
		try {
			const repoUrl = plugin.repoUrl.startsWith("https://github.com/") ? `${getGhProxy()}${plugin.repoUrl}` : plugin.repoUrl;
			logger.info(`[Yunzai] 正在安装 ${plugin.label}...`);
			await this.execGit(gitClone(repoUrl, pluginDir));
			this.throwIfCancelled();
			this.ensureWorkspaces();
			logger.info("[Yunzai] 正在安装插件依赖...");
			await this.npmInstall(getYunzaiDir());
			this.throwIfCancelled();
			logger.info(`[Yunzai] ${plugin.label} 安装完成`);
		} catch (err) {
			if (existsSync(pluginDir)) try {
				rmSync(pluginDir, {
					recursive: true,
					force: true
				});
			} catch {}
			throw err;
		} finally {
			this.endTask();
		}
	}
	async installPluginArchive(archivePath, options) {
		if (!this.isInstalled) throw new Error("Yunzai 未安装");
		const tempRoot = mkdtempSync(join(tmpdir(), "alemonjs-yunzai-plugin-"));
		const extractDir = join(tempRoot, "extract");
		let pluginDir = "";
		this.beginTask("安装插件压缩包");
		try {
			mkdirSync(extractDir, { recursive: true });
			await extractZip(archivePath, { dir: extractDir });
			this.throwIfCancelled();
			const { pluginRoot, suggestedDirName } = resolveArchivePluginRoot(extractDir);
			const dirName = sanitizePluginDirName(options?.dirName ?? suggestedDirName ?? options?.originalName ?? "uploaded-plugin");
			if (!dirName) throw new Error("无法确定插件目录名，请重新命名 ZIP 文件后再上传");
			pluginDir = join(getYunzaiDir(), "plugins", dirName);
			if (existsSync(pluginDir)) throw new Error(`${dirName} 已安装`);
			mkdirSync(join(getYunzaiDir(), "plugins"), { recursive: true });
			if (pluginRoot === extractDir) {
				mkdirSync(pluginDir, { recursive: true });
				for (const entry of getPluginCandidateEntries(pluginRoot)) renameSync(join(pluginRoot, entry), join(pluginDir, entry));
			} else cpSync(pluginRoot, pluginDir, { recursive: true });
			this.throwIfCancelled();
			this.ensureWorkspaces();
			logger.info(`[Yunzai] 正在为 ${dirName} 安装依赖...`);
			await this.npmInstall(getYunzaiDir());
			this.throwIfCancelled();
			logger.info(`[Yunzai] ${dirName} 安装完成`);
			return {
				dirName,
				repoUrl: "",
				label: dirName
			};
		} catch (err) {
			if (pluginDir && existsSync(pluginDir)) try {
				rmSync(pluginDir, {
					recursive: true,
					force: true
				});
			} catch {}
			throw err;
		} finally {
			try {
				rmSync(tempRoot, {
					recursive: true,
					force: true
				});
			} catch {}
			this.endTask();
		}
	}
	/**
	* 将已保存的插件压缩包解压安装到 plugins/ 目录。
	* 与仓库页压缩包解压保持一致：Yunzai 运行中拒绝操作；已存在同名目录时
	* 通过暂存 + 备份的方式安全覆盖，任一步失败都会回滚旧目录。
	*/
	async extractPluginArchiveFromFile(archivePath, options) {
		if (!this.isInstalled) throw new Error("Yunzai 未安装");
		if (this.isRunning) throw new Error("Yunzai 正在运行，请先停止后再解压插件压缩包");
		const tempRoot = mkdtempSync(join(tmpdir(), "alemonjs-yunzai-plugin-"));
		const extractDir = join(tempRoot, "extract");
		let targetDir = "";
		let backupDir = "";
		let movedCurrent = false;
		this.beginTask("解压安装插件");
		try {
			mkdirSync(extractDir, { recursive: true });
			await extractZip(archivePath, { dir: extractDir });
			this.throwIfCancelled();
			const { pluginRoot, suggestedDirName } = resolveArchivePluginRoot(extractDir);
			const dirName = sanitizePluginDirName(options?.dirName ?? suggestedDirName ?? options?.originalName ?? "uploaded-plugin");
			if (!dirName) throw new Error("无法确定插件目录名，请重新命名 ZIP 文件后再上传");
			const pluginsDir = join(getYunzaiDir(), "plugins");
			targetDir = join(pluginsDir, dirName);
			backupDir = join(pluginsDir, `.${dirName}.archive-backup-${Date.now()}`);
			const staging = join(pluginsDir, `.${dirName}.archive-staging-${Date.now()}`);
			mkdirSync(pluginsDir, { recursive: true });
			rmSync(staging, {
				recursive: true,
				force: true
			});
			if (pluginRoot === extractDir) {
				mkdirSync(staging, { recursive: true });
				for (const entry of getPluginCandidateEntries(pluginRoot)) renameSync(join(pluginRoot, entry), join(staging, entry));
			} else cpSync(pluginRoot, staging, { recursive: true });
			if (existsSync(targetDir)) {
				rmSync(backupDir, {
					recursive: true,
					force: true
				});
				renameSync(targetDir, backupDir);
				movedCurrent = true;
			}
			try {
				renameSync(staging, targetDir);
			} catch (err) {
				if (movedCurrent && existsSync(backupDir)) renameSync(backupDir, targetDir);
				throw err;
			}
			this.throwIfCancelled();
			this.ensureWorkspaces();
			logger.info(`[Yunzai] 正在为 ${dirName} 安装依赖...`);
			await this.npmInstall(getYunzaiDir());
			this.throwIfCancelled();
			rmSync(backupDir, {
				recursive: true,
				force: true
			});
			logger.info(`[Yunzai] ${dirName} 解压安装完成`);
			return {
				dirName,
				repoUrl: "",
				label: dirName
			};
		} catch (err) {
			try {
				if (backupDir && existsSync(backupDir)) {
					rmSync(targetDir, {
						recursive: true,
						force: true
					});
					renameSync(backupDir, targetDir);
				} else if (targetDir && !movedCurrent && existsSync(targetDir)) rmSync(targetDir, {
					recursive: true,
					force: true
				});
			} catch {}
			throw err;
		} finally {
			try {
				rmSync(tempRoot, {
					recursive: true,
					force: true
				});
			} catch {}
			this.endTask();
		}
	}
	/** 更新指定插件（git pull） */
	async updatePlugin(plugin, force = false) {
		if (!this.isInstalled) throw new Error("Yunzai 未安装");
		this.normalizeKnownPluginDirectories();
		const pluginDir = `${getYunzaiDir()}/plugins/${plugin.dirName}`;
		if (!existsSync(pluginDir)) throw new Error(`${plugin.label} 未安装`);
		this.beginTask("更新插件");
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
			logger.info("[Yunzai] 正在安装插件依赖...");
			await this.npmInstall(getYunzaiDir());
			this.throwIfCancelled();
			logger.info(`[Yunzai] ${plugin.label} 更新完成`);
			return out;
		} finally {
			this.endTask();
		}
	}
	/** 卸载指定插件 */
	uninstallPlugin(plugin) {
		if (!this.isInstalled) throw new Error("Yunzai 未安装");
		this.normalizeKnownPluginDirectories();
		const pluginDir = `${getYunzaiDir()}/plugins/${plugin.dirName}`;
		if (!existsSync(pluginDir)) throw new Error(`${plugin.label} 未安装`);
		this.beginTask("卸载插件");
		try {
			logger.info(`[Yunzai] 正在卸载 ${plugin.label}...`);
			rmSync(pluginDir, {
				recursive: true,
				force: true
			});
			logger.info(`[Yunzai] ${plugin.label} 已卸载`);
		} finally {
			this.endTask();
		}
	}
	/** 重新安装依赖（用于依赖缺失后修复） */
	async installDeps() {
		if (!this.isInstalled) throw new Error("Yunzai 未安装");
		this.beginTask("安装依赖");
		try {
			this.ensureWorkspaces();
			this.throwIfCancelled();
			logger.info("[Yunzai] 正在安装依赖...");
			const out = await this.npmInstall(getYunzaiDir());
			this.throwIfCancelled();
			logger.info("[Yunzai] 依赖安装完成");
			return out;
		} finally {
			this.endTask();
		}
	}
	/** 安装单个 npm 包，供管理面板的依赖工具使用。 */
	async installDependency(packageName, version, dependencyType) {
		if (!this.isInstalled) throw new Error("Yunzai 未安装");
		const name = packageName.trim();
		const requestedVersion = version.trim();
		if (!/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(name)) throw new Error("包名格式不正确");
		if (requestedVersion && !/^[a-z0-9._~+^<>=*| -]+$/i.test(requestedVersion)) throw new Error("版本格式不正确");
		const spec = requestedVersion ? `${name}@${requestedVersion}` : name;
		this.beginTask(`安装 ${spec}`);
		try {
			this.throwIfCancelled();
			logger.info(`[Yunzai] 正在安装 ${spec}...`);
			const isTrss = detectYunzaiVariant(readYunzaiPackage(getYunzaiDir())) === "trss";
			const devFlag = dependencyType === "devDependencies" ? "--dev" : "";
			const output = await this.execPackageAdd(getYunzaiDir(), spec, devFlag, isTrss);
			this.throwIfCancelled();
			logger.info(`[Yunzai] ${spec} 安装完成`);
			return output;
		} finally {
			this.endTask();
		}
	}
	execPackageAdd(cwd, spec, devFlag, isTrss) {
		const run = (command, args, retried = false) => new Promise((resolve, reject) => {
			try {
				const cp = execFile(command, args, {
					cwd,
					timeout: 18e5
				}, (err, stdout, stderr) => {
					this.taskProcess = null;
					if (err) {
						if (isTrss && err.code === "ENOENT" && !retried) {
							this.bootstrapManagedPnpm().then((pnpm) => run(pnpm, [
								"add",
								spec,
								devFlag
							].filter(Boolean), true)).then(resolve).catch(reject);
							return;
						}
						const detail = stderr?.trim() ? `${stderr.trim()}\n${err.message}` : err.message;
						reject(new Error(detail));
						return;
					}
					resolve(stdout);
				});
				this.taskProcess = cp;
			} catch (err) {
				this.taskProcess = null;
				reject(err);
			}
		});
		return isTrss ? run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", [
			"add",
			spec,
			devFlag
		].filter(Boolean)) : run(process.execPath, [
			YARN_PATH,
			"add",
			spec,
			devFlag
		].filter(Boolean));
	}
	/** 安装 Puppeteer 所需的 Chrome 浏览器 */
	async installBrowser() {
		if (!this.isInstalled) throw new Error("Yunzai 未安装");
		this.beginTask("安装浏览器");
		try {
			logger.info("[Yunzai] 正在安装 Puppeteer Chrome 浏览器...");
			const command = process.platform === "win32" ? "npx.cmd" : "npx";
			const output = await new Promise((resolve, reject) => {
				try {
					const cp = execFile(command, [
						"puppeteer",
						"browsers",
						"install",
						"chrome"
					], {
						cwd: getYunzaiDir(),
						timeout: 18e5
					}, (err, stdout, stderr) => {
						this.taskProcess = null;
						if (err) {
							const hint = err.killed ? " (超时)" : "";
							const detail = stderr?.trim() ? `${stderr.trim()}\n${err.message}` : err.message;
							reject(/* @__PURE__ */ new Error(`${detail}${hint}`));
							return;
						}
						resolve(stdout);
					});
					this.taskProcess = cp;
				} catch (err) {
					this.taskProcess = null;
					reject(err);
				}
			});
			this.throwIfCancelled();
			logger.info("[Yunzai] Puppeteer Chrome 浏览器安装完成");
			return output;
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
	patchPackageJsonForInstall(cwd) {
		const pkgPath = join(cwd, "package.json");
		const backupPath = join(cwd, "package.json.text");
		if (!existsSync(pkgPath)) return () => {};
		let raw = "";
		let pkg;
		try {
			raw = readFileSync(pkgPath, "utf-8");
			pkg = JSON.parse(raw);
		} catch (err) {
			logger.warn(`[Yunzai] package.json 解析失败: ${err.message}`);
			return () => {};
		}
		let modified = false;
		if (pkg.private !== true) {
			pkg.private = true;
			modified = true;
			logger.info("[Yunzai] 依赖安装前临时补充 private: true");
		}
		const workspaces = Array.isArray(pkg.workspaces) ? [...pkg.workspaces] : [];
		if (!workspaces.includes("plugins/**")) {
			pkg.workspaces = [...workspaces, "plugins/**"];
			modified = true;
			logger.info("[Yunzai] 依赖安装前临时补充 workspaces: [\"plugins/**\"]");
		}
		if (typeof pkg.name !== "string" || !pkg.name.startsWith("@")) {
			pkg.name = "@alemonjs/yunzai-workspace";
			modified = true;
			logger.info("[Yunzai] 依赖安装前临时补充私有命名空间包名: @alemonjs/yunzai-workspace");
		}
		if (modified) {
			writeFileSync(backupPath, raw, "utf-8");
			writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
		}
		return () => {
			if (!modified) return;
			try {
				if (existsSync(backupPath)) {
					writeFileSync(pkgPath, readFileSync(backupPath, "utf-8"), "utf-8");
					rmSync(backupPath, { force: true });
				}
				logger.info("[Yunzai] 依赖安装完成，已恢复 package.json 原始字段");
			} catch (err) {
				logger.warn(`[Yunzai] 恢复 package.json 失败: ${err.message}`);
			}
		};
	}
	/**
	* 预检查 package.json 是否存在并可解析。
	* 真正的临时补字段在 npmInstall() 内执行并自动恢复。
	*/
	ensureWorkspaces() {
		const pkgPath = `${getYunzaiDir()}/package.json`;
		if (!existsSync(pkgPath)) return;
		try {
			JSON.parse(readFileSync(pkgPath, "utf-8"));
		} catch (err) {
			logger.warn(`[Yunzai] package.json 解析失败: ${err.message}`);
		}
	}
};
const manager = new YunzaiManager();

//#endregion
export { manager };