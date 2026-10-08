function isPlatformResult(value: any): boolean {
  return (
    value && typeof value === 'object' && typeof value.code === 'number' && value.code >= 2000 && value.code < 6000 && ('message' in value || 'data' in value)
  );
}

/** 只移除 AlemonJS Result 包装，普通消息/成员数组仍保持数组。 */
export function unwrapOneBotResult(result: any): any {
  const entries = Array.isArray(result) && result.length > 0 && result.every(isPlatformResult) ? result : isPlatformResult(result) ? [result] : undefined;

  if (entries) {
    const success = entries.find(item => item.code === 2000);

    if (!success) {
      const failure = entries[0];
      const detail = failure.data;
      const response = detail?.oneBotResponse ?? (detail && (detail.retcode !== undefined || detail.status === 'failed') ? detail : undefined);
      const message = response?.wording ?? response?.message ?? detail?.message ?? failure.message ?? 'unknown error';
      // @alemonjs/onebot 2.1.21 的 SDK 对非 0/1 retcode 执行 reject(data)。
      // data=null 被 onapis 原样包装为这一形态；断线是 Error，CBP 超时文案为“接口超时”。
      const legacyNativeRejection = failure.code === 4000 && failure.message === '请求失败' && detail === null;

      throw Object.assign(new Error(`OneBot action failed (${failure.code}: ${message})`), {
        oneBotResultCode: failure.code,
        oneBotResponse: response,
        // ResultCode.Fail 也可能表示断线或超时，不能据此认定动作没有成功发送。
        oneBotActionRejected: legacyNativeRejection || Boolean(response && (response.status === 'failed' || Number(response.retcode) > 1))
      });
    }

    result = success.data;
  }

  if (result?.status === 'failed' || (result?.retcode !== undefined && ![0, 1].includes(Number(result.retcode)))) {
    throw Object.assign(new Error(result.wording ?? result.message ?? `OneBot action failed (retcode=${result.retcode})`), {
      oneBotResponse: result,
      oneBotActionRejected: true
    });
  }

  return result;
}

/** useClient 是深代理，每个方法都返回 Result[]，不是原生 OneBot data。 */
export function createOneBotClientCompat(client: any): any {
  return new Proxy(client, {
    get(target, key) {
      const method = Reflect.get(target, key);

      if (typeof method !== 'function' || key === 'then') {
        return method;
      }

      return async (...args: any[]) => unwrapOneBotResult(await Reflect.apply(method, target, args));
    }
  });
}

/** Bot.sendApi 的插件契约为 OneBot response，不能泄露宿主 Result[] 包装。 */
export function toOneBotApiResponse(result: any): any {
  const payload = unwrapOneBotResult(result);

  if (payload && typeof payload === 'object' && ('retcode' in payload || 'status' in payload) && 'data' in payload) {
    return payload;
  }

  return { status: 'ok', retcode: 0, data: payload };
}

/** 标准 hooks 结果保留 data 访问方式，兼容现有 Worker 查询适配器。 */
export function normalizeWorkerApiResult(result: any): any {
  if ((Array.isArray(result) && result.length > 0 && result.every(isPlatformResult)) || isPlatformResult(result)) {
    return { data: unwrapOneBotResult(result) };
  }

  return result;
}
