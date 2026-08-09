import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';

const enabled = process.env.ONEBOT_CONTRACT_ENABLED === '1';
const driverPath = process.env.ONEBOT_CONTRACT_DRIVER;
const groupId = Number(process.env.ONEBOT_CONTRACT_GROUP_ID);
const userId = Number(process.env.ONEBOT_CONTRACT_USER_ID);

function assertSuccess(result) {
  assert.notEqual(result?.status, 'failed', result?.wording ?? result?.message);
  assert.ok(result?.retcode === undefined || result.retcode === 0, result?.wording ?? result?.message);
}

test('OneBot provider supports forward and quoted-message contract', { skip: !enabled }, async () => {
  assert.ok(driverPath, '缺少 ONEBOT_CONTRACT_DRIVER');
  assert.ok(Number.isFinite(groupId), '缺少有效的 ONEBOT_CONTRACT_GROUP_ID');
  assert.ok(Number.isFinite(userId), '缺少有效的 ONEBOT_CONTRACT_USER_ID');

  const driver = await import(pathToFileURL(resolve(driverPath)).href);

  assert.equal(typeof driver.send, 'function', 'contract driver 必须导出 async send({ action, params })');

  const timestamp = new Date().toISOString();
  const nodes = [{ type: 'node', data: { user_id: userId, nickname: 'alemon-contract', content: `forward ${timestamp}` } }];
  const groupForward = await driver.send({ action: 'send_group_forward_msg', params: { group_id: groupId, messages: nodes } });
  const privateForward = await driver.send({ action: 'send_private_forward_msg', params: { user_id: userId, messages: nodes } });
  assertSuccess(groupForward);
  assertSuccess(privateForward);

  const groupMessageId = groupForward?.data?.message_id ?? groupForward?.message_id;
  assert.ok(groupMessageId, 'send_group_forward_msg must return a message ID for reply verification');
  const quotedMessage = await driver.send({
    action: 'send_group_msg',
    params: {
      group_id: groupId,
      message: [{ type: 'reply', data: { id: groupMessageId } }, { type: 'text', data: { text: `quote ${timestamp}` } }]
    }
  });

  assertSuccess(quotedMessage);
});
