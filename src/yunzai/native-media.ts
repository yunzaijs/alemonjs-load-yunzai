import { serializeReplyMediaFile } from './media';
import { normalizeOneBotMediaSource } from './forward';

/** 原生 API 也必须在 Worker 中读取本地媒体，递归覆盖合并转发节点。 */
export async function serializeNativeMessageMedia(value: any): Promise<any> {
  if (Array.isArray(value)) {
    return Promise.all(value.map(serializeNativeMessageMedia));
  }
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) {
    return value;
  }
  const copy = { ...value };
  const type = String(value.type ?? '');

  if (['image', 'flash', 'record', 'video'].includes(type)) {
    const source = value.data && typeof value.data === 'object' ? value.data : value;
    const media = { ...source };

    if (source.file !== undefined) {
      media.file = normalizeOneBotMediaSource(await serializeReplyMediaFile(source.file));
    }
    if (source === value) {
      return media;
    }
    copy.data = media;
  } else if (type === 'node') {
    copy.data = await serializeNativeMessageMedia(value.data);
  } else if (type) {
    return copy;
  }
  // 原生请求参数和无 type 的 icqq 转发节点均使用这些字段。
  for (const key of ['message', 'messages', 'content']) {
    if (value[key] !== undefined) {
      copy[key] = await serializeNativeMessageMedia(value[key]);
    }
  }

  return copy;
}
