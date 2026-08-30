/**
 * 路径配置
 *
 * 配置相关的值通过函数导出，每次调用时从 getConfigValue() 实时读取，
 * 支持 AlemonJS 动态修改配置后立即生效。
 */
import { getConfigValue } from 'alemonjs';
import { existsSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { YunzaiVariant } from './yunzai/variant';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 插件包根目录 (alemonjs-load-yunzai/) */
export const PACKAGE_ROOT = join(__dirname, '..');

/** Worker 脚本路径 (编译后位于 lib/yunzai/worker.js) */
export const WORKER_PATH = join(__dirname, 'yunzai', 'worker.js');

/** 内置 yarn 入口脚本路径 */
export const YARN_PATH = join(PACKAGE_ROOT, 'runtime', 'yarn', 'yarn.cjs');

// ─── 以下均为动态读取配置 ───

const DEFAULT_GH_PROXY = 'https://ghfast.top/';
const YUNZAI_DIRECTORY_NAME = 'Yunzai';
const DEFAULT_YUNZAI_REPO = 'https://github.com/TimeRainStarSky/Yunzai.git';
const DEFAULT_MIAO_PLUGIN_REPO = 'https://github.com/yoimiya-kokomi/miao-plugin.git';
const DEFAULT_EVENT_CONCURRENCY = 1;

function getConfig() {
  const values = getConfigValue() ?? {};

  return values['alemonjs-load-yunzai'] ?? {};
}

/** GitHub 代理前缀 */
export function getGhProxy(): string {
  return getConfig()?.gh_proxy ?? DEFAULT_GH_PROXY;
}

/** 默认 Yunzai 仓库地址 */
export function getDefaultRepo(): string {
  const repo = getConfig()?.yunzai_repo ?? DEFAULT_YUNZAI_REPO;

  return `${getGhProxy()}${repo}`;
}

/** miao-plugin 仓库地址 */
export function getMiaoPluginRepo(): string {
  const repo = getConfig()?.miao_plugin_repo ?? DEFAULT_MIAO_PLUGIN_REPO;

  return `${getGhProxy()}${repo}`;
}

/**
 * 同时交给 Yunzai Worker 处理的事件数。
 *
 * Yunzai 的 Puppeteer 后端使用单个共享 Chromium，默认串行可避免任一渲染
 * 失败时重启浏览器、连带中断其他截图任务。需要更高吞吐时可显式调大。
 */
export function getYunzaiEventConcurrency(): number {
  const value = Number(getConfig()?.event_concurrency ?? DEFAULT_EVENT_CONCURRENCY);

  if (!Number.isFinite(value)) {
    return DEFAULT_EVENT_CONCURRENCY;
  }

  return Math.min(4, Math.max(1, Math.floor(value)));
}

// ─── 插件注册表 ───

export interface PluginInfo {
  /** plugins/ 下的目录名 */
  dirName: string;
  /** git clone 地址 */
  repoUrl: string;
  /** 显示名称 */
  label: string;
}

/** 插件定义：信息 + 所有别名 */
export interface PluginDef extends PluginInfo {
  aliases: string[];
  /** 仅在指定 Yunzai 发行版的推荐目录中展示 */
  variants?: YunzaiVariant[];
}

/** 内置插件列表（每个插件只定义一次） */
const BUILTIN_PLUGINS: PluginDef[] = [
  {
    aliases: ['miao', 'miaomiao', '原神'],
    dirName: 'miao-plugin',
    repoUrl: 'https://github.com/yoimiya-kokomi/miao-plugin.git',
    label: 'miao-plugin',
    variants: ['miao']
  },
  {
    aliases: ['trss原神', 'trssgenshin', 'genshin'],
    dirName: 'Yunzai-genshin',
    repoUrl: 'https://github.com/TimeRainStarSky/Yunzai-genshin.git',
    label: 'Yunzai-genshin',
    variants: ['trss']
  },
  { aliases: ['starrail', '星铁'], dirName: 'StarRail-plugin', repoUrl: 'https://gitee.com/hewang1an/StarRail-plugin.git', label: 'StarRail-plugin' },
  { aliases: ['zzz'], dirName: 'ZZZ-Plugin', repoUrl: 'https://gitee.com/bietiaop/ZZZ-Plugin.git', label: 'ZZZ-Plugin' },
  { aliases: ['图鉴'], dirName: 'xiaoyao-cvs-plugin', repoUrl: 'https://cnb.cool/tar/xiaoyao-cvs-plugin.git', label: 'xiaoyao-cvs-plugin' },
  { aliases: ['锅巴', 'guoba'], dirName: 'guoba-plugin', repoUrl: 'https://gitee.com/guoba-yunzai/guoba-plugin.git', label: 'guoba-plugin' },
  { aliases: ['喵喵扩展', 'liangshi'], dirName: 'liangshi-calc', repoUrl: 'https://gitee.com/liangshi233/liangshi-calc.git', label: 'liangshi-calc' },
  {
    aliases: ['明日方舟', '方舟', 'endfield'],
    dirName: 'endfield-suzuki-plugin',
    repoUrl: 'https://github.com/yoshino-xiao7/endfield-suzuki-plugin.git',
    label: 'endfield-suzuki-plugin'
  },
  { aliases: ['终末地', 'zmd'], dirName: 'zmd-plugin', repoUrl: 'https://github.com/Anon-deisu/zmd-plugin.git', label: 'zmd-plugin' },
  { aliases: ['三角洲', 'delta'], dirName: 'delta-force-plugin', repoUrl: 'https://github.com/Dnyo666/delta-force-plugin.git', label: 'delta-force-plugin' },
  {
    aliases: ['王者荣耀', '王者'],
    dirName: 'GloryOfKings-Plugin',
    repoUrl: 'https://gitee.com/Tloml-Starry/GloryOfKings-Plugin.git',
    label: 'GloryOfKings-Plugin'
  },
  { aliases: ['尘白禁区', '尘白'], dirName: 'cb-plugin', repoUrl: 'https://github.com/Sakura1618/cb-plugin.git', label: 'cb-plugin' },
  { aliases: ['鸣潮', 'waves'], dirName: 'waves-plugin', repoUrl: 'https://github.com/erzaozi/waves-plugin.git', label: 'waves-plugin' },
  { aliases: ['重返未来', '1999'], dirName: '1999-plugin', repoUrl: 'https://gitee.com/fantasy-hx/1999-plugin.git', label: '1999-plugin' },
  { aliases: ['库洛', 'kuro'], dirName: 'Yunzai-Kuro-Plugin', repoUrl: 'https://github.com/TomyJan/Yunzai-Kuro-Plugin.git', label: 'Yunzai-Kuro-Plugin' },
  { aliases: ['光遇', 'sky'], dirName: 'Tlon-Sky', repoUrl: 'https://gitee.com/Tloml-Starry/Tlon-Sky.git', label: 'Tlon-Sky' }
];

/** 展开别名数组为 alias → PluginInfo 的扁平映射 */
function buildAliasMap(plugins: PluginDef[]): Record<string, PluginInfo> {
  const map: Record<string, PluginInfo> = {};

  for (const { aliases, dirName, repoUrl, label } of plugins) {
    const info: PluginInfo = { dirName, repoUrl, label };

    for (const alias of aliases) {
      map[alias] = info;
    }
  }

  return map;
}

const BUILTIN_PLUGIN_MAP = buildAliasMap(BUILTIN_PLUGINS);

/**
 * 合并内置插件与用户自定义插件配置
 * 用户可在 alemon.config.yaml 的 alemonjs-load-yunzai.plugins 中添加：
 * ```yaml
 * alemonjs-load-yunzai:
 *   plugins:
 *     别名:
 *       dirName: 插件目录名
 *       repoUrl: git仓库地址
 *       label: 显示名称
 *       aliases:          # 可选，额外别名
 *         - 别名2
 *         - 别名3
 * ```
 */
function getPluginAliasMap(): Record<string, PluginInfo> {
  const custom = getConfig()?.plugins ?? {};
  const merged = { ...BUILTIN_PLUGIN_MAP };

  for (const [alias, raw] of Object.entries(custom)) {
    if (raw && typeof raw === 'object' && (raw as any).dirName && (raw as any).repoUrl) {
      const info: PluginInfo = {
        dirName: (raw as any).dirName,
        repoUrl: (raw as any).repoUrl,
        label: (raw as any).label ?? (raw as any).dirName
      };

      merged[alias.toLowerCase()] = info;

      const extraAliases: string[] = Array.isArray((raw as any).aliases) ? (raw as any).aliases : [];

      for (const a of extraAliases) {
        if (typeof a === 'string' && a) {
          merged[a.toLowerCase()] = info;
        }
      }
    }
  }

  return merged;
}

/**
 * 返回所有可用插件（内置 + 用户自定义），按 dirName 去重
 */
export function getAllPlugins(variant?: YunzaiVariant): PluginDef[] {
  const result: PluginDef[] = BUILTIN_PLUGINS.filter(plugin => !variant || !plugin.variants || plugin.variants.includes(variant));
  const seen = new Set(result.map(p => p.dirName));
  const custom = getConfig()?.plugins ?? {};

  for (const [alias, raw] of Object.entries(custom)) {
    if (raw && typeof raw === 'object' && (raw as any).dirName && (raw as any).repoUrl) {
      const dirName = (raw as any).dirName as string;

      if (seen.has(dirName)) {
        continue;
      }
      seen.add(dirName);

      const extraAliases: string[] = Array.isArray((raw as any).aliases) ? (raw as any).aliases : [];

      result.push({
        dirName,
        repoUrl: (raw as any).repoUrl,
        label: (raw as any).label ?? dirName,
        aliases: [alias, ...extraAliases]
      });
    }
  }

  return result;
}

/** 根据用户输入的别名查找插件信息（大小写不敏感） */
export function getPluginInfo(alias: string): PluginInfo | undefined {
  return getPluginAliasMap()[alias.toLowerCase()];
}

/** Yunzai 安装目录（固定名称；发行版身份读取 package.json.name） */
export function getYunzaiDir(): string {
  return join(process.cwd(), YUNZAI_DIRECTORY_NAME);
}

/**
 * 迁移旧版本可配置目录名。
 * 只在新目录不存在时执行，且只处理旧配置中的目录名和历史默认名，避免覆盖数据。
 */
export function migrateLegacyYunzaiDir(): { migrated: boolean; source?: string; target: string } {
  const target = getYunzaiDir();

  if (existsSync(target)) {
    return { migrated: false, target };
  }

  const configuredName = getConfig()?.bot_name;
  const candidates = new Set(['Miao-Yunzai']);

  if (typeof configuredName === 'string' && /^[^\\/:*?"<>|]+$/.test(configuredName.trim())) {
    candidates.add(configuredName.trim());
  }

  for (const name of candidates) {
    const source = join(process.cwd(), name);

    if (source === target || !existsSync(source)) {
      continue;
    }

    renameSync(source, target);

    return { migrated: true, source, target };
  }

  return { migrated: false, target };
}
