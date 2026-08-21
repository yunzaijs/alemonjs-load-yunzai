import test from 'node:test';
import assert from 'node:assert/strict';

import { createOneBotRuntime, isOneBotPlatform } from '../lib/yunzai/adapters/onebot-icqq.js';
import {
  assertOneBotActionSucceeded,
  buildForwardMsgCompat,
  getNativeMessageRequest,
  getNativeOneBotRequest,
  getNativeForwardRequest,
  getReplyMessageId,
  isUnsupportedOneBotActionError,
  sendNativeForward
} from '../lib/yunzai/forward.js';
import { getExecutionContext, getExecutionContextForAction, runWithExecutionContext } from '../lib/yunzai/execution-context.js';
import { createCompatValueWrapper } from '../lib/yunzai/compat.js';
import {
  oneBotGroupMessageEvent,
  oneBotNoticeEvent,
  oneBotPrivateMessageEvent,
  oneBotQuotedGroupMessageEvent,
  oneBotRequestEvent
} from './fixtures/onebot-events.mjs';

function createRuntimeMock(overrides = {}) {
  const apiCalls = [];
  const apiMap = new Map(Object.entries(overrides.api ?? {}));
  const runtime = createOneBotRuntime({
    callApi: async (action, params = {}) => {
      apiCalls.push({ action, params });
      if (apiMap.has(action)) {
        const value = apiMap.get(action);

        return typeof value === 'function' ? value(params) : value;
      }

      return {};
    },
    serializeReply: async msg => [{ type: 'text', data: String(msg) }],
    wrapCompatValue: overrides.wrapCompatValue ?? (value => value),
    safeInt: (value, fallback) => {
      const parsed = Number.parseInt(String(value), 10);

      return Number.isFinite(parsed) ? parsed : fallback;
    },
    resolveMasterFlag: data => data.isMaster ?? data.IsMaster ?? false,
    buildForwardMsgCompat: nodes => ({
      type: 'forward',
      data: 'forward-text',
      file: '',
      id: '',
      resid: '',
      message: nodes,
      messages: nodes,
      __forwardParts: nodes,
      toString: () => 'forward-text'
    })
  });

  return { runtime, apiCalls };
}

test('isOneBotPlatform only matches onebot', () => {
  assert.equal(isOneBotPlatform('onebot'), true);
  assert.equal(isOneBotPlatform('qq-bot'), false);
  assert.equal(isOneBotPlatform(undefined), false);
});

test('execution contexts remain isolated across concurrent plugin work', async () => {
  const seen = await Promise.all([
    runWithExecutionContext({ msgId: 'event-a', platform: 'onebot' }, async () => {
      await new Promise(resolve => setTimeout(resolve, 10));

      return getExecutionContext();
    }),
    runWithExecutionContext({ msgId: 'event-b', platform: 'onebot' }, async () => {
      await new Promise(resolve => setTimeout(resolve, 1));

      return getExecutionContext();
    })
  ]);

  assert.deepEqual(seen, [
    { msgId: 'event-a', platform: 'onebot' },
    { msgId: 'event-b', platform: 'onebot' }
  ]);
  assert.equal(getExecutionContextForAction('sendGroupMsg'), undefined);
  assert.throws(() => getExecutionContextForAction('deleteMsg'), /缺少事件上下文/);
});

test('forward compatibility preserves nodes and builds a readable fallback', () => {
  const nodes = [
    { user_id: 10001, nickname: 'Alice', message: 'hello' },
    {
      type: 'node',
      data: {
        user_id: 10002,
        nickname: 'Bob',
        content: [{ type: 'image', file: 'https://example.com/a.png' }, { type: 'at', qq: 10003 }]
      }
    }
  ];
  const forward = buildForwardMsgCompat(nodes);

  assert.equal(forward.type, 'forward');
  assert.strictEqual(forward.__forwardNodes, nodes);
  assert.deepEqual(forward.__forwardParts, [
    { type: 'text', text: '【Alice】\n' },
    { type: 'text', text: 'hello\n' },
    { type: 'text', text: '【Bob】\n' },
    { type: 'image', file: 'https://example.com/a.png' },
    { type: 'at', qq: 10003 },
    { type: 'text', text: '\n' }
  ]);
});

test('native forward request uses correct OneBot action and preserves nodes', async () => {
  const nodes = [{ type: 'node', data: { user_id: 10001, nickname: 'Alice', content: 'hello' } }];
  const contents = [{ type: 'forward', data: '【Alice】\nhello', nodes, fallback: [{ type: 'text', data: '【Alice】\nhello' }] }];
  const groupRequest = getNativeForwardRequest(contents, { isPrivate: false, groupId: '20001' });
  const privateRequest = getNativeForwardRequest(contents, { isPrivate: true, userId: '10001' });
  const calls = [];
  const client = {
    send: async request => {
      calls.push(request);

      return { status: 'ok', data: { message_id: 666 } };
    }
  };

  assert.deepEqual(groupRequest, {
    action: 'send_group_forward_msg',
    params: { group_id: 20001, messages: nodes }
  });
  assert.deepEqual(privateRequest, {
    action: 'send_private_forward_msg',
    params: { user_id: 10001, messages: nodes }
  });
  assert.equal(getNativeForwardRequest([...contents, { type: 'text', data: 'extra' }], { isPrivate: false, groupId: 20001 }), null);

  const result = await sendNativeForward(client, groupRequest);

  assert.deepEqual(calls, [groupRequest]);
  assert.equal(getReplyMessageId(result), '666');
});

test('quoted messages use native OneBot send actions and expand quoted forwards safely', () => {
  const quote = [{ type: 'text', data: 'pong', quoteMessageId: '777' }];
  const groupRequest = getNativeOneBotRequest(quote, { isPrivate: false, groupId: 20001 });
  const privateRequest = getNativeOneBotRequest(quote, { isPrivate: true, userId: 10001 });
  const forward = buildForwardMsgCompat([{ user_id: 10001, nickname: 'Alice', message: 'hello' }]);
  const quotedForward = getNativeOneBotRequest([
    {
      type: 'forward',
      data: forward.data,
      nodes: forward.__forwardNodes,
      fallback: [{ type: 'text', data: '【Alice】\nhello\n' }],
      quoteMessageId: '888'
    }
  ], { isPrivate: false, groupId: 20001 });

  assert.deepEqual(groupRequest, {
    action: 'send_group_msg',
    params: {
      group_id: 20001,
      message: [{ type: 'reply', data: { id: '777' } }, { type: 'text', data: { text: 'pong' } }]
    }
  });
  assert.deepEqual(privateRequest, {
    action: 'send_private_msg',
    params: {
      user_id: 10001,
      message: [{ type: 'reply', data: { id: '777' } }, { type: 'text', data: { text: 'pong' } }]
    }
  });
  assert.deepEqual(quotedForward, {
    action: 'send_group_msg',
    params: {
      group_id: 20001,
      message: [{ type: 'reply', data: { id: '888' } }, { type: 'text', data: { text: '【Alice】\nhello\n' } }]
    }
  });
});

test('standard OneBot messages preserve structured segments and media parameters', () => {
  const contents = [
    { type: 'text', data: 'hello ' },
    { type: 'at', data: '10001' },
    { type: 'image', data: 'aGVsbG8=', params: { cache: 0, proxy: true, timeout: 30 } },
    { type: 'record', data: 'https://example.com/voice.mp3', params: { magic: true } },
    { type: 'json', data: '{"app":"com.tencent.structmsg"}' },
    { type: 'xml', data: '<msg>hello</msg>' }
  ];

  assert.deepEqual(getNativeMessageRequest(contents, { isPrivate: false, groupId: 20001 }), {
    action: 'send_group_msg',
    params: {
      group_id: 20001,
      message: [
        { type: 'text', data: { text: 'hello ' } },
        { type: 'at', data: { qq: '10001' } },
        { type: 'image', data: { cache: 0, proxy: true, timeout: 30, file: 'base64://aGVsbG8=' } },
        { type: 'record', data: { magic: true, file: 'https://example.com/voice.mp3' } },
        { type: 'json', data: { data: '{"app":"com.tencent.structmsg"}' } },
        { type: 'xml', data: { data: '<msg>hello</msg>' } }
      ]
    }
  });
  assert.equal(getNativeMessageRequest([{ type: 'other', data: 'unknown' }], { isPrivate: false, groupId: 20001 }), null);
});

test('only explicit unsupported OneBot errors are eligible for forward fallback', () => {
  assert.equal(isUnsupportedOneBotActionError(new Error('unsupported action: send_group_forward_msg')), true);
  assert.equal(isUnsupportedOneBotActionError(new Error('参数不支持')), true);
  assert.equal(isUnsupportedOneBotActionError(new Error('request timed out')), false);
  assert.equal(isUnsupportedOneBotActionError(new Error('socket disconnected')), false);
  assert.throws(() => assertOneBotActionSucceeded({ status: 'failed', retcode: 1404, wording: 'unsupported action' }), /unsupported action/);
});

test('bot adapter normalizes friend and group caches', async () => {
  const { runtime } = createRuntimeMock({
    api: {
      getFriendList: {
        data: [{ user_id: 10001, nickname: 'Alice', card: 'AliceCard' }]
      },
      getGroupList: {
        data: [{ group_id: 20001, group_name: 'GroupA', member_count: 3, max_member_count: 500 }]
      },
      getGroupMemberList: {
        data: [{ user_id: 10001, nickname: 'Alice', role: 'admin', title: 'Boss' }]
      }
    }
  });
  const botState = {
    nickname: 'Bot',
    tiny_id: '',
    avatar: '',
    fl: new Map(),
    gl: new Map(),
    gml: new Map(),
    stat: {},
    uin: 123456
  };
  const bot = runtime.createOneBotBotAdapter(botState);

  const friendMap = await bot.getFriendList();
  const friend = friendMap.get(10001);

  assert.equal(friend.nickname, 'Alice');
  assert.equal(friend.card, 'AliceCard');
  assert.equal(friend.remark, 'AliceCard');

  const groupMap = await bot.getGroupList();
  const group = groupMap.get(20001);

  assert.equal(group.group_name, 'GroupA');
  assert.equal(group.member_count, 3);

  const memberMap = await bot.getGroupMemberList(20001);
  const member = memberMap.get(10001);

  assert.equal(member.nickname, 'Alice');
  assert.equal(member.card, 'Alice');
  assert.equal(member.remark, 'Alice');
  assert.equal(member.role, 'admin');
});

test('bot adapter getLoginInfo updates runtime identity state', async () => {
  const { runtime } = createRuntimeMock({
    api: {
      getLoginInfo: {
        data: {
          user_id: 654321,
          nickname: 'UpdatedBot',
          avatar: 'https://example.com/bot.png'
        }
      }
    }
  });
  const botState = {
    nickname: 'Bot',
    tiny_id: '',
    avatar: '',
    fl: new Map(),
    gl: new Map(),
    gml: new Map(),
    stat: {},
    uin: 123456
  };
  const bot = runtime.createOneBotBotAdapter(botState);

  const loginInfo = await bot.getLoginInfo();

  assert.deepEqual(loginInfo, { user_id: 654321, nickname: 'UpdatedBot' });
  assert.equal(botState.uin, 654321);
  assert.equal(botState.nickname, 'UpdatedBot');
  assert.equal(botState.avatar, 'https://example.com/bot.png');
});

test('group and friend adapters expose icqq-like methods', async () => {
  const { runtime, apiCalls } = createRuntimeMock({
    api: {
      getGroupMemberList: {
        data: [{ user_id: 10001, card: 'MemberCard', role: 'owner', title: 'Leader', level: 9 }]
      },
      getGroupMemberInfo: {
        data: { user_id: 10001, nickname: 'MemberNick', card: 'MemberCard', role: 'owner', title: 'Leader', level: 9 }
      },
      getPrivateFileUrl: {
        data: { url: 'https://example.com/file' }
      }
    }
  });
  const botState = {
    nickname: 'Bot',
    tiny_id: '',
    avatar: '',
    fl: new Map([[10001, { user_id: 10001, nickname: 'Alice', remark: 'AliceRemark' }]]),
    gl: new Map(),
    gml: new Map(),
    stat: {},
    uin: 123456
  };

  runtime.createOneBotBotAdapter(botState);

  const group = runtime.createOneBotGroupAdapter(20001, { name: 'GroupA' });
  const memberMap = await group.getMemberMap();
  const member = group.pickMember(10001);

  assert.equal(memberMap.get(10001).role, 'owner');
  assert.equal(member.card, 'MemberCard');
  assert.equal(member.is_owner, true);
  assert.equal((await member.info).nickname, 'MemberNick');
  assert.deepEqual(await member.getInfo(), {
    user_id: 10001,
    nickname: 'MemberNick',
    card: 'MemberCard',
    remark: 'MemberCard',
    role: 'owner',
    title: 'Leader',
    level: 9
  });

  const friend = runtime.createOneBotFriendAdapter(10001, 'Alice');
  const fileUrl = await friend.getFileUrl('file-1');

  assert.equal(friend.nickname, 'Alice');
  assert.equal(friend.remark, 'AliceRemark');
  assert.equal(fileUrl, 'https://example.com/file');
  assert.ok(apiCalls.some(call => call.action === 'getPrivateFileUrl'));
});

test('compat wrapper keeps plain data serializable without false missing-property warnings', async () => {
  const warnings = [];
  const wrap = createCompatValueWrapper((kind, label) => warnings.push({ kind, label }));
  const { runtime } = createRuntimeMock({
    wrapCompatValue: wrap,
    api: {
      getGroupMemberInfo: {
        data: { user_id: 10001, card: 'MemberCard', role: 'owner', title: 'Leader' }
      }
    }
  });
  const member = runtime.createOneBotGroupAdapter(20001).pickMember(10001);
  const memberInfo = member.getInfo();

  assert.equal(JSON.stringify(memberInfo), '{}');
  assert.doesNotThrow(() => JSON.stringify(member));
  const info = await memberInfo;
  assert.equal(info.user_id, 10001);
  assert.equal(info.card, 'MemberCard');
  assert.equal(info.role, 'owner');
  assert.equal(info.title, 'Leader');
  assert.doesNotThrow(() => JSON.stringify(info));
  assert.deepEqual(warnings, []);
});

test('compat wrapper protects explicit nested behavior namespaces and fluent entity chains', async () => {
  const warnings = [];
  const wrap = createCompatValueWrapper((kind, label) => warnings.push({ kind, label }));
  const { runtime } = createRuntimeMock({
    wrapCompatValue: wrap,
    api: {
      get_group_file_system_info: { data: { total_count: 3 } }
    }
  });

  runtime.createOneBotBotAdapter({
    nickname: 'Bot',
    tiny_id: '',
    avatar: '',
    fl: new Map(),
    gl: new Map(),
    gml: new Map(),
    stat: {},
    uin: 123456
  });

  const fs = runtime.createOneBotGroupAdapter(20001).fs;
  const diskInfo = fs.df();

  assert.equal(JSON.stringify(diskInfo), '{}');
  assert.deepEqual(await diskInfo, { total_count: 3 });
  assert.doesNotThrow(() => JSON.stringify(fs));
  assert.doesNotThrow(() => fs.notImplemented());

  const botTarget = {
    on() {
      return this;
    }
  };
  const bot = wrap(new Proxy(botTarget, {
    get(target, prop, receiver) {
      return typeof prop === 'string' && /^\d+$/.test(prop)
        ? receiver
        : Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      return (typeof prop === 'string' && /^\d+$/.test(prop)) || Reflect.has(target, prop);
    }
  }), 'Bot');

  assert.strictEqual(bot.on(), bot);
  assert.strictEqual(bot[123456], bot);
  assert.doesNotThrow(() => bot.on().notImplemented());
  assert.deepEqual(warnings, [
    { kind: 'get', label: 'Group(20001).fs.notImplemented' },
    { kind: 'call', label: 'Group(20001).fs.notImplemented' },
    { kind: 'get', label: 'Bot.notImplemented' },
    { kind: 'call', label: 'Bot.notImplemented' }
  ]);
});

test('group and member proxies keep cached properties consistent after mutations', async () => {
  const { runtime, apiCalls } = createRuntimeMock({
    api: {
      getGroupInfo: {
        data: { group_id: 20001, group_name: 'RemoteGroup', member_count: 42, max_member_count: 500 }
      },
      getGroupMemberList: {
        data: [{ user_id: 10001, nickname: 'Alice', card: 'OldCard', role: 'member' }]
      },
      setGroupCard: {},
      setGroupAdmin: {},
      setGroupBan: {},
      setGroupName: {},
      setGroupWholeBan: {},
      setGroupKick: {}
    }
  });
  const botState = {
    nickname: 'Bot',
    tiny_id: '',
    avatar: '',
    fl: new Map(),
    gl: new Map(),
    gml: new Map(),
    stat: {},
    uin: 123456
  };

  runtime.createOneBotBotAdapter(botState);
  const group = runtime.createOneBotGroupAdapter(20001, { name: 'FallbackGroup' });

  assert.equal(group.name, 'FallbackGroup');
  await group.getInfo();
  assert.equal(group.group_name, 'RemoteGroup');
  assert.equal(group.member_count, 42);

  await group.getMemberMap();
  const member = group.pickMember(10001);
  assert.equal(member.card, 'OldCard');

  await member.setCard('NewCard');
  await member.setAdmin(true);
  await member.mute(60);

  assert.equal(member.card, 'NewCard');
  assert.equal(member.remark, 'NewCard');
  assert.equal(member.role, 'admin');
  assert.equal(member.is_admin, true);
  assert.ok(member.mute_left > 0);

  await group.setName('RenamedGroup');
  await group.muteAll(true);
  assert.equal(group.name, 'RenamedGroup');
  assert.equal(group.all_muted, true);

  await group.kickMember(10001);
  assert.equal(group.pickMember(10001).card, '');
  assert.ok(apiCalls.some(call => call.action === 'setGroupKick' && call.params.user_id === 10001));
});

test('friend adapter reflects refreshed Bot.fl cache instead of stale snapshot', async () => {
  const { runtime } = createRuntimeMock({
    api: {
      getFriendList: {
        data: [{ user_id: 10006, nickname: 'FreshName', card: 'FreshCard', remark: 'FreshRemark', class_id: 7, class_name: 'VIP' }]
      }
    }
  });
  const botState = {
    nickname: 'Bot',
    tiny_id: '',
    avatar: '',
    fl: new Map([[10006, { user_id: 10006, nickname: 'OldName', remark: 'OldRemark', class_id: 1, class_name: 'OldGroup' }]]),
    gl: new Map(),
    gml: new Map(),
    stat: {},
    uin: 123456
  };
  const bot = runtime.createOneBotBotAdapter(botState);
  const friend = runtime.createOneBotFriendAdapter(10006, 'Fallback');

  assert.equal(friend.nickname, 'OldName');
  assert.equal(friend.remark, 'OldRemark');
  assert.equal(friend.class_name, 'OldGroup');

  await bot.getFriendList();

  assert.equal(friend.nickname, 'FreshName');
  assert.equal(friend.remark, 'FreshRemark');
  assert.equal(friend.class_id, 7);
  assert.equal(friend.class_name, 'VIP');
  assert.equal(friend.info.card, 'FreshCard');
});

test('buildOneBotEvent builds group message event with reply and forward support', async () => {
  const { runtime } = createRuntimeMock();
  const botState = {
    nickname: 'Bot',
    tiny_id: '',
    avatar: '',
    fl: new Map(),
    gl: new Map(),
    gml: new Map(),
    stat: {},
    uin: 123456
  };

  runtime.createOneBotBotAdapter(botState);

  const replies = [];
  const event = runtime.buildOneBotEvent({
    data: {
      platform: 'onebot',
      isPrivate: false,
      spaceId: '20001',
      userId: '10001',
      userName: 'Alice',
      userAvatar: '',
      messageText: 'hello',
      botId: '123456',
      messageId: 'msg-1',
      isMaster: true,
      rawEvent: oneBotGroupMessageEvent
    },
    msgId: 'ipc-1',
    selfId: 123456,
    reply: async msg => {
      replies.push(msg);

      return { message_id: 'reply-1' };
    }
  });

  assert.equal(event.message_type, 'group');
  assert.equal(event.group.group_id, 20001);
  assert.equal(event.atme, true);
  assert.equal(event.hasReply, true);
  assert.equal(event.source.seq, 666);
  assert.equal(event.member.role, 'admin');
  assert.equal(typeof event.member.setCard, 'function');
  assert.equal(event.member.group.group_id, 20001);
  assert.equal(event.isMaster, true);
  assert.equal(event.toString(), '[CQ:at,qq=123456]hello');

  const forward = event.makeForwardMsg([{ nickname: 'Alice', message: 'hello' }]);

  assert.equal(forward.type, 'forward');
  assert.ok(Array.isArray(forward.messages));

  const replyResult = await event.reply('pong');

  assert.deepEqual(replyResult, { message_id: 'reply-1' });
  assert.deepEqual(replies, ['pong']);
});

test('buildOneBotEvent builds private message event with friend adapter', () => {
  const { runtime } = createRuntimeMock();
  const botState = {
    nickname: 'Bot',
    tiny_id: '',
    avatar: '',
    fl: new Map([[10002, { user_id: 10002, nickname: 'Bob', remark: 'BobRemark' }]]),
    gl: new Map(),
    gml: new Map(),
    stat: {},
    uin: 123456
  };

  runtime.createOneBotBotAdapter(botState);

  const event = runtime.buildOneBotEvent({
    data: {
      platform: 'onebot',
      isPrivate: true,
      spaceId: '',
      userId: '10002',
      userName: 'Bob',
      userAvatar: '',
      messageText: 'hello private',
      botId: '123456',
      messageId: 'msg-private',
      IsMaster: false,
      rawEvent: oneBotPrivateMessageEvent
    },
    msgId: 'ipc-private',
    selfId: 123456,
    reply: async () => ({ message_id: 'reply-private' })
  });

  assert.equal(event.message_type, 'private');
  assert.equal(event.friend.user_id, 10002);
  assert.equal(event.friend.remark, 'BobRemark');
  assert.equal(event.group, undefined);
  assert.equal(event.atme, false);
  assert.equal(event.hasReply, false);
  assert.equal(event.toString(), 'hello private');
});

test('buildOneBotEvent builds notice event with group member context', () => {
  const { runtime } = createRuntimeMock();
  runtime.createOneBotBotAdapter({
    nickname: 'Bot',
    tiny_id: '',
    avatar: '',
    fl: new Map(),
    gl: new Map(),
    gml: new Map(),
    stat: {},
    uin: 123456
  });

  const event = runtime.buildOneBotEvent({
    data: {
      platform: 'onebot',
      isPrivate: false,
      spaceId: '20001',
      userId: '10003',
      userName: 'Carol',
      userAvatar: '',
      messageText: '',
      botId: '123456',
      messageId: 'notice-1',
      isMaster: false,
      rawEvent: oneBotNoticeEvent
    },
    msgId: 'ipc-notice',
    selfId: 123456,
    reply: async () => ({ message_id: 'reply-notice' })
  });

  assert.equal(event.post_type, 'notice');
  assert.equal(event.notice_type, 'group_increase');
  assert.equal(event.group.group_id, 20001);
  assert.equal(event.friend.user_id, 10003);
  assert.equal(event.member.card, 'CarolCard');
  assert.equal(typeof event.member.renew, 'function');
  assert.equal(event.sender.nickname, 'Carol');
});

test('buildOneBotEvent builds request event with approve and reject methods', async () => {
  const { runtime, apiCalls } = createRuntimeMock();
  runtime.createOneBotBotAdapter({
    nickname: 'Bot',
    tiny_id: '',
    avatar: '',
    fl: new Map(),
    gl: new Map(),
    gml: new Map(),
    stat: {},
    uin: 123456
  });

  const event = runtime.buildOneBotEvent({
    data: {
      platform: 'onebot',
      isPrivate: true,
      spaceId: '',
      userId: '10004',
      userName: 'Dave',
      userAvatar: '',
      messageText: '',
      botId: '123456',
      messageId: 'request-1',
      isMaster: false,
      rawEvent: oneBotRequestEvent
    },
    msgId: 'ipc-request',
    selfId: 123456,
    reply: async () => ({ message_id: 'reply-request' })
  });

  assert.equal(event.post_type, 'request');
  assert.equal(event.request_type, 'friend');

  await event.approve(true);
  await event.reject('no');

  assert.ok(
    apiCalls.some(call => call.action === 'setFriendAddRequest' && call.params.flag === 'friend-flag-1' && call.params.approve === true)
  );
  assert.ok(
    apiCalls.some(call => call.action === 'setFriendAddRequest' && call.params.flag === 'friend-flag-1' && call.params.approve === false)
  );
});

test('group and friend chat history methods preserve onebot message payloads', async () => {
  const historyPayload = [{ message_id: 1, message: [{ type: 'image', file: 'https://example.com/a.png' }] }];
  const { runtime, apiCalls } = createRuntimeMock({
    api: {
      getChatHistory: { data: { messages: historyPayload } }
    }
  });
  runtime.createOneBotBotAdapter({
    nickname: 'Bot',
    tiny_id: '',
    avatar: '',
    fl: new Map(),
    gl: new Map(),
    gml: new Map(),
    stat: {},
    uin: 123456
  });

  const group = runtime.createOneBotGroupAdapter(20001, { name: 'GroupA' });
  const friend = runtime.createOneBotFriendAdapter(10005, 'Erin');
  const groupHistory = await group.getChatHistory(99, 2);
  const friendHistory = await friend.getChatHistory(88, 3);

  assert.deepEqual(groupHistory, historyPayload);
  assert.deepEqual(friendHistory, historyPayload);
  assert.ok(apiCalls.some(call => call.action === 'getChatHistory' && call.params.group_id === 20001 && call.params.message_seq === 99 && call.params.count === 2));
  assert.ok(apiCalls.some(call => call.action === 'getChatHistory' && call.params.user_id === 10005 && call.params.message_seq === 88 && call.params.count === 3));
});

test('group message event prefers explicit raw source and preserves referenced message info', () => {
  const { runtime } = createRuntimeMock();
  runtime.createOneBotBotAdapter({
    nickname: 'Bot',
    tiny_id: '',
    avatar: '',
    fl: new Map(),
    gl: new Map(),
    gml: new Map(),
    stat: {},
    uin: 123456
  });

  const event = runtime.buildOneBotEvent({
    data: {
      platform: 'onebot',
      isPrivate: false,
      spaceId: '20009',
      userId: '10009',
      userName: 'Frank',
      userAvatar: '',
      messageText: 'quoted',
      botId: '123456',
      messageId: 'msg-quoted',
      isMaster: false,
      rawEvent: oneBotQuotedGroupMessageEvent
    },
    msgId: 'ipc-quoted',
    selfId: 123456,
    reply: async () => ({ message_id: 'reply-quoted' })
  });

  assert.equal(event.hasReply, false);
  assert.deepEqual(event.source, {
    user_id: 10001,
    seq: 789,
    time: 1234567000,
    message: [{ type: 'image', file: 'https://example.com/source.png' }]
  });
});

test('worker-style Bot proxy semantics still allow Bot[uin] lookup', () => {
  const botState = {
    nickname: 'Bot',
    tiny_id: '',
    avatar: '',
    fl: new Map(),
    gl: new Map(),
    gml: new Map(),
    stat: {},
    uin: 123456
  };
  const { runtime } = createRuntimeMock();
  const bot = runtime.createOneBotBotAdapter(botState);
  const botProxy = new Proxy(
    { ...botState, ...bot },
    {
      get(target, prop) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          return target;
        }

        return target[prop];
      },
      has(target, prop) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          return true;
        }

        return prop in target;
      }
    }
  );

  assert.equal(123456 in botProxy, true);
  assert.equal(botProxy[123456].nickname, 'Bot');
});
