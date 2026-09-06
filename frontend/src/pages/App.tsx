import { HeaderDiv, SecondaryDiv, SidebarDiv } from '@alemonjs/react-ui';
import React, { lazy, Suspense, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

const Data = lazy(() => import('./Data'));
const From = lazy(() => import('./From'));
const Logs = lazy(() => import('./Logs'));
const Manage = lazy(() => import('./Manage'));
const Plugin = lazy(() => import('./Plugin'));
const Repo = lazy(() => import('./Repo'));
const Dependency = lazy(() => import('./Dependency'));

const APP_VERSION = __APP_VERSION__;
const THEME_STORAGE_KEY = 'alemonjs-load-yunzai:brand-theme';

const CONFIG_SECTIONS = [
  { key: 'qq', label: '💬 QQ 账号', short: '💬 QQ' },
  { key: 'feature', label: '🔧 功能开关', short: '🔧 功能' },
  { key: 'runtime', label: '⚙️ 运行配置', short: '⚙️ 运行' },
  { key: 'group', label: '👥 群聊配置', short: '👥 群聊' },
  { key: 'redis', label: '🗄️ Redis', short: '🗄️ Redis' },
  { key: 'blacklist', label: '📋 黑白名单', short: '📋 名单' },
  { key: 'notice', label: '🔔 通知推送', short: '🔔 通知' }
];

const REPO_SECTIONS = [
  { key: 'network', label: '🌐 网络配置', short: '🌐 网络' },
  { key: 'plugins', label: '🧩 插件来源', short: '🧩 来源' }
];

const CONFIG_KEYS = new Set(CONFIG_SECTIONS.map(s => s.key));
// “仓库”是独立页面，不属于下面的仓库配置子分类；两者都需要渲染 Repo。
const REPO_PAGE_KEYS = new Set(['gitrepo', ...REPO_SECTIONS.map(s => s.key)]);

function NavItem({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 rounded-lg text-[13px] transition-colors duration-150 ${active ? 'font-semibold opacity-100 nav-active' : 'opacity-50 hover:opacity-75'}`}
      style={active ? { background: 'var(--alemonjs-primary-bg, rgba(128,128,128,.08))' } : undefined}
    >
      {children}
    </button>
  );
}

function Pill({ active, onClick, children, small }: { active: boolean; onClick: () => void; children: React.ReactNode; small?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 rounded-full font-medium transition-colors whitespace-nowrap ${small ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1.5 text-xs'} ${active ? 'opacity-100' : 'opacity-40 hover:opacity-65'}`}
      style={active ? { background: 'var(--alemonjs-primary-bg, rgba(128,128,128,.1))' } : undefined}
    >
      {children}
    </button>
  );
}

export default function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [themeMode, setThemeMode] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') {
      return 'light';
    }

    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);

    if (saved === 'light' || saved === 'dark') {
      return saved;
    }

    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  const configMatch = location.pathname.match(/^\/config\/([^/]+)$/);
  const repoMatch = location.pathname.match(/^\/repo\/([^/]+)$/);
  const activeKey =
    configMatch?.[1] ??
    repoMatch?.[1] ??
    (location.pathname === '/plugin' ? 'plugin' : location.pathname === '/logs' ? 'logs' : location.pathname === '/data' ? 'data' : location.pathname === '/dependency' ? 'dependency' : 'manage');
  const isConfig = CONFIG_KEYS.has(activeKey);
  const isRepo = REPO_PAGE_KEYS.has(activeKey);
  const isLogs = activeKey === 'logs';
  const go = (path: string) => {
    void navigate(path);
  };

  useEffect(() => {
    document.documentElement.classList.toggle('dark', themeMode === 'dark');
    window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  }, [themeMode]);

  const toggleThemeMode = () => {
    setThemeMode(prev => (prev === 'dark' ? 'light' : 'dark'));
  };

  return (
    <SecondaryDiv className={`${isLogs ? 'h-screen overflow-hidden' : 'min-h-screen'} lg:h-screen lg:flex lg:overflow-hidden`}>
      {/* ── PC 侧边栏 ── */}
      <SidebarDiv className='hidden lg:flex lg:flex-col w-44 shrink-0 px-2 py-3 overflow-y-auto' style={{ borderRight: '1px solid rgba(128,128,128,.08)' }}>
        <div className='flex items-center gap-2 px-3 py-2 mb-3'>
          <button
            type='button'
            className='brand-badge w-7 h-7 rounded-lg flex items-center justify-center text-sm cursor-pointer transition-transform hover:scale-[1.04]'
            onClick={toggleThemeMode}
            title={`切换到${themeMode === 'dark' ? '浅色' : '深色'}主题`}
          >
            ⚡
          </button>
          <div>
            <div className='text-[13px] font-bold gradient-text leading-tight'>Yunzai</div>
            <div className='flex items-center gap-1.5 text-[9px] opacity-30'>
              <span>AlemonJS</span>
              <span className='rounded-full px-1.5 py-0.5 border border-current/15 opacity-70'>{APP_VERSION}</span>
            </div>
          </div>
        </div>

        {[
          {
            label: '⚡ 管理',
            activeKey: 'manage',
            path: '/manage'
          },
          {
            label: '📜 日志',
            activeKey: 'logs',
            path: '/logs'
          },
          {
            label: '🔌 插件',
            activeKey: 'plugin',
            path: '/plugin'
          },
          {
            label: '📦 仓库',
            activeKey: 'gitrepo',
            path: '/repo/gitrepo'
          },
          {
            label: '💾 数据',
            activeKey: 'data',
            path: '/data'
          },
          {
            label: '🧩 自定义包',
            activeKey: 'dependency',
            path: '/dependency'
          }
        ].map(item => {
          return (
            <NavItem key={item.activeKey} active={activeKey === item.activeKey} onClick={() => go(item.path)}>
              {item.label}
            </NavItem>
          );
        })}

        <div className='text-[10px] uppercase tracking-wider opacity-45 font-medium px-3 pt-4 pb-1'>设置 · 来源</div>
        {REPO_SECTIONS.map(s => (
          <NavItem key={s.key} active={activeKey === s.key} onClick={() => go(`/repo/${s.key}`)}>
            {s.label}
          </NavItem>
        ))}

        <div className='text-[10px] uppercase tracking-wider opacity-45 font-medium px-3 pt-4 pb-1'>设置 · 机器人</div>
        {CONFIG_SECTIONS.map(s => (
          <NavItem key={s.key} active={activeKey === s.key} onClick={() => go(`/config/${s.key}`)}>
            {s.label}
          </NavItem>
        ))}
      </SidebarDiv>

      {/* ── 主内容区 ── */}
      <div className={`flex-1 flex flex-col min-w-0 ${isLogs ? 'overflow-hidden' : 'lg:overflow-y-auto'}`}>
        {/* ── 移动端导航 ── */}
        <div className='lg:hidden'>
          <HeaderDiv className='px-3 py-2.5 flex items-center gap-2.5'>
            <button
              type='button'
              className='brand-badge w-7 h-7 rounded-lg flex items-center justify-center text-sm cursor-pointer transition-transform active:scale-95'
              onClick={toggleThemeMode}
              title={`切换到${themeMode === 'dark' ? '浅色' : '深色'}主题`}
            >
              ⚡
            </button>
            <div className='flex items-center gap-1.5 min-w-0'>
              <div className='text-[13px] font-bold gradient-text'>Yunzai</div>
              <div className='rounded-full px-1.5 py-0.5 text-[9px] border border-current/10 opacity-45 shrink-0'>{APP_VERSION}</div>
            </div>
          </HeaderDiv>
          <div className='flex gap-1.5 px-3 py-1.5'>
            <Pill active={activeKey === 'manage'} onClick={() => go('/manage')}>
              管理
            </Pill>
            <Pill active={activeKey === 'plugin'} onClick={() => go('/plugin')}>
              插件
            </Pill>
            <Pill active={activeKey === 'logs'} onClick={() => go('/logs')}>
              日志
            </Pill>
            <Pill
              active={isRepo}
              onClick={() => {
                if (!isRepo) {
                  go('/repo/gitrepo');
                }
              }}
            >
              仓库
            </Pill>
            <Pill active={activeKey === 'data'} onClick={() => go('/data')}>
              数据
            </Pill>
            <Pill active={activeKey === 'dependency'} onClick={() => go('/dependency')}>
              自定义包
            </Pill>
            <Pill
              active={isConfig}
              onClick={() => {
                if (!isConfig) {
                  go('/config/qq');
                }
              }}
            >
              配置
            </Pill>
          </div>
          {isRepo && (
            <div className='flex gap-1 px-3 pb-2 overflow-x-auto' style={{ scrollbarWidth: 'none' }}>
              {REPO_SECTIONS.map(s => (
                <Pill key={s.key} active={activeKey === s.key} onClick={() => go(`/repo/${s.key}`)} small>
                  {s.short}
                </Pill>
              ))}
            </div>
          )}
          {isConfig && (
            <div className='flex gap-1 px-3 pb-2 overflow-x-auto' style={{ scrollbarWidth: 'none' }}>
              {CONFIG_SECTIONS.map(s => (
                <Pill key={s.key} active={activeKey === s.key} onClick={() => go(`/config/${s.key}`)} small>
                  {s.short}
                </Pill>
              ))}
            </div>
          )}
        </div>

        {/* ── 内容 ── */}
        <div className={`flex-1 px-3 py-2 sm:px-4 lg:px-6 lg:py-4 ${isLogs ? 'min-h-0 flex flex-col overflow-hidden' : ''}`}>
          <Suspense fallback={<div className='rounded-xl px-4 py-8 text-center text-sm opacity-50'>页面加载中...</div>}>
            {activeKey === 'manage' && <Manage />}
            {activeKey === 'plugin' && <Plugin />}
            {activeKey === 'logs' && <Logs />}
            {activeKey === 'data' && <Data />}
            {activeKey === 'dependency' && <Dependency />}
            {isConfig && <From section={activeKey} />}
            {isRepo && <Repo section={activeKey} />}
          </Suspense>
        </div>
      </div>
    </SecondaryDiv>
  );
}
