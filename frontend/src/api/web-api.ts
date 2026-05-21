import axios from 'axios';
import { API } from '../types';

type MessagePayload = {
  type: string;
  data?: unknown;
};

type MessageHandler = (data: MessagePayload) => void;
export type RuntimeMode = 'desktop' | 'web' | 'unknown';

const STATUS_POLL_INTERVAL_IDLE_MS = 3000;
const STATUS_POLL_INTERVAL_BUSY_MS = 1000;
const STATUS_POLL_INTERVAL_HIDDEN_MS = 15000;

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

export async function uploadPluginArchive(file: File, dirName?: string) {
  const formData = new FormData();

  formData.append('file', file);
  if (dirName?.trim()) {
    formData.append('dirName', dirName.trim());
  }

  const response = await fetch('./api/yunzai/plugin-upload', {
    method: 'POST',
    body: formData
  });
  const json = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(json?.message ?? '上传失败');
  }

  return json;
}

export function createWebAPI(): API {
  const listeners = new Set<MessageHandler>();
  let statusSubscriberCount = 0;
  let statusTimer: ReturnType<typeof window.setTimeout> | null = null;
  let statusBusy = false;
  let statusRequestInflight = false;
  let actionInflightCount = 0;

  const isDocumentHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

  const emit = (data: MessagePayload) => {
    if (data.type === 'yunzai.status') {
      const state = (data.data ?? {}) as { busy?: boolean };

      statusBusy = Boolean(state.busy);
    } else if (data.type === 'yunzai.result') {
      actionInflightCount = Math.max(0, actionInflightCount - 1);
    }
    listeners.forEach(listener => listener(data));
  };

  const getStatusInterval = () => {
    if (isDocumentHidden()) {
      return STATUS_POLL_INTERVAL_HIDDEN_MS;
    }

    return statusBusy || actionInflightCount > 0 ? STATUS_POLL_INTERVAL_BUSY_MS : STATUS_POLL_INTERVAL_IDLE_MS;
  };

  const clearStatusTimer = () => {
    if (!statusTimer) {
      return;
    }

    window.clearTimeout(statusTimer);
    statusTimer = null;
  };

  const scheduleStatusPolling = () => {
    if (statusSubscriberCount <= 0) {
      statusTimer = null;

      return;
    }

    clearStatusTimer();
    statusTimer = window.setTimeout(() => {
      void fetchStatus();
    }, getStatusInterval());
  };

  const fetchStatus = async () => {
    if (statusRequestInflight) {
      return;
    }
    statusRequestInflight = true;
    try {
      const json = await callApi('/yunzai/status', 'GET');

      emit({ type: 'yunzai.status', data: json.data });
    } catch (err: any) {
      emit({ type: 'yunzai.result', data: { message: err?.message ?? '请求失败' } });
    } finally {
      statusRequestInflight = false;

      if (statusSubscriberCount > 0) {
        scheduleStatusPolling();
      } else {
        statusTimer = null;
      }
    }
  };

  const ensureStatusPolling = () => {
    if (statusSubscriberCount <= 0 || statusTimer || statusRequestInflight) {
      return;
    }

    void fetchStatus();
  };

  const stopStatusPollingIfIdle = () => {
    if (statusSubscriberCount > 0 || !statusTimer) {
      return;
    }

    clearStatusTimer();
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (statusSubscriberCount <= 0) {
        return;
      }

      clearStatusTimer();

      if (document.visibilityState === 'visible') {
        ensureStatusPolling();

        return;
      }

      if (!statusRequestInflight) {
        scheduleStatusPolling();
      }
    });
  }

  return {
    postMessage: data => {
      void (async () => {
        try {
          switch (data?.type) {
            case 'yunzai.status.subscribe': {
              statusSubscriberCount++;
              ensureStatusPolling();
              break;
            }
            case 'yunzai.status.unsubscribe': {
              statusSubscriberCount = Math.max(0, statusSubscriberCount - 1);
              stopStatusPollingIfIdle();
              break;
            }
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
              await fetchStatus();
              break;
            }
            case 'yunzai.logs': {
              const payload = (data.data ?? {}) as { file?: string; lines?: number };
              const params = new URLSearchParams();

              if (payload.file) {
                params.set('file', payload.file);
              }
              if (payload.lines) {
                params.set('lines', String(payload.lines));
              }
              const query = params.toString();
              const json = await callApi(`/yunzai/logs${query ? `?${query}` : ''}`, 'GET');

              emit({ type: 'yunzai.logs', data: json.data });
              break;
            }
            case 'yunzai.action': {
              actionInflightCount++;
              const json = await callApi('/yunzai/action', 'POST', data.data ?? {});

              emit({ type: 'yunzai.result', data: json.data });
              ensureStatusPolling();
              break;
            }
            default:
              break;
          }
        } catch (err: any) {
          if (data?.type === 'yunzai.action') {
            actionInflightCount = Math.max(0, actionInflightCount - 1);
          }
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

      return () => {
        listeners.delete(callback);
      };
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
