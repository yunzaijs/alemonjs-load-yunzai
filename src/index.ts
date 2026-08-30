import { defineChildren, defineRouter, lazy, logger } from 'alemonjs';
import apiRouter from './api-router';
import { manager } from './yunzai';
import { migrateLegacyYunzaiDir } from './path';

const responseRouter = defineRouter([
  // 帮助指令优先（更具体的正则先匹配）
  {
    regular: /^(\/|#|＃)(yz|云崽)(help|帮助)$/,
    selects: ['message.create', 'private.message.create'],
    handler: lazy(() => import('./response/help'))
  },
  // 插件帮助
  {
    regular: /^(\/|#|＃)(yz|云崽)(插件帮助|插件列表)$/,
    selects: ['message.create', 'private.message.create'],
    handler: lazy(() => import('./response/pluginHelp'))
  },
  // 插件说明
  {
    regular: /^(\/|#|＃)(yz|云崽)插件说明/,
    selects: ['message.create', 'private.message.create'],
    handler: lazy(() => import('./response/pluginReadme'))
  },
  // 管理指令
  {
    regular: /^(\/|#|＃)(yz|云崽)/,
    selects: ['message.create', 'private.message.create'],
    handler: lazy(() => import('./response/admin'))
  },
  // 其余全部转发给 Yunzai Worker
  {
    regular: /.*/,
    handler: lazy(() => import('./yunzai/bridge'))
  }
]);

export default defineChildren({
  register() {
    return { responseRouter, koaRouter: apiRouter };
  },
  async onCreated() {
    const migration = migrateLegacyYunzaiDir();

    if (migration.migrated) {
      logger.info(`[Yunzai] 已将旧目录 ${migration.source} 迁移为固定目录 ${migration.target}`);
    }
    logger.info('[alemonjs-load-yunzai] 启动');
    if (manager.isInstalled) {
      if (!manager.lastStartOk) {
        logger.warn('[Yunzai] 上次启动失败，跳过自动启动。请排查问题后发送 #yz启动');

        return;
      }
      try {
        await manager.start();
      } catch (err: any) {
        logger.error(`[Yunzai] Worker 启动失败: ${err?.message}`);
      }
    } else {
      logger.info('[Yunzai] 未安装。发送 #yz安装 安装机器人，安装后可通过 #yz安装<插件名> 添加插件');
    }
  }
});
