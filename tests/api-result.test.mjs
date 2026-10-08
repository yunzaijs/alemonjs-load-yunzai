import assert from 'node:assert/strict';
import test from 'node:test';
import { createOneBotClientCompat, normalizeWorkerApiResult, toOneBotApiResponse, unwrapOneBotResult } from '../lib/yunzai/api-result.js';
import { OneBotWebCredentials, needsQQWebCredentials } from '../lib/yunzai/web-credentials.js';
import { sendNativeForward } from '../lib/yunzai/forward.js';

const ok = data => [{ code: 2000, message: '请求完成', data }];

test('query results remove host wrappers while sendApi retains OneBot response contract', async () => {
  const profile = { user_id: 123456, nickname: 'fixture nickname' };
  const client = createOneBotClientCompat({ send: async () => ok(profile) });
  assert.deepEqual(await client.send({ action: 'get_stranger_info' }), profile);
  assert.deepEqual(toOneBotApiResponse(await client.send({})), { status: 'ok', retcode: 0, data: profile });
  assert.deepEqual(normalizeWorkerApiResult(ok(profile)), { data: profile });
  const native = { status: 'ok', retcode: 0, data: profile };
  assert.deepEqual(toOneBotApiResponse(ok(native)), native);
  const messages = [{ message_id: 123 }, { message_id: 456 }];
  assert.deepEqual(unwrapOneBotResult(messages), messages);
  assert.deepEqual(unwrapOneBotResult(ok(messages)), messages);
  assert.throws(() => toOneBotApiResponse([{ code: 4000, message: '请求失败', data: null }]), /请求失败/);
  assert.throws(() => unwrapOneBotResult(ok({ status: 'failed', retcode: 1404, wording: 'unsupported action' })), /unsupported/);
});

test('real OneBot SDK discards rejection wording but distinguishes it from timeout', async () => {
  const { OneBotAPI, consume } = await import('../node_modules/@alemonjs/onebot/lib/sdk/api.js');
  const api = new OneBotAPI();
  api.__ws = {
    readyState: 1,
    send: (text, callback) => {
      callback();
      const request = JSON.parse(text);
      queueMicrotask(() => consume({ echo: request.echo, status: 'failed', retcode: 100, wording: 'native failure', data: null }));
    }
  };
  let rejection = 'not rejected';
  try { await api.send({ action: 'send_group_forward_msg', params: {} }); } catch (error) { rejection = error; }
  assert.equal(rejection, null);
  assert.throws(() => unwrapOneBotResult([{ code: 4000, message: '请求失败', data: rejection }]), error => error.oneBotActionRejected === true);
  for (const result of [
    [{ code: 4000, message: '接口超时', data: null }],
    [{ code: 4000, message: '请求失败', data: { message: 'WebSocket 未连接' } }]
  ]) {
    assert.throws(() => unwrapOneBotResult(result), error => error.oneBotActionRejected === false);
  }
  await assert.rejects(sendNativeForward({ send: async () => ok(null) }, { action: 'send_group_forward_msg', params: { messages: [] } }), /发送状态未知/);
});

test('QQ web credentials populate synchronous plugin fields and remain isolated by bot', async () => {
  let botId = '123456';
  const calls = [];
  const credentials = new OneBotWebCredentials(async (action, params) => {
    calls.push({ botId, action, params });
    return action === 'getCookies' ? { cookies: `fixture_${botId}=test;` } : { token: Number(botId) };
  }, () => botId);
  await Promise.all([credentials.prepare(), credentials.prepare()]);
  assert.equal(calls.length, 2);
  assert.equal(credentials.cookies['qun.qq.com'], 'fixture_123456=test;');
  assert.equal(credentials.bkn, 123456);
  await credentials.prepare();
  assert.equal(calls.length, 2);
  botId = '654321';
  assert.equal(credentials.cookies['qun.qq.com'], undefined);
  await credentials.prepare();
  assert.equal(credentials.cookies['qun.qq.com'], 'fixture_654321=test;');
  assert.equal(credentials.bkn, 654321);
  botId = '123456';
  assert.equal(credentials.bkn, 123456);
  assert.deepEqual(calls[0].params, { domain: 'qun.qq.com' });
  for (const command of ['#查群公告', '#查公告', '#今日打卡', '#发群公告测试内容']) assert.equal(needsQQWebCredentials(command), true);
  for (const command of ['#兑换码', '#历史头像', '今日打卡']) assert.equal(needsQQWebCredentials(command), false);
});

test('unavailable web credentials fail explicitly instead of inventing cookies or token', async () => {
  const credentials = new OneBotWebCredentials(async () => null, () => '123456');
  await assert.rejects(credentials.prepare(), /未提供可用/);
  assert.equal(credentials.cookies['qun.qq.com'], undefined);
  assert.equal(credentials.bkn, undefined);
});

test('credential failures retain successful fields, back off, and recover independently', async () => {
  let now = 1000;
  let failCookie = true;
  const calls = [];
  const credentials = new OneBotWebCredentials(async (action, params) => {
    calls.push([action, params?.domain]);
    if (action === 'getCsrfToken') return { token: 123 };
    if (failCookie && params.domain === 'qun.qq.com') throw new Error('private upstream payload');
    return { cookies: `${params.domain}=fixture;` };
  }, () => '123456', () => now);
  await assert.rejects(credentials.prepare(['qun.qq.com', 'qzone.qq.com', 'qzone.qq.com']), /Cookie/);
  assert.equal(calls.length, 3);
  assert.equal(credentials.bkn, 123);
  assert.equal(credentials.cookies['qzone.qq.com'], 'qzone.qq.com=fixture;');
  await assert.rejects(credentials.prepare(['qun.qq.com', 'qzone.qq.com']), /Cookie/);
  assert.equal(calls.length, 3);
  failCookie = false;
  now += 30_000;
  await credentials.prepare(['qun.qq.com', 'qzone.qq.com']);
  assert.equal(calls.length, 4);
  assert.equal(credentials.cookies['qun.qq.com'], 'qun.qq.com=fixture;');
  now += 5 * 60_000;
  assert.equal(credentials.bkn, undefined);
  assert.equal(credentials.cookies['qun.qq.com'], undefined);
  assert.equal(credentials.cookies['qzone.qq.com'], undefined);
  failCookie = true;
  await assert.rejects(credentials.prepare(), /Cookie/);
  assert.equal(credentials.cookies['qun.qq.com'], undefined);
  assert.equal(credentials.bkn, 123);
});

test('direct concurrent credential requests share one request per account and domain', async () => {
  let calls = 0;
  const credentials = new OneBotWebCredentials(async () => {
    calls++;
    return { cookies: 'fixture=test;' };
  }, () => '123456');
  const cookies = await Promise.all([credentials.getCookies('qun.qq.com'), credentials.getCookies('qun.qq.com')]);
  assert.deepEqual(cookies, ['fixture=test;', 'fixture=test;']);
  assert.equal(calls, 1);
  await credentials.getCookies('qzone.qq.com');
  assert.equal(calls, 2);
});

test('plugin web capability discovery covers domains without loading plugin code', async () => {
  const { inspectQQWebCapabilities, discoverQQWebCapabilities } = await import('../lib/yunzai/web-capabilities.js');
  const { mkdtemp, mkdir, writeFile, symlink, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const capabilities = inspectQQWebCapabilities(`
    Bot.cookies["qun.qq.com"]; common.getck('qzone.qq.com', bot);
    Bot.getCookies('vip.qq.com'); Bot.getCookies(''); Bot.bkn;
    Bot.cookies["https://example.com"]; Bot.cookies["evilqq.com"];
  `);
  assert.deepEqual(capabilities, { domains: ['', 'qun.qq.com', 'qzone.qq.com', 'vip.qq.com'], csrf: true });
  const root = await mkdtemp(path.join(tmpdir(), 'yunzai-capabilities-'));
  try {
    await mkdir(path.join(root, 'model'));
    await mkdir(path.join(root, 'node_modules'));
    await writeFile(path.join(root, 'model', 'api.js'), 'throw new Error("must not execute"); Bot.cookies["qun.qq.com"]; Bot.bkn;');
    await writeFile(path.join(root, 'node_modules', 'ignored.js'), 'Bot.cookies["ignored.qq.com"]');
    await symlink(root, path.join(root, 'cycle'));
    assert.deepEqual(await discoverQQWebCapabilities(root), { domains: ['qun.qq.com'], csrf: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plugins without QQ web dependencies issue no credential requests', async () => {
  let calls = 0;
  const credentials = new OneBotWebCredentials(async () => { calls++; }, () => '123456');
  await credentials.prepare([], false);
  assert.equal(calls, 0);
});

test('native sends serialize local media inside nested forward nodes without changing input', async () => {
  const { serializeNativeMessageMedia } = await import('../lib/yunzai/native-media.js');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = await mkdtemp(path.join(tmpdir(), 'yunzai-native-media-'));
  try {
    const file = path.join(root, '奥 藏.jpg');
    const image = Buffer.from('native image fixture');
    await writeFile(file, image);
    const request = { group_id: 123, messages: [{ type: 'node', data: { name: 'A', uin: 123, content: [
      { type: 'image', data: { file, cache: 0 } },
      { type: 'node', data: { content: [{ type: 'record', data: { file, magic: true } }] } },
      { type: 'node', data: { id: 'reference-only' } },
      { type: 'text', data: { text: 'unchanged' } }
    ] } }] };
    const result = await serializeNativeMessageMedia(request);
    const content = result.messages[0].data.content;
    assert.deepEqual(content[0].data, { file: `base64://${image.toString('base64')}`, cache: 0 });
    assert.deepEqual(content[1].data.content[0].data, { file: `base64://${image.toString('base64')}`, magic: true });
    assert.deepEqual(content[2], request.messages[0].data.content[2]);
    assert.deepEqual(content[3], request.messages[0].data.content[3]);
    assert.equal(request.messages[0].data.content[0].data.file, file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
