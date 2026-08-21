import { AsyncLocalStorage } from "node:async_hooks";

//#region src/yunzai/execution-context.ts
const executionContextStorage = new AsyncLocalStorage();
const BACKGROUND_SAFE_ACTIONS = /* @__PURE__ */ new Set(["sendGroupMsg", "sendPrivateMsg"]);
function runWithExecutionContext(context, callback) {
	return executionContextStorage.run(context, callback);
}
function getExecutionContext() {
	return executionContextStorage.getStore();
}
/**
* 后台任务不能借用最近消息的上下文执行管理/原生动作。
* 仅跨平台普通消息发送可在无事件时安全执行。
*/
function getExecutionContextForAction(action) {
	const context = getExecutionContext();
	if (!context && !BACKGROUND_SAFE_ACTIONS.has(action)) throw new Error(`缺少事件上下文: ${action}`);
	return context;
}

//#endregion
export { getExecutionContext, getExecutionContextForAction, runWithExecutionContext };