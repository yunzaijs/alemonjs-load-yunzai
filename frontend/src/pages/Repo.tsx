import { Button, HeaderDiv, Input, PrimaryDiv, SecondaryDiv, TagDiv, Tooltip } from '@alemonjs/react-ui';
import React, { useEffect, useState } from 'react';

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
  const [formData, setFormData] = useState<RepoData>({ ...INITIAL });
  const [plugins, setPlugins] = useState<PluginEntry[]>([]);
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState('');
  const [repoTab, setRepoTab] = useState<'yunzai' | 'miao'>('yunzai');

  useEffect(() => {
    if (!window.API) {
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

    window.API.postMessage({ type: 'repo.init' });
    window.API.onMessage(handler);
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

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
            <Row label='Master Key' tip='AlemonJS 主人密钥，逗号分隔多个'>
              <Input
                name='master_key'
                value={formData.master_key}
                placeholder='key1,key2'
                onChange={handleChange}
                className='w-full px-3 py-1.5 text-sm rounded-lg'
              />
            </Row>
            <Row label='主人 ID' tip='AlemonJS 主人 ID，逗号分隔多个'>
              <Input
                name='master_id'
                value={formData.master_id}
                placeholder='id1,id2'
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
              <span className='text-sm font-semibold'>📦 仓库地址</span>
              <TagDiv className='px-2 py-0.5 rounded-full text-[10px]'>Git</TagDiv>
            </div>
            <SaveBtn saved={saved} />
          </HeaderDiv>
          <PrimaryDiv className='px-4 py-3 space-y-3'>
            <div className='flex items-center gap-2'>
              <TabBtn active={repoTab === 'yunzai'} onClick={() => setRepoTab('yunzai')}>
                Yunzai 仓库
              </TabBtn>
              <TabBtn active={repoTab === 'miao'} onClick={() => setRepoTab('miao')}>
                Miao 插件仓库
              </TabBtn>
            </div>

            {repoTab === 'yunzai' && (
              <div className='space-y-2'>
                <div className='text-[11px] opacity-40'>主仓库地址</div>
                <Input
                  name='yunzai_repo'
                  value={formData.yunzai_repo}
                  placeholder='https://github.com/.../Miao-Yunzai.git'
                  onChange={handleChange}
                  className='w-full px-3 py-1.5 text-sm rounded-lg'
                />
              </div>
            )}

            {repoTab === 'miao' && (
              <div className='space-y-2'>
                <div className='text-[11px] opacity-40'>默认插件仓库地址</div>
                <Input
                  name='miao_plugin_repo'
                  value={formData.miao_plugin_repo}
                  placeholder='https://github.com/.../miao-plugin.git'
                  onChange={handleChange}
                  className='w-full px-3 py-1.5 text-sm rounded-lg'
                />
              </div>
            )}
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
            <Row label='GitHub 代理' tip='国内加速代理地址'>
              <Input
                name='gh_proxy'
                value={formData.gh_proxy}
                placeholder='https://ghfast.top/'
                onChange={handleChange}
                className='w-full px-3 py-1.5 text-sm rounded-lg'
              />
            </Row>
            <Row label='目录名' tip='本地 Yunzai 目录名称'>
              <Input
                name='bot_name'
                value={formData.bot_name}
                placeholder='Miao-Yunzai'
                onChange={handleChange}
                className='w-full px-3 py-1.5 text-sm rounded-lg'
              />
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
