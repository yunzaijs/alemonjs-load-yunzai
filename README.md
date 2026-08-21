# 阿柠檬-加载Yunzai

这是一个桥接层，通过进程隔离 + IPC 协议，将 Yunzai-Bot 生态无缝桥接到现代 AlemonJS 框架上，同时提供了完整的安装管理、插件管理和跨平台消息适配能力。设计上做到了与 Yunzai 运行时的完全解耦。完全不需要有重启后导致账户异常和整个机器人不再响应的心智负担，因为Yunzai是被alemonjs托管起来的

## OneBot 兼容

当前兼容策略是明确的双通道：

- `onebot` 平台走 `OneBot -> icqq-compatible adapter`
- 其他平台走 AlemonJS 通用消息模型降级兼容

实现位置：

- OneBot adapter: [src/yunzai/adapters/onebot-icqq.ts](./src/yunzai/adapters/onebot-icqq.ts)
- 事件桥接分流: [src/yunzai/bridge.ts](./src/yunzai/bridge.ts)
- Worker 路由与通用兜底: [src/yunzai/worker.ts](./src/yunzai/worker.ts)

### 安装

请访问官网 https://alemonjs.com 先安装 ALemonX,

或者在官网简单的了解一下一些对于该框架的基本内容,

在ALemonX新建机器人并找到 插件管理

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

- 如帮助、面板等图片指令提示 Chromium/Chrome 缺失，可发送 `#yz安装浏览器`。该指令会在 Yunzai 目录执行 `npx puppeteer browsers install chrome`。

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
  # 同时进入 Yunzai Worker 的事件数，默认 1。
  # 降低共享 Puppeteer 被并发渲染中断的概率；最大值为 4。
  event_concurrency: 1
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
