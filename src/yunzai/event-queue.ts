/**
 * Worker 事件调度器。
 *
 * Yunzai 插件可以在事件处理中创建 Puppeteer 页面，而上游渲染器共用一个
 * Chromium 实例。这里在 load 层控制进入 Worker 的并发度，避免渲染器内部
 * 的强制重启中断其他仍在导航的页面。
 */
export class WorkerEventQueue {
  private readonly queued: { id: string; run: () => void }[] = [];
  private readonly active = new Set<string>();
  private concurrency: number;

  constructor(
    concurrency = 1,
    private readonly canRun: () => boolean = () => true
  ) {
    this.concurrency = Math.max(1, concurrency);
  }

  setConcurrency(concurrency: number): void {
    this.concurrency = Math.max(1, concurrency);
    this.drain();
  }

  enqueue(id: string, run: () => void): void {
    if (this.active.has(id) || this.queued.some(item => item.id === id)) {
      return;
    }

    this.queued.push({ id, run });
    this.drain();
  }

  complete(id: string): void {
    if (!this.active.delete(id)) {
      return;
    }

    this.drain();
  }

  /** Worker 异常退出时释放槽位；已开始的事件不能安全重放，避免重复业务操作。 */
  abortActive(): void {
    this.active.clear();
  }

  resume(): void {
    this.drain();
  }

  get pendingCount(): number {
    return this.queued.length;
  }

  get activeCount(): number {
    return this.active.size;
  }

  private drain(): void {
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
