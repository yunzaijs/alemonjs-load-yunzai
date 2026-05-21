import type { BusEnvelope, BusPayload } from './schema';
type ClaimedMessage = {
    envelope: BusEnvelope;
    claimedPath: string;
    fileName: string;
};
export declare function ensureBusDirs(): void;
export declare function createBusId(prefix: string): string;
export declare function publishRequest<TPayload extends BusPayload>(type: BusEnvelope<TPayload>['type'], payload: TPayload, source?: 'web' | 'host', target?: 'web' | 'host'): BusEnvelope<TPayload>;
export declare function writeResponse<TPayload extends BusPayload>(replyTo: string, type: BusEnvelope<TPayload>['type'], ok: boolean, payload: TPayload, error?: {
    code: string;
    message: string;
}): BusEnvelope<TPayload>;
export declare function emitEvent<TPayload extends BusPayload>(type: BusEnvelope<TPayload>['type'], payload: TPayload): void;
export declare function writeState<T>(name: string, data: T): void;
export declare function readState<T>(name: string): T | null;
export declare function waitForResponse<TPayload extends BusPayload>(replyTo: string, timeoutMs?: number, pollMs?: number): Promise<BusEnvelope<TPayload>>;
export declare function claimNextRequest(): ClaimedMessage | null;
export declare function ackClaimedRequest(message: ClaimedMessage): void;
export declare function getBusRoot(): string;
export {};
