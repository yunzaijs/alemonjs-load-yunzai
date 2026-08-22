import test from 'node:test';
import assert from 'node:assert/strict';

import { createOneBotRuntime, isOneBotPlatform } from '../lib/yunzai/adapters/onebot-icqq.js';
import {
  assertOneBotActionSucceeded,
  buildForwardMsgCompat,
  canUseGenericOneBotFallback,
  getNativeMessageRequest,
  getNativeOneBotRequest,
  getNativeForwardFallbackRequest,
  getNativeForwardRequest,
  getNativeQuotedForwardRequests,
  getReplyMessageId,
  isUnsupportedOneBotActionError,
  normalizeOneBotMediaSource,
  sendNativeForward,
  summarizeNativeOneBotRequest,
  toOneBotMessage,
  toOneBotSegment
} from '../lib/yunzai/forward.js';
import { getExecutionContext, getExecutionContextForAction, runWithExecutionContext } from '../lib/yunzai/execution-context.js';
import { createCompatValueWrapper } from '../lib/yunzai/compat.js';
import { WorkerEventQueue } from '../lib/yunzai/event-queue.js';
import { OneBotIngressGuard } from '../lib/yunzai/onebot-ingress.js';
import {
  assertMessageSendSucceeded,
  describeFormatContents,
  describeOneBotError,
  describeReplyContents,
  getPlatformFailureSummary,
  summarizeReplyContents
} from '../lib/yunzai/send-result.js';
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

test('load-layer event queue serializes Worker dispatch and preserves waiting events across restart', () => {
  const dispatched = [];
  const queue = new WorkerEventQueue(1);

  queue.enqueue('first', () => dispatched.push('first'));
  queue.enqueue('second', () => dispatched.push('second'));

  assert.deepEqual(dispatched, ['first']);
  assert.equal(queue.activeCount, 1);
  assert.equal(queue.pendingCount, 1);

  queue.complete('first');
  assert.deepEqual(dispatched, ['first', 'second']);
  assert.equal(queue.activeCount, 1);
  assert.equal(queue.pendingCount, 0);

  queue.enqueue('third', () => dispatched.push('third'));
  queue.abortActive();
  queue.resume();

  assert.deepEqual(dispatched, ['first', 'second', 'third']);
  assert.equal(queue.activeCount, 1);
});

test('OneBot ingress guard rejects self echoes and only deduplicates the same raw message', () => {
  const guard = new OneBotIngressGuard(100, 10);
  const message = {
    post_type: 'message',
    self_id: 10001,
    user_id: 20002,
    message_type: 'group',
    group_id: 30003,
    message_id: 40004
  };

  assert.equal(guard.accept('onebot', message, 1), true);
  assert.equal(guard.accept('onebot', message, 2), false);
  assert.equal(guard.accept('onebot', { ...message, message_id: 40005 }, 2), true);
  assert.equal(guard.accept('onebot', { ...message, user_id: 10001, message_id: 40006 }, 2), false);
  assert.equal(guard.accept('onebot', { post_type: 'notice', self_id: 10001, user_id: 10001 }, 2), true);
  assert.equal(guard.accept('qq-bot', message, 2), true);
  assert.equal(guard.accept('onebot', message, 102), true);
});

test('send result validation exposes OneBot adapter failures without logging image data', () => {
  assert.doesNotThrow(() => assertMessageSendSucceeded([{ code: 2000, message: 'ok' }]));
  assert.doesNotThrow(() => assertMessageSendSucceeded({ message_id: 10001 }));
  assert.throws(() => assertMessageSendSucceeded([{ code: 4000, message: 'upload failed' }]), /平台消息发送失败 \(4000:upload failed\)/);
  assert.throws(
    () =>
      assertMessageSendSucceeded([
        { code: 4000, message: 'upload failed', data: { oneBotResponse: { status: 'failed', retcode: 1002, wording: 'bad file', data: null } } }
      ]),
    error => describeOneBotError(error) === 'status=failed, retcode=1002, wording=bad file, data=null'
  );
  assert.equal(getPlatformFailureSummary([{ code: 4000, message: 'request failed' }]), '4000:request failed');
  assert.equal(
    getPlatformFailureSummary([
      { code: 2000, message: 'ok' },
      { code: 4000, message: 'other target failed' }
    ]),
    undefined
  );
  assert.equal(
    summarizeReplyContents([
      { type: 'image', data: 'a'.repeat(16) },
      { type: 'text', data: 'done' }
    ]),
    'segments=2, images=1, imageBytes≈12'
  );
  assert.match(describeReplyContents([{ type: 'image', data: 'a'.repeat(16), params: { cache: 0 } }]), /data=base64\(length=16\),params=cache/);
  assert.doesNotMatch(describeReplyContents([{ type: 'image', data: 'sensitive-image-data' }]), /sensitive-image-data/);
  assert.match(describeFormatContents([{ type: 'Image', value: 'base64://a'.repeat(8) }]), /value=base64\(length=/);
  assert.equal(
    describeOneBotError({ oneBotResponse: { status: 'failed', retcode: 1002, wording: 'invalid request', data: null } }),
    'status=failed, retcode=1002, wording=invalid request, data=null'
  );
  assert.equal(
    describeOneBotError({ oneBotResponse: { status: 'failed', retcode: 1200, wording: 'uri= /9j/abcdefghijklmnop', data: null } }),
    'status=failed, retcode=1200, wording=uri= <redacted-base64>, data=null'
  );
});

test('forward compatibility preserves nodes and builds a readable fallback', () => {
  const nodes = [
    { user_id: 10001, nickname: 'Alice', message: 'hello' },
    {
      type: 'node',
      data: {
        user_id: 10002,
        nickname: 'Bob',
        content: [
          { type: 'image', file: 'https://example.com/a.png' },
          { type: 'at', qq: 10003 }
        ]
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
    params: { group_id: '20001', messages: nodes }
  });
  assert.deepEqual(privateRequest, {
    action: 'send_private_forward_msg',
    params: { user_id: '10001', messages: nodes }
  });
  assert.equal(getNativeForwardRequest([...contents, { type: 'text', data: 'extra' }], { isPrivate: false, groupId: 20001 }), null);

  const result = await sendNativeForward(client, groupRequest);

  assert.deepEqual(calls, [groupRequest]);
  assert.equal(getReplyMessageId(result), '666');
});

test('native forward requests convert Yunzai message nodes to the OneBot node segment structure', () => {
  const request = getNativeForwardRequest(
    [{ type: 'forward', data: 'hello', nodes: [{ user_id: [10001], nickname: 'Alice', message: 'hello', time: 123 }], fallback: [] }],
    { isPrivate: true, userId: '20001' }
  );

  assert.deepEqual(request, {
    action: 'send_private_forward_msg',
    params: {
      user_id: '20001',
      messages: [{ type: 'node', data: { user_id: 10001, nickname: 'Alice', content: 'hello', time: 123 } }]
    }
  });
});

test('icqq message elements inside forward nodes are converted to OneBot segment data', () => {
  assert.deepEqual(
    toOneBotMessage([
      'hello',
      { type: 'image', file: 'aGVsbG8=' },
      { type: 'flash', file: 'aGVsbG8=' },
      { type: 'at', qq: 10002 },
      { type: 'location', lat: 30.1, lng: 120.2, name: 'West Lake', address: 'Hangzhou' },
      { type: 'share', url: 'https://example.com', title: 'Example', content: 'description', image: 'https://example.com/a.png' },
      { type: 'music', id: '28949129', platform: '163' },
      { type: 'poke', id: 2 },
      { type: 'dice', id: 6 }
    ]),
    [
      { type: 'text', data: { text: 'hello' } },
      { type: 'image', data: { file: 'base64://aGVsbG8=' } },
      { type: 'image', data: { file: 'base64://aGVsbG8=', type: 'flash' } },
      { type: 'at', data: { qq: '10002' } },
      { type: 'location', data: { lat: 30.1, lon: 120.2, title: 'West Lake', content: 'Hangzhou' } },
      { type: 'share', data: { url: 'https://example.com', title: 'Example', content: 'description', image: 'https://example.com/a.png' } },
      { type: 'music', data: { type: '163', id: '28949129' } },
      { type: 'poke', data: { type: '1', id: '2' } },
      { type: 'dice', data: {} }
    ]
  );

  assert.deepEqual(
    toOneBotSegment({
      type: 'node',
      user_id: 10001,
      nickname: 'Alice',
      message: [
        { type: 'face', id: 14 },
        { type: 'text', text: 'hi' }
      ]
    }),
    {
      type: 'node',
      data: {
        user_id: 10001,
        nickname: 'Alice',
        content: [
          { type: 'face', data: { id: 14 } },
          { type: 'text', data: { text: 'hi' } }
        ]
      }
    }
  );
});

test('raw icqq-only segments also use the shared OneBot field mapper', () => {
  const request = getNativeMessageRequest(
    [
      { type: 'raw', data: '', nativeType: 'poke', nativeData: { id: 2 } },
      { type: 'raw', data: '', nativeType: 'location', nativeData: { lat: 30.1, lng: 120.2, title: 'West Lake' } },
      { type: 'raw', data: '', nativeType: 'music', nativeData: { platform: '163', id: '28949129' } }
    ],
    { isPrivate: true, userId: '10001' }
  );

  assert.deepEqual(request, {
    action: 'send_private_msg',
    params: {
      user_id: '10001',
      message: [
        { type: 'poke', data: { id: '2', type: '1' } },
        { type: 'location', data: { lat: 30.1, title: 'West Lake', lon: 120.2 } },
        { type: 'music', data: { id: '28949129', type: '163' } }
      ]
    }
  });
});

test('rejected native forwards can send the complete fallback content as an ordinary message', () => {
  const contents = [
    {
      type: 'forward',
      data: 'forward text',
      nodes: [{ user_id: '10001', nickname: 'Alice', message: 'forward text' }],
      fallback: [
        { type: 'text', data: '欢迎回来主人~' },
        { type: 'text', data: '登录地址：https://example.com/login' }
      ]
    }
  ];

  assert.deepEqual(getNativeForwardFallbackRequest(contents, { isPrivate: true, userId: '10001' }), {
    action: 'send_private_msg',
    params: {
      user_id: '10001',
      message: [
        { type: 'text', data: { text: '欢迎回来主人~' } },
        { type: 'text', data: { text: '登录地址：https://example.com/login' } }
      ]
    }
  });
  assert.equal(getNativeForwardFallbackRequest([{ ...contents[0], quoteMessageId: '888' }], { isPrivate: true, userId: '10001' }), null);
});

test('standard native messages use the same semantic OneBot methods as generic dispatch', async () => {
  const calls = [];
  const request = getNativeMessageRequest([{ type: 'image', data: 'aGVsbG8=' }], { isPrivate: false, groupId: '20001' });
  const client = {
    send: async request => {
      calls.push(['send', request]);
      return { message_id: 1 };
    },
    sendGroupMessage: async params => {
      calls.push(['sendGroupMessage', params]);
      return { message_id: 2 };
    }
  };

  const result = await sendNativeForward(client, request);

  assert.deepEqual(calls, [['sendGroupMessage', request.params]]);
  assert.equal(getReplyMessageId(result), '2');
});

test('native V12 messages use upload_file followed by send_message', async () => {
  const calls = [];
  const request = getNativeMessageRequest([{ type: 'image', data: 'aGVsbG8=' }], { isPrivate: false, groupId: '20001' });
  const client = {
    send: async () => {
      throw new Error('V11 send must not be called for V12');
    },
    getConnectionStatus: async () => [{ code: 2000, data: { activeVersion: 12 } }],
    sendV12Action: async (action, params) => {
      calls.push([action, params]);
      return action === 'upload_file' ? [{ code: 2000, data: { file_id: 'file-1' } }] : [{ code: 2000, data: { message_id: 'message-1' } }];
    }
  };

  const result = await sendNativeForward(client, request);

  assert.deepEqual(calls, [
    ['upload_file', { type: 'data', data: 'aGVsbG8=' }],
    ['send_message', { detail_type: 'group', group_id: '20001', message: [{ type: 'image', data: { file_id: 'file-1' } }] }]
  ]);
  assert.equal(getReplyMessageId(result), 'message-1');
});

test('quoted messages use native OneBot send actions and expand quoted forwards safely', () => {
  const quote = [{ type: 'text', data: 'pong', quoteMessageId: '777' }];
  const groupRequest = getNativeOneBotRequest(quote, { isPrivate: false, groupId: 20001 });
  const privateRequest = getNativeOneBotRequest(quote, { isPrivate: true, userId: 10001 });
  const forward = buildForwardMsgCompat([{ user_id: 10001, nickname: 'Alice', message: 'hello' }]);
  const quotedForward = getNativeOneBotRequest(
    [
      {
        type: 'forward',
        data: forward.data,
        nodes: forward.__forwardNodes,
        fallback: [{ type: 'text', data: '【Alice】\nhello\n' }],
        quoteMessageId: '888'
      }
    ],
    { isPrivate: false, groupId: 20001 }
  );

  assert.deepEqual(groupRequest, {
    action: 'send_group_msg',
    params: {
      group_id: '20001',
      message: [
        { type: 'reply', data: { id: '777' } },
        { type: 'text', data: { text: 'pong' } }
      ]
    }
  });
  assert.deepEqual(privateRequest, {
    action: 'send_private_msg',
    params: {
      user_id: '10001',
      message: [
        { type: 'reply', data: { id: '777' } },
        { type: 'text', data: { text: 'pong' } }
      ]
    }
  });
  assert.deepEqual(quotedForward, {
    action: 'send_group_msg',
    params: {
      group_id: '20001',
      message: [
        { type: 'reply', data: { id: '888' } },
        { type: 'text', data: { text: '【Alice】\nhello\n' } }
      ]
    }
  });
});

test('quoted forwards use two native actions so neither quote nor forward semantics are lost', () => {
  const requests = getNativeQuotedForwardRequests(
    [
      {
        type: 'forward',
        data: 'forward',
        nodes: [{ type: 'node', data: { user_id: '10001', nickname: 'Alice', content: 'hello' } }],
        quoteMessageId: '888'
      }
    ],
    { isPrivate: false, groupId: '20001' }
  );

  assert.deepEqual(requests, [
    {
      action: 'send_group_msg',
      params: {
        group_id: '20001',
        message: [
          { type: 'reply', data: { id: '888' } },
          { type: 'text', data: { text: '[转发消息]' } }
        ]
      }
    },
    {
      action: 'send_group_forward_msg',
      params: {
        group_id: '20001',
        messages: [{ type: 'node', data: { user_id: '10001', nickname: 'Alice', content: 'hello' } }]
      }
    }
  ]);
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
      group_id: '20001',
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
  assert.deepEqual(
    getNativeOneBotRequest(contents, { isPrivate: false, groupId: 20001 }),
    getNativeMessageRequest(contents, { isPrivate: false, groupId: 20001 })
  );
});

test('native media segments discard only leaked structural type while preserving real media type', () => {
  const image = getNativeMessageRequest([{ type: 'image', data: 'aGVsbG8=', params: { type: 'image', cache: 0 } }], { isPrivate: false, groupId: '20001' });
  const flash = getNativeMessageRequest([{ type: 'image', data: 'aGVsbG8=', params: { type: 'flash', cache: 0 } }], { isPrivate: false, groupId: '20001' });

  assert.deepEqual(image.params.message[0].data, { cache: 0, file: 'base64://aGVsbG8=' });
  assert.deepEqual(flash.params.message[0].data, { type: 'flash', cache: 0, file: 'base64://aGVsbG8=' });
});

test('native request diagnostics expose segment shape without image base64 data', () => {
  const request = getNativeMessageRequest([{ type: 'image', data: 'aGVsbG8=' }], { isPrivate: false, groupId: '20001' });
  const summary = summarizeNativeOneBotRequest(request);

  assert.match(summary, /action=send_group_msg/);
  assert.match(summary, /image\(base64≈6B\)/);
  assert.doesNotMatch(summary, /aGVsbG8=/);
});

test('native JPEG base64 is never mistaken for an absolute path', () => {
  const request = getNativeMessageRequest([{ type: 'image', data: '/9j/QUJDREVGR0hJSktMTU5PUA==' }], { isPrivate: false, groupId: '20001' });

  assert.equal(request.params.message[0].data.file, 'base64:///9j/QUJDREVGR0hJSktMTU5PUA==');
});

test('all native media sources use one normal form for raw and generic dispatch', () => {
  assert.equal(normalizeOneBotMediaSource('/9j/QUJDREVGR0hJSktMTU5PUA=='), 'base64:///9j/QUJDREVGR0hJSktMTU5PUA==');
  assert.equal(normalizeOneBotMediaSource('data:image/jpeg;base64,/9j/QUJDREVGR0hJSktMTU5PUA=='), 'base64:///9j/QUJDREVGR0hJSktMTU5PUA==');
  assert.equal(normalizeOneBotMediaSource('buffer://aGVsbG8='), 'base64://aGVsbG8=');
  assert.equal(normalizeOneBotMediaSource('https://example.com/video.mp4'), 'https://example.com/video.mp4');
  assert.equal(normalizeOneBotMediaSource('file:///tmp/voice.mp3'), 'file:///tmp/voice.mp3');

  const media = getNativeMessageRequest(
    [
      { type: 'record', data: 'data:audio/ogg;base64,aGVsbG8=' },
      { type: 'video', data: '/9j/QUJDREVGR0hJSktMTU5PUA==' }
    ],
    { isPrivate: false, groupId: '20001' }
  );

  assert.deepEqual(media.params.message, [
    { type: 'record', data: { file: 'base64://aGVsbG8=' } },
    { type: 'video', data: { file: 'base64:///9j/QUJDREVGR0hJSktMTU5PUA==' } }
  ]);
});

test('generic retry is allowed only when Format can preserve the OneBot segment semantics', () => {
  assert.equal(canUseGenericOneBotFallback([{ type: 'text', data: 'hello' }]), true);
  assert.equal(
    canUseGenericOneBotFallback([
      { type: 'image', data: 'aGVsbG8=' },
      { type: 'record', data: 'https://example.com/a.ogg' }
    ]),
    true
  );
  assert.equal(canUseGenericOneBotFallback([{ type: 'image', data: 'aGVsbG8=', params: { type: 'flash' } }]), false);
  assert.equal(canUseGenericOneBotFallback([{ type: 'text', data: 'reply', quoteMessageId: '123' }]), false);
  assert.equal(canUseGenericOneBotFallback([{ type: 'forward', data: 'forward', nodes: [] }]), false);
  assert.equal(canUseGenericOneBotFallback([{ type: 'face', data: '14' }]), false);
  assert.equal(canUseGenericOneBotFallback([{ type: 'json', data: '{}' }]), false);
});

test('OneBot-only structured segments stay native instead of being flattened to text', () => {
  const request = getNativeMessageRequest(
    [
      {
        type: 'raw',
        data: '',
        nativeType: 'share',
        nativeData: {
          url: 'https://example.com/article',
          title: 'Article',
          content: 'Summary',
          image: 'https://example.com/cover.png'
        }
      },
      { type: 'raw', data: '', nativeType: 'poke', nativeData: { type: '1', id: '2' } }
    ],
    { isPrivate: false, groupId: '20001' }
  );

  assert.deepEqual(request.params.message, [
    {
      type: 'share',
      data: {
        url: 'https://example.com/article',
        title: 'Article',
        content: 'Summary',
        image: 'https://example.com/cover.png'
      }
    },
    { type: 'poke', data: { type: '1', id: '2' } }
  ]);
  assert.equal(getNativeMessageRequest([{ type: 'raw', data: '' }], { isPrivate: false, groupId: '20001' }), null);
});

test('only explicit unsupported OneBot errors are eligible for forward fallback', () => {
  assert.equal(isUnsupportedOneBotActionError(new Error('unsupported action: send_group_forward_msg')), true);
  assert.equal(isUnsupportedOneBotActionError(new Error('参数不支持')), true);
  assert.equal(isUnsupportedOneBotActionError(new Error('request timed out')), false);
  assert.equal(isUnsupportedOneBotActionError(new Error('socket disconnected')), false);
  assert.throws(() => assertOneBotActionSucceeded({ status: 'failed', retcode: 1404, wording: 'unsupported action' }), /unsupported action/);
  assert.throws(
    () => assertOneBotActionSucceeded([{ code: 4000, message: '请求失败', data: null }]),
    error => error?.oneBotActionRejected === true && error?.oneBotResultCode === 4000 && /4000: 请求失败/.test(error.message)
  );
  assert.deepEqual(assertOneBotActionSucceeded([{ code: 2000, message: '请求完成', data: { message_id: 666 } }]), { message_id: 666 });
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
      },
      getForwardMsg: {
        data: {
          messages: [
            {
              sender: { user_id: 10002, nickname: 'Bob' },
              time: 123,
              content: [
                { type: 'location', data: { lat: 30.1, lon: 120.2, title: 'West Lake', content: 'Hangzhou' } },
                { type: 'text', data: { text: 'hello' } }
              ]
            }
          ]
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

  const friendMap = await bot.getFriendList();
  const friend = friendMap.get(10001);
  const forwards = await bot.getForwardMsg('forward-id');

  assert.equal(friend.nickname, 'Alice');
  assert.equal(friend.card, 'AliceCard');
  assert.equal(friend.remark, 'AliceCard');
  assert.deepEqual(forwards[0].message, [
    { type: 'location', lat: 30.1, lng: 120.2, name: 'West Lake', address: 'Hangzhou' },
    { type: 'text', text: 'hello' }
  ]);

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

test('direct Bot and entity sends propagate confirmed failures instead of pretending success', async () => {
  const { runtime } = createRuntimeMock({
    api: {
      sendGroupMsg: () => Promise.reject(new Error('send group failed')),
      sendPrivateMsg: () => Promise.reject(new Error('send private failed'))
    }
  });
  const bot = runtime.createOneBotBotAdapter({
    nickname: 'Bot',
    tiny_id: '',
    avatar: '',
    fl: new Map(),
    gl: new Map(),
    gml: new Map(),
    stat: {},
    uin: 123456
  });

  await assert.rejects(runtime.createOneBotGroupAdapter(20001).sendMsg('hello'), /send group failed/);
  await assert.rejects(bot.sendGroupMsg(20001, 'hello'), /send group failed/);
  await assert.rejects(runtime.createOneBotFriendAdapter(10001, 'Alice').sendMsg('hello'), /send private failed/);
  await assert.rejects(bot.sendPrivateMsg(10001, 'hello'), /send private failed/);
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

test('compat wrapper keeps Bot cache maps as native Map instances', () => {
  const warnings = [];
  const wrap = createCompatValueWrapper((kind, label) => warnings.push({ kind, label }));
  const fl = new Map([[10001, { nickname: 'Alice' }]]);
  const gl = new Map([[20001, { group_name: 'GroupA' }]]);
  const gml = new Map([[20001, new Map([[10001, { card: 'Alice' }]])]]);
  const bot = wrap(
    {
      fl,
      gl,
      gml,
      getFriendMap: () => fl,
      getGroupMap: () => gl
    },
    'Bot'
  );

  assert.strictEqual(bot.fl, fl);
  assert.strictEqual(bot.gl, gl);
  assert.strictEqual(bot.gml, gml);
  assert.equal(bot.fl.size, 1);
  assert.equal(bot.gl.size, 1);
  assert.equal(bot.gml.get(20001).size, 1);
  assert.strictEqual(bot.getFriendMap(), fl);
  assert.strictEqual(bot.getGroupMap(), gl);
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
  const bot = wrap(
    new Proxy(botTarget, {
      get(target, prop, receiver) {
        return typeof prop === 'string' && /^\d+$/.test(prop) ? receiver : Reflect.get(target, prop, receiver);
      },
      has(target, prop) {
        return (typeof prop === 'string' && /^\d+$/.test(prop)) || Reflect.has(target, prop);
      }
    }),
    'Bot'
  );

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

test('OneBot inbound structured segments are converted to their icqq field names', () => {
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
      userId: '10001',
      userName: 'Alice',
      userAvatar: '',
      messageText: '',
      botId: '123456',
      messageId: 'msg-fields',
      isMaster: false,
      rawEvent: {
        ...oneBotGroupMessageEvent,
        message: [
          { type: 'image', data: { file: 'image-id', type: 'flash' } },
          { type: 'location', data: { lat: 30.1, lon: 120.2, title: 'West Lake', content: 'Hangzhou' } },
          {
            type: 'node',
            data: { user_id: '10002', nickname: 'Bob', content: [{ type: 'text', data: { text: 'forward text' } }] }
          }
        ]
      }
    },
    msgId: 'ipc-fields',
    selfId: 123456,
    reply: async () => ({ message_id: 'reply-fields' })
  });

  assert.deepEqual(event.message, [
    { type: 'flash', file: 'image-id' },
    { type: 'location', lat: 30.1, lng: 120.2, name: 'West Lake', address: 'Hangzhou' },
    { type: 'node', user_id: '10002', nickname: 'Bob', time: undefined, message: [{ type: 'text', text: 'forward text' }] }
  ]);
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

  assert.ok(apiCalls.some(call => call.action === 'setFriendAddRequest' && call.params.flag === 'friend-flag-1' && call.params.approve === true));
  assert.ok(apiCalls.some(call => call.action === 'setFriendAddRequest' && call.params.flag === 'friend-flag-1' && call.params.approve === false));
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
  assert.ok(
    apiCalls.some(call => call.action === 'getChatHistory' && call.params.group_id === 20001 && call.params.message_seq === 99 && call.params.count === 2)
  );
  assert.ok(
    apiCalls.some(call => call.action === 'getChatHistory' && call.params.user_id === 10005 && call.params.message_seq === 88 && call.params.count === 3)
  );
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
