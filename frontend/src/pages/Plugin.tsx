import { Button, Collapse, HeaderDiv, Input, Modal, NotificationDiv, PrimaryDiv, SecondaryDiv, TagDiv } from '@alemonjs/react-ui';
import { useEffect, useRef, useState } from 'react';
import { deletePluginArchiveEntry, extractPluginArchiveEntry, getPluginArchiveEntries, type PluginArchiveEntry, uploadPluginArchive } from '../api/web-api';
import { SmartDropdown } from './SmartDropdown';

interface PluginItem {
  name: string;
  installed: boolean;
  isGit: boolean;
}

interface CatalogItem {
  dirName: string;
  label: string;
  aliases: string[];
  repoUrl: string;
  installed: boolean;
}

interface OnlineCatalogItem {
  dirName: string;
  label: string;
  repoUrl: string;
  author: string;
  description: string;
  category: string;
  installed: boolean;
}

/** 插件图标映射 */
const PLUGIN_ICONS: Record<string, string> = {
  'miao-plugin': '🐱',
  'StarRail-plugin': '🚂',
  'ZZZ-Plugin': '🎮',
  'xiaoyao-cvs-plugin': '📚',
  'guoba-plugin': '🍢',
  'liangshi-calc': '🧮',
  'endfield-suzuki-plugin': '🏗️',
  'zmd-plugin': '🌍',
  'delta-force-plugin': '🔺',
  'GloryOfKings-Plugin': '👑',
  'cb-plugin': '🛡️',
  'waves-plugin': '🌊',
  '1999-plugin': '⏳',
  'Yunzai-Kuro-Plugin': '🎯',
  'Tlon-Sky': '☁️'
};

/** 插件简短描述 */
const PLUGIN_DESC: Record<string, string> = {
  'miao-plugin': '原神面板查询、角色攻略、伤害计算等',
  'StarRail-plugin': '崩坏：星穹铁道攻略与数据查询',
  'ZZZ-Plugin': '绝区零游戏数据查询',
  'xiaoyao-cvs-plugin': '原神/星铁/绝区零图鉴查询',
  'guoba-plugin': 'Yunzai 后台管理面板',
  'liangshi-calc': '喵喵面板扩展与练度计算',
  'endfield-suzuki-plugin': '明日方舟：终末地数据查询',
  'zmd-plugin': '终末地游戏数据查询',
  'delta-force-plugin': '三角洲行动游戏数据查询',
  'GloryOfKings-Plugin': '王者荣耀数据与战绩查询',
  'cb-plugin': '尘白禁区游戏数据查询',
  'waves-plugin': '鸣潮游戏数据查询',
  '1999-plugin': '重返未来 1999 游戏数据',
  'Yunzai-Kuro-Plugin': '库洛游戏通用插件',
  'Tlon-Sky': '光遇游戏数据查询'
};

const RECOMMENDED_GROUP_LABELS: Record<string, string> = {
  game: '🎮 游戏数据',
  panel: '📊 面板图鉴',
  tool: '🛠️ 工具管理',
  other: '🧩 其他推荐'
};

interface PluginState {
  installed: boolean;
  pureEdition: boolean;
  busy: boolean;
  plugins: PluginItem[];
  catalog: CatalogItem[];
  onlineCatalog: OnlineCatalogItem[];
}

const ONLINE_PLUGIN_CACHE_KEY = 'alemonjs-load-yunzai:online-plugins';
const MAX_PLUGIN_ARCHIVE_SIZE_MB = 2048;

function readOnlinePluginCache(): OnlineCatalogItem[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(ONLINE_PLUGIN_CACHE_KEY);

    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as { data?: OnlineCatalogItem[] } | OnlineCatalogItem[];
    const data = Array.isArray(parsed) ? parsed : parsed.data;

    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeOnlinePluginCache(data: OnlineCatalogItem[]): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(
      ONLINE_PLUGIN_CACHE_KEY,
      JSON.stringify({
        cachedAt: Date.now(),
        data
      })
    );
  } catch {}
}

function applyInstalledFlags(items: OnlineCatalogItem[], plugins: PluginItem[]): OnlineCatalogItem[] {
  const installedSet = new Set(plugins.map(item => item.name));

  return items.map(item => ({
    ...item,
    installed: installedSet.has(item.dirName)
  }));
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button
      type='button'
      className={`px-3 py-1 text-[11px] rounded-lg font-medium ${active ? 'opacity-100' : 'opacity-45 hover:opacity-70'}`}
      style={active ? { background: 'var(--alemonjs-primary-bg, rgba(128,128,128,.1))' } : undefined}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function getRecommendedGroup(dirName: string): keyof typeof RECOMMENDED_GROUP_LABELS {
  if (['xiaoyao-cvs-plugin', 'liangshi-calc'].includes(dirName)) {
    return 'panel';
  }

  if (['guoba-plugin'].includes(dirName)) {
    return 'tool';
  }

  if (
    [
      'StarRail-plugin',
      'ZZZ-Plugin',
      'endfield-suzuki-plugin',
      'zmd-plugin',
      'delta-force-plugin',
      'GloryOfKings-Plugin',
      'cb-plugin',
      'waves-plugin',
      '1999-plugin',
      'Yunzai-Kuro-Plugin',
      'Tlon-Sky'
    ].includes(dirName)
  ) {
    return 'game';
  }

  return 'other';
}

const formatSize = (bytes: number) => {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const formatTime = (timestamp: number | null) => (timestamp ? new Date(timestamp).toLocaleString() : '—');

export default function Plugin() {
  const isDesktopRuntime = window.__ALEMONJS_RUNTIME_MODE__ === 'desktop';
  const cachedOnlineCatalog = readOnlinePluginCache();
  const [state, setState] = useState<PluginState>({
    installed: false,
    pureEdition: false,
    busy: false,
    plugins: [],
    catalog: [],
    onlineCatalog: cachedOnlineCatalog
  });
  const [loading, setLoading] = useState('');
  const [message, setMessage] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [uploadDirName, setUploadDirName] = useState('');
  const [archiveFile, setArchiveFile] = useState<File | null>(null);
  const [pluginArchives, setPluginArchives] = useState<PluginArchiveEntry[]>([]);
  const [archiveLoading, setArchiveLoading] = useState('');
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [isArchiveDragActive, setIsArchiveDragActive] = useState(false);
  const [onlineKeyword, setOnlineKeyword] = useState('');
  const [pluginTab, setPluginTab] = useState<'required' | 'installed' | 'catalog' | 'online' | 'custom'>('required');
  const [confirmAction, setConfirmAction] = useState<{ action: string; label: string; extra?: Record<string, string> } | null>(null);
  const [lastAction, setLastAction] = useState('');
  const archiveInputRef = useRef<HTMLInputElement>(null);

  const showMessage = (msg: string) => {
    setMessage(msg);
    setTimeout(() => setMessage(''), 4000);
  };

  useEffect(() => {
    if (!window.API) {
      return;
    }

    const handler = (data: Record<string, unknown>) => {
      if (data.type === 'yunzai.status') {
        const d = data.data as Record<string, unknown>;
        const plugins = (d.plugins as PluginItem[]) ?? [];
        const onlineCatalogPayload = (d.onlineCatalog as OnlineCatalogItem[]) ?? [];
        const onlineCatalog = onlineCatalogPayload.length > 0 ? onlineCatalogPayload : applyInstalledFlags(readOnlinePluginCache(), plugins);

        if (onlineCatalogPayload.length > 0) {
          writeOnlinePluginCache(onlineCatalogPayload);
        }

        setState({
          installed: d.installed as boolean,
          pureEdition: d.pureEdition === true,
          busy: d.busy as boolean,
          plugins,
          catalog: (d.catalog as CatalogItem[]) ?? [],
          onlineCatalog
        });
        if (!(d.busy as boolean)) {
          setLoading('');
        }
      } else if (data.type === 'yunzai.result') {
        showMessage((data.data as Record<string, string>)?.message ?? '操作完成');
      }
    };

    const dispose = window.API.onMessage(handler);

    window.API.postMessage({ type: 'yunzai.status.subscribe' });

    return () => {
      window.API.postMessage({ type: 'yunzai.status.unsubscribe' });
      dispose();
    };
  }, []);

  const sendAction = (action: string, label: string, extra?: Record<string, string>) => {
    if (loading || isDesktopRuntime) {
      return;
    }
    setLoading(label);
    setLastAction(action);
    window.API.postMessage({ type: 'yunzai.action', data: { action, ...extra } });
  };

  const dangerAction = (action: string, label: string, extra?: Record<string, string>) => {
    setConfirmAction({ action, label, extra });
  };

  const confirmDanger = () => {
    if (!confirmAction) {
      return;
    }
    sendAction(confirmAction.action, confirmAction.label, confirmAction.extra);
    setConfirmAction(null);
  };

  const handleInstallUrl = () => {
    const val = customUrl.trim();

    if (!val) {
      return;
    }
    sendAction('install_plugin', `安装 ${val}`, { plugin: val });
    setCustomUrl('');
  };

  const refreshPluginArchives = async () => {
    if (isDesktopRuntime) {
      return;
    }

    try {
      setPluginArchives(await getPluginArchiveEntries());
    } catch (err: any) {
      showMessage(err?.message ?? '无法读取插件压缩包列表');
    }
  };

  useEffect(() => {
    void refreshPluginArchives();
  }, [isDesktopRuntime]);

  useEffect(() => {
    const preventBrowserDrop = (event: DragEvent) => event.preventDefault();

    window.addEventListener('dragover', preventBrowserDrop);
    window.addEventListener('drop', preventBrowserDrop);

    return () => {
      window.removeEventListener('dragover', preventBrowserDrop);
      window.removeEventListener('drop', preventBrowserDrop);
    };
  }, []);

  const uploadArchiveFile = async (file: File) => {
    if (archiveLoading || isDesktopRuntime) {
      return;
    }

    setArchiveFile(file);
    setArchiveLoading('upload');
    setUploadProgress(0);
    try {
      const list = await uploadPluginArchive(file, uploadDirName, setUploadProgress);

      setPluginArchives(list);
      setUploadDirName('');
      showMessage('插件压缩包已保存，可在列表中点击「解压安装」');
    } catch (err: any) {
      showMessage(err?.message ?? '压缩包上传失败');
    } finally {
      setArchiveLoading('');
      setUploadProgress(null);
      setArchiveFile(null);
      if (archiveInputRef.current) {
        archiveInputRef.current.value = '';
      }
    }
  };

  const selectArchiveFile = (file: File | null) => {
    if (!file) {
      return;
    }
    if (!/\.zip$/i.test(file.name)) {
      showMessage('仅支持上传 .zip 压缩包');

      return;
    }
    if (file.size > MAX_PLUGIN_ARCHIVE_SIZE_MB * 1024 * 1024) {
      showMessage(`压缩包过大，当前最大支持 ${MAX_PLUGIN_ARCHIVE_SIZE_MB}MB`);

      return;
    }

    void uploadArchiveFile(file);
  };

  const handleArchiveExtract = async (id: string) => {
    if (archiveLoading || isDesktopRuntime) {
      return;
    }

    setArchiveLoading(id);
    try {
      const list = await extractPluginArchiveEntry(id);

      setPluginArchives(list);
      showMessage('插件压缩包解压安装完成');
      window.API.postMessage({ type: 'yunzai.status' });
    } catch (err: any) {
      showMessage(err?.message ?? '插件压缩包解压失败');
    } finally {
      setArchiveLoading('');
    }
  };

  const handleArchiveDelete = async (id: string) => {
    if (archiveLoading || isDesktopRuntime) {
      return;
    }

    setArchiveLoading(id);
    try {
      setPluginArchives(await deletePluginArchiveEntry(id));
      showMessage('插件压缩包记录已删除');
    } catch (err: any) {
      showMessage(err?.message ?? '删除失败');
    } finally {
      setArchiveLoading('');
    }
  };

  const isDisabled = !!loading || state.busy || isDesktopRuntime;
  const busyLabel = loading || (state.busy ? '处理中...' : '') || (lastAction ? `${lastAction}中...` : '处理中...');
  const requiredPlugin = state.catalog.find(item => item.dirName === 'miao-plugin') ?? null;
  const requiredInstalledPlugin = state.plugins.find(item => item.name === 'miao-plugin') ?? null;

  // 分组：目录内已安装 / 目录内未安装
  const catalogInstalled = state.catalog.filter(c => c.installed);
  const catalogNotInstalled = state.catalog.filter(c => !c.installed && c.dirName !== 'miao-plugin');
  const onlineCatalogInstalled = new Set(state.onlineCatalog.filter(item => item.installed).map(item => item.repoUrl));
  const onlineFiltered = state.onlineCatalog.filter(item => {
    if (item.installed || onlineCatalogInstalled.has(item.repoUrl)) {
      return false;
    }

    const keyword = onlineKeyword.trim().toLowerCase();

    if (!keyword) {
      return true;
    }

    return [item.label, item.dirName, item.author, item.description, item.category, item.repoUrl].some(field => field.toLowerCase().includes(keyword));
  });

  // 已安装但不在插件目录中的（用户自己装的）
  const catalogDirNames = new Set(state.catalog.map(c => c.dirName));
  const extraInstalled = state.plugins.filter(p => !catalogDirNames.has(p.name));
  const installedPluginMap = new Map(state.plugins.map(item => [item.name, item]));
  const recommendedGroups = Object.entries(
    catalogNotInstalled.reduce<Record<string, CatalogItem[]>>((acc, item) => {
      const group = getRecommendedGroup(item.dirName);

      if (!acc[group]) {
        acc[group] = [];
      }
      acc[group].push(item);

      return acc;
    }, {})
  );
  const onlineGroups = Object.entries(
    onlineFiltered.reduce<Record<string, OnlineCatalogItem[]>>((acc, item) => {
      if (!acc[item.category]) {
        acc[item.category] = [];
      }
      acc[item.category].push(item);

      return acc;
    }, {})
  );

  if (!state.installed) {
    return (
      <div className='py-2'>
        <PrimaryDiv className='rounded-xl p-6 text-center space-y-2'>
          <div className='text-2xl'>📦</div>
          <div className='text-sm opacity-50'>请先在管理页安装 Yunzai</div>
        </PrimaryDiv>
      </div>
    );
  }

  return (
    <div className='py-2 space-y-3'>
      {isDesktopRuntime && (
        <PrimaryDiv className='rounded-xl px-4 py-3 text-[12px]' style={{ background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.16)' }}>
          当前 desktop 链路仅同步机器人状态，不提供插件安装、更新或卸载操作。
        </PrimaryDiv>
      )}
      {/* ── 通知 ── */}
      {message && <NotificationDiv className='rounded-xl px-4 py-3 text-sm animate-fade-in shadow-sm'>{message}</NotificationDiv>}

      {/* ── 进行中 ── */}
      {(loading || state.busy) && (
        <PrimaryDiv className='rounded-xl px-4 py-3.5 flex items-center justify-between animate-fade-in'>
          <div className='flex items-center gap-2.5'>
            <div className='w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin opacity-50' />
            <span className='text-sm font-medium opacity-70'>{busyLabel}</span>
          </div>
        </PrimaryDiv>
      )}

      <SecondaryDiv className='rounded-xl overflow-hidden'>
        <HeaderDiv className='px-4 py-2.5 flex flex-wrap items-center justify-between gap-3'>
          <div className='flex items-center gap-2 min-w-0'>
            <span className='text-sm font-semibold'>🧩 插件分类</span>
          </div>
          <div className='flex flex-wrap items-center gap-2'>
            <TabBtn active={pluginTab === 'required'} onClick={() => setPluginTab('required')}>
              必装插件
            </TabBtn>
            <TabBtn active={pluginTab === 'installed'} onClick={() => setPluginTab('installed')}>
              已安装
            </TabBtn>
            <TabBtn active={pluginTab === 'catalog'} onClick={() => setPluginTab('catalog')}>
              推荐插件
            </TabBtn>
            <TabBtn active={pluginTab === 'online'} onClick={() => setPluginTab('online')}>
              在线插件
            </TabBtn>
            <TabBtn active={pluginTab === 'custom'} onClick={() => setPluginTab('custom')}>
              自定义安装
            </TabBtn>
          </div>
        </HeaderDiv>
      </SecondaryDiv>

      {pluginTab === 'required' && requiredPlugin && (
        <SecondaryDiv className='rounded-xl overflow-hidden'>
          <HeaderDiv className='px-4 py-2.5 flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <span className='text-sm font-semibold'>{state.pureEdition ? '🐱 可选增强插件' : '🐱 必装插件'}</span>
              <TagDiv className='px-2 py-0.5 rounded-full text-[10px]'>{requiredPlugin.installed ? '已安装' : '未安装'}</TagDiv>
            </div>
          </HeaderDiv>
          <PrimaryDiv className='px-4 py-4 space-y-3'>
            <div
              className='rounded-xl px-4 py-3 text-[12px]'
              style={{
                background: requiredPlugin.installed ? 'rgba(34,197,94,.08)' : 'rgba(245,158,11,.08)',
                border: requiredPlugin.installed ? '1px solid rgba(34,197,94,.15)' : '1px solid rgba(245,158,11,.18)'
              }}
            >
              {state.pureEdition
                ? requiredPlugin.installed
                  ? '当前为 Miao-Yunzai 纯净版。miao-plugin 已安装，将作为可选增强插件提供扩展能力。'
                  : '当前为 Miao-Yunzai 纯净版。miao-plugin 为可选插件，未安装时相关扩展能力会降级，但宿主仍可正常启动。'
                : requiredPlugin.installed
                  ? 'miao-plugin 已安装。该插件被视为核心依赖，建议保留并优先维护。'
                  : 'miao-plugin 被视为必装插件。未安装时，部分能力可能出现异常或不可用。'}
            </div>

            <div className='flex items-start gap-3'>
              <div className='w-10 h-10 rounded-xl flex items-center justify-center text-lg shrink-0' style={{ background: 'rgba(128,128,128,.06)' }}>
                {PLUGIN_ICONS[requiredPlugin.dirName] ?? '🐱'}
              </div>
              <div className='flex-1 min-w-0'>
                <div className='flex items-center gap-2'>
                  <span className='text-[13px] font-semibold truncate'>{requiredPlugin.label}</span>
                  {requiredPlugin.installed && <span className='shrink-0 w-1.5 h-1.5 rounded-full bg-green-500' title='已安装' />}
                </div>
                <div className='text-[11px] opacity-40 mt-0.5'>{PLUGIN_DESC[requiredPlugin.dirName] ?? requiredPlugin.aliases.join(' / ')}</div>
                <div className='flex items-center gap-1.5 mt-2'>
                  {!requiredPlugin.installed && (
                    <Button
                      className='px-3 py-1 text-[11px] rounded-lg font-medium'
                      onClick={() => sendAction('install_plugin', `安装 ${requiredPlugin.label}`, { plugin: requiredPlugin.aliases[0] })}
                      disabled={isDisabled}
                      style={{ background: 'linear-gradient(135deg, #d5c8b2 0%, #8f8c76 100%)' }}
                    >
                      立即安装
                    </Button>
                  )}
                  {requiredPlugin.installed && (
                    <>
                      {requiredInstalledPlugin?.isGit && (
                        <Button
                          className='px-2.5 py-1 text-[11px] rounded-lg font-medium'
                          onClick={() => sendAction('update_plugin', `更新 ${requiredPlugin.label}`, { plugin: requiredPlugin.dirName })}
                          disabled={isDisabled}
                        >
                          更新
                        </Button>
                      )}
                      <SmartDropdown
                        buttons={[
                          ...(requiredInstalledPlugin?.isGit
                            ? [
                                {
                                  children: '强制更新',
                                  onClick: () => sendAction('force_update_plugin', `强制更新 ${requiredPlugin.label}`, { plugin: requiredPlugin.dirName }),
                                  disabled: isDisabled
                                }
                              ]
                            : []),
                          {
                            children: '卸载',
                            onClick: () => dangerAction('uninstall_plugin', `卸载 ${requiredPlugin.label}`, { plugin: requiredPlugin.dirName }),
                            disabled: isDisabled,
                            className: 'text-red-400'
                          }
                        ]}
                      >
                        <Button className='px-2 py-1 text-[11px] rounded-lg'>···</Button>
                      </SmartDropdown>
                    </>
                  )}
                </div>
              </div>
            </div>
          </PrimaryDiv>
        </SecondaryDiv>
      )}

      {/* ── 已安装插件 ── */}
      {pluginTab === 'installed' && (catalogInstalled.length > 0 || extraInstalled.length > 0) && (
        <SecondaryDiv className='rounded-xl overflow-hidden'>
          <HeaderDiv className='px-4 py-2.5 flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <span className='text-sm font-semibold'>✅ 已安装</span>
              <TagDiv className='px-2 py-0.5 rounded-full text-[10px]'>{catalogInstalled.length + extraInstalled.length}</TagDiv>
            </div>
          </HeaderDiv>
          <Collapse
            items={[
              ...(catalogInstalled.length > 0
                ? [
                    {
                      key: 'installed-builtin',
                      label: `🧱 内置已装 · ${catalogInstalled.length}`,
                      children: (
                        <div className='grid grid-cols-1 xl:grid-cols-2 gap-px' style={{ background: 'rgba(128,128,128,.06)' }}>
                          {catalogInstalled.map(p => {
                            const installedPlugin = installedPluginMap.get(p.dirName);
                            const canUpdate = Boolean(installedPlugin?.isGit);

                            return (
                              <PrimaryDiv key={p.dirName} className='px-4 py-3 flex items-start gap-3'>
                                <div
                                  className='w-9 h-9 rounded-xl flex items-center justify-center text-lg shrink-0'
                                  style={{ background: 'rgba(128,128,128,.06)' }}
                                >
                                  {PLUGIN_ICONS[p.dirName] ?? '🧩'}
                                </div>
                                <div className='flex-1 min-w-0'>
                                  <div className='flex items-center gap-2'>
                                    <span className='text-[13px] font-semibold truncate'>{p.label}</span>
                                    <span className='shrink-0 w-1.5 h-1.5 rounded-full bg-green-500' title='已安装' />
                                  </div>
                                  <div className='text-[11px] opacity-40 mt-0.5 line-clamp-1'>{PLUGIN_DESC[p.dirName] ?? p.aliases.join(' / ')}</div>
                                  <div className='flex items-center gap-1.5 mt-1.5'>
                                    {canUpdate && (
                                      <Button
                                        className='px-2.5 py-1 text-[11px] rounded-lg font-medium'
                                        onClick={() => sendAction('update_plugin', `更新 ${p.label}`, { plugin: p.dirName })}
                                        disabled={isDisabled}
                                      >
                                        更新
                                      </Button>
                                    )}
                                    <SmartDropdown
                                      buttons={[
                                        ...(canUpdate
                                          ? [
                                              {
                                                children: '强制更新',
                                                onClick: () => sendAction('force_update_plugin', `强制更新 ${p.label}`, { plugin: p.dirName }),
                                                disabled: isDisabled
                                              }
                                            ]
                                          : []),
                                        {
                                          children: '卸载',
                                          onClick: () => dangerAction('uninstall_plugin', `卸载 ${p.label}`, { plugin: p.dirName }),
                                          disabled: isDisabled,
                                          className: 'text-red-400'
                                        }
                                      ]}
                                    >
                                      <Button className='px-2 py-1 text-[11px] rounded-lg'>···</Button>
                                    </SmartDropdown>
                                  </div>
                                </div>
                              </PrimaryDiv>
                            );
                          })}
                        </div>
                      )
                    }
                  ]
                : []),
              ...(extraInstalled.length > 0
                ? [
                    {
                      key: 'installed-third-party',
                      label: `🔗 第三方已装 · ${extraInstalled.length}`,
                      children: (
                        <div className='grid grid-cols-1 xl:grid-cols-2 gap-px' style={{ background: 'rgba(128,128,128,.06)' }}>
                          {extraInstalled.map(p => (
                            <PrimaryDiv key={p.name} className='px-4 py-3 flex items-start gap-3'>
                              <div
                                className='w-9 h-9 rounded-xl flex items-center justify-center text-lg shrink-0'
                                style={{ background: 'rgba(128,128,128,.06)' }}
                              >
                                🧩
                              </div>
                              <div className='flex-1 min-w-0'>
                                <div className='flex items-center gap-2'>
                                  <span className='text-[13px] font-semibold truncate'>{p.name}</span>
                                  <span className='shrink-0 w-1.5 h-1.5 rounded-full bg-green-500' title='已安装' />
                                </div>
                                <div className='text-[11px] opacity-40 mt-0.5 line-clamp-1'>第三方插件</div>
                                <div className='flex items-center gap-1.5 mt-1.5'>
                                  {p.isGit && (
                                    <Button
                                      className='px-2.5 py-1 text-[11px] rounded-lg font-medium'
                                      onClick={() => sendAction('update_plugin', `更新 ${p.name}`, { plugin: p.name })}
                                      disabled={isDisabled}
                                    >
                                      更新
                                    </Button>
                                  )}
                                  <SmartDropdown
                                    buttons={[
                                      ...(p.isGit
                                        ? [
                                            {
                                              children: '强制更新',
                                              onClick: () => sendAction('force_update_plugin', `强制更新 ${p.name}`, { plugin: p.name }),
                                              disabled: isDisabled
                                            }
                                          ]
                                        : []),
                                      {
                                        children: '卸载',
                                        onClick: () => dangerAction('uninstall_plugin', `卸载 ${p.name}`, { plugin: p.name }),
                                        disabled: isDisabled,
                                        className: 'text-red-400'
                                      }
                                    ]}
                                  >
                                    <Button className='px-2 py-1 text-[11px] rounded-lg'>···</Button>
                                  </SmartDropdown>
                                </div>
                              </div>
                            </PrimaryDiv>
                          ))}
                        </div>
                      )
                    }
                  ]
                : [])
            ]}
          />
        </SecondaryDiv>
      )}

      {pluginTab === 'installed' && catalogInstalled.length === 0 && extraInstalled.length === 0 && (
        <PrimaryDiv className='rounded-xl px-4 py-6 text-center'>
          <div className='text-sm opacity-40'>当前还没有已安装插件</div>
        </PrimaryDiv>
      )}

      {/* ── 未安装插件 ── */}
      {pluginTab === 'catalog' && catalogNotInstalled.length > 0 && (
        <SecondaryDiv className='rounded-xl overflow-hidden'>
          <HeaderDiv className='px-4 py-2.5 flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <span className='text-sm font-semibold'>🏪 推荐插件</span>
              <TagDiv className='px-2 py-0.5 rounded-full text-[10px]'>{catalogNotInstalled.length}</TagDiv>
            </div>
          </HeaderDiv>
          <Collapse
            items={recommendedGroups.map(([group, items]) => ({
              key: `recommended-${group}`,
              label: `${RECOMMENDED_GROUP_LABELS[group] ?? group} · ${items.length}`,
              children: (
                <div className='grid grid-cols-1 xl:grid-cols-2 gap-px' style={{ background: 'rgba(128,128,128,.06)' }}>
                  {items.map(p => (
                    <PrimaryDiv key={p.dirName} className='px-4 py-3 flex items-start gap-3'>
                      <div className='w-9 h-9 rounded-xl flex items-center justify-center text-lg shrink-0' style={{ background: 'rgba(128,128,128,.06)' }}>
                        {PLUGIN_ICONS[p.dirName] ?? '🧩'}
                      </div>
                      <div className='flex-1 min-w-0'>
                        <div className='flex items-center gap-2'>
                          <span className='text-[13px] font-semibold truncate'>{p.label}</span>
                        </div>
                        <div className='text-[11px] opacity-40 mt-0.5 line-clamp-1'>{PLUGIN_DESC[p.dirName] ?? p.aliases.join(' / ')}</div>
                        <div className='flex items-center gap-1.5 mt-1.5'>
                          <Button
                            className='px-3 py-1 text-[11px] rounded-lg font-medium'
                            onClick={() => sendAction('install_plugin', `安装 ${p.label}`, { plugin: p.aliases[0] })}
                            disabled={isDisabled}
                            style={{ background: 'linear-gradient(135deg, #d5c8b2 0%, #8f8c76 100%)' }}
                          >
                            安装
                          </Button>
                        </div>
                      </div>
                    </PrimaryDiv>
                  ))}
                </div>
              )
            }))}
          />
        </SecondaryDiv>
      )}

      {pluginTab === 'catalog' && catalogNotInstalled.length === 0 && (
        <PrimaryDiv className='rounded-xl px-4 py-6 text-center'>
          <div className='text-sm opacity-40'>推荐插件都已经安装了</div>
        </PrimaryDiv>
      )}

      {/* ── 在线插件索引 ── */}
      {pluginTab === 'online' && (
        <SecondaryDiv className='rounded-xl overflow-hidden'>
          <HeaderDiv className='px-4 py-2.5 flex flex-wrap items-center justify-between gap-3'>
            <div className='flex items-center gap-2 min-w-0'>
              <span className='text-sm font-semibold'>🌐 在线选插件</span>
              <TagDiv className='px-2 py-0.5 rounded-full text-[10px]'>{onlineFiltered.length}</TagDiv>
            </div>
            <Input
              type='text'
              value={onlineKeyword}
              onChange={e => setOnlineKeyword(e.target.value)}
              placeholder='搜索名称、作者、分类、仓库'
              className='w-[220px] max-w-full px-3 py-1.5 text-xs rounded-xl'
            />
          </HeaderDiv>
          {onlineFiltered.length === 0 ? (
            <PrimaryDiv className='px-4 py-4 text-center'>
              <div className='text-sm opacity-40'>没有匹配到可安装的在线插件</div>
              <div className='text-[11px] opacity-25 mt-1'>已自动过滤已安装插件，数据源来自 Yunzai-Bot-plugins-index</div>
            </PrimaryDiv>
          ) : (
            <Collapse
              items={onlineGroups.map(([category, items]) => ({
                key: `online-${category}`,
                label: `${category} · ${items.length}`,
                children: (
                  <div className='grid grid-cols-1 xl:grid-cols-2 gap-px' style={{ background: 'rgba(128,128,128,.06)' }}>
                    {items.map(item => (
                      <PrimaryDiv key={`${item.repoUrl}-${item.category}`} className='px-4 py-3 flex items-start gap-3'>
                        <div className='w-9 h-9 rounded-xl flex items-center justify-center text-lg shrink-0' style={{ background: 'rgba(128,128,128,.06)' }}>
                          {PLUGIN_ICONS[item.dirName] ?? '🌐'}
                        </div>
                        <div className='flex-1 min-w-0'>
                          <div className='flex items-center gap-2 flex-wrap'>
                            <span className='text-[13px] font-semibold truncate'>{item.label}</span>
                            <TagDiv className='px-2 py-0.5 rounded-full text-[10px]'>{item.category}</TagDiv>
                          </div>
                          <div className='text-[11px] opacity-45 mt-0.5 line-clamp-1'>{item.description || item.repoUrl}</div>
                          <div className='text-[10px] opacity-30 mt-1'>
                            作者: {item.author || '未知'} · {item.dirName}
                          </div>
                          <div className='flex items-center gap-1.5 mt-2'>
                            <Button
                              className='px-3 py-1 text-[11px] rounded-lg font-medium'
                              onClick={() => sendAction('install_plugin', `安装 ${item.label}`, { plugin: item.repoUrl })}
                              disabled={isDisabled}
                              style={{ background: 'linear-gradient(135deg, #d5c8b2 0%, #8f8c76 100%)' }}
                            >
                              安装
                            </Button>
                          </div>
                        </div>
                      </PrimaryDiv>
                    ))}
                  </div>
                )
              }))}
            />
          )}
        </SecondaryDiv>
      )}

      {/* ── 自定义安装 ── */}
      {pluginTab === 'custom' && (
        <div className='space-y-3'>
          <SecondaryDiv className='rounded-xl overflow-hidden'>
            <HeaderDiv className='px-4 py-2.5 flex items-center justify-between'>
              <span className='text-sm font-semibold'>🔗 通过 URL 安装</span>
            </HeaderDiv>
            <PrimaryDiv className='px-4 py-3'>
              <div className='text-[11px] opacity-40 mb-2'>输入 Git 仓库地址安装第三方插件</div>
              <div className='flex gap-2'>
                <Input
                  type='text'
                  value={customUrl}
                  onChange={e => setCustomUrl(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleInstallUrl()}
                  placeholder='https://github.com/xxx/xxx-plugin.git'
                  className='flex-1 px-3 py-1.5 text-sm rounded-xl'
                />
                <Button className='px-4 py-1.5 rounded-xl text-sm font-medium' onClick={handleInstallUrl} disabled={isDisabled || !customUrl.trim()}>
                  安装
                </Button>
              </div>
            </PrimaryDiv>
          </SecondaryDiv>

          <SecondaryDiv className='rounded-xl overflow-hidden'>
            <HeaderDiv className='px-4 py-2.5 flex items-center justify-between'>
              <div className='flex items-center gap-2'>
                <span className='text-sm font-semibold'>📦 插件压缩包</span>
                <TagDiv className='px-2 py-0.5 rounded-full text-[10px]'>{pluginArchives.length}</TagDiv>
              </div>
            </HeaderDiv>
            <PrimaryDiv className='px-4 py-3 space-y-3'>
              <div className='text-[11px] opacity-45'>
                上传 ZIP 保存到压缩包列表，再点击「解压安装」写入 plugins/；支持反复解压覆盖已有文件。解压时需先停止 Yunzai。
              </div>

              <div>
                <div className='text-[11px] opacity-45 mb-1'>目标目录名（可选）</div>
                <Input
                  type='text'
                  value={uploadDirName}
                  onChange={e => setUploadDirName(e.target.value)}
                  placeholder='留空自动识别压缩包内插件目录'
                  className='w-full px-3 py-1.5 text-sm rounded-lg'
                />
                <div className='text-[10px] opacity-35 mt-1'>不填写时，将优先使用压缩包内顶层目录名，其次使用 ZIP 文件名。</div>
              </div>

              <input
                ref={archiveInputRef}
                type='file'
                accept='.zip,application/zip,application/x-zip-compressed'
                className='sr-only'
                onChange={event => selectArchiveFile(event.target.files?.[0] ?? null)}
              />
              <div
                role='button'
                tabIndex={0}
                className={`block rounded-lg border border-dashed px-3 py-4 text-center cursor-pointer transition-opacity ${isArchiveDragActive ? 'border-current opacity-100' : 'border-current/20 hover:opacity-80'}`}
                onClick={() => archiveInputRef.current?.click()}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    archiveInputRef.current?.click();
                  }
                }}
                onDragEnter={event => {
                  event.preventDefault();
                  setIsArchiveDragActive(true);
                }}
                onDragOver={event => event.preventDefault()}
                onDragLeave={event => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setIsArchiveDragActive(false);
                  }
                }}
                onDrop={event => {
                  event.preventDefault();
                  setIsArchiveDragActive(false);
                  selectArchiveFile(event.dataTransfer.files?.[0] ?? null);
                }}
              >
                <div className='text-sm font-medium'>
                  {archiveLoading === 'upload'
                    ? `正在上传 ${archiveFile?.name ?? ''}`
                    : isArchiveDragActive
                      ? '松开以立即上传 ZIP 压缩包'
                      : '选择或拖入插件 ZIP 压缩包'}
                </div>
                <div className='text-[11px] opacity-45 mt-1'>选择或拖入后会立即上传；最大 {MAX_PLUGIN_ARCHIVE_SIZE_MB}MB，每次上传都会追加到压缩包列表</div>
              </div>

              {uploadProgress !== null && (
                <div className='space-y-1'>
                  <div className='flex justify-between text-[11px] opacity-60'>
                    <span>上传中</span>
                    <span>{uploadProgress}%</span>
                  </div>
                  <div className='h-1.5 rounded-full overflow-hidden bg-current/10' aria-label={`上传进度 ${uploadProgress}%`}>
                    <div
                      className='h-full rounded-full transition-[width] duration-150'
                      style={{ width: `${uploadProgress}%`, background: 'var(--alemonjs-primary-bg, currentColor)' }}
                    />
                  </div>
                </div>
              )}

              {pluginArchives.length === 0 ? (
                <div className='text-[11px] opacity-45'>尚未上传插件压缩包。上传后可在列表中解压安装。</div>
              ) : (
                <div className='space-y-2'>
                  {pluginArchives.map(entry => (
                    <div
                      key={entry.id}
                      className='rounded-lg px-3 py-2 text-[11px] space-y-1'
                      style={{ background: 'var(--alemonjs-primary-bg, rgba(128,128,128,.08))' }}
                    >
                      <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
                        <span className='font-medium'>{entry.originalName}</span>
                        <span className='opacity-50'>{formatSize(entry.size)}</span>
                        <span className='opacity-50'>上传于 {formatTime(entry.uploadedAt)}</span>
                        <span className='opacity-50'>目录: {entry.dirName || '自动识别'}</span>
                        <div className='ml-auto flex items-center gap-1.5'>
                          <Button
                            type='button'
                            className='px-2.5 py-1 rounded-lg text-[11px] font-medium'
                            onClick={() => void handleArchiveExtract(entry.id)}
                            disabled={!!archiveLoading || isDisabled}
                          >
                            {archiveLoading === entry.id ? '处理中...' : entry.extracted ? '重新解压' : '解压安装'}
                          </Button>
                          <Button
                            type='button'
                            className='px-2 py-0.5 text-[10px] rounded text-red-400'
                            onClick={() => void handleArchiveDelete(entry.id)}
                            disabled={!!archiveLoading}
                          >
                            删除
                          </Button>
                        </div>
                      </div>
                      <div className={entry.extracted ? 'text-emerald-500' : 'text-amber-500'}>
                        {entry.extracted ? `✓ 已解压安装（${formatTime(entry.extractedAt)}）` : '○ 尚未解压'}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </PrimaryDiv>
          </SecondaryDiv>
        </div>
      )}

      {/* ── 确认弹窗 ── */}
      <Modal isOpen={!!confirmAction} onClose={() => setConfirmAction(null)}>
        <div className='p-6 space-y-5'>
          <div className='text-base font-semibold'>⚠️ 确认操作</div>
          <div className='text-sm opacity-60 leading-relaxed'>确定要{confirmAction?.label}吗？此操作不可撤销。</div>
          <div className='flex gap-2.5 justify-end'>
            <Button className='px-5 py-2 rounded-xl text-sm font-medium' onClick={() => setConfirmAction(null)}>
              取消
            </Button>
            <Button className='px-5 py-2 rounded-xl text-sm font-medium bg-red-500/20 hover:bg-red-500/30' onClick={confirmDanger}>
              确认
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
