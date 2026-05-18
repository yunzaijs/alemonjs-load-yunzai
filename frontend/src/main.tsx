import { detectRuntimeMode, ensureRuntimeAPI } from '@/api/web-api';
import '@/input.scss';
import '@/main.typings';
import '@alemonjs/react-ui/style.css';
import '@alemonjs/react-ui/theme';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import router from './route';

// 统一入口：
// - desktop: 使用桌面容器注入的全局 API
// - web: 使用 HTTP /api 兼容层
// - unknown: 非浏览器环境，不初始化
window.__ALEMONJS_RUNTIME_MODE__ = detectRuntimeMode();
ensureRuntimeAPI();

const root = createRoot(document.getElementById('root')!);

root.render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
