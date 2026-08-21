export declare class OneBotIngressGuard {
    private readonly ttl;
    private readonly maxEntries;
    private readonly recent;
    constructor(ttl?: number, maxEntries?: number);
    accept(platform: string | undefined, raw: unknown, now?: number): boolean;
    private isMessageEvent;
    private isSelfMessage;
    private getMessageKey;
    private prune;
    private trim;
}
