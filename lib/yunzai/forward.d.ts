import type { ReplyContent } from './protocol';
export type NativeForwardTarget = {
    isPrivate: boolean;
    groupId?: string | number;
    userId?: string | number;
};
export type NativeForwardRequest = {
    action: 'send_group_forward_msg' | 'send_private_forward_msg';
    params: {
        group_id?: number;
        user_id?: number;
        messages: any[];
    };
};
export type NativeMessageRequest = {
    action: 'send_group_msg' | 'send_private_msg';
    params: {
        group_id?: number;
        user_id?: number;
        message: any[];
    };
};
export type NativeOneBotRequest = NativeForwardRequest | NativeMessageRequest;
export declare function buildForwardMsgParts(nodes: any[]): any[];
export declare function buildForwardMsgCompat(nodes: any[]): {
    type: string;
    data: string;
    file: string;
    id: string;
    resid: string;
    message: any[];
    messages: any[];
    __forwardNodes: any[];
    __forwardParts: any[];
    toString: () => string;
};
export declare function getNativeForwardRequest(contents: ReplyContent[], target: NativeForwardTarget): NativeForwardRequest | null;
export declare function getNativeMessageRequest(contents: ReplyContent[], target: NativeForwardTarget): NativeMessageRequest | null;
export declare function getNativeQuoteRequest(contents: ReplyContent[], target: NativeForwardTarget): NativeMessageRequest | null;
export declare function getNativeOneBotRequest(contents: ReplyContent[], target: NativeForwardTarget): NativeOneBotRequest | null;
export declare function isUnsupportedOneBotActionError(error: unknown): boolean;
export declare function getReplyMessageId(result: any): string | undefined;
export declare function assertOneBotActionSucceeded(result: any): any;
export declare function sendNativeForward(client: {
    send: (request: NativeOneBotRequest) => Promise<any>;
}, request: NativeOneBotRequest): Promise<any>;
