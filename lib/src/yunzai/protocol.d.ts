export interface IPCMedia {
    type: 'image' | 'audio' | 'video' | 'file' | 'sticker';
    url?: string;
    fileId?: string;
    fileName?: string;
}
export interface IPCEventMessage {
    type: 'event';
    id: string;
    data: {
        eventName: string;
        platform: string;
        botId: string;
        messageText: string;
        messageId: string;
        media: IPCMedia[];
        userId: string;
        userName: string;
        userAvatar: string;
        spaceId: string;
        isPrivate: boolean;
        isMaster: boolean;
        atUsers?: {
            userId: string;
            userName?: string;
        }[];
        rawEvent?: any;
    };
}
export interface IPCShutdown {
    type: 'shutdown';
}
export interface IPCApiResponse {
    type: 'api_response';
    reqId: string;
    ok: boolean;
    data?: any;
    error?: string;
}
export interface IPCReplyResult {
    type: 'reply_result';
    replyId: string;
    messageId?: string;
    ok: boolean;
}
export type ParentToWorker = IPCEventMessage | IPCShutdown | IPCApiResponse | IPCReplyResult;
export interface IPCReady {
    type: 'ready';
    pluginCount: number;
}
export interface IPCReply {
    type: 'reply';
    id: string;
    replyId: string;
    contents: ReplyContent[];
    channelId?: string;
    userId?: string;
    isPrivate?: boolean;
}
export interface IPCError {
    type: 'error';
    message: string;
}
export interface IPCLog {
    type: 'log';
    level: 'info' | 'warn' | 'error' | 'debug';
    args: string[];
}
export interface IPCDone {
    type: 'done';
    id: string;
    replied: boolean;
}
export interface IPCApiRequest {
    type: 'api';
    reqId: string;
    action: string;
    params: Record<string, any>;
    msgId?: string;
}
export type WorkerToParent = IPCReady | IPCReply | IPCError | IPCLog | IPCDone | IPCApiRequest;
export interface ReplyContent {
    type: 'text' | 'image' | 'at' | 'face' | 'forward' | 'record' | 'video' | 'other';
    data: string;
}
