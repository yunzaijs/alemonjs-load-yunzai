import { ResultCode } from 'alemonjs';

type PlatformSendResult = {
  code?: unknown;
  message?: unknown;
};

/**
 * AlemonJS 平台适配器常以 Result[] 表示失败，而非 reject Promise。
 *
 * OneBot 的 sendGroup/sendPrivate 正是这种行为；若不显式检查，Worker 会
 * 收到“发送成功”的回执，日志却没有任何可用于排查图片上传失败的线索。
 */
export function assertMessageSendSucceeded(result: unknown): void {
  const entries = (Array.isArray(result) ? result : [result]).filter(
    (item): item is PlatformSendResult => Boolean(item) && typeof item === 'object' && 'code' in item
  );

  // 非 Result 形态（例如部分原生 API 直接返回 message_id）由调用方正常处理。
  if (entries.length === 0 || entries.some(item => item.code === ResultCode.Ok)) {
    return;
  }

  const summary = entries.map(item => `${String(item.code)}:${String(item.message ?? 'unknown error')}`).join('; ');

  throw new Error(`平台消息发送失败 (${summary})`);
}

/** 只记录类型和大小，禁止把 base64 图片正文写进日志。 */
export function summarizeReplyContents(contents: { type: string; data: string }[]): string {
  const images = contents.filter(item => item.type === 'image');

  if (images.length === 0) {
    return `segments=${contents.length}`;
  }

  const imageBytes = images.reduce((total, item) => total + Math.floor((item.data.length * 3) / 4), 0);

  return `segments=${contents.length}, images=${images.length}, imageBytes≈${imageBytes}`;
}
