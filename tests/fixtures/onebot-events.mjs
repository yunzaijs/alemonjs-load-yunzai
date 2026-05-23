export const oneBotGroupMessageEvent = {
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  self_id: 123456,
  user_id: 10001,
  group_id: 20001,
  group_name: 'GroupA',
  message_id: 777,
  message_seq: 888,
  time: 1234567890,
  message: [
    { type: 'at', data: { qq: '123456' } },
    { type: 'text', data: { text: 'hello' } },
    { type: 'reply', data: { id: 666 } }
  ],
  raw_message: '[CQ:at,qq=123456]hello',
  sender: {
    nickname: 'Alice',
    card: 'AliceCard',
    role: 'admin'
  }
};

export const oneBotPrivateMessageEvent = {
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend',
  self_id: 123456,
  user_id: 10002,
  message_id: 888,
  time: 1234567891,
  message: [{ type: 'text', data: { text: 'hello private' } }],
  raw_message: 'hello private',
  sender: {
    nickname: 'Bob'
  }
};

export const oneBotNoticeEvent = {
  post_type: 'notice',
  notice_type: 'group_increase',
  sub_type: 'approve',
  self_id: 123456,
  user_id: 10003,
  group_id: 20001,
  sender: {
    nickname: 'Carol',
    card: 'CarolCard',
    role: 'member'
  }
};

export const oneBotRequestEvent = {
  post_type: 'request',
  request_type: 'friend',
  sub_type: 'add',
  self_id: 123456,
  user_id: 10004,
  flag: 'friend-flag-1',
  sender: {
    nickname: 'Dave'
  }
};

export const oneBotQuotedGroupMessageEvent = {
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  self_id: 123456,
  user_id: 10009,
  group_id: 20009,
  message_id: 1000,
  time: 1234567999,
  message: [{ type: 'text', data: { text: 'quoted' } }],
  raw_message: 'quoted',
  source: {
    user_id: 10001,
    seq: 789,
    time: 1234567000,
    message: [{ type: 'image', file: 'https://example.com/source.png' }]
  },
  sender: {
    nickname: 'Frank',
    role: 'member'
  }
};
