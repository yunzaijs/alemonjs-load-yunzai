export interface PluginArchiveEntry {
    id: string;
    originalName: string;
    size: number;
    uploadedAt: number;
    dirName: string;
    extracted: boolean;
    extractedAt: number | null;
}
export declare function getPluginArchiveEntries(): PluginArchiveEntry[];
export declare function savePluginArchive(uploadedPath: string, originalName: string, dirName?: string): PluginArchiveEntry[];
export declare function extractPluginArchiveEntry(idValue: unknown): Promise<PluginArchiveEntry[]>;
export declare function deletePluginArchiveEntry(idValue: unknown): PluginArchiveEntry[];
