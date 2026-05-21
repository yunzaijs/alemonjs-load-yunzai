import { logger } from 'alemonjs';
import { ensureBusDirs, getBusRoot, writeState, emitEvent, claimNextRequest, writeResponse, ackClaimedRequest } from './file-bus.js';
import { getStatusSnapshotLocal, executeYunzaiActionLocal } from '../yunzai/control.js';

let started = false;
let pollTimer = null;
let stateTimer = null;
async function handleRequest(message) {
    const { envelope } = message;
    try {
        if (envelope.type === 'yunzai.status.get') {
            const payload = getStatusSnapshotLocal();
            writeResponse(envelope.id, 'yunzai.status.result', true, payload);
        }
        else if (envelope.type === 'yunzai.action') {
            const payload = await executeYunzaiActionLocal(envelope.payload);
            writeResponse(envelope.id, 'yunzai.action.result', true, payload);
        }
        else {
            writeResponse(envelope.id, 'yunzai.action.result', false, {}, {
                code: 'UNKNOWN_REQUEST_TYPE',
                message: `未知请求类型: ${envelope.type}`
            });
        }
    }
    catch (err) {
        writeResponse(envelope.id, envelope.type === 'yunzai.status.get' ? 'yunzai.status.result' : 'yunzai.action.result', false, {}, {
            code: 'HOST_REQUEST_FAILED',
            message: err?.message ?? '未知错误'
        });
    }
    finally {
        ackClaimedRequest(message);
        void publishStatusSnapshot();
    }
}
function publishStatusSnapshot() {
    const status = getStatusSnapshotLocal();
    writeState('host-status', status);
    emitEvent('host.status', status);
}
async function pollLoop() {
    try {
        let claimed = claimNextRequest();
        while (claimed) {
            await handleRequest(claimed);
            claimed = claimNextRequest();
        }
    }
    catch (err) {
        logger.warn(`[file-bus] 请求轮询异常: ${err.message}`);
    }
    finally {
        pollTimer = setTimeout(() => {
            void pollLoop();
        }, 250);
    }
}
function startHostBridge() {
    if (started) {
        return;
    }
    started = true;
    ensureBusDirs();
    logger.info(`[file-bus] 宿主桥已启动: ${getBusRoot()}`);
    void publishStatusSnapshot();
    void pollLoop();
    stateTimer = setInterval(() => {
        void publishStatusSnapshot();
    }, 2000);
}
function stopHostBridge() {
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
    if (stateTimer) {
        clearInterval(stateTimer);
        stateTimer = null;
    }
    started = false;
}

export { startHostBridge, stopHostBridge };
