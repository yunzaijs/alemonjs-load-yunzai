# OneBot / icqq 兼容矩阵

本文记录 `alemonjs-load-yunzai` 在 `platform === 'onebot'` 时提供的 icqq 兼容面。状态以代码和单元测试为准；NapCat、LLOneBot 的实际部署差异应在发布前分别验证。

| 范畴               | 当前能力                                                               | 状态               | 说明                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot                | `Bot[uin]`、好友/群缓存、登录信息、好友/群列表、常用 `pick*`           | 已映射             | 通过 OneBot API 构建兼容代理。                                                                                                                  |
| Group              | 发消息、成员查询、踢人、禁言、名片、管理员、头衔、退群、全员禁言       | 已映射             | 群资料与成员缓存会在查询、事件和成功的本地管理操作后同步更新。                                                                                  |
| Friend / Member    | 私聊、点赞、戳一戳、资料、群成员信息与常用管理操作                     | 已映射             | `pickMember()` 与群事件 `e.member` 使用同一动态缓存；失败时维持 icqq 常见的空值/`false` 降级。                                                  |
| Event              | 群/私聊消息、notice、request、引用消息、`Bot.on` 分层事件              | 已映射             | OneBot 原始事件优先透传；其他平台按通用字段降级构建。                                                                                           |
| Message            | 文本、图片、闪照、@、表情、语音、视频、JSON/XML、引用、历史消息        | 原生映射           | 有精确 OneBot 事件上下文时走原生段；图片、语音和视频的缓存/代理/超时等参数会保留，Worker 会把本机媒体转换为 OneBot 可识别的 `base64://`。       |
| 合并转发           | `Bot/e/group/friend.makeForwardMsg`、原生群/私聊合并转发               | OneBot 原生 + 降级 | 先将 icqq `node.message` 转为 OneBot `node.data.content`，再调用 `send_group_forward_msg` 或 `send_private_forward_msg`；动作明确被拒绝才展平。 |
| 引用回复           | `segment.reply()`、`e.reply(message, true)`                            | OneBot 原生 + 降级 | OneBot 使用标准 reply 段；其他平台保留正文但不伪造引用。                                                                                        |
| OneBot API         | `getForwardMsg`、消息历史、文件 URL、Cookie/CSRF、未显式注册的原生动作 | 仅 OneBot          | 需要当前事件对应的 `@alemonjs/onebot` 客户端；后台任务不会借用历史事件。                                                                        |
| 文件系统与私有扩展 | 群文件、匿名、精华、资料、OCR 等                                       | 实现商依赖         | 代码会透传动作；NapCat、LLOneBot 对每个扩展的支持需单独验证。                                                                                   |

## 原生合并转发策略

1. Worker 同时保留原始 `node` 与展平后的消息段。
2. 仅“回复内容恰好是一条合并转发”时才发起原生 API，避免混合消息的顺序和语义不确定。
3. 明确返回不支持动作或参数时发送展平版本并记录警告。
4. 超时、网络断开等发送状态不确定时不再补发，避免 QQ 用户收到重复消息。
5. Worker API 调用使用事件级 `AsyncLocalStorage` 上下文；后台任务不会借用最近消息执行管理或原生动作。

## 消息字段转换契约

转换只在 `src/yunzai/forward.ts` 的 `toOneBotSegment()` / `toOneBotMessage()` 定义；普通 `raw` 段和合并转发节点共享同一实现。这样一个字段修正不会只在某条发送路径生效。

| icqq / Yunzai 输入                        | OneBot 11 输出                                  | 保留规则                                                                                              |
| ----------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 字符串、`{ type: 'text', text }`          | `{ type: 'text', data: { text } }`              | 文本不拼接、不转 CQ 码。                                                                              |
| `at.qq`                                   | `at.data.qq`                                    | QQ 号和 `all` 保留为字符串。                                                                          |
| `image.file`、`record.file`、`video.file` | 相应段的 `data.file`                            | URL、`file://`、`base64://` 保持语义；Worker 在本机读取转发节点的绝对路径，避免远端 OneBot 无法访问。 |
| `flash.file`                              | `image.data.file` + `image.data.type = 'flash'` | OneBot 11 的闪照是图片参数，不是名为 `flash` 的独立段。                                               |
| `face.id`                                 | `face.data.id`                                  | 原样保留。                                                                                            |
| `json.data`、`xml.data`                   | `json/xml.data.data`                            | JSON 对象会序列化为字符串，满足 OneBot 字段类型。                                                     |
| `location.lat/lng/name/address`           | `location.data.lat/lon/title/content`           | `lng → lon`、`name → title`、`address → content`。                                                    |
| `share.url/title/content/image`           | 同名 `share.data.*`                             | 可选描述和封面不丢失。                                                                                |
| `music.platform/id`                       | `music.data.type/id`                            | 自定义音乐同时保留 `url/audio/title/content/image`。                                                  |
| `poke.id`                                 | `poke.data.type/id`                             | icqq 未给类型时补 QQ 基础戳一戳类型 `1`；实现商给出的类型优先。                                       |
| `dice`、`rps`                             | 同名段、空 `data`                               | OneBot 11 不允许用 icqq 的结果 id 强行指定随机结果。                                                  |
| `node.user_id/nickname/message`           | `node.data.user_id/nickname/content`            | 节点内部再次递归转换为 OneBot 段数组；这是私聊转发 4000 的关键修复。                                  |

`bface`、`sface`、`markdown`、`button`、`mirai` 和文件消息没有统一的 OneBot 11 核心段定义。桥接层会按 `{ type, data }` 形式保留实现商扩展，不会伪装成文本；群/私聊文件应优先使用 icqq 的 `sendFile`/`upload_*_file` 专用 API，而不是消息段。该专用 API 的 `file` 是 **OneBot 服务所在机器** 的本地路径：当前 Worker 与 OneBot 服务分机部署时，必须共享挂载目录或由 OneBot 服务先下载文件；图片、语音、视频不受此限制，桥接层会使用 `base64://` 传输。

## 后续优先级

1. 在 NapCat 和 LLOneBot 实机上覆盖群聊、私聊、图片节点、@节点及失败回退。
2. 根据已安装 Yunzai 插件的真实调用补齐高频 API，并为每个新能力增加 fixture 和回归断言。
3. 将已验证的实现商版本和不兼容动作补充到本文档。
