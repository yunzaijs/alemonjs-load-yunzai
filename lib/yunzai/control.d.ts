type PrimitiveRecord = Record<string, unknown>;
export interface PluginItem {
    name: string;
    installed: boolean;
    isGit: boolean;
}
export interface CatalogItem {
    dirName: string;
    label: string;
    aliases: string[];
    repoUrl: string;
    installed: boolean;
}
export declare function getStatusSnapshotLocal(): {
    status: string;
    installed: boolean;
    pureEdition: boolean;
    running: boolean;
    busy: boolean;
    busyTask: string;
    plugins: PluginItem[];
    catalog: CatalogItem[];
    logCount: number;
    updatedAt: number;
};
export declare function executeYunzaiActionLocal(data: PrimitiveRecord): Promise<{
    message: string;
}>;
export declare function installPluginArchiveLocal(filePath: string, options?: {
    dirName?: string;
    originalName?: string;
}): Promise<{
    message: string;
}>;
export {};
