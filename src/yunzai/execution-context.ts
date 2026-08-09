import { AsyncLocalStorage } from 'node:async_hooks';

export interface ExecutionContext {
  msgId: string;
  platform: string;
}

const executionContextStorage = new AsyncLocalStorage<ExecutionContext>();
const BACKGROUND_SAFE_ACTIONS = new Set(['sendGroupMsg', 'sendPrivateMsg']);

export function runWithExecutionContext<T>(context: ExecutionContext, callback: () => T): T {
  return executionContextStorage.run(context, callback);
}

export function getExecutionContext(): ExecutionContext | undefined {
  return executionContextStorage.getStore();
}

/**
 * 后台任务不能借用最近消息的上下文执行管理/原生动作。
 * 仅跨平台普通消息发送可在无事件时安全执行。
 */
export function getExecutionContextForAction(action: string): ExecutionContext | undefined {
  const context = getExecutionContext();

  if (!context && !BACKGROUND_SAFE_ACTIONS.has(action)) {
    throw new Error(`缺少事件上下文: ${action}`);
  }

  return context;
}
