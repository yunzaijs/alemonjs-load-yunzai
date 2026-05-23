import type { ChildProcess } from 'node:child_process';
export declare function hasNativeGit(): boolean;
export interface GitResult {
    promise: Promise<string>;
    process: ChildProcess | null;
}
export declare function gitClone(url: string, dir: string): GitResult;
export declare function gitFetchAll(dir: string): GitResult;
export declare function gitResetHard(dir: string): GitResult;
export declare function gitPull(dir: string): GitResult;
