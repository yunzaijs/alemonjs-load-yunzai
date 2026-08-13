function buildForwardMsgParts(nodes) {
    if (!Array.isArray(nodes) || nodes.length === 0) {
        return [];
    }
    const parts = [];
    for (const node of nodes) {
        const nodeData = node?.data && node.type === 'node' ? node.data : node;
        const msg = nodeData?.message ?? nodeData?.content ?? node;
        const nickname = nodeData?.nickname ?? node?.nickname ?? '';
        if (nickname) {
            parts.push({ type: 'text', text: `【${nickname}】\n` });
        }
        if (typeof msg === 'string') {
            parts.push({ type: 'text', text: msg + '\n' });
        }
        else if (Array.isArray(msg)) {
            parts.push(...msg);
            parts.push({ type: 'text', text: '\n' });
        }
        else if (msg && typeof msg === 'object') {
            parts.push(msg);
            parts.push({ type: 'text', text: '\n' });
        }
    }
    return parts;
}
function buildForwardMsgCompat(nodes) {
    const forwardNodes = Array.isArray(nodes) ? nodes : [];
    const parts = buildForwardMsgParts(forwardNodes);
    const text = parts
        .map(part => {
        if (part?.type === 'text') {
            return String(part.text ?? part.data?.text ?? '');
        }
        return '';
    })
        .join('');
    return {
        type: 'forward',
        data: text,
        file: '',
        id: '',
        resid: '',
        message: parts,
        messages: parts,
        __forwardNodes: forwardNodes,
        __forwardParts: parts,
        toString: () => text
    };
}
function getNativeForwardRequest(contents, target) {
    if (contents.length !== 1) {
        return null;
    }
    const forward = contents[0];
    if (forward?.type !== 'forward' || forward.quoteMessageId || !Array.isArray(forward.nodes) || forward.nodes.length === 0) {
        return null;
    }
    if (target.isPrivate) {
        const userId = Number(target.userId);
        if (!Number.isFinite(userId)) {
            return null;
        }
        return {
            action: 'send_private_forward_msg',
            params: { user_id: userId, messages: forward.nodes }
        };
    }
    const groupId = Number(target.groupId);
    if (!Number.isFinite(groupId)) {
        return null;
    }
    return {
        action: 'send_group_forward_msg',
        params: { group_id: groupId, messages: forward.nodes }
    };
}
function toOneBotFile(data) {
    if (data.startsWith('http') || data.startsWith('/') || data.startsWith('file://') || data.startsWith('base64://')) {
        return data;
    }
    return `base64://${data}`;
}
function withSegmentParams(params, required) {
    return { ...params, ...required };
}
function toOneBotSegments(contents) {
    const result = [];
    for (const content of contents) {
        if (content.type === 'quote') {
            continue;
        }
        if (content.type === 'forward') {
            if (content.fallback?.length) {
                result.push(...toOneBotSegments(content.fallback));
            }
            else if (content.data) {
                result.push({ type: 'text', data: { text: content.data } });
            }
            continue;
        }
        switch (content.type) {
            case 'text':
                result.push({ type: 'text', data: { text: content.data } });
                break;
            case 'at':
                result.push({ type: 'at', data: { qq: content.data } });
                break;
            case 'image':
            case 'record':
            case 'video':
                result.push({ type: content.type, data: withSegmentParams(content.params, { file: toOneBotFile(content.data) }) });
                break;
            case 'face':
                result.push({ type: 'face', data: { id: content.data } });
                break;
            case 'json':
            case 'xml':
                result.push({ type: content.type, data: { data: content.data } });
                break;
            default:
                result.push({ type: 'text', data: { text: content.data } });
        }
    }
    return result;
}
function getNativeMessageRequest(contents, target) {
    const supportedTypes = new Set(['text', 'at', 'image', 'record', 'video', 'face', 'json', 'xml']);
    if (contents.length === 0 || !contents.every(content => supportedTypes.has(content.type))) {
        return null;
    }
    const message = toOneBotSegments(contents);
    if (target.isPrivate) {
        const userId = Number(target.userId);
        return Number.isFinite(userId) ? { action: 'send_private_msg', params: { user_id: userId, message } } : null;
    }
    const groupId = Number(target.groupId);
    return Number.isFinite(groupId) ? { action: 'send_group_msg', params: { group_id: groupId, message } } : null;
}
function getNativeQuoteRequest(contents, target) {
    const quoteMessageId = contents.find(content => content.quoteMessageId)?.quoteMessageId;
    if (!quoteMessageId) {
        return null;
    }
    const message = [{ type: 'reply', data: { id: quoteMessageId } }, ...toOneBotSegments(contents)];
    if (target.isPrivate) {
        const userId = Number(target.userId);
        return Number.isFinite(userId) ? { action: 'send_private_msg', params: { user_id: userId, message } } : null;
    }
    const groupId = Number(target.groupId);
    return Number.isFinite(groupId) ? { action: 'send_group_msg', params: { group_id: groupId, message } } : null;
}
function getNativeOneBotRequest(contents, target) {
    return getNativeForwardRequest(contents, target) ?? getNativeQuoteRequest(contents, target) ?? getNativeMessageRequest(contents, target);
}
function isUnsupportedOneBotActionError(error) {
    const value = error;
    const message = [value?.message, value?.wording, value?.error, typeof error === 'string' ? error : ''].filter(Boolean).join(' ');
    const unsupportedPatterns = [
        /(unsupported|not\s+support(?:ed)?|not\s+implemented|不支持|未实现)/i,
        /(unknown\s+action|action\s+not\s+found|未知(?:动作|接口))/i,
        /(invalid\s+(?:param|parameter)|参数(?:错误|不支持))/i
    ];
    return unsupportedPatterns.some(pattern => pattern.test(message));
}
function getReplyMessageId(result) {
    const messageId = result?.MessageId ?? result?.message_id ?? result?.data?.MessageId ?? result?.data?.message_id;
    return messageId === undefined || messageId === null ? undefined : String(messageId);
}
function assertOneBotActionSucceeded(result) {
    if (result?.status === 'failed' || (typeof result?.retcode === 'number' && result.retcode !== 0)) {
        const error = Object.assign(new Error(result?.wording ?? result?.message ?? `OneBot action failed (retcode=${result?.retcode ?? 'unknown'})`), result);
        throw error;
    }
    return result;
}
async function sendNativeForward(client, request) {
    return assertOneBotActionSucceeded(await client.send(request));
}

export { assertOneBotActionSucceeded, buildForwardMsgCompat, buildForwardMsgParts, getNativeForwardRequest, getNativeMessageRequest, getNativeOneBotRequest, getNativeQuoteRequest, getReplyMessageId, isUnsupportedOneBotActionError, sendNativeForward };
