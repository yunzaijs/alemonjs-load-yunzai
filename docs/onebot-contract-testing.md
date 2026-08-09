# OneBot 实机契约测试

默认回归测试不会访问 QQ。只有在专用测试账号、群和用户已准备好时，才运行：

```sh
ONEBOT_CONTRACT_ENABLED=1 \
ONEBOT_CONTRACT_DRIVER=/absolute/path/to/driver.mjs \
ONEBOT_CONTRACT_GROUP_ID=123456 \
ONEBOT_CONTRACT_USER_ID=123456 \
node --test tests/onebot-contract.test.mjs
```

`ONEBOT_CONTRACT_DRIVER` 必须导出一个异步 `send(request)` 函数。它应复用部署环境中已经登录的 OneBot 客户端，并将请求转发为 OneBot 动作：

```js
export async function send({ action, params }) {
  return oneBotClient.send({ action, params });
}
```

测试会向配置的专用群和私聊发送两条合并转发与一条引用消息；不要配置生产群或普通用户。该测试用于分别记录 NapCat、LLOneBot 对 `send_group_forward_msg`、`send_private_forward_msg` 和 `send_group_msg` 引用段的实际支持情况。
