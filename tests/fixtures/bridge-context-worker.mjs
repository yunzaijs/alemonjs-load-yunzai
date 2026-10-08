import assert from 'node:assert/strict';
import { mock } from 'node:test';

const sent = [];
const responses = [];
const native = [];
const memberQueries = [];
let forwardFailure = 'rejected';
const handlers = {};
const manager = { isReady: true, send: message => sent.push(message), sendToWorker: message => responses.push(message) };
for (const name of ['Reply', 'Done', 'ApiRequest', 'WorkerExit', 'Ready']) {
  manager[`on${name}`] = callback => { handlers[name] = callback; };
}
mock.module(new URL('../../lib/yunzai/manager.js', import.meta.url).href, { namedExports: { manager } });
mock.module(new URL('../../lib/path.js', import.meta.url).href, { namedExports: { getYunzaiEventConcurrency: () => 1 } });
const noop = () => {};
let clientLoaded;
const clientReady = new Promise(resolve => { clientLoaded = resolve; });
mock.module('alemonjs', {
  namedExports: {
    Format: class {}, ResultCode: { Ok: 2000 }, logger: {
      info: message => { if (message.includes('@alemonjs/onebot API 已加载')) clientLoaded(); },
      debug: noop, warn: noop, error: noop
    },
    sendToChannel: noop, sendToUser: noop, useMessage: () => [{}], useGuild: noop, useMe: noop,
    useMember: () => [{ info: async params => { memberQueries.push(params); return [{ code: 2000, data: { user_id: 10001, nickname: 'member' } }]; } }],
    useRequest: noop, useUser: noop,
    useClient: event => [{ send: async request => {
      native.push({ request, botId: event.BotId });
      if (request.action === 'send_group_forward_msg') {
        return [{ code: 4000, message: forwardFailure === 'timeout' ? '接口超时' : '请求失败', data: null }];
      }
      if (request.action === 'unsupported_test') return [{ code: 4000, message: '请求失败', data: null }];
      const data = request.action === 'get_msg' ? { message_id: request.params.message_id, message: [{ type: 'text', data: { text: 'quoted' } }] }
        : request.action === 'get_stranger_info' ? { user_id: 10001, nickname: 'profile' }
        : request.action === 'get_cookies' ? { cookies: 'fixture_cookie=test;' }
        : request.action === 'get_csrf_token' ? { token: 123 }
        : request.action === 'send_group_msg' ? { message_id: 777 }
        : { messages: [{ message_id: 123 }] };
      return [{ code: 2000, message: '请求完成', data }];
    } }]
  }
});
mock.module('@alemonjs/onebot', { namedExports: { API: {} } });
mock.timers.enable({ apis: ['setTimeout'] });
const { default: bridge } = await import('../../lib/yunzai/bridge.js');
const event = botId => ({
  name: 'message.create', Platform: 'onebot', BotId: botId, GuildId: '20001', ChannelId: '20001',
  UserId: '10001', MessageId: botId, MessageText: 'hello',
  value: { post_type: 'message', self_id: botId, message_id: botId, user_id: 10001, group_id: 20001, message: [] }
});
const flush = () => new Promise(resolve => setImmediate(resolve));
const api = async (msgId, action, params, rawOneBot = false) => {
  handlers.ApiRequest({ reqId: String(responses.length), msgId, action, params, rawOneBot });
  await flush();
  return responses.at(-1);
};

bridge(event('123456'), noop);
await clientReady;
const firstId = sent[0].id;
handlers.Done({ id: firstId, replied: false });
bridge(event('654321'), noop);
const secondId = sent[1].id;
handlers.Done({ id: secondId, replied: false });

assert.equal((await api(firstId, 'getChatHistory', { group_id: 20001 })).ok, true);
assert.equal(responses.at(-1).data.messages[0].message_id, 123);
assert.equal(native.at(-1).botId, '123456');
assert.equal('message_seq' in native.at(-1).request.params, false);
assert.equal((await api(secondId, 'getMsg', { message_id: 'opaque-id' })).ok, true);
assert.equal(native.at(-1).botId, '654321');
assert.equal(native.at(-1).request.params.message_id, 'opaque-id');
assert.equal((await api(firstId, 'getMsg', { message_id: '-123' })).ok, true);
assert.equal(native.at(-1).request.params.message_id, -123);
assert.equal(responses.at(-1).data.message_id, -123);
const rawProfile = await api(firstId, 'get_stranger_info', { user_id: 10001 }, true);
assert.equal(rawProfile.data.status, 'ok');
assert.equal(rawProfile.data.data.nickname, 'profile');
assert.equal((await api(firstId, 'unsupported_test', {}, true)).ok, false);
assert.equal((await api(firstId, 'getCookies', { domain: 'qun.qq.com' })).data.cookies, 'fixture_cookie=test;');
assert.deepEqual(native.at(-1).request.params, { domain: 'qun.qq.com' });
assert.equal((await api(firstId, 'getCsrfToken', {})).data.token, 123);
assert.equal((await api(firstId, 'getGroupMemberInfo', { group_id: 20001, user_id: '呢' })).ok, false);
assert.equal(memberQueries.length, 0);
assert.equal((await api(firstId, 'getGroupMemberInfo', { group_id: 20001, user_id: '10001' })).ok, true);
assert.equal(memberQueries[0].userId, '10001');
assert.equal(responses.at(-1).data.data.nickname, 'member');
assert.equal((await api('unknown', 'getChatHistory', { group_id: 20001 })).ok, false);

const forward = {
  type: 'forward', data: 'summary', nodes: [{ user_id: 10001, nickname: 'name', message: '兑换码内容' }],
  fallback: [{ type: 'text', data: '兑换码内容' }, { type: 'image', data: 'base64://aGVsbG8=' }]
};
handlers.Reply({ id: firstId, replyId: 'forward-ok', contents: [forward] });
await flush();
assert.deepEqual(native.slice(-2).map(item => item.request.action), ['send_group_forward_msg', 'send_group_msg']);
assert.ok(native.at(-1).request.params.message.some(segment => segment.data.text === '兑换码内容'));
assert.ok(native.at(-1).request.params.message.some(segment => segment.data.file === 'base64://aGVsbG8='));
assert.equal(responses.at(-1).ok, true);
assert.equal(responses.at(-1).messageId, '777');
forwardFailure = 'timeout';
const requestCount = native.length;
handlers.Reply({ id: firstId, replyId: 'forward-timeout', contents: [forward] });
await flush();
assert.equal(native.length, requestCount + 1);
assert.equal(responses.at(-1).ok, false);

mock.timers.tick(8 * 60_000);
assert.equal((await api(firstId, 'getChatHistory', { group_id: 20001 })).ok, false);
bridge(event('987654'), noop);
const lastId = sent.at(-1).id;
handlers.WorkerExit();
assert.equal((await api(lastId, 'getChatHistory', { group_id: 20001 })).ok, false);
mock.timers.reset();
console.log('bridge context lifecycle passed');
