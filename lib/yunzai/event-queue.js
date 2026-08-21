class WorkerEventQueue {
    canRun;
    queued = [];
    active = new Set();
    concurrency;
    constructor(concurrency = 1, canRun = () => true) {
        this.canRun = canRun;
        this.concurrency = Math.max(1, concurrency);
    }
    setConcurrency(concurrency) {
        this.concurrency = Math.max(1, concurrency);
        this.drain();
    }
    enqueue(id, run) {
        if (this.active.has(id) || this.queued.some(item => item.id === id)) {
            return;
        }
        this.queued.push({ id, run });
        this.drain();
    }
    complete(id) {
        if (!this.active.delete(id)) {
            return;
        }
        this.drain();
    }
    abortActive() {
        this.active.clear();
    }
    resume() {
        this.drain();
    }
    get pendingCount() {
        return this.queued.length;
    }
    get activeCount() {
        return this.active.size;
    }
    drain() {
        if (!this.canRun()) {
            return;
        }
        while (this.active.size < this.concurrency && this.queued.length > 0) {
            const item = this.queued.shift();
            if (!item) {
                return;
            }
            this.active.add(item.id);
            item.run();
        }
    }
}

export { WorkerEventQueue };
