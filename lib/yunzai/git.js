import * as fs$1 from "node:fs";
import { join, resolve } from "node:path";
import { logger } from "alemonjs";
import { execFile, execFileSync } from "node:child_process";

//#region src/yunzai/git.ts
/**
* Git 抽象层
*
* 优先使用本地 git 命令行，如果系统未安装 git 则回退到 isomorphic-git。
*/
let _hasNativeGit = null;
function hasNativeGit() {
	if (_hasNativeGit !== null) return _hasNativeGit;
	try {
		execFileSync("git", ["--version"], {
			timeout: 5e3,
			stdio: "ignore"
		});
		_hasNativeGit = true;
		logger.info("[Git] 检测到本地 git");
	} catch {
		_hasNativeGit = false;
		logger.info("[Git] 未检测到本地 git，将使用 isomorphic-git");
	}
	return _hasNativeGit;
}
/** 仅在当前命令中信任操作目录，兼容不记录所有权的 Windows 磁盘。 */
function repositoryGitArgs(args, cwd) {
	return cwd ? [
		"-c",
		`safe.directory=${resolve(cwd).replace(/\\/g, "/")}`,
		...args
	] : args;
}
function describeGitFailure(operation, cwd, detail) {
	let hint = "请查看机器人日志中的 Git 详情，处理后重试。";
	if (/dubious ownership|safe\.directory|does not record ownership/i.test(detail)) hint = "Git 无法确认仓库目录的所有权，当前命令的目录信任设置未能解决。请在机器人运行账户下将此仓库加入 safe.directory，或迁移到支持文件所有权的磁盘后重试。";
	else if (/would be overwritten|local changes|conflict|divergent branches/i.test(detail)) hint = "本地修改或分支冲突阻止更新。请先备份并处理本地修改，再重试；强制更新会丢弃本地修改。";
	else if (/not a git repository|no tracking information|origin\/HEAD|no such remote/i.test(detail)) hint = "仓库元数据或远程分支配置不完整。若通过 ZIP 安装，请先修复仓库来源并检查远程分支配置。";
	else if (/authentication failed|permission denied|could not read Username|repository not found/i.test(detail)) hint = "仓库地址、访问权限或凭据有误，请检查仓库配置及运行账户的访问权限。";
	else if (/resolve host|connect|timed out|timeout|SSL|TLS/i.test(detail)) hint = "连接仓库失败或超时，请检查网络、代理和证书配置后重试。";
	return `Git 操作失败（${operation}）${cwd ? `，目录：${cwd}` : ""}。${hint}`;
}
function gitFailure(args, cwd, err, stderr) {
	const detail = stderr?.trim() ? stderr.trim() : err.message;
	logger.error(`[Git] ${args[0]} 失败，目录：${cwd ?? "默认目录"}\n${detail}`);
	return new Error(describeGitFailure(args[0], cwd, detail));
}
/** ZIP 仓库修复也复用同样的目录信任与错误反馈。 */
function gitExecSync(args, cwd) {
	try {
		execFileSync("git", repositoryGitArgs(args, cwd), {
			cwd,
			timeout: 3e4,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
	} catch (err) {
		throw gitFailure(args, cwd, err, err.stderr?.toString());
	}
}
function nativeExec(args, cwd) {
	let cp;
	return {
		promise: new Promise((resolve, reject) => {
			cp = execFile("git", repositoryGitArgs(args, cwd), {
				cwd,
				timeout: 18e5
			}, (err, stdout, stderr) => {
				if (err) reject(gitFailure(args, cwd, err, stderr));
				else resolve(stdout);
			});
		}),
		process: cp
	};
}
let _isoGit = null;
let _isoHttp = null;
async function iso() {
	if (!_isoGit) {
		_isoGit = await import("isomorphic-git");
		const httpMod = await import("isomorphic-git/http/node");
		_isoHttp = httpMod.default ?? httpMod;
	}
	return {
		git: _isoGit,
		http: _isoHttp
	};
}
/** git clone --depth 1 --single-branch <url> <dir> */
function gitClone(url, dir) {
	if (hasNativeGit()) return nativeExec([
		"clone",
		"--depth",
		"1",
		"--single-branch",
		url,
		dir
	]);
	return {
		process: null,
		promise: (async () => {
			const { git, http } = await iso();
			await git.clone({
				fs: fs$1,
				http,
				dir,
				url,
				depth: 1,
				singleBranch: true
			});
			return "clone complete";
		})()
	};
}
/** git fetch --all */
function gitFetchAll(dir) {
	if (hasNativeGit()) return nativeExec(["fetch", "--all"], dir);
	return {
		process: null,
		promise: (async () => {
			const { git, http } = await iso();
			await git.fetch({
				fs: fs$1,
				http,
				dir
			});
			return "fetch complete";
		})()
	};
}
/** git reset --hard origin/HEAD */
function gitResetHard(dir) {
	if (hasNativeGit()) return nativeExec([
		"reset",
		"--hard",
		"origin/HEAD"
	], dir);
	return {
		process: null,
		promise: (async () => {
			const { git } = await iso();
			const branch = await git.currentBranch({
				fs: fs$1,
				dir,
				fullname: false
			}) ?? "master";
			let remoteSha;
			try {
				remoteSha = await git.resolveRef({
					fs: fs$1,
					dir,
					ref: `refs/remotes/origin/${branch}`
				});
			} catch {
				remoteSha = await git.resolveRef({
					fs: fs$1,
					dir,
					ref: "refs/remotes/origin/HEAD"
				});
			}
			const refsDir = join(dir, ".git", "refs", "heads");
			if (!fs$1.existsSync(refsDir)) fs$1.mkdirSync(refsDir, { recursive: true });
			fs$1.writeFileSync(join(refsDir, branch), remoteSha + "\n");
			await git.checkout({
				fs: fs$1,
				dir,
				ref: branch,
				force: true
			});
			return "reset complete";
		})()
	};
}
/** git pull */
function gitPull(dir) {
	if (hasNativeGit()) return nativeExec(["pull"], dir);
	return {
		process: null,
		promise: (async () => {
			const { git, http } = await iso();
			await git.pull({
				fs: fs$1,
				http,
				dir,
				singleBranch: true,
				author: {
					name: "alemonjs",
					email: "alemonjs@local"
				}
			});
			return "pull complete";
		})()
	};
}

//#endregion
export { describeGitFailure, gitClone, gitExecSync, gitFetchAll, gitPull, gitResetHard, hasNativeGit, repositoryGitArgs };