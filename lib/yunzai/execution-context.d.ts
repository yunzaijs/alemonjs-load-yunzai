export interface ExecutionContext {
    msgId: string;
    platform: string;
}
export declare function runWithExecutionContext<T>(context: ExecutionContext, callback: () => T): T;
export declare function getExecutionContext(): ExecutionContext | undefined;
export declare function getExecutionContextForAction(action: string): ExecutionContext | undefined;
