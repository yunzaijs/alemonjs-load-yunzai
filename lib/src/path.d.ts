export declare const PACKAGE_ROOT: string;
export declare const WORKER_PATH: string;
export declare const YARN_PATH: string;
export declare function getGhProxy(): string;
export declare function getDefaultRepo(): string;
export declare function getMiaoPluginRepo(): string;
export interface PluginInfo {
    dirName: string;
    repoUrl: string;
    label: string;
}
export interface PluginDef extends PluginInfo {
    aliases: string[];
}
export declare function getAllPlugins(): PluginDef[];
export declare function getPluginInfo(alias: string): PluginInfo | undefined;
export declare function getYunzaiDir(): string;
