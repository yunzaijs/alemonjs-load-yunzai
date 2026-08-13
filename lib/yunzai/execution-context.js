import { AsyncLocalStorage } from 'node:async_hooks';

const executionContextStorage = new AsyncLocalStorage();
const BACKGROUND_SAFE_ACTIONS = new Set(['sendGroupMsg', 'sendPrivateMsg']);
function runWithExecutionContext(context, callback) {
    return executionContextStorage.run(context, callback);
}
function getExecutionContext() {
    return executionContextStorage.getStore();
}
function getExecutionContextForAction(action) {
    const context = getExecutionContext();
    if (!context && !BACKGROUND_SAFE_ACTIONS.has(action)) {
        throw new Error(`缺少事件上下文: ${action}`);
    }
    return context;
}

export { getExecutionContext, getExecutionContextForAction, runWithExecutionContext };
