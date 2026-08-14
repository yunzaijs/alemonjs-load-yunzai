export type DataBackupItem = {
    id: string;
    name: string;
    size: number;
    createdAt: number;
    source: 'created' | 'uploaded';
};
export declare function getDataBackups(): DataBackupItem[];
export declare function createDataBackup(): DataBackupItem;
export declare function saveUploadedDataBackup(uploadedPath: string, originalName: string): DataBackupItem;
export declare function restoreDataBackup(idValue: unknown): Promise<DataBackupItem>;
