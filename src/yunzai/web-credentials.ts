type CallApi = (action: string, params?: Record<string, any>) => Promise<any>;
type CachedRequest = { until: number; error?: Error; pending?: Promise<any> };
type Credentials = { cookies: Record<string, string>; bkn?: number; requests: Map<string, CachedRequest> };

/** QQ 网页凭据只保存在 Worker 内存，按真实账号隔离，不输出或持久化。 */
export class OneBotWebCredentials {
  private readonly entries = new Map<string, Credentials>();

  constructor(
    private readonly callApi: CallApi,
    private readonly currentBotId: () => string,
    private readonly now = Date.now
  ) {}

  private entry(botId = this.currentBotId()): Credentials {
    let value = this.entries.get(botId);

    if (!value) {
      value = { cookies: Object.create(null), requests: new Map() };
      this.entries.set(botId, value);
    }

    return value;
  }

  private clearExpired(entry: Credentials): void {
    for (const [key, request] of entry.requests) {
      if (request.until > this.now()) {
        continue;
      }
      if (key === 'csrf') {
        entry.bkn = undefined;
      } else {
        Reflect.deleteProperty(entry.cookies, key.slice('cookie:'.length));
      }
    }
  }

  get cookies(): Record<string, string> {
    const entry = this.entry();

    this.clearExpired(entry);

    return entry.cookies;
  }

  get bkn(): number | undefined {
    const entry = this.entry();

    this.clearExpired(entry);

    return entry.bkn;
  }

  private load<T>(entry: Credentials, key: string, read: () => T, fetch: () => Promise<T>): Promise<T> {
    this.clearExpired(entry);
    const cached = entry.requests.get(key);

    if (cached?.pending) {
      return cached.pending;
    }
    if (cached && cached.until > this.now()) {
      return cached.error ? Promise.reject(cached.error) : Promise.resolve(read());
    }
    const request: CachedRequest = { until: 0 };

    entry.requests.set(key, request);
    request.pending = Promise.resolve()
      .then(fetch)
      .then(
        value => {
          request.until = this.now() + 5 * 60_000;

          return value;
        },
        () => {
          // 保存兼容层生成的错误，不缓存可能包含凭据的底层回包。
          request.error = new Error(key === 'csrf' ? 'OneBot 未提供可用的 QQ 网页 CSRF token' : 'OneBot 未提供可用的 QQ 网页 Cookie');
          request.until = this.now() + 30_000;

          throw request.error;
        }
      )
      .finally(() => {
        request.pending = undefined;
      });

    return request.pending;
  }

  getCookies(domain = ''): Promise<string> {
    const entry = this.entry();

    return this.load(
      entry,
      `cookie:${domain}`,
      () => entry.cookies[domain],
      async () => {
        const response = await this.callApi('getCookies', { domain });
        const payload = response?.data ?? response;
        const cookie = typeof payload === 'string' ? payload : payload?.cookies;

        if (typeof cookie !== 'string' || !cookie.trim()) {
          throw new Error('OneBot 未提供可用的 QQ 网页 Cookie');
        }
        entry.cookies[domain] = cookie;

        return cookie;
      }
    );
  }

  getCsrfToken(): Promise<number> {
    const entry = this.entry();

    return this.load(
      entry,
      'csrf',
      () => entry.bkn!,
      async () => {
        const response = await this.callApi('getCsrfToken');
        const payload = response?.data ?? response;
        const token = payload?.token ?? payload;

        if (typeof token !== 'number' || !Number.isSafeInteger(token) || token < 0) {
          throw new Error('OneBot 未提供可用的 QQ 网页 CSRF token');
        }
        entry.bkn = token;

        return token;
      }
    );
  }

  /** 同步读取 cookies/bkn 的插件运行前，在其事件上下文中准备凭据。 */
  async prepare(domains: readonly string[] = ['qun.qq.com'], csrf = true): Promise<void> {
    const results = await Promise.allSettled([...Array.from(new Set(domains), domain => this.getCookies(domain)), ...(csrf ? [this.getCsrfToken()] : [])]);
    const failure = results.find(result => result.status === 'rejected');

    if (failure?.status === 'rejected') {
      throw failure.reason;
    }
  }
}

export function needsQQWebCredentials(message: string): boolean {
  return /^#(?:(?:查|发|删)群?公告|今日打卡)/.test(message.trim());
}
