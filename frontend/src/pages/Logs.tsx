import { Button, PrimaryDiv, TagDiv } from '@alemonjs/react-ui';
import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog, Feedback } from '../components/Ui';

interface LogFileItem {
  name: string;
  size: number;
  updatedAt: number;
}

interface LogViewerData {
  files: LogFileItem[];
  activeFile: string;
  content: string;
  truncated: boolean;
  updatedAt: number;
}

function formatTime(timestamp: number) {
  if (!timestamp) {
    return '--';
  }

  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function renderLogLine(line: string, index: number) {
  const lowerLine = line.toLowerCase();
  let className = 'opacity-80';

  if (/\berror\b|\bfatal\b/.test(lowerLine)) {
    className = 'text-red-400 bg-red-500/10';
  } else if (/\bwarn\b|\bwarning\b/.test(lowerLine)) {
    className = 'text-amber-300 bg-amber-500/10';
  } else if (/\binfo\b/.test(lowerLine)) {
    className = 'text-sky-300 bg-sky-500/10';
  }

  return (
    <div key={`${index}-${line.slice(0, 24)}`} className={`px-2 py-0.5 rounded ${className}`}>
      {line || ' '}
    </div>
  );
}

export default function Logs() {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [followTail, setFollowTail] = useState(true);
  const [logViewer, setLogViewer] = useState<LogViewerData>({
    files: [],
    activeFile: '',
    content: '',
    truncated: false,
    updatedAt: 0
  });
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [messageKind, setMessageKind] = useState<'success' | 'error'>('success');
  const logContentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!window.API) {
      return;
    }

    const handler = (data: Record<string, unknown>) => {
      if (data.type === 'yunzai.logs') {
        setLogViewer((data.data as LogViewerData) ?? { files: [], activeFile: '', content: '', truncated: false, updatedAt: Date.now() });
      } else if (data.type === 'yunzai.logs.deleted') {
        setLogViewer((data.data as LogViewerData) ?? { files: [], activeFile: '', content: '', truncated: false, updatedAt: Date.now() });
        setMessageKind('success');
        setMessage('日志已删除');
      } else if (data.type === 'yunzai.result') {
        setMessageKind('error');
        setMessage((data.data as { message?: string })?.message ?? '日志删除失败');
      }
    };

    const dispose = window.API.onMessage(handler);

    return () => {
      dispose();
    };
  }, []);

  useEffect(() => {
    if (!window.API) {
      return;
    }

    const fetchLogs = () => {
      window.API.postMessage({ type: 'yunzai.logs', data: { file: logViewer.activeFile || undefined, lines: 400 } });
    };

    fetchLogs();

    if (!autoRefresh) {
      return;
    }

    const timer = window.setInterval(fetchLogs, 2500);

    return () => {
      window.clearInterval(timer);
    };
  }, [logViewer.activeFile, autoRefresh]);

  useEffect(() => {
    if (!followTail || !logContentRef.current) {
      return;
    }

    logContentRef.current.scrollTop = logContentRef.current.scrollHeight;
  }, [logViewer.updatedAt, logViewer.content, followTail]);

  const deleteLog = () => {
    if (!deleteTarget) { return; }
    window.API?.postMessage({ type: 'yunzai.logs.delete', data: { file: deleteTarget } });
    setDeleteTarget(null);
  };

  return (
    <div className='py-2 flex-1 min-h-0 flex flex-col'>
      {message && <Feedback kind={messageKind}>{message}</Feedback>}
      <PrimaryDiv
        className='rounded-[22px] overflow-hidden flex-1 min-h-0 flex flex-col md:flex-row mt-2'
        style={{ background: 'linear-gradient(180deg, rgba(255,255,255,.025), rgba(255,255,255,.01))' }}
      >
        <div
          className='border-b border-white/10 md:border-b-0 md:border-r overflow-hidden md:w-[230px] lg:w-[250px] xl:w-[280px] md:shrink-0 md:min-h-0'
          style={{ background: 'rgba(255,255,255,.02)' }}
        >
          <div className='px-4 py-4 border-b border-white/10'>
            <div className='text-[15px] font-semibold tracking-tight'>日志文件</div>
            <div className='text-[11px] opacity-40 mt-1'>{logViewer.files.length} 个文件 · 自动按更新时间排序</div>
          </div>
          <div className='p-2 flex gap-1.5 overflow-x-auto md:block md:space-y-1.5 md:overflow-y-auto md:overflow-x-visible md:min-h-0 md:h-[calc(100%-73px)]'>
            {logViewer.files.length === 0 && <div className='px-2 py-3 text-[12px] opacity-40'>暂无日志文件</div>}
            {logViewer.files.map(file => (
              <div
                key={file.name}
                className={`shrink-0 min-w-[190px] sm:min-w-[210px] md:min-w-0 md:w-full rounded-xl px-3 py-2.5 text-[12px] transition-all flex items-center gap-2 ${file.name === logViewer.activeFile ? 'opacity-100 shadow-sm' : 'opacity-60 hover:opacity-85'}`}
                style={
                  file.name === logViewer.activeFile
                    ? {
                        background: 'linear-gradient(135deg, rgba(213,200,178,.18), rgba(143,140,118,.10))',
                        border: '1px solid rgba(213,200,178,.18)'
                      }
                    : { background: 'rgba(255,255,255,.018)' }
                }
              >
                <button className='min-w-0 flex-1 text-left' onClick={() => setLogViewer(prev => ({ ...prev, activeFile: file.name }))}>
                  <div className='font-medium truncate'>{file.name}</div>
                  <div className='flex items-center justify-between gap-2 opacity-45 text-[10px] mt-1.5'>
                    <span>{Math.max(1, Math.round(file.size / 1024))} KB</span>
                    <span>{formatTime(file.updatedAt)}</span>
                  </div>
                </button>
                <button type='button' aria-label={`删除日志 ${file.name}`} className='shrink-0 rounded-lg px-2 py-1 text-[11px] text-red-400 hover:bg-red-500/10' onClick={() => setDeleteTarget(file.name)}>
                  删除
                </button>
              </div>
            ))}
          </div>
        </div>

          <div className='flex-1 min-w-0 min-h-0 flex flex-col'>
          <div className='px-4 py-4 border-b border-white/10 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3'>
            <div className='min-w-0'>
              <div className='text-[15px] font-semibold tracking-tight truncate'>日志查看</div>
              <div className='text-[11px] opacity-40 truncate mt-1'>{logViewer.activeFile || '当前没有可显示的日志'}</div>
            </div>
            <div className='flex items-center gap-2 flex-wrap xl:justify-end'>
              <TagDiv className='px-2.5 py-1 rounded-full text-[10px]'>{autoRefresh ? '自动刷新中' : '已暂停刷新'}</TagDiv>
              <TagDiv className='px-2.5 py-1 rounded-full text-[10px]'>{followTail ? '跟随尾部' : '自由浏览'}</TagDiv>
              <Button
                className='px-3 py-1.5 rounded-xl text-[12px]'
                onClick={() => window.API?.postMessage({ type: 'yunzai.logs', data: { file: logViewer.activeFile || undefined, lines: 400 } })}
              >
                刷新
              </Button>
              <Button className='px-3 py-1.5 rounded-xl text-[12px]' onClick={() => setAutoRefresh(v => !v)}>
                {autoRefresh ? '暂停刷新' : '自动刷新'}
              </Button>
              <Button className='px-3 py-1.5 rounded-xl text-[12px]' onClick={() => setFollowTail(v => !v)}>
                {followTail ? '取消跟随' : '跟随到底'}
              </Button>
            </div>
          </div>

          {logViewer.truncated && <div className='px-4 py-2 text-[11px] opacity-45 border-b border-white/10'>当前仅展示最新 400 行日志</div>}

          <div className='px-4 py-2.5 text-[11px] opacity-45 border-b border-white/10 grid grid-cols-1 sm:grid-cols-3 gap-1.5 sm:gap-3'>
            <span>刷新间隔 2.5s</span>
            <span>更新时间 {formatTime(logViewer.updatedAt)}</span>
            <span className='sm:text-right'>共展示 {logViewer.content ? logViewer.content.split('\n').length : 0} 行</span>
          </div>

          <div
            ref={logContentRef}
            className='flex-1 overflow-auto min-h-[360px] md:min-h-0'
            onScroll={e => {
              const target = e.currentTarget;
              const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 24;

              if (followTail && !nearBottom) {
                setFollowTail(false);
              }
            }}
          >
            <div className='p-2 sm:p-3 md:p-4'>
              <div
                className='rounded-2xl min-h-full border border-white/8 shadow-inner'
                style={{ background: 'linear-gradient(180deg, rgba(9,12,18,.92), rgba(14,17,24,.96))' }}
              >
                <div className='flex items-center gap-2 px-4 py-3 border-b border-white/8'>
                  <span className='w-2.5 h-2.5 rounded-full bg-[#ff5f57]' />
                  <span className='w-2.5 h-2.5 rounded-full bg-[#febc2e]' />
                  <span className='w-2.5 h-2.5 rounded-full bg-[#28c840]' />
                  <span className='text-[11px] text-white/35 ml-2 font-mono truncate'>{logViewer.activeFile || 'log-output'}</span>
                </div>
                <div className='p-3 sm:p-4 text-[11px] sm:text-[12px] leading-5 whitespace-pre-wrap break-words font-mono space-y-1 text-white/88'>
                  {logViewer.content ? logViewer.content.split('\n').map(renderLogLine) : <div className='opacity-40'>暂无日志内容</div>}
                </div>
              </div>
            </div>
          </div>
        </div>
      </PrimaryDiv>
      <ConfirmDialog
        open={!!deleteTarget}
        title='删除日志'
        description={`确定删除“${deleteTarget ?? ''}”？删除后无法恢复。`}
        confirmLabel='删除'
        onClose={() => setDeleteTarget(null)}
        onConfirm={deleteLog}
      />
    </div>
  );
}
