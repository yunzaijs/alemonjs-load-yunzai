# 阿柠檬-加载Yunzai

这是一个桥接层，通过进程隔离 + IPC 协议，将 Yunzai-Bot 生态无缝桥接到现代 AlemonJS 框架上，同时提供了完整的安装管理、插件管理和跨平台消息适配能力。设计上做到了与 Yunzai 运行时的完全解耦。完全不需要有重启后导致账户异常和整个机器人不再响应的心智负担，因为Yunzai是被alemonjs托管起来的

- 尽可能的兼容所有效果，因此版本需要 ⚠️ `alemonjs` >= v2.1.46

- 是OneBot优先的，确保最大程度上适用于所有Yunzai插件，其他平台适配情况则完全依赖于框架的通用模型

<img src="./image.png">

## 架构链路

当前实现明确收口为两条入口链路：

- `web -> api -> koa进程(机器人进程) -> Yunzai进程`
- `webview -> 桌面主进程 -> desktop子进程 -> 机器人进程 -> Yunzai子进程`

边界说明：

- `koa` 与机器人控制核心同进程，Web 前端只通过 `/api` 访问，不使用文件总线。
- `desktop` 是独立子进程，不是机器人进程本体；当前与机器人主进程的跨进程交互范围仅收口到“机器人状态”。
- `manager` 是机器人进程内唯一的 Yunzai 控制面。
- `worker` / `Yunzai` 为独立子进程，不直接暴露给 Web 或 desktop。

## OneBot 兼容

当前兼容策略是明确的双通道：

- `onebot` 平台走 `OneBot -> icqq-compatible adapter`
- 其他平台走 AlemonJS 通用消息模型降级兼容

实现位置：

- OneBot adapter: [src/yunzai/adapters/onebot-icqq.ts](./src/yunzai/adapters/onebot-icqq.ts)
- 事件桥接分流: [src/yunzai/bridge.ts](./src/yunzai/bridge.ts)
- Worker 路由与通用兜底: [src/yunzai/worker.ts](./src/yunzai/worker.ts)

当前已经覆盖的兼容面：

- `Bot / Friend / Group / Member`
- `Bot[uin]`
- 私聊 / 群聊 / `notice` / `request`
- `makeForwardMsg`
- `reply`
- `source`
- `getChatHistory`

## 测试

OneBot 兼容回归测试入口：

```sh
yarn test
```

当前测试资产：

- 主测试: [tests/onebot-compat.test.mjs](./tests/onebot-compat.test.mjs)
- 事件 fixture: [tests/fixtures/onebot-events.mjs](./tests/fixtures/onebot-events.mjs)

新增兼容修复时，优先补对应 fixture 和断言，再改实现，避免回到“线上告警驱动散补”的方式。

详细拓扑、职责和升级路径见 [docs/architecture.md](./docs/architecture.md)。

### 安装

请访问官网 https://alemonjs.com 先安装 桌面/web版,

或者在官网简单的了解一下一些对于该框架的基本内容

- 仓库地址

```sh
https://github.com/yunzaijs/alemonjs-load-yunzai.git
```

- 仓库分支

```sh title="alemon.config.yaml"
release: 123
```

- alemon.config.yaml

```yaml
apps:
  alemonjs-load-yunzai: true # 启动扩展
```

## 管理指令

所有管理指令⚠️`仅限主人使用`，前缀支持 `#yz` 或 `#云崽`,使用`#yz帮助`、`#yz插件帮助`和`#yz插件说明<别名>`了解基本使用

- alemon.config.yaml 新增 uk

```yaml
# https://alemonjs.com/docs/config
# 可发指令后观察控制台 [UserKey:abcdefg] 后得到
# 不配置将无法正常获得主人权限
master_key:
  abcdefg: true
```

- 安装一般操作步骤

`#yz安装` -> `#yz安装插件miao` -> `#yz安装依赖` -> `#yz启动/#yz重启`

## 配置项

在 `alemon.config.yaml` 中通过 `alemonjs-load-yunzai` 键进行配置，所有项均为可选：

```yaml
# https://alemonjs.com/docs/config
alemonjs-load-yunzai:
  # Bot 目录名
  bot_name: Miao-Yunzai
  # GitHub 代理前缀
  gh_proxy: https://ghfast.top/
  # Yunzai 仓库地址
  yunzai_repo: https://github.com/yoimiya-kokomi/Miao-Yunzai.git
  # miao-plugin 仓库地址
  miao_plugin_repo: https://github.com/yoimiya-kokomi/miao-plugin.git
  # 自定义插件（会与内置插件列表合并，别名不区分大小写）
  plugins:
    my:
      dirName: my-plugin
      repoUrl: https://github.com/xxx/my-plugin.git
      label: my-plugin
      # 别名
      aliases:
        - 我的插件
        - myplugin
```

> Redis 配置会自动从顶层 `redis` 配置同步到 Miao-Yunzai，无需重复配置。

```yaml
# https://alemonjs.com/docs/config
redis:
  host: 127.0.0.1
  port: 6379
  user: root
  db: 0
```

## 免责声明

- 勿用于以盈利为目的的场景

- 代码开放，无需征得特殊同意，可任意使用。能备注来源最好，但不强求

- 图片与其他素材均来自于网络，仅供交流学习使用，如有侵权请联系，会立即删除
