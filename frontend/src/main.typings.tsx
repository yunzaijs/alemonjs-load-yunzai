import { API } from './types';

declare global {
  interface Window {
    __ALEMONJS_RUNTIME_MODE__?: 'desktop' | 'web' | 'unknown';
    createDesktopAPI: () => API;
    desktopAPI: API;
    API: API;
  }
}
