import { Button, HeaderDiv, Input, PrimaryDiv, SecondaryDiv, Select, Switch, TagDiv, Tooltip } from '@alemonjs/react-ui';
import React, { useEffect, useState } from 'react';

const INITIAL = {
  // ── bot.yaml ──
  log_level: 'info',
  resend: false,
  online_msg: true,
  online_msg_exp: 86400,
  chromium_path: '',
  puppeteer_ws: '',
  puppeteer_timeout: '',
  proxyAddress: '',
  sign_api_addr: '',
  // ── other.yaml ──
  autoFriend: '1',
  autoQuit: 50,
  masterQQ: '',
  disablePrivate: false,
  disableGuildMsg: true,
  disableMsg: '',
  whiteGroup: '',
  blackGroup: '',
  whiteQQ: '',
  blackQQ: '',
  // ── qq.yaml ──
  qq: '',
  pwd: '',
  platform: '6',
  // ── redis.yaml ──
  redis_host: '127.0.0.1',
  redis_port: 6379,
  redis_username: '',
  redis_password: '',
  redis_db: 0,
  // ── group.yaml (default) ──
  groupGlobalCD: 0,
  singleCD: 1000,
  onlyReplyAt: '0',
  botAlias: '',
  imgAddLimit: '0',
  imgMaxSize: 2,
  addPrivate: '1',
  // ── notice.yaml ──
  iyuu: '',
  sct: '',
  feishu_webhook: ''
};

type FormData = typeof INITIAL;

/* ─── 原子组件 ─── */

function Row({ label, tip, children }: { label: string; tip?: string; children: React.ReactNode }) {
  return (
    <div className='row-hover flex  xs:items-center xs:justify-between gap-1 xs:gap-3 py-2 lg:py-2.5'>
      <div className='flex items-center gap-1.5 shrink-0 text-[13px] font-medium opacity-75'>
        <span>{label}</span>
        {tip && (
          <Tooltip text={tip} position='right'>
            <span className='cursor-help opacity-40 text-[10px] w-3.5 h-3.5 rounded-full border border-current flex items-center justify-center'>?</span>
          </Tooltip>
        )}
      </div>
      <div className='w-full xs:flex-1 xs:max-w-[65%] lg:max-w-[75%]'>{children}</div>
    </div>
  );
}

function Txt({
  id,
  value,
  placeholder,
  onChange,
  type = 'text'
}: {
  id: string;
  value: string | number;
  placeholder?: string;
  onChange: React.ChangeEventHandler<HTMLInputElement>;
  type?: string;
}) {
  return <Input type={type} id={id} name={id} value={value} placeholder={placeholder} onChange={onChange} className='w-full px-3 py-1.5 text-sm rounded-lg' />;
}

function Sel({
  id,
  value,
  onChange,
  children
}: {
  id: string;
  value: string;
  onChange: React.ChangeEventHandler<HTMLSelectElement>;
  children: React.ReactNode;
}) {
  return (
    <Select id={id} name={id} value={value} onChange={onChange} className='w-full px-3 py-1.5 text-sm rounded-lg'>
      {children}
    </Select>
  );
}

function SaveBtn({ saved, saving }: { saved: boolean; saving: boolean }) {
  return (
    <Button
      type='submit'
      className={`px-3 py-1 rounded-lg text-[11px] font-semibold ${saved ? 'opacity-70' : ''}`}
      style={!saved ? { background: 'linear-gradient(135deg, #d5c8b2 0%, #8f8c76 100%)' } : undefined}
    >
      {saving ? '保存中...' : saved ? '✓ 已保存' : '💾 保存'}
    </Button>
  );
}

/* ─── 主组件 ─── */

export default function Form({ section }: { section: string }) {
  const isDesktopRuntime = window.__ALEMONJS_RUNTIME_MODE__ === 'desktop';
  const [formData, setFormData] = useState<FormData>({ ...INITIAL });
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!window.API || isDesktopRuntime) {
      return;
    }
    const dispose = window.API.onMessage(data => {
      if (data.type === 'yunzai.init') {
        const d = data.data ?? {};
        const arr2str = (v: unknown) => (Array.isArray(v) ? v.join(',') : String(v ?? ''));

        setFormData({
          log_level: d.log_level ?? 'info',
          resend: d.resend ?? false,
          online_msg: d.online_msg ?? true,
          online_msg_exp: d.online_msg_exp ?? 86400,
          chromium_path: d.chromium_path ?? '',
          puppeteer_ws: d.puppeteer_ws ?? '',
          puppeteer_timeout: d.puppeteer_timeout ?? '',
          proxyAddress: d.proxyAddress ?? '',
          sign_api_addr: d.sign_api_addr ?? '',
          autoFriend: String(d.autoFriend ?? '1'),
          autoQuit: d.autoQuit ?? 50,
          masterQQ: arr2str(d.masterQQ),
          disablePrivate: d.disablePrivate ?? false,
          disableGuildMsg: d.disableGuildMsg ?? true,
          disableMsg: d.disableMsg ?? '',
          whiteGroup: arr2str(d.whiteGroup),
          blackGroup: arr2str(d.blackGroup),
          whiteQQ: arr2str(d.whiteQQ),
          blackQQ: arr2str(d.blackQQ),
          qq: d.qq ?? '',
          pwd: d.pwd ?? '',
          platform: String(d.platform ?? '6'),
          redis_host: d.redis_host ?? '127.0.0.1',
          redis_port: d.redis_port ?? 6379,
          redis_username: d.redis_username ?? '',
          redis_password: d.redis_password ?? '',
          redis_db: d.redis_db ?? 0,
          groupGlobalCD: d.groupGlobalCD ?? 0,
          singleCD: d.singleCD ?? 1000,
          onlyReplyAt: String(d.onlyReplyAt ?? '0'),
          botAlias: arr2str(d.botAlias),
          imgAddLimit: String(d.imgAddLimit ?? '0'),
          imgMaxSize: d.imgMaxSize ?? 2,
          addPrivate: String(d.addPrivate ?? '1'),
          iyuu: d.iyuu ?? '',
          sct: d.sct ?? '',
          feishu_webhook: d.feishu_webhook ?? ''
        });
      } else if (data.type === 'yunzai.result') {
        setSaving(false);
        setSaved(true);
        window.setTimeout(() => setSaved(false), 2000);
      }
    });

    window.API.postMessage({ type: 'yunzai.init' });

    return () => {
      dispose();
    };
  }, [isDesktopRuntime]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;

    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? e.target.checked : value
    }));
  };

  const setBool = (name: keyof FormData, val: boolean) => {
    setFormData(prev => ({ ...prev, [name]: val }));
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isDesktopRuntime) {
      return;
    }
    window.API.postMessage({ type: 'yunzai.form.save', data: formData });
    setSaved(false);
    setSaving(true);
  };

  if (isDesktopRuntime) {
    return (
      <div className='py-2'>
        <PrimaryDiv className='rounded-xl px-4 py-3 text-[12px]' style={{ background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.16)' }}>
          当前 desktop 链路仅同步机器人状态，不提供 Yunzai 配置读取或保存。
        </PrimaryDiv>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className='py-2 space-y-3'>
      <div
        className='rounded-xl px-4 py-2.5 text-[12px] opacity-50 text-center'
        style={{ background: 'rgba(234,179,8,.08)', border: '1px solid rgba(234,179,8,.15)' }}
      >
        ⚠️ 原属于 Yunzai 的配置都不一定都再适用于当前架构设计，请自己探索
      </div>

      {section === 'qq' && (
        <SecondaryDiv className='rounded-xl overflow-hidden animate-fade-in'>
          <HeaderDiv className='px-4 py-2.5 flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <span className='text-sm font-semibold'>💬 QQ 账号</span>
              <TagDiv className='px-2 py-0.5 rounded-full text-[10px]'>qq.yaml</TagDiv>
            </div>
            <SaveBtn saved={saved} saving={saving} />
          </HeaderDiv>
          <PrimaryDiv className='px-4 py-0.5 divide-y divide-gray-200/10'>
            <Row label='QQ 号'>
              <Txt id='qq' value={formData.qq} onChange={handleChange} />
            </Row>
            <Row label='密码' tip='为空则使用扫码登录'>
              <Txt id='pwd' value={formData.pwd} type='password' onChange={handleChange} />
            </Row>
            <Row label='登录平台'>
              <Sel id='platform' value={formData.platform} onChange={handleChange}>
                <option value='1'>安卓手机</option>
                <option value='2'>aPad</option>
                <option value='3'>安卓手表</option>
                <option value='4'>MacOS</option>
                <option value='5'>iPad</option>
                <option value='6'>Tim</option>
              </Sel>
            </Row>
            <Row label='签名 API' tip='签名服务地址'>
              <Txt id='sign_api_addr' value={formData.sign_api_addr} placeholder='http://127.0.0.1:8080/sign' onChange={handleChange} />
            </Row>
          </PrimaryDiv>
        </SecondaryDiv>
      )}

      {section === 'feature' && (
        <SecondaryDiv className='rounded-xl overflow-hidden animate-fade-in'>
          <HeaderDiv className='px-4 py-2.5 flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <span className='text-sm font-semibold'>🔧 功能开关</span>
              <TagDiv className='px-2 py-0.5 rounded-full text-[10px]'>other.yaml</TagDiv>
            </div>
            <SaveBtn saved={saved} saving={saving} />
          </HeaderDiv>
          <PrimaryDiv className='px-4 py-0.5 divide-y divide-gray-200/10'>
            <Row label='主人 QQ' tip='Yunzai masterQQ，逗号分隔'>
              <Txt id='masterQQ' value={formData.masterQQ} placeholder='12345,67890' onChange={handleChange} />
            </Row>
            <Row label='自动加好友'>
              <Sel id='autoFriend' value={formData.autoFriend} onChange={handleChange}>
                <option value='1'>自动同意</option>
                <option value='0'>不处理</option>
              </Sel>
            </Row>
            <Row label='自动退群阈值' tip='群人数低于此值自动退出，0 不处理'>
              <Txt id='autoQuit' value={formData.autoQuit} type='number' onChange={handleChange} />
            </Row>
            <Row label='禁用私聊'>
              <Switch value={formData.disablePrivate} onChange={v => setBool('disablePrivate', v)} />
            </Row>
            <Row label='私聊提示' tip='禁用私聊时的提示文案'>
              <Txt id='disableMsg' value={formData.disableMsg} onChange={handleChange} />
            </Row>
            <Row label='禁用频道'>
              <Switch value={formData.disableGuildMsg} onChange={v => setBool('disableGuildMsg', v)} />
            </Row>
          </PrimaryDiv>
        </SecondaryDiv>
      )}

      {section === 'runtime' && (
        <SecondaryDiv className='rounded-xl overflow-hidden animate-fade-in'>
          <HeaderDiv className='px-4 py-2.5 flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <span className='text-sm font-semibold'>⚙️ 运行配置</span>
              <TagDiv className='px-2 py-0.5 rounded-full text-[10px]'>bot.yaml</TagDiv>
            </div>
            <SaveBtn saved={saved} saving={saving} />
          </HeaderDiv>
          <PrimaryDiv className='px-4 py-0.5 divide-y divide-gray-200/10'>
            <Row label='日志等级'>
              <Sel id='log_level' value={formData.log_level} onChange={handleChange}>
                <option value='trace'>trace</option>
                <option value='debug'>debug</option>
                <option value='info'>info</option>
                <option value='warn'>warn</option>
                <option value='error'>error</option>
                <option value='mark'>mark</option>
                <option value='off'>off</option>
              </Sel>
            </Row>
            <Row label='分片发送' tip='风控时尝试分片发送'>
              <Switch value={formData.resend} onChange={v => setBool('resend', v)} />
            </Row>
            <Row label='上线推送' tip='上线时给主人推送帮助'>
              <Switch value={formData.online_msg} onChange={v => setBool('online_msg', v)} />
            </Row>
            <Row label='推送冷却' tip='上线推送冷却（秒）'>
              <Txt id='online_msg_exp' value={formData.online_msg_exp} type='number' onChange={handleChange} />
            </Row>
            <Row label='Chromium 路径'>
              <Txt id='chromium_path' value={formData.chromium_path} onChange={handleChange} />
            </Row>
            <Row label='Puppeteer WS'>
              <Txt id='puppeteer_ws' value={formData.puppeteer_ws} onChange={handleChange} />
            </Row>
            <Row label='截图超时(ms)'>
              <Txt id='puppeteer_timeout' value={formData.puppeteer_timeout} onChange={handleChange} />
            </Row>
            <Row label='米游社代理'>
              <Txt id='proxyAddress' value={formData.proxyAddress} onChange={handleChange} />
            </Row>
          </PrimaryDiv>
        </SecondaryDiv>
      )}

      {section === 'blacklist' && (
        <SecondaryDiv className='rounded-xl overflow-hidden animate-fade-in'>
          <HeaderDiv className='px-4 py-2.5 flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <span className='text-sm font-semibold'>📋 黑白名单</span>
              <TagDiv className='px-2 py-0.5 rounded-full text-[10px]'>other.yaml</TagDiv>
            </div>
            <SaveBtn saved={saved} saving={saving} />
          </HeaderDiv>
          <PrimaryDiv className='px-4 py-0.5 divide-y divide-gray-200/10'>
            <Row label='白名单群' tip='逗号分隔，配置后仅在这些群生效'>
              <Txt id='whiteGroup' value={formData.whiteGroup} placeholder='群号1,群号2' onChange={handleChange} />
            </Row>
            <Row label='白名单 QQ'>
              <Txt id='whiteQQ' value={formData.whiteQQ} placeholder='QQ1,QQ2' onChange={handleChange} />
            </Row>
            <Row label='黑名单群'>
              <Txt id='blackGroup' value={formData.blackGroup} placeholder='群号1,群号2' onChange={handleChange} />
            </Row>
            <Row label='黑名单 QQ'>
              <Txt id='blackQQ' value={formData.blackQQ} placeholder='QQ1,QQ2' onChange={handleChange} />
            </Row>
          </PrimaryDiv>
        </SecondaryDiv>
      )}

      {section === 'group' && (
        <SecondaryDiv className='rounded-xl overflow-hidden animate-fade-in'>
          <HeaderDiv className='px-4 py-2.5 flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <span className='text-sm font-semibold'>👥 群聊配置</span>
              <TagDiv className='px-2 py-0.5 rounded-full text-[10px]'>group.yaml</TagDiv>
            </div>
            <SaveBtn saved={saved} saving={saving} />
          </HeaderDiv>
          <PrimaryDiv className='px-4 py-0.5 divide-y divide-gray-200/10'>
            <Row label='全局冷却(ms)'>
              <Txt id='groupGlobalCD' value={formData.groupGlobalCD} type='number' onChange={handleChange} />
            </Row>
            <Row label='个人冷却(ms)'>
              <Txt id='singleCD' value={formData.singleCD} type='number' onChange={handleChange} />
            </Row>
            <Row label='仅@回复' tip='0-否 1-是 2-非主人仅@'>
              <Sel id='onlyReplyAt' value={formData.onlyReplyAt} onChange={handleChange}>
                <option value='0'>否</option>
                <option value='1'>是</option>
                <option value='2'>非主人仅@</option>
              </Sel>
            </Row>
            <Row label='机器人别名' tip='逗号分隔，如：云崽,云宝'>
              <Txt id='botAlias' value={formData.botAlias} placeholder='云崽,云宝' onChange={handleChange} />
            </Row>
            <Row label='表情限制'>
              <Sel id='imgAddLimit' value={formData.imgAddLimit} onChange={handleChange}>
                <option value='0'>所有群员</option>
                <option value='1'>群管理</option>
                <option value='2'>仅主人</option>
              </Sel>
            </Row>
            <Row label='表情大小(MB)'>
              <Txt id='imgMaxSize' value={formData.imgMaxSize} type='number' onChange={handleChange} />
            </Row>
            <Row label='私聊添加'>
              <Sel id='addPrivate' value={formData.addPrivate} onChange={handleChange}>
                <option value='1'>允许</option>
                <option value='0'>禁止</option>
              </Sel>
            </Row>
          </PrimaryDiv>
        </SecondaryDiv>
      )}

      {section === 'redis' && (
        <SecondaryDiv className='rounded-xl overflow-hidden animate-fade-in'>
          <HeaderDiv className='px-4 py-2.5 flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <span className='text-sm font-semibold'>🗄️ Redis</span>
              <TagDiv className='px-2 py-0.5 rounded-full text-[10px]'>redis.yaml</TagDiv>
            </div>
            <SaveBtn saved={saved} saving={saving} />
          </HeaderDiv>
          <PrimaryDiv className='px-4 py-0.5 divide-y divide-gray-200/10'>
            <Row label='地址'>
              <Txt id='redis_host' value={formData.redis_host} placeholder='127.0.0.1' onChange={handleChange} />
            </Row>
            <Row label='端口'>
              <Txt id='redis_port' value={formData.redis_port} type='number' onChange={handleChange} />
            </Row>
            <Row label='用户名'>
              <Txt id='redis_username' value={formData.redis_username} onChange={handleChange} />
            </Row>
            <Row label='密码'>
              <Txt id='redis_password' value={formData.redis_password} type='password' onChange={handleChange} />
            </Row>
            <Row label='数据库'>
              <Txt id='redis_db' value={formData.redis_db} type='number' onChange={handleChange} />
            </Row>
          </PrimaryDiv>
        </SecondaryDiv>
      )}

      {section === 'notice' && (
        <SecondaryDiv className='rounded-xl overflow-hidden animate-fade-in'>
          <HeaderDiv className='px-4 py-2.5 flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <span className='text-sm font-semibold'>🔔 通知推送</span>
              <TagDiv className='px-2 py-0.5 rounded-full text-[10px]'>notice.yaml</TagDiv>
            </div>
            <SaveBtn saved={saved} saving={saving} />
          </HeaderDiv>
          <PrimaryDiv className='px-4 py-0.5 divide-y divide-gray-200/10'>
            <Row label='IYUU Token'>
              <Txt id='iyuu' value={formData.iyuu} onChange={handleChange} />
            </Row>
            <Row label='Server 酱'>
              <Txt id='sct' value={formData.sct} onChange={handleChange} />
            </Row>
            <Row label='飞书 Webhook'>
              <Txt id='feishu_webhook' value={formData.feishu_webhook} onChange={handleChange} />
            </Row>
          </PrimaryDiv>
        </SecondaryDiv>
      )}
    </form>
  );
}
