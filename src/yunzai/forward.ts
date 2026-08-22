import type { ReplyContent } from './protocol';

export type NativeForwardTarget = {
  isPrivate: boolean;
  groupId?: string | number;
  userId?: string | number;
};

export type NativeForwardRequest = {
  action: 'send_group_forward_msg' | 'send_private_forward_msg';
  params: {
    group_id?: string | number;
    user_id?: string | number;
    messages: any[];
  };
};

export type NativeMessageRequest = {
  action: 'send_group_msg' | 'send_private_msg';
  params: {
    group_id?: string | number;
    user_id?: string | number;
    message: any[];
  };
};

export type NativeOneBotRequest = NativeForwardRequest | NativeMessageRequest;

type OneBotSegment = { type: string; data: Record<string, any> };

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function withoutType(value: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'type'));
}

function withDefinedValues(value: Record<string, any>, keys: string[]): Record<string, any> {
  return Object.fromEntries(keys.filter(key => value[key] !== undefined && value[key] !== null).map(key => [key, value[key]]));
}

/**
 * icqq 的 Sendable 与 OneBot 11 的 message 都允许字符串或消息段数组，但段对象
 * 的字段布局不同：icqq 使用外层 text/file/message，OneBot 11 使用 data.text /
 * data.file / node.data.content。所有转发节点和 raw 段必须经过此处，不能分散
 * 在调用点猜字段。
 */
export function toOneBotSegment(value: unknown): OneBotSegment {
  if (typeof value === 'string') {
    return { type: 'text', data: { text: value } };
  }

  if (!isRecord(value)) {
    return { type: 'text', data: { text: String(value ?? '') } };
  }

  const type = String(value.type ?? 'text');
  const hasOneBotData = isRecord(value.data);
  const source = hasOneBotData ? value.data : withoutType(value);

  // 已是 OneBot 段时只做媒体来源规范化，避免重写实现商扩展字段。
  if (hasOneBotData && type !== 'node') {
    const data = { ...source };

    if (['image', 'record', 'video', 'flash'].includes(type) && data.file !== undefined) {
      data.file = normalizeOneBotMediaSource(data.file);
    }
    if (type === 'json' && typeof data.data !== 'string') {
      data.data = JSON.stringify(data.data ?? '');
    }
    if (type === 'poke') {
      data.type = String(data.type ?? 1);
      data.id = String(data.id ?? '');
    }
    if (type === 'location') {
      data.lon ??= data.lng;
      delete data.lng;
    }
    if (type === 'music' && data.type === undefined && data.platform !== undefined) {
      data.type = data.platform;
      delete data.platform;
    }

    if (type === 'flash') {
      data.type ??= 'flash';

      return { type: 'image', data };
    }

    return { type, data };
  }

  switch (type) {
    case 'text':
      return { type: 'text', data: { text: String(source.text ?? '') } };
    case 'at':
      return { type: 'at', data: { qq: String(source.qq ?? source.id ?? '') } };
    case 'face':
    case 'sface':
      return { type, data: withDefinedValues(source, ['id', 'text']) };
    case 'image':
    case 'flash':
    case 'record':
    case 'video': {
      const data = withDefinedValues(source, ['cache', 'proxy', 'timeout', 'type', 'subType', 'summary', 'magic']);

      if (source.file !== undefined) {
        data.file = normalizeOneBotMediaSource(source.file);
      }

      if (type === 'flash') {
        data.type ??= 'flash';

        return { type: 'image', data };
      }

      return { type, data };
    }
    case 'json':
      return { type: 'json', data: { data: typeof source.data === 'string' ? source.data : JSON.stringify(source.data ?? '') } };
    case 'xml':
      return { type: 'xml', data: withDefinedValues({ ...source, data: String(source.data ?? '') }, ['data', 'id']) };
    case 'reply':
    case 'forward':
      return { type, data: withDefinedValues(source, ['id']) };
    case 'rps':
    case 'dice':
    case 'shake':
      // OneBot 11 的 rps/dice/shake 没有可控的 id 参数；保留 id 会使严格实现拒绝请求。
      return { type, data: {} };
    case 'poke':
      // icqq 仅暴露 id，而 OneBot 11 还要求 type。icqq 的 0~6 基础戳一戳
      // 对应 QQ 基础类型 1；实现商提供的 type 则优先保留。
      return { type: 'poke', data: { type: String(source.poke_type ?? source.pokeType ?? 1), id: String(source.id ?? '') } };
    case 'share':
      return { type: 'share', data: withDefinedValues(source, ['url', 'title', 'content', 'image']) };
    case 'location':
      return {
        type: 'location',
        data: withDefinedValues(
          { lat: source.lat, lon: source.lon ?? source.lng, title: source.title ?? source.name, content: source.content ?? source.address },
          ['lat', 'lon', 'title', 'content']
        )
      };
    case 'music': {
      const musicType = source.music_type ?? source.platform ?? source.type;

      return { type: 'music', data: withDefinedValues({ ...source, type: musicType }, ['type', 'id', 'url', 'audio', 'title', 'content', 'image']) };
    }
    case 'node':
      return toOneBotForwardNode(value);
    default:
      // bface、mirai、markdown 等并非 OneBot 11 核心段；若实现商支持其扩展，
      // 仍按正确的 { type, data } 结构保留，绝不退化为文本。
      return { type, data: source };
  }
}

/** 将 icqq Sendable 转成 OneBot 自定义转发节点所要求的 content 字段。 */
export function toOneBotMessage(value: unknown): string | OneBotSegment[] {
  if (typeof value === 'string') {
    return value;
  }

  const elements = Array.isArray(value) ? value : [value];

  return elements.map(toOneBotSegment);
}

/**
 * Yunzai/icqq 的转发节点一般是 { user_id, nickname, message }，而 OneBot
 * send_*_forward_msg 要求 messages 中每项都是 { type: 'node', data: { ..., content } }。
 * 不能把前者原样透传，否则 OneBot 会以参数错误拒绝私聊合并转发。
 */
function toOneBotForwardNode(node: any): { type: 'node'; data: Record<string, any> } {
  const source = node?.type === 'node' && node?.data && typeof node.data === 'object' ? node.data : (node ?? {});

  if (source.id !== undefined && source.id !== null && source.id !== '') {
    return { type: 'node', data: { id: String(source.id) } };
  }

  const rawUserId = source.user_id ?? source.userId;
  const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;
  const content = toOneBotMessage(source.content ?? source.message ?? '');
  const data: Record<string, any> = {
    user_id: userId ?? '',
    nickname: String(source.nickname ?? source.name ?? ''),
    content
  };

  if (source.time !== undefined && source.time !== null) {
    data.time = Number(source.time);
  }

  return { type: 'node', data };
}

/**
 * 原生动作诊断摘要。绝不输出媒体数据本身，避免 base64 图片进入日志。
 */
export function summarizeNativeOneBotRequest(request: NativeOneBotRequest): string {
  const segments = 'message' in request.params ? request.params.message : request.params.messages;
  const summary = (Array.isArray(segments) ? segments : []).map(segment => {
    const type = String(segment?.type ?? 'unknown');
    const file = segment?.data?.file;

    if (typeof file === 'string' && file.startsWith('base64://')) {
      const bytes = Math.floor(((file.length - 'base64://'.length) * 3) / 4);

      return `${type}(base64≈${bytes}B)`;
    }

    return type;
  });
  const target = request.action.includes('_group_') ? 'group' : 'private';

  return `action=${request.action}, target=${target}, segments=${summary.join(',') || 'none'}`;
}

function getTargetId(value: string | number | undefined): string | undefined {
  if (value === undefined || value === null || String(value) === '') {
    return undefined;
  }

  // 与 AlemonJS 通用 message.send 的 OneBot 适配器保持完全相同的 ID 类型。
  // 部分 OneBot 实现会严格校验字符串 ID；将其转为 number 会导致同一动作
  // 仅在原生 client.api 路径中失败。
  return String(value);
}

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
    const userId = getTargetId(target.userId);

    if (!userId) {
      return null;
    }

    return {
      action: 'send_private_forward_msg',
      params: { user_id: userId, messages: forward.nodes.map(toOneBotForwardNode) }
    };
  }

  const groupId = getTargetId(target.groupId);

  if (!groupId) {
    return null;
  }

  return {
    action: 'send_group_forward_msg',
    params: { group_id: groupId, messages: forward.nodes.map(toOneBotForwardNode) }
  };
}

/**
 * 部分 OneBot 实现（尤其私聊）没有实现 send_*_forward_msg。动作被服务端明确
 * 拒绝后，用 Worker 已构建好的完整展平内容发送普通消息：登录链接、图片等业务
 * 数据仍可到达，只缺失服务端本来就不支持的“合并转发展示容器”。
 */
export function getNativeForwardFallbackRequest(contents: ReplyContent[], target: NativeForwardTarget): NativeMessageRequest | null {
  if (contents.length !== 1 || contents[0]?.type !== 'forward' || contents[0].quoteMessageId) {
    return null;
  }

  const forward = contents[0];
  const fallback = forward.fallback?.length ? forward.fallback : forward.data ? [{ type: 'text' as const, data: forward.data }] : [];

  return getNativeMessageRequest(fallback, target);
}

/**
 * 规范化媒体来源，使原生 OneBot 与 Format → OneBot 的输入含义一致。
 *
 * JPEG 的 base64 常以 /9j/ 开头，不能按“以 / 开头即本地路径”处理；data URI
 * 也必须剥掉头部后再交给 OneBot。这里绝不记录原始媒体内容。
 */
export function normalizeOneBotMediaSource(value: unknown): string {
  const data = String(value ?? '');
  const dataUri = data.match(/^data:[^;,]+;base64,([A-Za-z0-9+/_-]+={0,2})$/i);

  if (dataUri) {
    return `base64://${dataUri[1].replace(/-/g, '+').replace(/_/g, '/')}`;
  }

  if (data.startsWith('base64://')) {
    return data;
  }
  if (data.startsWith('buffer://')) {
    return `base64://${data.slice('buffer://'.length)}`;
  }

  // 标准和 URL-safe Base64 都允许；长度阈值避免把常见短文本误判成媒体数据。
  const base64 = /^[A-Za-z0-9+/_-]+={0,2}$/.test(data) && data.length >= 16 && data.length % 4 === 0;

  if (base64) {
    return `base64://${data.replace(/-/g, '+').replace(/_/g, '/')}`;
  }

  if (/^https?:\/\//.test(data) || data.startsWith('file://') || data.startsWith('/')) {
    return data;
  }

  // Yunzai 的 Buffer 序列化结果应全部走到这里；维持历史兼容行为。
  return `base64://${data}`;
}

function toOneBotFile(data: string): string {
  return normalizeOneBotMediaSource(data);
}

/**
 * 仅当 Format 通用接口能不丢失 OneBot 段语义时，才允许原生动作失败后重试。
 * 引用、合并转发、表情、JSON/XML，以及媒体控制参数均没有等价的 Format 表示，
 * 因此不能悄悄降成文本或普通消息。
 */
export function canUseGenericOneBotFallback(contents: ReplyContent[]): boolean {
  const directlyRepresentable = new Set<ReplyContent['type']>(['text', 'at', 'image', 'record', 'video']);

  return (
    contents.length > 0 &&
    contents.every(content => directlyRepresentable.has(content.type) && !content.quoteMessageId && Object.keys(content.params ?? {}).length === 0)
  );
}

function withSegmentParams(
  params: ReplyContent['params'] | undefined,
  required: Record<string, string>,
  segmentType: string
): Record<string, string | number | boolean> {
  const normalized = Object.fromEntries(Object.entries(params ?? {}).filter(([key, value]) => key !== 'type' || value !== segmentType));

  return { ...normalized, ...required };
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
        // Format.addImage 等通用接口不会把段自身的 type 字段塞进媒体 data。
        // 仅过滤与段类型同名的结构字段，同时保留 type=flash 等真实媒体参数。
        result.push({ type: content.type, data: withSegmentParams(content.params, { file: toOneBotFile(content.data) }, content.type) });
        break;
      case 'face':
        result.push({ type: 'face', data: { id: content.data } });
        break;
      case 'json':
      case 'xml':
        result.push({ type: content.type, data: { data: content.data } });
        break;
      case 'raw':
        if (content.nativeType && content.nativeData) {
          result.push(toOneBotSegment({ type: content.nativeType, data: content.nativeData }));
        }
        break;
      default:
        result.push({ type: 'text', data: { text: content.data } });
    }
  }

  return result;
}

/** 没有转发或引用时，标准 OneBot 段可直接发送，避免经 Format 丢失段语义。 */
export function getNativeMessageRequest(contents: ReplyContent[], target: NativeForwardTarget): NativeMessageRequest | null {
  const supportedTypes = new Set<ReplyContent['type']>(['text', 'at', 'image', 'record', 'video', 'face', 'json', 'xml', 'raw']);

  if (
    contents.length === 0 ||
    contents.some(content => content.quoteMessageId ?? (content.type === 'raw' && (!content.nativeType || !content.nativeData))) ||
    !contents.every(content => supportedTypes.has(content.type))
  ) {
    return null;
  }

  const message = toOneBotSegments(contents);

  if (target.isPrivate) {
    const userId = getTargetId(target.userId);

    return userId ? { action: 'send_private_msg', params: { user_id: userId, message } } : null;
  }

  const groupId = getTargetId(target.groupId);

  return groupId ? { action: 'send_group_msg', params: { group_id: groupId, message } } : null;
}

/** 引用消息使用标准 send_*_msg 动作；携带转发时改发可读 fallback，确保引用不丢失。 */
export function getNativeQuoteRequest(contents: ReplyContent[], target: NativeForwardTarget): NativeMessageRequest | null {
  const quoteMessageId = contents.find(content => content.quoteMessageId)?.quoteMessageId;

  if (!quoteMessageId) {
    return null;
  }

  const message = [{ type: 'reply', data: { id: quoteMessageId } }, ...toOneBotSegments(contents)];

  if (target.isPrivate) {
    const userId = getTargetId(target.userId);

    return userId ? { action: 'send_private_msg', params: { user_id: userId, message } } : null;
  }

  const groupId = getTargetId(target.groupId);

  return groupId ? { action: 'send_group_msg', params: { group_id: groupId, message } } : null;
}

/**
 * OneBot 的“引用”和“合并转发”分别是不同动作，无法装入同一条消息。此前会把
 * 转发摊成文本来保留引用，导致合并转发体验丢失；现在拆成一条引用正文和一条
 * 原生合并转发，两个语义均可保留。
 */
export function getNativeQuotedForwardRequests(contents: ReplyContent[], target: NativeForwardTarget): NativeOneBotRequest[] | null {
  const forwards = contents.filter(content => content.type === 'forward');
  const quoteMessageId = contents.find(content => content.quoteMessageId)?.quoteMessageId;

  if (forwards.length !== 1 || !quoteMessageId) {
    return null;
  }

  const forward = forwards[0];
  const forwardRequest = getNativeForwardRequest([{ ...forward, quoteMessageId: undefined }], target);

  if (!forwardRequest) {
    return null;
  }

  const quoteBody = contents.filter(content => content !== forward);
  const quotedContents =
    quoteBody.length > 0 ? [{ ...quoteBody[0], quoteMessageId }, ...quoteBody.slice(1)] : [{ type: 'text' as const, data: '[转发消息]', quoteMessageId }];
  const quoteRequest = getNativeQuoteRequest(quotedContents, target);

  return quoteRequest ? [quoteRequest, forwardRequest] : null;
}

export function getNativeOneBotRequest(contents: ReplyContent[], target: NativeForwardTarget): NativeOneBotRequest | null {
  // OneBot 事件统一优先走原生动作，用于完整验证 OneBot API 能力；非 OneBot
  // 平台、未知段或明确不支持的动作才由 bridge 降级到通用 message.send。
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
  if (Array.isArray(result)) {
    const success = result.find(item => item?.code === 2000);

    if (success) {
      return success.data;
    }

    const failure = result.find(item => item && typeof item === 'object' && 'code' in item);

    if (failure) {
      const response = failure.data?.oneBotResponse;
      const error = Object.assign(new Error(`OneBot action failed (${String(failure.code)}: ${String(failure.message ?? 'unknown error')})`), {
        // 这是平台已返回的明确失败，不是超时或断线；可安全尝试另一路发送。
        oneBotActionRejected: true,
        oneBotResultCode: failure.code,
        oneBotResponse: response
      });

      throw error;
    }
  }

  if (result?.status === 'failed' || (typeof result?.retcode === 'number' && result.retcode !== 0)) {
    const error = Object.assign(new Error(result?.wording ?? result?.message ?? `OneBot action failed (retcode=${result?.retcode ?? 'unknown'})`), result);

    throw error;
  }

  return result;
}

type NativeOneBotClient = {
  send: (request: NativeOneBotRequest) => Promise<any>;
  sendGroupMessage?: (params: NativeMessageRequest['params']) => Promise<any>;
  sendPrivateMessage?: (params: NativeMessageRequest['params']) => Promise<any>;
  getConnectionStatus?: () => Promise<any>;
  sendV12Action?: (action: string, params: Record<string, any>) => Promise<any>;
};

async function getOneBotActiveVersion(client: NativeOneBotClient): Promise<number | undefined> {
  if (!client.getConnectionStatus) {
    return undefined;
  }

  try {
    const status = assertOneBotActionSucceeded(await client.getConnectionStatus());
    const version = Number(status?.activeVersion);

    return version === 11 || version === 12 ? version : undefined;
  } catch {
    return undefined;
  }
}

function getV12UploadParams(file: unknown): Record<string, string> {
  const input = String(file ?? '');

  if (/^https?:\/\//.test(input)) {
    return { type: 'url', url: input };
  }
  if (input.startsWith('file://')) {
    return { type: 'path', path: input.slice('file://'.length) };
  }
  if (input.startsWith('base64://') || input.startsWith('buffer://')) {
    return { type: 'data', data: input.slice(input.indexOf('://') + 3) };
  }

  return { type: 'data', data: input };
}

async function toV12Message(client: NativeOneBotClient, message: any[]): Promise<any[]> {
  const sendV12Action = client.sendV12Action;

  if (!sendV12Action) {
    throw new Error('OneBot v12 原生动作不可用');
  }

  const converted = await Promise.all(
    message.map(async segment => {
      const type = segment?.type;

      if (type === 'text') {
        return { type: 'text', data: { text: String(segment?.data?.text ?? '') } };
      }
      if (type === 'at') {
        const qq = String(segment?.data?.qq ?? '');

        return qq === 'all' ? { type: 'mention_all', data: {} } : { type: 'mention', data: { user_id: qq } };
      }
      if (['image', 'record', 'video'].includes(type)) {
        const uploaded = assertOneBotActionSucceeded(await sendV12Action('upload_file', getV12UploadParams(segment?.data?.file)));
        const fileId = uploaded?.file_id ?? uploaded?.id;

        if (!fileId) {
          throw new Error(`OneBot v12 upload_file 未返回 file_id (${type})`);
        }

        return { type: type === 'record' ? 'voice' : type, data: { file_id: String(fileId) } };
      }

      // reply/json/xml/face 由支持其段定义的 V12 实现原样处理；不把内容降为文本。
      return segment;
    })
  );

  return converted;
}

async function sendV12Message(client: NativeOneBotClient, request: NativeMessageRequest): Promise<any> {
  if (!client.sendV12Action) {
    throw new Error('OneBot v12 原生动作不可用');
  }

  const message = await toV12Message(client, request.params.message);
  const params =
    request.action === 'send_group_msg'
      ? { detail_type: 'group', group_id: request.params.group_id, message }
      : { detail_type: 'private', user_id: request.params.user_id, message };

  return assertOneBotActionSucceeded(await client.sendV12Action('send_message', params));
}

/**
 * 普通消息使用与 OneBot 通用消息适配器相同的语义方法；该适配器内部也是
 * sendGroupMessage/sendPrivateMessage。只有合并转发没有对应语义方法时才透传 action。
 */
export async function sendNativeForward(client: NativeOneBotClient, request: NativeOneBotRequest): Promise<any> {
  if ((request.action === 'send_group_msg' || request.action === 'send_private_msg') && (await getOneBotActiveVersion(client)) === 12) {
    return sendV12Message(client, request);
  }

  if (request.action === 'send_group_msg' && client.sendGroupMessage) {
    return assertOneBotActionSucceeded(await client.sendGroupMessage(request.params));
  }

  if (request.action === 'send_private_msg' && client.sendPrivateMessage) {
    return assertOneBotActionSucceeded(await client.sendPrivateMessage(request.params));
  }

  return assertOneBotActionSucceeded(await client.send(request));
}
