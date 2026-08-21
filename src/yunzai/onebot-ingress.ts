/**
 * OneBot 入站消息保护。
 *
 * 部分 OneBot 实现会把机器人自己发送的消息也以 `post_type: message`
 * 回推到 WebSocket。qq-bot 适配器已经过滤 `author.bot`，而 OneBot v11
 * 没有等价过滤；不在 load 层挡住会让 Yunzai 再次处理自己的回复，造成
 * 回声触发、渲染排队，最终放大共享 Chromium 的不稳定性。
 */
type OneBotRawEvent = Record<string, any>;

const DEFAULT_DEDUP_TTL = 2 * 60_000;
const DEFAULT_MAX_ENTRIES = 2_000;

export class OneBotIngressGuard {
  private readonly recent = new Map<string, number>();

  constructor(
    private readonly ttl = DEFAULT_DEDUP_TTL,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES
  ) {}

  /** `true` 表示事件可以进入 Yunzai Worker。 */
  accept(platform: string | undefined, raw: unknown, now = Date.now()): boolean {
    if (platform !== 'onebot' || !raw || typeof raw !== 'object') {
      return true;
    }

    const event = raw as OneBotRawEvent;

    if (!this.isMessageEvent(event)) {
      return true;
    }

    if (this.isSelfMessage(event)) {
      return false;
    }

    const key = this.getMessageKey(event);

    if (!key) {
      return true;
    }

    this.prune(now);
    if (this.recent.has(key)) {
      return false;
    }

    this.recent.set(key, now + this.ttl);
    this.trim();

    return true;
  }

  private isMessageEvent(event: OneBotRawEvent): boolean {
    return event.post_type === 'message' || event.type === 'message';
  }

  private isSelfMessage(event: OneBotRawEvent): boolean {
    const selfId = event.self_id ?? event.self?.user_id;
    const userId = event.user_id ?? event.sender?.user_id;

    return selfId !== undefined && userId !== undefined && String(selfId) === String(userId);
  }

  private getMessageKey(event: OneBotRawEvent): string | undefined {
    const messageId = event.message_id ?? event.id;

    if (messageId === undefined || messageId === null || messageId === '') {
      return undefined;
    }

    const selfId = event.self_id ?? event.self?.user_id ?? '';
    const messageType = event.message_type ?? event.detail_type ?? '';
    const targetId = event.group_id ?? event.user_id ?? '';

    return `${selfId}:${messageType}:${targetId}:${messageId}`;
  }

  private prune(now: number): void {
    for (const [key, expiresAt] of this.recent) {
      if (expiresAt <= now) {
        this.recent.delete(key);
      }
    }
  }

  private trim(): void {
    while (this.recent.size > this.maxEntries) {
      const oldest = this.recent.keys().next().value;

      if (oldest === undefined) {
        return;
      }
      this.recent.delete(oldest);
    }
  }
}
