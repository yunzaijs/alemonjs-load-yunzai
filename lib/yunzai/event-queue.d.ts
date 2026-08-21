export declare class WorkerEventQueue {
    private readonly canRun;
    private readonly queued;
    private readonly active;
    private concurrency;
    constructor(concurrency?: number, canRun?: () => boolean);
    setConcurrency(concurrency: number): void;
    enqueue(id: string, run: () => void): void;
    complete(id: string): void;
    abortActive(): void;
    resume(): void;
    get pendingCount(): number;
    get activeCount(): number;
    private drain;
}
