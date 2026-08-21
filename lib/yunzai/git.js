import * as fs$1 from "node:fs";
import { join } from "node:path";
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
function nativeExec(args, cwd) {
	let cp;
	return {
		promise: new Promise((resolve, reject) => {
			cp = execFile("git", args, {
				cwd,
				timeout: 18e5
			}, (err, stdout, stderr) => {
				if (err) {
					const hint = err.killed ? " (超时)" : "";
					const detail = stderr?.trim() ? `${stderr.trim()}\n${err.message}` : err.message;
					reject(/* @__PURE__ */ new Error(`${detail}${hint}`));
				} else resolve(stdout);
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
export { gitClone, gitFetchAll, gitPull, gitResetHard, hasNativeGit };