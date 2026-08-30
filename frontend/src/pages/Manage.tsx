import { Button, Modal, NotificationDiv, PrimaryDiv, TagDiv, Tooltip } from '@alemonjs/react-ui';
import { useEffect, useState } from 'react';

type ColorKey = 'green' | 'blue' | 'orange' | 'red';

const COLOR_MAP: Record<ColorKey, { text: string; bg: string; border: string }> = {
  green: { text: 'text-green-600', bg: 'bg-green-500/10', border: 'border-green-500/40' },
  blue: { text: 'text-blue-500', bg: 'bg-blue-500/10', border: 'border-blue-500/40' },
  orange: { text: 'text-orange-500', bg: 'bg-orange-500/10', border: 'border-orange-500/40' },
  red: { text: 'text-red-500', bg: 'bg-red-500/10', border: 'border-red-500/40' }
};

function CmdRow({ cmd, desc, color }: { cmd: string; desc: string; color: ColorKey }) {
  const c = COLOR_MAP[color];

  return (
    <div className={`flex items-center gap-2.5 rounded-lg py-1.5 px-2.5 border-l-[3px] ${c.bg} ${c.border}`}>
      <span className={`text-[11px] font-bold min-w-[90px] ${c.text}`}>{cmd}</span>
      <span className='text-[11px] opacity-50'>{desc}</span>
    </div>
  );
}

interface HelpData {
  installFlow: { step: string; label: string; cmd: string; desc: string }[];
  controls: { cmd: string; desc: string; color: ColorKey }[];
  tools: { cmd: string; desc: string; color: ColorKey }[];
}

interface ManagerState {
  status: string;
  installed: boolean;
  running: boolean;
  busy: boolean;
  busyTask: string;
  logCount: number;
}

function getStatusTagLabel(state: Pick<ManagerState, 'installed' | 'running' | 'busy' | 'busyTask'>): string {
  if (!state.installed) {
    return '未安装';
  }
  if (state.busy) {
    if (state.busyTask.includes('启动')) {
      return '启动中';
    }
    if (state.busyTask.includes('停止')) {
      return '停止中';
    }

    return '处理中';
  }

  return state.running ? '运行中' : '已停止';
}

function ActionButton({
  disabled,
  reason,
  children,
  className,
  onClick,
  style
}: {
  disabled: boolean;
  reason?: string;
  children: React.ReactNode;
  className?: string;
  onClick: () => void;
  style?: React.CSSProperties;
}) {
  const button = (
    <Button className={className} disabled={disabled} onClick={onClick} style={style}>
      {children}
    </Button>
  );

  if (!disabled || !reason) {
    return button;
  }

  return (
    <Tooltip text={reason} position='top'>
      <span className='inline-flex shrink-0'>{button}</span>
    </Tooltip>
  );
}

export default function Manage() {
  const isDesktopRuntime = window.__ALEMONJS_RUNTIME_MODE__ === 'desktop';
  const [state, setState] = useState<ManagerState>({
    status: '获取中...',
    installed: false,
    running: false,
    busy: false,
    busyTask: '',
    logCount: 0
  });
  const [loading, setLoading] = useState('');
  const [message, setMessage] = useState('');
  const [helpData, setHelpData] = useState<HelpData | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ action: string; label: string; extra?: Record<string, string> } | null>(null);
  const [lastAction, setLastAction] = useState('');

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
        const d = data.data as ManagerState & { help?: HelpData };

        setState(d);
        if (d.help) {
          setHelpData(d.help);
        }
        if (!d.busy) {
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
    if ((loading && action !== 'cancel') || isDesktopRuntime) {
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

  const statusTagLabel = getStatusTagLabel(state);
  const canInstall = !state.installed && !state.busy && !loading && !isDesktopRuntime;
  const canStart = state.installed && !state.running && !state.busy && !loading && !isDesktopRuntime;
  const canStop = state.installed && state.running && !state.busy && !loading && !isDesktopRuntime;
  const canRestart = state.installed && !state.busy && !loading && !isDesktopRuntime;
  const canUpdate = state.installed && !state.busy && !loading && !isDesktopRuntime;
  const canForceUpdate = state.installed && !state.busy && !loading && !isDesktopRuntime;
  const canInstallDeps = state.installed && !state.busy && !loading && !isDesktopRuntime;
  const canUninstall = state.installed && !state.busy && !loading && !isDesktopRuntime;
  const showCardActions = state.installed && !state.busy && !loading && !isDesktopRuntime;
  const busyLabel = loading || state.busyTask || (lastAction ? `${lastAction}中...` : '处理中...');
  const getDisabledReason = (action: 'install' | 'start' | 'stop' | 'restart' | 'update' | 'force_update' | 'install_deps' | 'uninstall') => {
    if (isDesktopRuntime) {
      return 'Desktop 模式仅展示状态，不提供此操作';
    }
    if (loading || state.busy) {
      return busyLabel;
    }
    if (action === 'install' && state.installed) {
      return 'Yunzai 已安装';
    }
    if (action !== 'install' && !state.installed) {
      return '请先安装 Yunzai';
    }
    if (action === 'start' && state.running) {
      return '机器人已在运行';
    }
    if (action === 'stop' && !state.running) {
      return '机器人当前未运行';
    }

    return '当前状态下不可操作';
  };

  return (
    <div className='py-2 space-y-3'>
      {isDesktopRuntime && (
        <PrimaryDiv className='rounded-xl px-4 py-3 text-[12px]' style={{ background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.16)' }}>
          当前 desktop 链路仅同步机器人状态，不提供 Yunzai 启动、停止、重启或维护操作。
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
          {state.busy && !isDesktopRuntime && (
            <Button className='px-3 py-1 text-xs rounded-lg' onClick={() => sendAction('cancel', '取消')}>
              取消
            </Button>
          )}
        </PrimaryDiv>
      )}

      {/* ── 状态卡片 + 操作 ── */}
      <div className='space-y-3'>
        <PrimaryDiv className='rounded-xl p-4 card-hover'>
          <div className='flex flex-wrap items-start justify-between gap-3'>
            <div className='flex items-center gap-3'>
              <div
                className='relative w-10 h-10 rounded-xl flex items-center justify-center text-lg'
                style={{
                  background: state.running
                    ? 'linear-gradient(135deg, #22c55e33, #22c55e11)'
                    : state.installed
                      ? 'linear-gradient(135deg, #eab30833, #eab30811)'
                      : 'linear-gradient(135deg, #9ca3af33, #9ca3af11)'
                }}
              >
                <div
                  className={`absolute top-1 right-1 w-2.5 h-2.5 rounded-full ${state.running ? 'bg-green-500 animate-pulse-dot shadow-[0_0_8px_rgba(34,197,94,.6)]' : state.installed ? 'bg-yellow-500' : 'bg-gray-400'}`}
                />
                ⚡
              </div>
              <div>
                <div className='text-sm font-semibold tracking-tight'>Yunzai</div>
                <div className='text-[11px] opacity-40 mt-0.5'>{state.status}</div>
              </div>
            </div>
            <TagDiv className='px-3 py-1 rounded-full text-xs font-medium'>{statusTagLabel}</TagDiv>
          </div>

          {showCardActions && (
            <div className='mt-4 flex flex-wrap items-center justify-start gap-2 sm:justify-end'>
              {!state.running ? (
                <>
                  <ActionButton
                    className='px-3 py-1.5 rounded-lg text-sm font-medium'
                    disabled={!canStart}
                    reason={!canStart ? getDisabledReason('start') : undefined}
                    onClick={() => sendAction('start', '启动')}
                  >
                    启动
                  </ActionButton>
                  <ActionButton
                    className='px-3 py-1.5 rounded-lg text-sm font-medium bg-red-500/10 hover:bg-red-500/20 text-red-400'
                    disabled={!canUninstall}
                    reason={!canUninstall ? getDisabledReason('uninstall') : undefined}
                    onClick={() => dangerAction('uninstall', '卸载 Yunzai')}
                  >
                    卸载
                  </ActionButton>
                  <ActionButton
                    className='px-3 py-1.5 rounded-lg text-sm font-medium'
                    disabled={!canUpdate}
                    reason={!canUpdate ? getDisabledReason('update') : undefined}
                    onClick={() => sendAction('update', '更新')}
                  >
                    更新
                  </ActionButton>
                  <ActionButton
                    className='px-3 py-1.5 rounded-lg text-sm font-medium'
                    disabled={!canForceUpdate}
                    reason={!canForceUpdate ? getDisabledReason('force_update') : undefined}
                    onClick={() => sendAction('force_update', '强制更新')}
                  >
                    强制更新
                  </ActionButton>
                  <ActionButton
                    className='px-3 py-1.5 rounded-lg text-sm font-medium'
                    disabled={!canInstallDeps}
                    reason={!canInstallDeps ? getDisabledReason('install_deps') : undefined}
                    onClick={() => sendAction('install_deps', '安装依赖')}
                  >
                    重装依赖
                  </ActionButton>
                </>
              ) : (
                <>
                  <ActionButton
                    className='px-3 py-1.5 rounded-lg text-sm font-medium'
                    disabled={!canStop}
                    reason={!canStop ? getDisabledReason('stop') : undefined}
                    onClick={() => sendAction('stop', '停止')}
                  >
                    停止
                  </ActionButton>
                  <ActionButton
                    className='px-3 py-1.5 rounded-lg text-sm font-medium'
                    disabled={!canRestart}
                    reason={!canRestart ? getDisabledReason('restart') : undefined}
                    onClick={() => sendAction('restart', '重启')}
                  >
                    重启
                  </ActionButton>
                </>
              )}
            </div>
          )}
        </PrimaryDiv>
      </div>

      {/* ── 操作区 ── */}
      {!state.installed && !isDesktopRuntime && (
        <div className='flex justify-end'>
          <ActionButton
            className='px-4 py-2 rounded-xl text-sm font-semibold shadow-sm'
            onClick={() => sendAction('install', '安装机器人')}
            disabled={!canInstall}
            reason={!canInstall ? getDisabledReason('install') : undefined}
            style={{ background: 'linear-gradient(135deg, #d5c8b2 0%, #8f8c76 100%)' }}
          >
            安装机器人
          </ActionButton>
        </div>
      )}

      {/* ── 帮助 ── */}
      {helpData && (
        <PrimaryDiv className='rounded-b-xl px-4 py-3 space-y-3'>
          {/* 安装流程 */}
          <div>
            <div className='text-[12px] font-semibold opacity-60 mb-2'>首次安装流程</div>
            <div className='grid grid-cols-4 gap-2'>
              {helpData.installFlow.map(s => (
                <div key={s.step} className='rounded-lg p-2 text-center' style={{ background: 'rgba(128,128,128,.05)' }}>
                  <div className='text-base font-bold opacity-40 mb-1'>{s.step}</div>
                  <div className='text-[11px] font-semibold opacity-70'>{s.label}</div>
                  <div className='text-[10px] font-mono opacity-50 mt-0.5'>{s.cmd}</div>
                </div>
              ))}
            </div>
            <div className='text-[10px] opacity-30 mt-1.5 text-center'>步骤②可重复执行安装多个插件</div>
          </div>

          {/* 进程控制 + 工具指令 */}
          <div className='grid grid-cols-1 lg:grid-cols-2 gap-3'>
            <div>
              <div className='text-[12px] font-semibold opacity-60 mb-2'>进程控制</div>
              <div className='flex flex-col gap-1.5'>
                {helpData.controls.map(c => (
                  <CmdRow key={c.cmd} {...c} />
                ))}
              </div>
            </div>
            <div>
              <div className='text-[12px] font-semibold opacity-60 mb-2'>工具指令</div>
              <div className='flex flex-col gap-1.5'>
                {helpData.tools.map(t => (
                  <CmdRow key={t.cmd} {...t} />
                ))}
              </div>
            </div>
          </div>

          <div className='text-[10px] opacity-30 text-center'>💡 前缀支持 # ! / · 可用 #yz 或 #云崽</div>
        </PrimaryDiv>
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
