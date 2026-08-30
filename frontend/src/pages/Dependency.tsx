import { Button, Input, PrimaryDiv, TagDiv } from '@alemonjs/react-ui';
import { useEffect, useState } from 'react';
import { Feedback } from '../components/Ui';

type DependencyType = 'dependencies' | 'devDependencies';

export default function Dependency() {
  const isDesktopRuntime = window.__ALEMONJS_RUNTIME_MODE__ === 'desktop';
  const [packageName, setPackageName] = useState('');
  const [version, setVersion] = useState('');
  const [dependencyType, setDependencyType] = useState<DependencyType>('dependencies');
  const [installed, setInstalled] = useState(false);
  const [variant, setVariant] = useState<'trss' | 'miao' | 'yunzai' | 'unknown'>('unknown');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!window.API) { return; }
    const dispose = window.API.onMessage(data => {
      if (data.type === 'yunzai.status') {
        setInstalled(Boolean(data.data?.installed));
        setVariant(data.data?.variant === 'trss' || data.data?.variant === 'miao' || data.data?.variant === 'yunzai' ? data.data.variant : 'unknown');
      } else if (data.type === 'yunzai.result') {
        setLoading(false);
        setError(false);
        setMessage(data.data?.message ?? '安装完成');
      } else if (data.type === 'yunzai.error') {
        setLoading(false);
        setError(true);
        setMessage(data.data?.message ?? '无法连接管理服务');
      }
    });

    window.API.postMessage({ type: 'yunzai.status.subscribe' });

    return () => {
      window.API.postMessage({ type: 'yunzai.status.unsubscribe' });
      dispose();
    };
  }, []);

  const execute = () => {
    const name = packageName.trim();

    if (!name || loading || isDesktopRuntime || !installed) { return; }
    setLoading(true);
    setMessage('');
    window.API.postMessage({ type: 'yunzai.action', data: { action: 'install_dependency', packageName: name, version, dependencyType } });
  };

  return (
    <div className='py-2 space-y-3 max-w-2xl'>
      {isDesktopRuntime && <Feedback kind='warning'>桌面模式暂不支持安装依赖。</Feedback>}
      {!installed && !isDesktopRuntime && <Feedback kind='warning'>请先在“概览”安装 Yunzai。</Feedback>}
      {message && <Feedback kind={error ? 'error' : 'success'}>{message}</Feedback>}
      <PrimaryDiv className='rounded-2xl p-4 sm:p-5 space-y-4'>
        <div className='flex items-center justify-between'>
          <div className='text-sm font-semibold'>安装依赖</div>
          <TagDiv className='px-2 py-0.5 rounded-full text-[10px]'>{variant === 'trss' ? 'pnpm' : 'Yarn'}</TagDiv>
        </div>
        <label className='block'>
          <span className='text-xs opacity-60'>包名</span>
          <Input value={packageName} onChange={event => setPackageName(event.target.value)} placeholder='例如 lodash 或 @scope/package' className='mt-1.5 w-full px-3 py-2 text-sm rounded-xl' />
        </label>
        <label className='block'>
          <span className='text-xs opacity-60'>版本 <span className='opacity-60'>（可选）</span></span>
          <Input value={version} onChange={event => setVersion(event.target.value)} placeholder='留空使用最新版' className='mt-1.5 w-full px-3 py-2 text-sm rounded-xl' />
        </label>
        <div>
          <div className='text-xs opacity-60 mb-1.5'>保存到</div>
          <div className='grid grid-cols-2 gap-2'>
            {(['dependencies', 'devDependencies'] as const).map(type => (
              <button key={type} type='button' className={`rounded-xl px-3 py-2 text-xs font-medium ${dependencyType === type ? 'dependency-selected' : 'dependency-option'}`} onClick={() => setDependencyType(type)}>
                {type}
              </button>
            ))}
          </div>
        </div>
        <Button type='button' className='w-full rounded-xl py-2.5 text-sm font-semibold dependency-execute' onClick={execute} disabled={!packageName.trim() || loading || !installed || isDesktopRuntime}>
          {loading ? '安装中...' : '执行'}
        </Button>
      </PrimaryDiv>
    </div>
  );
}
