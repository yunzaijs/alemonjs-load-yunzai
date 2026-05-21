import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getLogViewerData, getStatusData } from './panel-service';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const activate = context => {
  // Desktop 子进程入口：
  // - 当前文档层面仅将 desktop子进程 -> 机器人进程 的交互范围定义为“机器人状态”。
  // - 若后续恢复/启用 src/bus/*，其职责也仅限 desktop子进程 -> 机器人进程 的状态桥接，不属于 Web 主链路。
  // - Web 模式的浏览器访问始终走 src/api-router.ts 提供的 HTTP /api 接口。
  const webView = context.createSidebarWebView(context);
  let statusSubscriberCount = 0;
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  let statusBusy = false;
  const getStatusInterval = () => (statusBusy ? 500 : 2000);

  const pushStatus = async () => {
    const data = await getStatusData();

    statusBusy = Boolean((data as { busy?: boolean }).busy);
    webView.postMessage({
      type: 'yunzai.status',
      data
    });
  };

  const scheduleStatusPush = () => {
    if (statusSubscriberCount <= 0) {
      statusTimer = null;

      return;
    }

    statusTimer = setTimeout(() => {
      void pushStatus()
        .catch(console.error)
        .finally(() => {
          scheduleStatusPush();
        });
    }, getStatusInterval());
  };

  const ensureStatusPushLoop = () => {
    if (statusSubscriberCount <= 0 || statusTimer) {
      return;
    }

    void pushStatus()
      .catch(console.error)
      .finally(() => {
        scheduleStatusPush();
      });
  };

  const stopStatusPushLoop = () => {
    if (statusSubscriberCount > 0 || !statusTimer) {
      return;
    }

    clearTimeout(statusTimer);
    statusTimer = null;
  };

  const postBoundaryMessage = (type: 'yunzai.result' | 'repo.result', message: string) => {
    webView.postMessage({
      type,
      data: { message }
    });
  };

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
      if (data.type === 'yunzai.status.subscribe') {
        statusSubscriberCount++;
        ensureStatusPushLoop();
      } else if (data.type === 'yunzai.status.unsubscribe') {
        statusSubscriberCount = Math.max(0, statusSubscriberCount - 1);
        stopStatusPushLoop();
      } else if (data.type === 'yunzai.status') {
        await pushStatus();
      } else if (data.type === 'yunzai.logs') {
        webView.postMessage({
          type: 'yunzai.logs',
          data: getLogViewerData(typeof data.data?.file === 'string' ? data.data.file : undefined, typeof data.data?.lines === 'number' ? data.data.lines : 400)
        });
      } else if (data.type === 'yunzai.action' || data.type === 'yunzai.init' || data.type === 'yunzai.form.save') {
        postBoundaryMessage('yunzai.result', '当前 desktop 链路仅支持机器人状态同步，不提供 Yunzai 控制或配置写入');
      } else if (data.type === 'repo.init' || data.type === 'repo.save') {
        postBoundaryMessage('repo.result', '当前 desktop 链路仅支持机器人状态同步，不提供仓库配置读写');
      }
    } catch (e) {
      console.error(e);
    }
  });
};
