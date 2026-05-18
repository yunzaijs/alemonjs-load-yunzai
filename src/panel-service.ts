import { getConfig, getConfigValue } from 'alemonjs';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import YAML from 'yaml';
import { getAllPlugins, getPluginInfo, getYunzaiDir } from './path';
import { manager } from './yunzai/manager';

type PrimitiveRecord = Record<string, unknown>;

export interface PluginItem {
  name: string;
  installed: boolean;
}

export interface CatalogItem {
  dirName: string;
  label: string;
  aliases: string[];
  repoUrl: string;
  installed: boolean;
}

function getInstalledPlugins(): PluginItem[] {
  const pluginsDir = join(getYunzaiDir(), 'plugins');

  if (!existsSync(pluginsDir)) {
    return [];
  }

  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => ({ name: d.name, installed: true }));
}

function getLogCount(): number {
  const logsDir = join(getYunzaiDir(), 'logs');

  if (!existsSync(logsDir)) {
    return 0;
  }

  return readdirSync(logsDir).filter(f => f.endsWith('.log')).length;
}

function getConfigDir(): string {
  return join(getYunzaiDir(), 'config', 'config');
}

function readYaml(name: string): PrimitiveRecord {
  const file = join(getConfigDir(), `${name}.yaml`);

  if (!existsSync(file)) {
    return {};
  }

  try {
    return (YAML.parse(readFileSync(file, 'utf-8')) as PrimitiveRecord) ?? {};
  } catch {
    return {};
  }
}

function writeYaml(name: string, data: PrimitiveRecord): void {
  const dir = getConfigDir();

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(data), 'utf-8');
}

function csv2arr(v: unknown): string[] | null {
  if (!v) {
    return null;
  }

  const arr = String(v)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  return arr.length > 0 ? arr : null;
}

function csv2numArr(v: unknown): number[] | null {
  const arr = csv2arr(v);

  if (!arr) {
    return null;
  }

  const nums = arr.map(Number).filter(n => !Number.isNaN(n));

  return nums.length > 0 ? nums : null;
}

export function getYunzaiFormData() {
  const bot = readYaml('bot');
  const other = readYaml('other');
  const qq = readYaml('qq');
  const redis = readYaml('redis');
  const group = readYaml('group');
  const groupDef = (group.default as PrimitiveRecord) ?? {};
  const notice = readYaml('notice');

  return {
    log_level: bot.log_level ?? 'info',
    resend: bot.resend ?? false,
    online_msg: bot.online_msg ?? true,
    online_msg_exp: bot.online_msg_exp ?? 86400,
    chromium_path: bot.chromium_path ?? '',
    puppeteer_ws: bot.puppeteer_ws ?? '',
    puppeteer_timeout: bot.puppeteer_timeout ?? '',
    proxyAddress: bot.proxyAddress ?? '',
    sign_api_addr: bot.sign_api_addr ?? '',
    autoFriend: other.autoFriend ?? 1,
    autoQuit: other.autoQuit ?? 50,
    masterQQ: other.masterQQ,
    disablePrivate: other.disablePrivate ?? false,
    disableGuildMsg: other.disableGuildMsg ?? true,
    disableMsg: other.disableMsg ?? '',
    whiteGroup: other.whiteGroup,
    whiteQQ: other.whiteQQ,
    blackGroup: other.blackGroup,
    blackQQ: other.blackQQ,
    qq: qq.qq ?? '',
    pwd: qq.pwd ?? '',
    platform: qq.platform ?? 6,
    redis_host: redis.host ?? '127.0.0.1',
    redis_port: redis.port ?? 6379,
    redis_username: redis.username ?? '',
    redis_password: redis.password ?? '',
    redis_db: redis.db ?? 0,
    groupGlobalCD: groupDef.groupGlobalCD ?? 0,
    singleCD: groupDef.singleCD ?? 1000,
    onlyReplyAt: groupDef.onlyReplyAt ?? 0,
    botAlias: groupDef.botAlias,
    imgAddLimit: groupDef.imgAddLimit ?? 0,
    imgMaxSize: groupDef.imgMaxSize ?? 2,
    addPrivate: groupDef.addPrivate ?? 1,
    iyuu: notice.iyuu ?? '',
    sct: notice.sct ?? '',
    feishu_webhook: notice.feishu_webhook ?? ''
  };
}

export function saveYunzaiFormData(db: PrimitiveRecord) {
  const bot = readYaml('bot');

  bot.log_level = db.log_level ?? 'info';
  bot.resend = db.resend === true || db.resend === 'true';
  bot.online_msg = db.online_msg !== false && db.online_msg !== 'false';
  bot.online_msg_exp = Number(db.online_msg_exp) || 86400;
  bot.chromium_path = db.chromium_path ?? '';
  bot.puppeteer_ws = db.puppeteer_ws ?? '';
  bot.puppeteer_timeout = db.puppeteer_timeout ? Number(db.puppeteer_timeout) : '';
  bot.proxyAddress = db.proxyAddress ?? '';
  bot.sign_api_addr = db.sign_api_addr ?? '';
  writeYaml('bot', bot);

  const other = readYaml('other');

  other.autoFriend = Number(db.autoFriend) || 0;
  other.autoQuit = Number(db.autoQuit) || 0;
  other.masterQQ = csv2numArr(db.masterQQ);
  other.disablePrivate = db.disablePrivate === true || db.disablePrivate === 'true';
  other.disableGuildMsg = db.disableGuildMsg !== false && db.disableGuildMsg !== 'false';
  other.disableMsg = db.disableMsg ?? '';
  other.whiteGroup = csv2numArr(db.whiteGroup);
  other.whiteQQ = csv2numArr(db.whiteQQ);
  other.blackGroup = csv2numArr(db.blackGroup);
  other.blackQQ = csv2numArr(db.blackQQ);
  writeYaml('other', other);

  const qq: PrimitiveRecord = readYaml('qq');

  qq.qq = db.qq ? Number(db.qq) || db.qq : '';
  qq.pwd = db.pwd ?? '';
  qq.platform = Number(db.platform) || 6;
  writeYaml('qq', qq);

  writeYaml('redis', {
    host: db.redis_host ?? '127.0.0.1',
    port: Number(db.redis_port) || 6379,
    username: db.redis_username ?? '',
    password: db.redis_password ?? '',
    db: Number(db.redis_db) || 0
  });

  const group = readYaml('group');
  const groupDefault = (group.default as PrimitiveRecord) ?? {};

  groupDefault.groupGlobalCD = Number(db.groupGlobalCD) || 0;
  groupDefault.singleCD = Number(db.singleCD) || 0;
  groupDefault.onlyReplyAt = Number(db.onlyReplyAt) || 0;
  groupDefault.botAlias = csv2arr(db.botAlias);
  groupDefault.imgAddLimit = Number(db.imgAddLimit) || 0;
  groupDefault.imgMaxSize = Number(db.imgMaxSize) || 2;
  groupDefault.addPrivate = Number(db.addPrivate);
  group.default = groupDefault;
  writeYaml('group', group);

  writeYaml('notice', {
    iyuu: db.iyuu ?? '',
    sct: db.sct ?? '',
    feishu_webhook: db.feishu_webhook ?? ''
  });
}

export function getRepoData() {
  let config = getConfigValue();

  if (!config) {
    config = {};
  }

  const yunzaiCfg = config.yunzai ?? {};
  const pkgCfg = config['alemonjs-load-yunzai'] ?? {};

  return {
    master_key: yunzaiCfg.master_key,
    master_id: yunzaiCfg.master_id,
    gh_proxy: pkgCfg.gh_proxy ? String(pkgCfg.gh_proxy) : 'https://ghfast.top/',
    bot_name: pkgCfg.bot_name ? String(pkgCfg.bot_name) : 'Miao-Yunzai',
    yunzai_repo: pkgCfg.yunzai_repo ? String(pkgCfg.yunzai_repo) : 'https://github.com/yoimiya-kokomi/Miao-Yunzai.git',
    miao_plugin_repo: pkgCfg.miao_plugin_repo ? String(pkgCfg.miao_plugin_repo) : 'https://github.com/yoimiya-kokomi/miao-plugin.git',
    plugins: pkgCfg.plugins ?? {}
  };
}

export function saveRepoData(db: PrimitiveRecord) {
  const config = getConfig();
  const value = config.value ?? {};

  value.yunzai = {
    ...value.yunzai,
    master_key: csv2arr(db.master_key),
    master_id: csv2arr(db.master_id)
  };

  const pkg = value['alemonjs-load-yunzai'] ?? {};

  pkg.gh_proxy = db.gh_proxy ?? '';
  pkg.bot_name = db.bot_name ?? '';
  pkg.yunzai_repo = db.yunzai_repo ?? '';
  pkg.miao_plugin_repo = db.miao_plugin_repo ?? '';
  if (db.plugins && typeof db.plugins === 'object') {
    pkg.plugins = db.plugins;
  }
  value['alemonjs-load-yunzai'] = pkg;
  config.saveValue(value);
}

export function getStatusData() {
  const installedPlugins = manager.isInstalled ? getInstalledPlugins() : [];
  const installedSet = new Set(installedPlugins.map(p => p.name));
  const catalog: CatalogItem[] = getAllPlugins().map(p => ({
    dirName: p.dirName,
    label: p.label,
    aliases: p.aliases,
    repoUrl: p.repoUrl,
    installed: installedSet.has(p.dirName)
  }));

  return {
    status: manager.getStatus(),
    installed: manager.isInstalled,
    running: manager.isRunning,
    busy: manager.isBusy,
    busyTask: manager.busyTaskName,
    plugins: installedPlugins,
    catalog,
    logCount: manager.isInstalled ? getLogCount() : 0,
    help: {
      installFlow: [
        { step: '①', label: '安装框架', cmd: '#yz安装', desc: '克隆 Yunzai 仓库' },
        { step: '②', label: '安装插件', cmd: '#yz安装插件miao', desc: '按需安装游戏插件' },
        { step: '③', label: '安装依赖', cmd: '#yz安装依赖', desc: '统一安装所有依赖' },
        { step: '④', label: '启动', cmd: '#yz启动', desc: '启动 Worker 进程' }
      ],
      controls: [
        { cmd: '#yz安装', desc: '安装 Yunzai 框架', color: 'green' },
        { cmd: '#yz安装插件', desc: '安装指定插件', color: 'green' },
        { cmd: '#yz安装依赖', desc: '重新安装所有依赖', color: 'blue' },
        { cmd: '#yz启动', desc: '启动 Worker', color: 'green' },
        { cmd: '#yz停止', desc: '停止 Worker', color: 'orange' },
        { cmd: '#yz重启', desc: '停止后重新启动', color: 'blue' },
        { cmd: '#yz更新', desc: '拉取代码+装依赖+重启', color: 'blue' },
        { cmd: '#yz强制更新', desc: '重置本地+更新+装依赖', color: 'red' },
        { cmd: '#yz更新插件', desc: '更新指定插件', color: 'blue' },
        { cmd: '#yz强制更新插件', desc: '重置+更新指定插件', color: 'red' }
      ],
      tools: [
        { cmd: '#yz状态', desc: '查看当前运行状态', color: 'orange' },
        { cmd: '#yz取消', desc: '取消正在执行的任务', color: 'orange' },
        { cmd: '#yz插件帮助', desc: '查看插件列表', color: 'green' },
        { cmd: '#yz插件说明', desc: '查看插件 README', color: 'green' },
        { cmd: '#yz日志清理', desc: '清理所有日志文件', color: 'orange' },
        { cmd: '#yz卸载插件', desc: '卸载指定插件', color: 'red' },
        { cmd: '#yz卸载', desc: '停止并删除 Yunzai', color: 'red' },
        { cmd: '#yz帮助', desc: '查看本帮助图', color: 'orange' }
      ]
    }
  };
}

export async function runYunzaiAction(data: PrimitiveRecord) {
  const action = String(data.action ?? '');
  const plugin = typeof data.plugin === 'string' ? data.plugin : '';

  switch (action) {
    case 'install':
      await manager.install();

      return { message: 'Yunzai 安装完成' };
    case 'uninstall':
      await manager.uninstall();

      return { message: 'Yunzai 已卸载' };
    case 'start':
      await manager.start();

      return { message: 'Yunzai 已启动' };
    case 'stop':
      await manager.stop();

      return { message: 'Yunzai 已停止' };
    case 'restart':
      await manager.restart();

      return { message: 'Yunzai 已重启' };
    case 'update':
      await manager.updateAll();

      return { message: 'Yunzai 更新完成' };
    case 'force_update':
      await manager.updateAll(true);

      return { message: 'Yunzai 强制更新完成' };
    case 'install_deps':
      await manager.installDeps();

      return { message: '依赖安装完成' };
    case 'cancel':
      if (manager.isBusy) {
        const taskName = manager.busyTaskName;

        manager.cancelTask();

        return { message: `已取消: ${taskName}` };
      }

      return { message: '当前没有正在执行的任务' };
    case 'clean_logs': {
      const logsDir = join(getYunzaiDir(), 'logs');

      if (!existsSync(logsDir)) {
        return { message: '日志目录不存在' };
      }

      const files = readdirSync(logsDir).filter(f => f.endsWith('.log'));

      for (const file of files) {
        rmSync(join(logsDir, file), { force: true });
      }

      return { message: `已清理 ${files.length} 个日志文件` };
    }
    case 'install_plugin': {
      if (!plugin) {
        return { message: '请输入插件别名或仓库地址' };
      }

      const info = getPluginInfo(plugin);

      if (info) {
        await manager.installPlugin(info);

        return { message: `${info.label} 安装完成` };
      }

      if (/^(https?:\/\/|git@)/.test(plugin)) {
        const dirName =
          plugin
            .replace(/\.git$/, '')
            .split('/')
            .pop() ?? 'unknown-plugin';

        await manager.installPlugin({ dirName, repoUrl: plugin, label: dirName });

        return { message: `${dirName} 安装完成` };
      }

      return { message: `未知插件「${plugin}」，请使用别名或完整仓库地址` };
    }
    case 'update_plugin': {
      if (!plugin) {
        return { message: '缺少插件参数' };
      }

      const info = getPluginInfo(plugin) ?? { dirName: plugin, repoUrl: '', label: plugin };

      await manager.updatePlugin(info);

      return { message: `${info.label} 更新完成` };
    }
    case 'force_update_plugin': {
      if (!plugin) {
        return { message: '缺少插件参数' };
      }

      const info = getPluginInfo(plugin) ?? { dirName: plugin, repoUrl: '', label: plugin };

      await manager.updatePlugin(info, true);

      return { message: `${info.label} 强制更新完成` };
    }
    case 'uninstall_plugin': {
      if (!plugin) {
        return { message: '缺少插件参数' };
      }

      const info = getPluginInfo(plugin) ?? { dirName: plugin, repoUrl: '', label: plugin };

      manager.uninstallPlugin(info);

      return { message: `${info.label} 已卸载` };
    }
    default:
      return { message: `未知操作: ${action}` };
  }
}
