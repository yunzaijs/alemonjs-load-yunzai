export type RepositoryArchiveTarget = 'yunzai' | 'miao';
export type RepositoryArchiveStatus = {
    target: RepositoryArchiveTarget;
    archive: {
        name: string;
        size: number;
        uploadedAt: number;
    } | null;
    extracted: boolean;
    extractedAt: number | null;
};
export declare function getRepositoryArchiveStatus(target: RepositoryArchiveTarget): RepositoryArchiveStatus;
export declare function getAllRepositoryArchiveStatuses(): RepositoryArchiveStatus[];
export declare function saveRepositoryArchive(targetValue: unknown, uploadedPath: string, originalName: string): RepositoryArchiveStatus;
export declare function extractRepositoryArchive(targetValue: unknown): Promise<RepositoryArchiveStatus>;
export declare function repairRepositoryArchiveOrigin(targetValue: unknown, repoUrl: string): Promise<RepositoryArchiveStatus>;
