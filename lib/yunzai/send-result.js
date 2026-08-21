import { ResultCode } from 'alemonjs';

function assertMessageSendSucceeded(result) {
    const entries = (Array.isArray(result) ? result : [result]).filter((item) => Boolean(item) && typeof item === 'object' && 'code' in item);
    if (entries.length === 0 || entries.some(item => item.code === ResultCode.Ok)) {
        return;
    }
    const summary = entries.map(item => `${String(item.code)}:${String(item.message ?? 'unknown error')}`).join('; ');
    throw new Error(`平台消息发送失败 (${summary})`);
}
function summarizeReplyContents(contents) {
    const images = contents.filter(item => item.type === 'image');
    if (images.length === 0) {
        return `segments=${contents.length}`;
    }
    const imageBytes = images.reduce((total, item) => total + Math.floor((item.data.length * 3) / 4), 0);
    return `segments=${contents.length}, images=${images.length}, imageBytes≈${imageBytes}`;
}

export { assertMessageSendSucceeded, summarizeReplyContents };
