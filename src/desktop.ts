import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getRepoData, getStatusData, getYunzaiFormData, runYunzaiAction, saveRepoData, saveYunzaiFormData } from './panel-service';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const activate = context => {
  // Desktop 模式入口：
  // 这里只负责在 AlemonJS Desktop/WebView 中注入页面与桌面消息总线。
  // Web 模式下的浏览器访问走 src/api-router.ts 提供的 HTTP /api 接口。
  const webView = context.createSidebarWebView(context);

  context.onCommand('open.yunzai', () => {
    const htmlPath = join(__dirname, '../', 'dist', 'index.html');
    const scriptReg = /<script.*?src="(.+?)".*?>/;
    const styleReg = /<link.*?rel="stylesheet".*?href="(.+?)".*?>/;
    const iconReg = /<link.*?rel="icon".*?href="(.+?)".*?>/g;
    const styleUri = context.createExtensionDir(join(__dirname, '../', 'dist', 'assets', 'index.css'));
    const scriptUri = context.createExtensionDir(join(__dirname, '../', 'dist', 'assets', 'index.js'));
    const html = readFileSync(htmlPath, 'utf-8')
      .replace(iconReg, '')
      .replace(scriptReg, `<script type="module" crossorigin src="${scriptUri}"></script>`)
      .replace(styleReg, `<link rel="stylesheet" crossorigin href="${styleUri}">`);

    webView.loadWebView(html);
  });

  webView.onMessage(async data => {
    try {
      if (data.type === 'yunzai.form.save') {
        saveYunzaiFormData(data.data ?? {});
        context.notification('Yunzai 配置保存成功～');
      } else if (data.type === 'yunzai.init') {
        webView.postMessage({
          type: 'yunzai.init',
          data: getYunzaiFormData()
        });
      } else if (data.type === 'repo.init') {
        webView.postMessage({
          type: 'repo.init',
          data: getRepoData()
        });
      } else if (data.type === 'repo.save') {
        saveRepoData(data.data ?? {});
        context.notification('仓库配置保存成功～');
      } else if (data.type === 'yunzai.status') {
        webView.postMessage({
          type: 'yunzai.status',
          data: getStatusData()
        });
      } else if (data.type === 'yunzai.action') {
        try {
          const result = await runYunzaiAction(data.data ?? {});

          webView.postMessage({ type: 'yunzai.result', data: result });
        } catch (err: any) {
          webView.postMessage({ type: 'yunzai.result', data: { message: `操作失败: ${err?.message ?? '未知错误'}` } });
        }
      }
    } catch (e) {
      console.error(e);
    }
  });
};
