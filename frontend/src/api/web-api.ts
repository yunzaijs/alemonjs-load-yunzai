import axios from 'axios';
import { API } from '../types';

type MessagePayload = {
  type: string;
  data?: unknown;
};

type MessageHandler = (data: MessagePayload) => void;
export type RuntimeMode = 'desktop' | 'web' | 'unknown';

export function detectRuntimeMode(): RuntimeMode {
  if (typeof window === 'undefined') {
    return 'unknown';
  }

  if (window.API || window.createDesktopAPI) {
    return 'desktop';
  }

  return 'web';
}

const request = axios.create({
  // 相对当前 html 去请求。要使用哈希路由
  baseURL: './api',
  headers: {
    'Content-Type': 'application/json'
  }
});

async function callApi(path: string, method: 'GET' | 'POST', data?: unknown) {
  try {
    const response = await request({
      url: path,
      method,
      data
    });

    return response.data;
  } catch (error: any) {
    throw new Error(error?.response?.data?.message ?? error?.message ?? '请求失败');
  }
}

export function createWebAPI(): API {
  const listeners = new Set<MessageHandler>();

  const emit = (data: MessagePayload) => {
    listeners.forEach(listener => listener(data));
  };

  return {
    postMessage: data => {
      void (async () => {
        try {
          switch (data?.type) {
            case 'yunzai.init': {
              const json = await callApi('/yunzai/config', 'GET');

              emit({ type: 'yunzai.init', data: json.data });
              break;
            }
            case 'yunzai.form.save': {
              const json = await callApi('/yunzai/config', 'POST', data.data ?? {});

              emit({ type: 'yunzai.result', data: { message: json.message } });
              break;
            }
            case 'repo.init': {
              const json = await callApi('/repo', 'GET');

              emit({ type: 'repo.init', data: json.data });
              break;
            }
            case 'repo.save': {
              const json = await callApi('/repo', 'POST', data.data ?? {});

              emit({ type: 'repo.result', data: { message: json.message } });
              break;
            }
            case 'yunzai.status': {
              const json = await callApi('/yunzai/status', 'GET');

              emit({ type: 'yunzai.status', data: json.data });
              break;
            }
            case 'yunzai.action': {
              const json = await callApi('/yunzai/action', 'POST', data.data ?? {});

              emit({ type: 'yunzai.result', data: json.data });
              break;
            }
            default:
              break;
          }
        } catch (err: any) {
          const message = err?.message ?? '请求失败';

          if (String(data?.type).startsWith('repo')) {
            emit({ type: 'repo.result', data: { message } });
          } else {
            emit({ type: 'yunzai.result', data: { message } });
          }
        }
      })();
    },
    onMessage: callback => {
      listeners.add(callback);
    },
    theme: {
      variables: () => {},
      on: () => {}
    },
    expansion: {
      getList: () => {},
      on: () => {}
    }
  };
}

export function ensureRuntimeAPI() {
  const mode = detectRuntimeMode();

  if (mode === 'unknown' || window.API) {
    return;
  }

  // Desktop 模式由 AlemonJS Desktop 注入全局 API。
  // Web 模式没有该变量，则回退到 HTTP /api 通道。
  if (mode === 'desktop' && window.createDesktopAPI) {
    window.API = window.createDesktopAPI();

    return;
  }

  window.API = createWebAPI();
}
