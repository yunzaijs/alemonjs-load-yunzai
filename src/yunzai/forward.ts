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

/**
 * 将转发消息节点展平为普通消息段数组。
 * 非 OneBot 平台和原生 API 不可用时使用该结果作为可读降级内容。
 */
export function buildForwardMsgParts(nodes: any[]): any[] {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return [];
  }
  const parts: any[] = [];

  for (const node of nodes) {
    const nodeData = node?.data && node.type === 'node' ? node.data : node;
    const msg = nodeData?.message ?? nodeData?.content ?? node;
    const nickname = nodeData?.nickname ?? node?.nickname ?? '';

    if (nickname) {
      parts.push({ type: 'text', text: `【${nickname}】\n` });
    }
    if (typeof msg === 'string') {
      parts.push({ type: 'text', text: msg + '\n' });
    } else if (Array.isArray(msg)) {
      parts.push(...msg);
      parts.push({ type: 'text', text: '\n' });
    } else if (msg && typeof msg === 'object') {
      parts.push(msg);
      parts.push({ type: 'text', text: '\n' });
    }
  }

  return parts;
}

/**
 * 构造 icqq 兼容的合并转发对象：保留原始 nodes 用于 OneBot 原生发送，
 * 同时保存展平消息段供跨平台降级。
 */
export function buildForwardMsgCompat(nodes: any[]) {
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

/** 单个原生合并转发才可映射到 OneBot 的整条消息发送动作。 */
export function getNativeForwardRequest(contents: ReplyContent[], target: NativeForwardTarget): NativeForwardRequest | null {
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

function toOneBotFile(data: string): string {
  if (data.startsWith('http') || data.startsWith('/') || data.startsWith('file://') || data.startsWith('base64://')) {
    return data;
  }

  return `base64://${data}`;
}

function withSegmentParams(params: ReplyContent['params'] | undefined, required: Record<string, string>): Record<string, string | number | boolean> {
  return { ...params, ...required };
}

function toOneBotSegments(contents: ReplyContent[]): any[] {
  const result: any[] = [];

  for (const content of contents) {
    if (content.type === 'quote') {
      continue;
    }
    if (content.type === 'forward') {
      if (content.fallback?.length) {
        result.push(...toOneBotSegments(content.fallback));
      } else if (content.data) {
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

/** 没有转发或引用时，标准 OneBot 段可直接发送，避免经 Format 丢失段语义。 */
export function getNativeMessageRequest(contents: ReplyContent[], target: NativeForwardTarget): NativeMessageRequest | null {
  const supportedTypes = new Set<ReplyContent['type']>(['text', 'at', 'image', 'record', 'video', 'face', 'json', 'xml']);

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

/** 引用消息使用标准 send_*_msg 动作；携带转发时改发可读 fallback，确保引用不丢失。 */
export function getNativeQuoteRequest(contents: ReplyContent[], target: NativeForwardTarget): NativeMessageRequest | null {
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

export function getNativeOneBotRequest(contents: ReplyContent[], target: NativeForwardTarget): NativeOneBotRequest | null {
  return getNativeForwardRequest(contents, target) ?? getNativeQuoteRequest(contents, target) ?? getNativeMessageRequest(contents, target);
}

/** 只对明确的“该动作/参数不被实现支持”错误进行降级，避免超时后重复发送。 */
export function isUnsupportedOneBotActionError(error: unknown): boolean {
  const value = error as Record<string, any> | undefined;
  const message = [value?.message, value?.wording, value?.error, typeof error === 'string' ? error : ''].filter(Boolean).join(' ');

  const unsupportedPatterns = [
    /(unsupported|not\s+support(?:ed)?|not\s+implemented|不支持|未实现)/i,
    /(unknown\s+action|action\s+not\s+found|未知(?:动作|接口))/i,
    /(invalid\s+(?:param|parameter)|参数(?:错误|不支持))/i
  ];

  return unsupportedPatterns.some(pattern => pattern.test(message));
}

export function getReplyMessageId(result: any): string | undefined {
  const messageId = result?.MessageId ?? result?.message_id ?? result?.data?.MessageId ?? result?.data?.message_id;

  return messageId === undefined || messageId === null ? undefined : String(messageId);
}

/** 将 OneBot failed 响应提升为 Error，便于按错误确定性决定是否降级。 */
export function assertOneBotActionSucceeded(result: any): any {
  if (result?.status === 'failed' || (typeof result?.retcode === 'number' && result.retcode !== 0)) {
    const error = Object.assign(new Error(result?.wording ?? result?.message ?? `OneBot action failed (retcode=${result?.retcode ?? 'unknown'})`), result);

    throw error;
  }

  return result;
}

/** 便于桥接层与测试共用的 OneBot 原生转发发送入口。 */
export async function sendNativeForward(client: { send: (request: NativeOneBotRequest) => Promise<any> }, request: NativeOneBotRequest): Promise<any> {
  return assertOneBotActionSucceeded(await client.send(request));
}
