import { Button, HeaderDiv, PrimaryDiv, SecondaryDiv, TagDiv } from '@alemonjs/react-ui';
import React, { useEffect, useRef, useState } from 'react';
import { createDataBackup, getDataBackups, restoreDataBackup, type DataBackupItem, uploadDataBackup } from '../api/web-api';

const MAX_BACKUP_SIZE_MB = 2048;

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleString();
}

export default function Data() {
  const isDesktopRuntime = window.__ALEMONJS_RUNTIME_MODE__ === 'desktop';
  const [backups, setBackups] = useState<DataBackupItem[]>([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState<'backup' | 'restore' | 'upload' | ''>('');
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    if (isDesktopRuntime) {
      return;
    }

    try {
      setBackups(await getDataBackups());
    } catch (err: any) {
      setMessage(err?.message ?? '无法读取数据备份列表');
    }
  };

  useEffect(() => {
    void refresh();
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

  const handleCreate = async () => {
    if (loading) {
      return;
    }

    setLoading('backup');
    try {
      await createDataBackup();
      setMessage('数据备份已创建');
      await refresh();
    } catch (err: any) {
      setMessage(err?.message ?? '数据备份失败');
    } finally {
      setLoading('');
    }
  };

  const handleRestore = async (backup: DataBackupItem) => {
    if (loading) {
      return;
    }

    if (!window.confirm(`恢复“${backup.name}”会覆盖当前 Miao-Yunzai/data 数据。请确认机器人已停止，是否继续？`)) {
      return;
    }

    setLoading('restore');
    try {
      await restoreDataBackup(backup.id);
      setMessage(`已恢复备份：${backup.name}`);
    } catch (err: any) {
      setMessage(err?.message ?? '恢复数据备份失败');
    } finally {
      setLoading('');
    }
  };

  const uploadBackupFile = async (file: File) => {
    if (loading) {
      return;
    }

    setUploadFile(file);
    setLoading('upload');
    setUploadProgress(0);
    try {
      await uploadDataBackup(file, setUploadProgress);
      setMessage(`已上传数据备份：${file.name}`);
      await refresh();
    } catch (err: any) {
      setMessage(err?.message ?? '数据备份上传失败');
    } finally {
      setLoading('');
      setUploadProgress(null);
      setUploadFile(null);
      if (inputRef.current) {
        inputRef.current.value = '';
      }
    }
  };

  const selectFile = (file: File | null) => {
    if (!file) {
      return;
    }
    if (!/\.zip$/i.test(file.name)) {
      setMessage('仅支持上传 .zip 数据备份');

      return;
    }
    if (file.size > MAX_BACKUP_SIZE_MB * 1024 * 1024) {
      setMessage(`上传文件不能超过 ${MAX_BACKUP_SIZE_MB}MB`);

      return;
    }

    void uploadBackupFile(file);
  };

  if (isDesktopRuntime) {
    return (
      <div className='py-2'>
        <PrimaryDiv className='rounded-xl px-4 py-3 text-[12px]' style={{ background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.16)' }}>
          当前 desktop 链路不提供数据备份管理，请在 Web 管理面板中使用。
        </PrimaryDiv>
      </div>
    );
  }

  return (
    <div className='py-2 space-y-3'>
      {message && <PrimaryDiv className='rounded-xl px-4 py-3 text-sm animate-fade-in shadow-sm'>{message}</PrimaryDiv>}

      <SecondaryDiv className='rounded-xl overflow-hidden'>
        <HeaderDiv className='px-4 py-2.5 flex flex-wrap items-center justify-between gap-2'>
          <div className='flex items-center gap-2'>
            <span className='text-sm font-semibold'>💾 数据备份</span>
            <TagDiv className='px-2 py-0.5 rounded-full text-[10px]'>Miao-Yunzai/data</TagDiv>
          </div>
          <div className='flex items-center gap-2'>
            <Button type='button' className='px-3 py-1 rounded-lg text-[11px] font-medium' onClick={() => void refresh()} disabled={!!loading}>
              刷新列表
            </Button>
            <Button type='button' className='px-3 py-1 rounded-lg text-[11px] font-semibold' onClick={() => void handleCreate()} disabled={!!loading}>
              {loading === 'backup' ? '备份中...' : '创建备份'}
            </Button>
          </div>
        </HeaderDiv>
        <PrimaryDiv className='px-4 py-3 space-y-3'>
          <div className='text-[11px] opacity-50'>恢复会解压并完整覆盖当前 data 目录；为避免写入冲突，恢复前必须先停止机器人。</div>

          <input
            ref={inputRef}
            id='data-backup-upload'
            type='file'
            accept='.zip,application/zip,application/x-zip-compressed'
            className='sr-only'
            onChange={event => selectFile(event.target.files?.[0] ?? null)}
          />
          <label
            htmlFor='data-backup-upload'
            className={`block rounded-lg border border-dashed px-3 py-4 text-center cursor-pointer transition-opacity ${dragActive ? 'border-current opacity-100' : 'border-current/20 hover:opacity-80'}`}
            onDragEnter={event => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragOver={event => event.preventDefault()}
            onDragLeave={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDragActive(false);
              }
            }}
            onDrop={event => {
              event.preventDefault();
              setDragActive(false);
              selectFile(event.dataTransfer.files?.[0] ?? null);
            }}
          >
            <div className='text-sm font-medium'>
              {loading === 'upload' ? `正在上传 ${uploadFile?.name ?? ''}` : dragActive ? '松开以立即上传数据备份' : '选择或拖入数据备份 ZIP'}
            </div>
            <div className='text-[11px] opacity-45 mt-1'>上传后会加入备份列表，不会覆盖已有备份；最大 {MAX_BACKUP_SIZE_MB}MB</div>
          </label>

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
        </PrimaryDiv>
      </SecondaryDiv>

      <SecondaryDiv className='rounded-xl overflow-hidden'>
        <HeaderDiv className='px-4 py-2.5 flex items-center justify-between'>
          <span className='text-sm font-semibold'>备份列表</span>
          <TagDiv className='px-2 py-0.5 rounded-full text-[10px]'>{backups.length}</TagDiv>
        </HeaderDiv>
        {backups.length === 0 ? (
          <PrimaryDiv className='px-4 py-6 text-center text-sm opacity-45'>暂无数据备份。创建或上传 ZIP 后会显示在这里。</PrimaryDiv>
        ) : (
          <PrimaryDiv className='divide-y divide-gray-200/10'>
            {backups.map(backup => (
              <div key={backup.id} className='px-4 py-3 flex flex-wrap items-center justify-between gap-3'>
                <div className='min-w-0'>
                  <div className='text-sm font-medium truncate'>{backup.name}</div>
                  <div className='mt-1 text-[11px] opacity-45 flex flex-wrap gap-x-3 gap-y-1'>
                    <span>{formatSize(backup.size)}</span>
                    <span>{formatTime(backup.createdAt)}</span>
                    <span>{backup.source === 'created' ? '本地创建' : '上传备份'}</span>
                  </div>
                </div>
                <Button
                  type='button'
                  className='px-3 py-1.5 rounded-lg text-xs font-semibold shrink-0'
                  onClick={() => void handleRestore(backup)}
                  disabled={!!loading}
                >
                  {loading === 'restore' ? '恢复中...' : '恢复备份'}
                </Button>
              </div>
            ))}
          </PrimaryDiv>
        )}
      </SecondaryDiv>
    </div>
  );
}
