import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Format } from '../../node_modules/alemonjs/lib/application/format/message-format.js';
const directory = await mkdtemp(join(tmpdir(), 'yunzai-qq-md-'));
const events = [];
const calls = [];
const handlers = {};
let resultReady;
let failure;
let markdownToText = false;
let unavailable = false;
let uploads = 0;
let deletes = 0;
const remote = new Map();
const ok = data => ({ code: 2000, data });
const send = async (format, target) => {
  calls.push({ format: format.value, target });
  if (failure) {
    const result = failure;
    failure = undefined;
    return [result];
  }
  return [ok({ id: `msg-${calls.length}` })];
};
const media = {
  list: async () => unavailable ? { code: 4000 } : ok({ Items: [...remote.values()], Total: remote.size }),
  upload: async params => {
    uploads++;
    const resource = { kind: 'media-resource', type: 'image', usage: 'markdown', id: `r-${uploads}`,
      owner: { platform: 'qq-bot', botId: 'bot' }, reference: `qqbot-media://image/v1/r-${uploads}`,
      expiration: { mode: 'sliding', windowSeconds: 7776000 } };
    remote.set(resource.id, resource);
    return ok(resource);
  },
  delete: async resource => { deletes++; remote.delete(resource.id); return ok({}); }
};
const manager = { isReady: true, send: message => events.push(message), sendToWorker: message => resultReady(message) };
for (const name of ['Reply', 'Done', 'ApiRequest', 'WorkerExit', 'Ready']) manager[`on${name}`] = cb => { handlers[name] = cb; };
mock.module(new URL('../../lib/yunzai/manager.js', import.meta.url).href, { namedExports: { manager } });
mock.module(new URL('../../lib/path.js', import.meta.url).href, { namedExports: { getYunzaiEventConcurrency: () => 1 } });
const noop = () => {};
mock.module('alemonjs', { namedExports: {
  Format, ResultCode: { Ok: 2000 }, getConfigValue: () => ({ 'qq-bot': { markdownToText } }),
  logger: { info: noop, debug: noop, warn: noop, error: noop },
  useMessage: () => [{ send: ({ format }) => send(format, 'reply') }], useMedia: () => [media],
  MessageDirect: { create: () => ({ sendToTarget: ({ target, format }) => send(format, target) }) },
  sendToChannel: noop, sendToUser: noop, useGuild: noop, useMe: noop, useMember: noop, useClient: noop, useRequest: noop, useUser: noop
} });
mock.module('@alemonjs/onebot', { namedExports: { API: {} } });
const original = await import('../../lib/yunzai/qq-material-cache.js');
mock.module(new URL('../../lib/yunzai/qq-material-cache.js', import.meta.url).href, { namedExports: {
  ...original,
  QQMaterialCache: class extends original.QQMaterialCache { constructor(_dir, warn) { super(directory, warn); } }
} });
mock.timers.enable({ apis: ['setTimeout'] });
const { default: bridge } = await import('../../lib/yunzai/bridge.js');
const event = { name: 'message.create', Platform: 'qq-bot', BotId: 'bot', GuildId: 'group', ChannelId: 'group', UserId: 'user', MessageId: 'message', MessageText: 'hello' };
bridge(event, noop);
const id = events.at(-1).id;
const image = { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1sAAAAASUVORK5CYII=' };
const text = { type: 'text', data: '面板说明' };
const md = { type: 'markdown', data: '**面板**\n![已有链接](https://example.com/image.png)' };
const button = { type: 'button', data: '', buttonData: [[{ title: '更新', data: '#更新' }]] };
const request = message => {
  calls.length = 0;
  const response = new Promise(resolve => { resultReady = resolve; });
  if (message.type === 'api_request') handlers.ApiRequest(message);
  else handlers.Reply({ id, replyId: 'reply', ...message });
  return response;
};
try {
  assert.equal((await request({ contents: [text, image, md, button] })).ok, true);
  assert.equal(calls.length, 1);
  assert.equal(uploads, 1);
  assert.deepEqual(calls[0].format.map(item => item.type), ['MarkdownOriginal', 'MarkdownOriginal', 'MarkdownOriginal', 'BT.group']);
  assert.match(calls[0].format[1].value, /qqbot-media:\/\/image\/v1\/r-1/);
  assert.match(calls[0].format[1].value, /^!\[图片 #0 #0\]\(qqbot-media:/, 'image carries the size annotation QQ clients require');
  const callbackMsg = { type: 'button', data: '', buttonData: [[{ text: '卡片', callback: '#卡片' }, { text: '主页', link: 'https://example.com' }]] };
  assert.equal((await request({ contents: [text, callbackMsg] })).ok, true);
  const callbackGroup = calls[0].format.find(item => item.type === 'BT.group');
  assert.deepEqual(callbackGroup.value[0].value.map(button => [button.options.data, button.options.type]), [['#卡片', 'call'], ['https://example.com', 'link']]);
  assert.equal(calls[0].format[2].value, md.data);
  assert.equal((await request({ contents: [image, button] })).ok, true);
  assert.equal(uploads, 1, 'identical image bypasses upload');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].format.map(item => item.type), ['MarkdownOriginal', 'BT.group']);
  await request({ contents: [{ type: 'forward', data: '', fallback: [image, md, button] }] });
  assert.equal(calls.length, 1);

  for (const action of ['sendGroupMsg', 'sendPrivateMsg']) {
    assert.equal((await request({ type: 'api_request', reqId: action, msgId: id, action, params: { group_id: 'another-group', user_id: 'another-user', contents: [image, md, button] } })).ok, true);
    assert.deepEqual(calls[0].target, { scope: action === 'sendGroupMsg' ? 'group' : 'c2c', targetId: action === 'sendGroupMsg' ? 'another-group' : 'another-user', BotId: 'bot' });
  }
  failure = { code: 4000, message: { code: 40035009 } };
  assert.equal((await request({ contents: [image, button] })).ok, true);
  assert.equal(calls.length, 2, 'explicit invalid reference gets exactly one retry');
  assert.equal(uploads, 2);
  assert.equal(deletes, 1);
  assert.match(calls[1].format[0].value, /r-2/);
  failure = { code: 4000, message: 'timeout' };
  assert.equal((await request({ contents: [image, button] })).ok, false);
  assert.equal(calls.length, 1, 'uncertain send never retries or falls back');
  assert.equal(uploads, 2);
  markdownToText = true;
  assert.equal((await request({ contents: [image, md, button] })).ok, true);
  assert.equal(calls.length, 2);
  assert.equal(uploads, 2, 'disabled Markdown does not allocate resources');
  markdownToText = false;
  unavailable = true;
  const changed = { ...image, data: Buffer.concat([Buffer.from(image.data, 'base64'), Buffer.from('changed')]).toString('base64') };
  assert.equal((await request({ contents: [changed, md, button] })).ok, true);
  assert.equal(calls.length, 2, 'preparation failure falls back before sending');
  assert.deepEqual(calls.map(call => call.format.map(item => item.type)), [['Image'], ['MarkdownOriginal', 'BT.group']]);
  assert.equal(uploads, 2);
  console.log('QQ Markdown material bridge passed');
} finally {
  handlers.WorkerExit();
  mock.timers.reset();
  await rm(directory, { recursive: true, force: true });
}
