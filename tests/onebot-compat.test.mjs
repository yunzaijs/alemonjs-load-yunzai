import test from 'node:test';
import assert from 'node:assert/strict';

import { createOneBotRuntime, isOneBotPlatform } from '../lib/yunzai/adapters/onebot-icqq.js';
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
    wrapCompatValue: value => value,
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

  const friend = runtime.createOneBotFriendAdapter(10001, 'Alice');
  const fileUrl = await friend.getFileUrl('file-1');

  assert.equal(friend.nickname, 'Alice');
  assert.equal(friend.remark, 'AliceRemark');
  assert.equal(fileUrl, 'https://example.com/file');
  assert.ok(apiCalls.some(call => call.action === 'getPrivateFileUrl'));
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
