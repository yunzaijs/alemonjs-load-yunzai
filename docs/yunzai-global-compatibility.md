# Yunzai 全局变量兼容说明

## 目的

Yunzai 插件生态的核心兼容面，不只是消息事件和 `e.reply()`，还包括插件加载时直接读取的全局变量。本文记录 `alemonjs-load-yunzai` 对这些变量的处理方式、真实支持范围，以及在不同 AlemonJS 平台上的表现。

状态定义：

- **原生可用**：由 Miao-Yunzai 自身初始化，插件可按 Yunzai 习惯使用。
- **桥接兼容**：由 AlemonJS Worker 注入或代理，行为与 Yunzai/icqq 相近，但底层实现不同。
- **部分支持**：只有部分字段或部分方法可用，不能当作完整原对象。
- **不支持**：当前平台没有对应能力，调用会明确失败或只能降级。

## 1. 全局变量总表

| 全局变量             | Yunzai 原用途                                | 当前实现                                                | 状态     | 说明                                                                                           |
| -------------------- | -------------------------------------------- | ------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `Bot`                | icqq 登录客户端、好友/群缓存、发送和管理 API | Worker 注入兼容代理                                     | 桥接兼容 | `Bot[uin]`、`pick*`、缓存、消息、群成员和常用管理方法已接入 IPC。                              |
| `Bot.icqq`           | icqq 模块和底层协议工具                      | 加载 Miao-Yunzai 内置 icqq 模块导出                     | 部分支持 | 静态类、`segment`、`Parser`、`Converter`、`core.jce/pb/tea` 可用；不等于真实 icqq 登录客户端。 |
| `Bot.sendApi`        | TRSS/Yunzai 内部调用 OneBot v11 action       | 原始 OneBot action 透传                                 | 桥接兼容 | 仅 `onebot` 平台可用，action 和 params 原样发送。                                              |
| `Bot.sendUni`        | icqq QQ SSO 底层请求                         | 明确失败的兼容方法                                      | 不支持   | `qq-bot` 和 OneBot 没有 icqq SSO 长连接，不能伪造成功。                                        |
| `Bot.sig`            | 登录态、序列号和协议签名                     | 提供基础 `seq`                                          | 部分支持 | 只用于避免常见属性缺失；不包含真实登录签名。                                                   |
| `segment`            | icqq 消息段构造器                            | Worker 注入跨平台构造器                                 | 桥接兼容 | 文本、图片、@、表情、语音、视频、JSON、XML、引用、转发、文件、按钮、Markdown 等已覆盖。        |
| `plugin`             | Yunzai 插件基类和插件管理                    | Miao-Yunzai 原生加载                                    | 原生可用 | 由 Miao-Yunzai 的 loader 设置。                                                                |
| `logger`             | 全局日志对象                                 | 转入 Worker 日志通道并写入 Yunzai command 日志          | 桥接兼容 | 支持 `trace/debug/info/warn/error/fatal/mark` 等常用方法。                                     |
| `redis`              | 全局 Redis 客户端                            | Miao-Yunzai 自身 `redisInit()` 初始化                   | 原生可用 | 依赖顶层 Redis 配置同步到 Miao-Yunzai 配置。 Redis 服务不可用时 Worker 启动失败。              |
| `Renderer`           | 全局渲染器类                                 | Miao-Yunzai renderer loader 初始化                      | 原生可用 | 实际渲染能力仍依赖 Puppeteer/浏览器安装。                                                      |
| `cfg` / `Cfg`        | 配置对象                                     | 由 Miao-Yunzai 模块提供，并注入 `_yunzaiCfg` 供桥接使用 | 部分支持 | `masterQQ`、群配置等可用；`cfg.getGroup(selfId, groupId)` 已兼容 TRSS 双参数调用。             |
| `_yunzaiCfg`         | Worker 内部保存的 Yunzai 配置引用            | Worker 内部使用                                         | 内部变量 | 不建议插件依赖；插件应使用 Yunzai 原有配置入口。                                               |
| `global.inputTicket` | icqq 登录过程中的验证码状态                  | 由 Miao-Yunzai 原代码管理                               | 原生可用 | 在托管/跳过登录模式下通常没有实际业务意义。                                                    |

## 2. `Bot` 兼容明细

### 2.1 已接入的常用字段

```js
Bot.uin;
Bot[uin];
Bot.bots[uin];
Bot.bots.get(uin);
Bot.nickname;
Bot.avatar;
Bot.tiny_id;
Bot.fl;
Bot.gl;
Bot.gml;
Bot.stat;
Bot.logger;
Bot.getFriendMap();
Bot.getGroupMap();
```

当前 Worker 是单 Bot 管理模型。`Bot.bots[uin]` 可以满足插件访问习惯，但不会创建多个独立 Worker 或多个真实登录连接。

### 2.2 已接入的方法

```js
Bot.pickFriend(uid);
Bot.pickUser(uid);
Bot.pickGroup(groupId);
Bot.pickMember(groupId, userId);
Bot.sendGroupMsg(groupId, message);
Bot.sendPrivateMsg(userId, message);
Bot.sendFriendMsg(userId, message);
Bot.sendMasterMsg(message);
Bot.makeForwardMsg(nodes);
Bot.sendApi(action, params);
Bot.fileToUrl(file);
Bot.makeLog(level, ...args);
```

其中：

- `sendGroupMsg`、`sendPrivateMsg`、`e.reply` 可以走跨平台桥接。
- `sendApi` 是严格的 OneBot v11 原始 API，只适用于 `platform === 'onebot'`。
- `sendMasterMsg` 会向配置中的 `masterQQ` 发送私聊消息。
- `fileToUrl` 只负责把本地文件转换成跨进程可传输形式，不会伪造远程文件服务。

### 2.3 `Bot.icqq` 的字段范围

当前 `Bot.icqq` 主要等价于已安装的 icqq 模块导出：

```js
Bot.icqq.Client;
Bot.icqq.createClient;
Bot.icqq.User;
Bot.icqq.Friend;
Bot.icqq.Group;
Bot.icqq.Member;
Bot.icqq.Message;
Bot.icqq.segment;
Bot.icqq.Image;
Bot.icqq.Parser;
Bot.icqq.Converter;
Bot.icqq.Platform;
Bot.icqq.core;
Bot.icqq.core.jce;
Bot.icqq.core.pb;
Bot.icqq.core.tea;
```

这类静态工具和数据编解码字段可以使用。例如：

```js
const body = Bot.icqq.core.jce.encodeStruct([...])
```

但以下能力不成立：

```js
Bot.icqq.login();
Bot.icqq.sendUni();
Bot.icqq.sig.session;
Bot.icqq.network;
```

原因是这些能力依赖真实 icqq 客户端的登录态和 QQ SSO 长连接，而 AlemonJS 的 `qq-bot` 与 OneBot 连接模型不同。

## 3. `segment` 兼容明细

| 构造器                            | OneBot                    | `qq-bot`             | 其他平台                     |
| --------------------------------- | ------------------------- | -------------------- | ---------------------------- |
| `text/image/at/face/record/video` | 原生转换                  | 标准 Format 转换     | 通用 Format 降级             |
| `json/xml/reply/forward/file`     | 原生或 OneBot 专用 action | 按平台能力转换       | 尽量保留结构，无法支持时降级 |
| `button`                          | 不属于 OneBot v11 核心段  | 转换为 QQ Bot 按钮   | 转换为可读文本               |
| `markdown`                        | 非核心段，按扩展处理      | 使用 QQ Bot Markdown | 转换为普通文本               |
| `custom/raw`                      | 保留实现商扩展结构        | 按平台能力处理       | 不伪装成标准消息段           |

## 4. 事件对象中的全局兼容

插件通常不是只读取全局变量，还会依赖 Yunzai 事件字段。Worker 会补齐：

```js
e.bot;
e.isGroup;
e.isPrivate;
e.atBot;
e.interaction_id;
e.interaction_data;
e.interaction;
e.interaction_target;
e.button_data;
e.buttonData;
```

Miao-Yunzai 的 `Runtime` 会在插件执行阶段自行初始化，因此桥接层不伪造不完整的 `e.runtime`。插件可以继续使用：

```js
e.runtime
e.runtime.render(...)
e.runtime.getUid(...)
```

但这些能力依赖 Miao-Yunzai 本身及相关插件/浏览器环境，并不是 AlemonJS 平台 API。

## 5. 平台支持矩阵

| 能力                   | OneBot             | `qq-bot`           | 其他 AlemonJS 平台 |
| ---------------------- | ------------------ | ------------------ | ------------------ |
| Yunzai 插件加载        | 支持               | 支持               | 支持               |
| `Bot` 常用代理         | 支持               | 支持               | 部分支持           |
| `e.reply`              | 支持               | 支持               | 支持               |
| `Bot.sendApi`          | OneBot v11 原生    | 不支持             | 不支持             |
| `Bot.icqq.core.jce/pb` | 支持               | 支持               | 支持               |
| icqq SSO / `sendUni`   | 不支持             | 不支持             | 不支持             |
| 按钮                   | 非核心段           | 原生按钮           | 文本降级           |
| Markdown               | 扩展/降级          | 原生 Markdown      | 文本降级           |
| `e.runtime`            | Miao-Yunzai 初始化 | Miao-Yunzai 初始化 | Miao-Yunzai 初始化 |

## 6. 使用建议

1. 普通消息发送优先使用 `e.reply()`、`Bot.sendGroupMsg()` 和 `Bot.sendPrivateMsg()`。
2. 只有明确需要 OneBot v11 action 时使用 `Bot.sendApi()`。
3. 依赖 `Bot.icqq.core.jce/pb` 的插件可以继续运行，但依赖 `sendUni`、真实 `sig` 或 QQ SSO 的插件不能仅靠兼容层解决。
4. 新增全局变量时，必须同时补充：注入位置、平台行为、失败行为和回归测试。

## 7. 维护依据

本文对应的主要实现位置：

- `src/yunzai/worker.ts`：全局变量注入、`Bot`、`segment`、事件字段和 Runtime 启动。
- `src/yunzai/bridge.ts`：平台 API 分发、OneBot 原生透传、消息和按钮转换。
- `src/yunzai/adapters/onebot-icqq.ts`：OneBot/icqq 风格实体代理。
- `src/yunzai/compat.ts`：兼容对象缺失属性/方法的安全包装。
