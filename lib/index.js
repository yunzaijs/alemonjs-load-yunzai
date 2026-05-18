import { defineRouter, lazy, defineChildren, logger } from 'alemonjs';
import apiRouter from './api-router.js';
import { manager } from './yunzai/manager.js';

const responseRouter = defineRouter([
    {
        regular: /^(!|！|\/|#|＃)(yz|云崽)(help|帮助)$/,
        selects: ['message.create', 'private.message.create'],
        handler: lazy(() => import('./response/help.js'))
    },
    {
        regular: /^(!|！|\/|#|＃)(yz|云崽)(插件帮助|插件列表)$/,
        selects: ['message.create', 'private.message.create'],
        handler: lazy(() => import('./response/pluginHelp.js'))
    },
    {
        regular: /^(!|！|\/|#|＃)(yz|云崽)插件说明/,
        selects: ['message.create', 'private.message.create'],
        handler: lazy(() => import('./response/pluginReadme.js'))
    },
    {
        regular: /^(!|！|\/|#|＃)(yz|云崽)/,
        selects: ['message.create', 'private.message.create'],
        handler: lazy(() => import('./response/admin.js'))
    },
    {
        regular: /.*/,
        handler: lazy(() => import('./yunzai/bridge.js'))
    }
]);
var index = defineChildren({
    register() {
        return { responseRouter, koaRouter: apiRouter };
    },
    async onCreated() {
        logger.info('[alemonjs-load-yunzai] 启动');
        if (manager.isInstalled) {
            if (!manager.lastStartOk) {
                logger.warn('[Yunzai] 上次启动失败，跳过自动启动。请排查问题后发送 #yz启动');
                return;
            }
            try {
                await manager.start();
            }
            catch (err) {
                logger.error(`[Yunzai] Worker 启动失败: ${err?.message}`);
            }
        }
        else {
            logger.info('[Yunzai] 未安装。发送 #yz安装 安装机器人，安装后可通过 #yz安装<插件名> 添加插件');
        }
    }
});

export { index as default };
