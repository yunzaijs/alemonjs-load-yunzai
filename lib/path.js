import { getConfigValue } from 'alemonjs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname$1 = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname$1, '..');
const WORKER_PATH = join(__dirname$1, 'yunzai', 'worker.js');
const YARN_PATH = join(PACKAGE_ROOT, 'yarn', 'yarn.cjs');
const DEFAULT_GH_PROXY = 'https://ghfast.top/';
const DEFAULT_BOT_NAME = 'Miao-Yunzai';
const DEFAULT_YUNZAI_REPO = 'https://github.com/yoimiya-kokomi/Miao-Yunzai.git';
const DEFAULT_MIAO_PLUGIN_REPO = 'https://github.com/yoimiya-kokomi/miao-plugin.git';
const DEFAULT_EVENT_CONCURRENCY = 1;
function getConfig() {
    const values = getConfigValue() ?? {};
    return values['alemonjs-load-yunzai'] ?? {};
}
function getGhProxy() {
    return getConfig()?.gh_proxy ?? DEFAULT_GH_PROXY;
}
function getDefaultRepo() {
    const repo = getConfig()?.yunzai_repo ?? DEFAULT_YUNZAI_REPO;
    return `${getGhProxy()}${repo}`;
}
function getMiaoPluginRepo() {
    const repo = getConfig()?.miao_plugin_repo ?? DEFAULT_MIAO_PLUGIN_REPO;
    return `${getGhProxy()}${repo}`;
}
function getYunzaiEventConcurrency() {
    const value = Number(getConfig()?.event_concurrency ?? DEFAULT_EVENT_CONCURRENCY);
    if (!Number.isFinite(value)) {
        return DEFAULT_EVENT_CONCURRENCY;
    }
    return Math.min(4, Math.max(1, Math.floor(value)));
}
const BUILTIN_PLUGINS = [
    { aliases: ['miao', 'miaomiao', '原神'], dirName: 'miao-plugin', repoUrl: 'https://github.com/yoimiya-kokomi/miao-plugin.git', label: 'miao-plugin' },
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
function buildAliasMap(plugins) {
    const map = {};
    for (const { aliases, dirName, repoUrl, label } of plugins) {
        const info = { dirName, repoUrl, label };
        for (const alias of aliases) {
            map[alias] = info;
        }
    }
    return map;
}
const BUILTIN_PLUGIN_MAP = buildAliasMap(BUILTIN_PLUGINS);
function getPluginAliasMap() {
    const custom = getConfig()?.plugins ?? {};
    const merged = { ...BUILTIN_PLUGIN_MAP };
    for (const [alias, raw] of Object.entries(custom)) {
        if (raw && typeof raw === 'object' && raw.dirName && raw.repoUrl) {
            const info = {
                dirName: raw.dirName,
                repoUrl: raw.repoUrl,
                label: raw.label ?? raw.dirName
            };
            merged[alias.toLowerCase()] = info;
            const extraAliases = Array.isArray(raw.aliases) ? raw.aliases : [];
            for (const a of extraAliases) {
                if (typeof a === 'string' && a) {
                    merged[a.toLowerCase()] = info;
                }
            }
        }
    }
    return merged;
}
function getAllPlugins() {
    const result = [...BUILTIN_PLUGINS];
    const seen = new Set(result.map(p => p.dirName));
    const custom = getConfig()?.plugins ?? {};
    for (const [alias, raw] of Object.entries(custom)) {
        if (raw && typeof raw === 'object' && raw.dirName && raw.repoUrl) {
            const dirName = raw.dirName;
            if (seen.has(dirName)) {
                continue;
            }
            seen.add(dirName);
            const extraAliases = Array.isArray(raw.aliases) ? raw.aliases : [];
            result.push({
                dirName,
                repoUrl: raw.repoUrl,
                label: raw.label ?? dirName,
                aliases: [alias, ...extraAliases]
            });
        }
    }
    return result;
}
function getPluginInfo(alias) {
    return getPluginAliasMap()[alias.toLowerCase()];
}
function getYunzaiDir() {
    const botName = getConfig()?.bot_name ?? DEFAULT_BOT_NAME;
    return join(process.cwd(), botName);
}

export { PACKAGE_ROOT, WORKER_PATH, YARN_PATH, getAllPlugins, getDefaultRepo, getGhProxy, getMiaoPluginRepo, getPluginInfo, getYunzaiDir, getYunzaiEventConcurrency };
