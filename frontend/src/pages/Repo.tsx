import { Button, HeaderDiv, Input, PrimaryDiv, SecondaryDiv, Select, TagDiv, Tooltip } from '@alemonjs/react-ui';
import React, { useEffect, useRef, useState } from 'react';
import {
  extractRepositoryArchive,
  getRepositoryArchiveStatuses,
  repairRepositoryArchiveOrigin,
  type RepositoryArchiveStatus,
  type RepositoryArchiveTarget,
  uploadRepositoryArchive
} from '../api/web-api';

interface PluginEntry {
  key: string;
  dirName: string;
  repoUrl: string;
  label: string;
  aliases: string;
}

const INITIAL = {
  master_key: '',
  master_id: '',
  gh_proxy: '',
  bot_name: '',
  yunzai_repo: '',
  miao_plugin_repo: ''
};

const MAX_REPOSITORY_ARCHIVE_SIZE_MB = 2048;
const ARCHIVE_TARGETS: Record<RepositoryArchiveTarget, { label: string; description: string }> = {
  yunzai: { label: 'Yunzai', description: '解压到 Yunzai 根目录' },
  miao: { label: 'Miao', description: '解压到 plugins/miao-plugin' }
};

/** 已知 GitHub URL 前缀代理（纯前缀形式，兼容 gh_proxy 直接拼接 github.com 地址） */
const GH_PROXY_PRESETS = [
  { value: 'https://ghfast.top/', label: 'ghfast.top' },
  { value: 'https://gh-proxy.com/', label: 'gh-proxy.com' },
  { value: 'https://ghproxy.net/', label: 'ghproxy.net' },
  { value: 'https://ghproxy.com/', label: 'ghproxy.com' },
  { value: 'https://ghproxy.cc/', label: 'ghproxy.cc' },
  { value: 'https://gh.llkk.cc/', label: 'gh.llkk.cc' },
  { value: 'https://ghproxy.homeboyc.cn/', label: 'ghproxy.homeboyc.cn' },
  { value: 'https://mirror.ghproxy.com/', label: 'mirror.ghproxy.com' },
  { value: 'https://ghp.ci/', label: 'ghp.ci' },
  { value: 'https://moeyy.cn/gh-proxy/', label: 'moeyy.cn/gh-proxy' },
  { value: 'https://github.moeyy.xyz/', label: 'github.moeyy.xyz' },
  { value: 'https://v6.gh-proxy.org/', label: 'v6.gh-proxy.org' },
  { value: 'https://gh.api.99988866.xyz/', label: 'gh.api.99988866.xyz' },
  { value: 'https://ghps.cc/', label: 'ghps.cc' },
  { value: 'https://hub.gitmirror.com/', label: 'hub.gitmirror.com' },
  { value: 'https://gh.ddlc.top/', label: 'gh.ddlc.top' },
  { value: 'https://ghproxy.link/', label: 'ghproxy.link' }
];

const GH_PROXY_PRESET_VALUES = new Set(GH_PROXY_PRESETS.map(item => item.value));

type RepoData = typeof INITIAL;

function Row({ label, tip, children }: { label: string; tip?: string; children: React.ReactNode }) {
  return (
    <div className='row-hover flex  xs:items-center xs:justify-between gap-1 xs:gap-3 py-2.5'>
      <div className='flex items-center gap-1.5 shrink-0 text-sm font-medium opacity-75'>
        <span>{label}</span>
        {tip && (
          <Tooltip text={tip} position='right'>
            <span className='cursor-help opacity-40 text-[10px] w-3.5 h-3.5 rounded-full border border-current flex items-center justify-center'>?</span>
          </Tooltip>
        )}
      </div>
      <div className='w-full xs:flex-1 xs:max-w-[65%]'>{children}</div>
    </div>
  );
}

function SaveBtn({ saved }: { saved: boolean }) {
  return (
    <Button
      type='submit'
      className={`px-3 py-1 rounded-lg text-[11px] font-semibold ${saved ? 'opacity-70' : ''}`}
      style={!saved ? { background: 'linear-gradient(135deg, #d5c8b2 0%, #8f8c76 100%)' } : undefined}
    >
      {saved ? '✓ 已保存' : '💾 保存'}
    </Button>
  );
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

export default function Repo({ section }: { section: string }) {
  const isDesktopRuntime = window.__ALEMONJS_RUNTIME_MODE__ === 'desktop';
  const [formData, setFormData] = useState<RepoData>({ ...INITIAL });
  const [plugins, setPlugins] = useState<PluginEntry[]>([]);
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState('');
  const [repoTab, setRepoTab] = useState<RepositoryArchiveTarget>('yunzai');
  const [archiveStatuses, setArchiveStatuses] = useState<RepositoryArchiveStatus[]>([]);
  const [archiveFile, setArchiveFile] = useState<File | null>(null);
  const [archiveLoading, setArchiveLoading] = useState('');
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [isArchiveDragActive, setIsArchiveDragActive] = useState(false);
  const archiveInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!window.API || isDesktopRuntime) {
      return;
    }
    const handler = data => {
      if (data.type === 'repo.init') {
        const d = data.data ?? {};
        const arr2str = (v: unknown) => (Array.isArray(v) ? v.join(',') : String(v ?? ''));

        setFormData({
          master_key: arr2str(d.master_key),
          master_id: arr2str(d.master_id),
          gh_proxy: d.gh_proxy ?? '',
          bot_name: d.bot_name ?? '',
          yunzai_repo: d.yunzai_repo ?? '',
          miao_plugin_repo: d.miao_plugin_repo ?? ''
        });

        // 还原自定义插件列表
        const raw = d.plugins ?? {};
        const list: PluginEntry[] = [];

        for (const [key, val] of Object.entries(raw as Record<string, any>)) {
          if (val && typeof val === 'object' && val.dirName) {
            list.push({
              key,
              dirName: val.dirName ?? '',
              repoUrl: val.repoUrl ?? '',
              label: val.label ?? '',
              aliases: Array.isArray(val.aliases) ? val.aliases.join(',') : ''
            });
          }
        }
        setPlugins(list);
      } else if (data.type === 'repo.result') {
        setMessage((data.data as { message?: string })?.message ?? '保存完成');
      }
    };

    const dispose = window.API.onMessage(handler);

    window.API.postMessage({ type: 'repo.init' });

    return () => {
      dispose();
    };
  }, [isDesktopRuntime]);

  const refreshArchiveStatuses = async () => {
    if (isDesktopRuntime) {
      return;
    }

    try {
      setArchiveStatuses(await getRepositoryArchiveStatuses());
    } catch (err: any) {
      setMessage(err?.message ?? '无法读取压缩包状态');
    }
  };

  useEffect(() => {
    void refreshArchiveStatuses();
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

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (isDesktopRuntime) {
      setMessage('当前 desktop 链路仅支持机器人状态同步，不提供仓库配置读写');

      return;
    }

    // 把 plugins 数组转成 key→object 结构
    const pluginsObj: Record<string, any> = {};

    for (const p of plugins) {
      const k = p.key.trim();

      if (!k || !p.dirName.trim()) {
        continue;
      }
      pluginsObj[k] = {
        dirName: p.dirName.trim(),
        repoUrl: p.repoUrl.trim(),
        label: p.label.trim() || p.dirName.trim(),
        aliases: p.aliases
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
      };
    }

    window.API.postMessage({ type: 'repo.save', data: { ...formData, plugins: pluginsObj } });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const currentArchiveStatus = archiveStatuses.find(item => item.target === repoTab) ?? {
    target: repoTab,
    archive: null,
    extracted: false,
    extractedAt: null
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024 * 1024) {
      return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    }

    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const formatTime = (timestamp: number | null) => (timestamp ? new Date(timestamp).toLocaleString() : '—');

  const uploadArchiveFile = async (file: File) => {
    if (archiveLoading) {
      return;
    }

    setArchiveFile(file);
    setArchiveLoading('upload');
    setUploadProgress(0);
    try {
      await uploadRepositoryArchive(repoTab, file, setUploadProgress);
      setMessage(`${ARCHIVE_TARGETS[repoTab].label} 压缩包已保存，旧压缩包已覆盖`);
      await refreshArchiveStatuses();
    } catch (err: any) {
      setMessage(err?.message ?? '压缩包上传失败');
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
      setMessage('仅支持上传 .zip 压缩包');

      return;
    }
    if (file.size > MAX_REPOSITORY_ARCHIVE_SIZE_MB * 1024 * 1024) {
      setMessage(`压缩包过大，当前最大支持 ${MAX_REPOSITORY_ARCHIVE_SIZE_MB}MB`);

      return;
    }

    setMessage('');
    void uploadArchiveFile(file);
  };

  const handleArchiveExtract = async () => {
    if (!currentArchiveStatus.archive || archiveLoading) {
      return;
    }

    setArchiveLoading('extract');
    try {
      await extractRepositoryArchive(repoTab);
      setMessage(`${ARCHIVE_TARGETS[repoTab].label} 压缩包解压完成`);
      await refreshArchiveStatuses();
    } catch (err: any) {
      setMessage(err?.message ?? '压缩包解压失败');
    } finally {
      setArchiveLoading('');
    }
  };

  const handleRepairArchiveOrigin = async () => {
    const repoUrl = (repoTab === 'yunzai' ? formData.yunzai_repo : formData.miao_plugin_repo).trim();

    if (!repoUrl) {
      setMessage('请先填写 Git 仓库地址');

      return;
    }

    setArchiveLoading('repair');
    try {
      await repairRepositoryArchiveOrigin(repoTab, repoUrl);
      setMessage(`${ARCHIVE_TARGETS[repoTab].label} 仓库来源已修复，不会覆盖当前解压文件`);
    } catch (err: any) {
      setMessage(err?.message ?? '仓库来源修复失败');
    } finally {
      setArchiveLoading('');
    }
  };

  if (isDesktopRuntime) {
    return (
      <div className='py-2'>
        <PrimaryDiv className='rounded-xl px-4 py-3 text-[12px]' style={{ background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.16)' }}>
          当前 desktop 链路仅同步机器人状态，不提供仓库配置或压缩包管理。
        </PrimaryDiv>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className='py-2 space-y-3'>
      {message && <PrimaryDiv className='rounded-xl px-4 py-3 text-sm animate-fade-in shadow-sm'>{message}</PrimaryDiv>}
      {section === 'auth' && (
        <SecondaryDiv className='rounded-xl overflow-hidden'>
          <HeaderDiv className='px-4 py-2.5 flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <span className='text-sm font-semibold'>🔑 主人认证</span>
              <TagDiv className='px-2 py-0.5 rounded-full text-[10px]'>AlemonJS</TagDiv>
            </div>
            <SaveBtn saved={saved} />
          </HeaderDiv>
          <PrimaryDiv className='px-4 py-0.5 divide-y divide-gray-200/10'>
            <Row label='主人 ID' tip='AlemonJS 主人 ID，逗号分隔多个'>
              <Input
                name='master_id'
                value={formData.master_id}
                placeholder='id1,id2'
                onChange={handleChange}
                className='w-full px-3 py-1.5 text-sm rounded-lg'
              />
            </Row>
            <Row label='主人 Key' tip='AlemonJS 主人密钥，逗号分隔多个'>
              <Input
                name='master_key'
                value={formData.master_key}
                placeholder='key1,key2'
                onChange={handleChange}
                className='w-full px-3 py-1.5 text-sm rounded-lg'
              />
            </Row>
          </PrimaryDiv>
        </SecondaryDiv>
      )}

      {section === 'gitrepo' && (
        <SecondaryDiv className='rounded-xl overflow-hidden'>
          <HeaderDiv className='px-4 py-2.5 flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <span className='text-sm font-semibold'>📦 仓库</span>
              <TagDiv className='px-2 py-0.5 rounded-full text-[10px]'>Git + ZIP</TagDiv>
            </div>
            <SaveBtn saved={saved} />
          </HeaderDiv>
          <PrimaryDiv className='px-4 py-3 space-y-3'>
            <div className='flex items-center gap-2'>
              <TabBtn active={repoTab === 'yunzai'} onClick={() => setRepoTab('yunzai')}>
                Yunzai
              </TabBtn>
              <TabBtn active={repoTab === 'miao'} onClick={() => setRepoTab('miao')}>
                Miao
              </TabBtn>
            </div>

            <div className='rounded-xl border border-current/10 px-3 py-3 space-y-2'>
              <div className='flex flex-wrap items-center justify-between gap-2'>
                <div className='text-sm font-semibold'>Git 仓库配置</div>
                <Button
                  type='button'
                  className='px-2.5 py-1 rounded-lg text-[11px] font-medium'
                  onClick={() => void handleRepairArchiveOrigin()}
                  disabled={!!archiveLoading}
                  title='为已解压目录初始化 Git 并设置 origin，不会拉取或覆盖当前文件'
                >
                  {archiveLoading === 'repair' ? '修复中...' : '修复仓库来源'}
                </Button>
              </div>
              {repoTab === 'yunzai' ? (
                <>
                  <div>
                    <div className='text-[11px] opacity-45 mb-1'>Yunzai 仓库地址</div>
                    <Input
                      name='yunzai_repo'
                      value={formData.yunzai_repo}
                      placeholder='https://github.com/.../Miao-Yunzai.git'
                      onChange={handleChange}
                      className='w-full px-3 py-1.5 text-sm rounded-lg'
                    />
                  </div>
                  <div>
                    <div className='text-[11px] opacity-45 mb-1'>机器人目录名</div>
                    <Input
                      name='bot_name'
                      value={formData.bot_name}
                      placeholder='Miao-Yunzai'
                      onChange={handleChange}
                      className='w-full px-3 py-1.5 text-sm rounded-lg'
                    />
                    <div className='text-[10px] opacity-35 mt-1'>控制本地 Yunzai 文件夹名称；ZIP 解压也会使用此目录。</div>
                  </div>
                </>
              ) : (
                <div>
                  <div className='text-[11px] opacity-45 mb-1'>Miao 插件仓库地址</div>
                  <Input
                    name='miao_plugin_repo'
                    value={formData.miao_plugin_repo}
                    placeholder='https://github.com/.../miao-plugin.git'
                    onChange={handleChange}
                    className='w-full px-3 py-1.5 text-sm rounded-lg'
                  />
                </div>
              )}
            </div>

            <div className='rounded-xl border border-current/10 px-3 py-3 space-y-3'>
              <div>
                <div className='text-sm font-semibold'>{ARCHIVE_TARGETS[repoTab].label} 压缩包</div>
                <div className='text-[11px] opacity-45 mt-0.5'>{ARCHIVE_TARGETS[repoTab].description}；支持反复解压覆盖已有文件。</div>
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
                      : `选择或拖入 ${ARCHIVE_TARGETS[repoTab].label} ZIP 压缩包`}
                </div>
                <div className='text-[11px] opacity-45 mt-1'>选择或拖入后会立即上传；最大 {MAX_REPOSITORY_ARCHIVE_SIZE_MB}MB，同类型上传会覆盖已保存压缩包</div>
              </div>

              <div className='flex flex-wrap items-center gap-2'>
                {currentArchiveStatus.archive && (
                  <Button
                    type='button'
                    className='px-3 py-1.5 rounded-lg text-xs font-semibold'
                    onClick={() => void handleArchiveExtract()}
                    disabled={!!archiveLoading}
                  >
                    {archiveLoading === 'extract' ? '解压中...' : currentArchiveStatus.extracted ? '重新解压' : '解压压缩包'}
                  </Button>
                )}
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

              {currentArchiveStatus.archive ? (
                <div className='rounded-lg px-3 py-2 text-[11px] space-y-1' style={{ background: 'var(--alemonjs-primary-bg, rgba(128,128,128,.08))' }}>
                  <div className='flex flex-wrap gap-x-3 gap-y-1'>
                    <span>已保存：{currentArchiveStatus.archive.name}</span>
                    <span className='opacity-50'>{formatSize(currentArchiveStatus.archive.size)}</span>
                    <span className='opacity-50'>上传于 {formatTime(currentArchiveStatus.archive.uploadedAt)}</span>
                  </div>
                  <div className={currentArchiveStatus.extracted ? 'text-emerald-500' : 'text-amber-500'}>
                    {currentArchiveStatus.extracted ? `✓ 已完成解压（${formatTime(currentArchiveStatus.extractedAt)}）` : '○ 尚未解压当前压缩包'}
                  </div>
                </div>
              ) : (
                <div className='text-[11px] opacity-45'>尚未保存压缩包。上传完成后将显示解压按钮与状态。</div>
              )}
            </div>
          </PrimaryDiv>
        </SecondaryDiv>
      )}

      {section === 'network' && (
        <SecondaryDiv className='rounded-xl overflow-hidden'>
          <HeaderDiv className='px-4 py-2.5 flex items-center justify-between'>
            <span className='text-sm font-semibold'>🌐 网络配置</span>
            <SaveBtn saved={saved} />
          </HeaderDiv>
          <PrimaryDiv className='px-4 py-0.5 divide-y divide-gray-200/10'>
            <Row label='GitHub 代理' tip='国内加速代理前缀，GitHub 仓库克隆与在线插件索引下载都会拼接此前缀'>
              <div className='space-y-1.5'>
                <Select
                  value={GH_PROXY_PRESET_VALUES.has(formData.gh_proxy) ? formData.gh_proxy : formData.gh_proxy ? 'custom' : 'none'}
                  onChange={e => {
                    const next = e.target.value;

                    setFormData(prev => ({
                      ...prev,
                      gh_proxy: next === 'none' ? '' : next === 'custom' ? prev.gh_proxy : next
                    }));
                  }}
                  className='w-full px-3 py-1.5 text-sm rounded-lg'
                >
                  <option value='none'>不使用代理</option>
                  {GH_PROXY_PRESETS.map(item => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                  <option value='custom'>自定义…</option>
                </Select>
                <Input
                  name='gh_proxy'
                  value={formData.gh_proxy}
                  placeholder='https://ghfast.top/'
                  onChange={handleChange}
                  className='w-full px-3 py-1.5 text-sm rounded-lg'
                />
                <div className='text-[10px] opacity-35'>从下拉选择常用代理即可生效，也可直接在输入框填写任意前缀；代理服务可用性会变化，失效时切换一个即可</div>
              </div>
            </Row>
          </PrimaryDiv>
        </SecondaryDiv>
      )}

      {section === 'plugins' && (
        <SecondaryDiv className='rounded-xl overflow-hidden'>
          <HeaderDiv className='px-4 py-2.5 flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <span className='text-sm font-semibold'>🧩 自定义插件来源</span>
              <TagDiv className='px-2 py-0.5 rounded-full text-[10px]'>{plugins.length}</TagDiv>
            </div>
            <div className='flex items-center gap-2'>
              <Button
                type='button'
                className='px-3 py-1 text-[11px] rounded-lg font-medium'
                onClick={() => setPlugins(prev => [...prev, { key: '', dirName: '', repoUrl: '', label: '', aliases: '' }])}
              >
                + 添加
              </Button>
              <SaveBtn saved={saved} />
            </div>
          </HeaderDiv>
          {plugins.length === 0 ? (
            <PrimaryDiv className='px-4 py-4 text-center'>
              <div className='text-sm opacity-40'>暂无自定义插件，点击「添加」定义新的插件来源</div>
              <div className='text-[11px] opacity-25 mt-1'>添加后会与内置插件目录合并显示在插件管理页</div>
            </PrimaryDiv>
          ) : (
            <div className='divide-y divide-gray-200/10'>
              {plugins.map((p, idx) => (
                <PrimaryDiv key={idx} className='px-4 py-3 space-y-2'>
                  <div className='flex items-center justify-between'>
                    <span className='text-[11px] opacity-40 font-medium'>插件 #{idx + 1}</span>
                    <Button
                      type='button'
                      className='px-2 py-0.5 text-[10px] rounded text-red-400'
                      onClick={() => setPlugins(prev => prev.filter((_, i) => i !== idx))}
                    >
                      删除
                    </Button>
                  </div>
                  <div className='grid grid-cols-2 gap-2'>
                    <div>
                      <div className='text-[10px] opacity-40 mb-1'>别名键 *</div>
                      <Input
                        value={p.key}
                        placeholder='如: 我的插件'
                        onChange={e => {
                          const list = [...plugins];

                          list[idx] = { ...list[idx], key: e.target.value };
                          setPlugins(list);
                        }}
                        className='w-full px-2.5 py-1 text-xs rounded-lg'
                      />
                    </div>
                    <div>
                      <div className='text-[10px] opacity-40 mb-1'>目录名 *</div>
                      <Input
                        value={p.dirName}
                        placeholder='my-plugin'
                        onChange={e => {
                          const list = [...plugins];

                          list[idx] = { ...list[idx], dirName: e.target.value };
                          setPlugins(list);
                        }}
                        className='w-full px-2.5 py-1 text-xs rounded-lg'
                      />
                    </div>
                  </div>
                  <div>
                    <div className='text-[10px] opacity-40 mb-1'>仓库地址 *</div>
                    <Input
                      value={p.repoUrl}
                      placeholder='https://github.com/xxx/my-plugin.git'
                      onChange={e => {
                        const list = [...plugins];

                        list[idx] = { ...list[idx], repoUrl: e.target.value };
                        setPlugins(list);
                      }}
                      className='w-full px-2.5 py-1 text-xs rounded-lg'
                    />
                  </div>
                  <div className='grid grid-cols-2 gap-2'>
                    <div>
                      <div className='text-[10px] opacity-40 mb-1'>显示名称</div>
                      <Input
                        value={p.label}
                        placeholder='默认同目录名'
                        onChange={e => {
                          const list = [...plugins];

                          list[idx] = { ...list[idx], label: e.target.value };
                          setPlugins(list);
                        }}
                        className='w-full px-2.5 py-1 text-xs rounded-lg'
                      />
                    </div>
                    <div>
                      <div className='text-[10px] opacity-40 mb-1'>更多别名</div>
                      <Input
                        value={p.aliases}
                        placeholder='别名1,别名2'
                        onChange={e => {
                          const list = [...plugins];

                          list[idx] = { ...list[idx], aliases: e.target.value };
                          setPlugins(list);
                        }}
                        className='w-full px-2.5 py-1 text-xs rounded-lg'
                      />
                    </div>
                  </div>
                </PrimaryDiv>
              ))}
            </div>
          )}
        </SecondaryDiv>
      )}
    </form>
  );
}
