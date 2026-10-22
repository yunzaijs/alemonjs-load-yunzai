# LoadYunzai

这是一个桥接层，通过进程隔离 + IPC 协议，将所有 Yunzai-Bot 版本的生态无缝桥接到现代 AlemonJS 框架的加载插件。默认安装 [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai)，同时兼容 Miao-Yunzai。

## 特性

- 所有 Yunzai-Bot 版本的生态都能无缝桥接

- 提供了完整的且不需要运行Yunzai就能进行管理的能力

- 让 Yunzai-Bot 插件具备跨平台适配能力

- 完全不需要有重启后，可能会导致账户异常和整个机器人不再响应的心智负担

## OneBot 兼容

当前兼容策略是明确的双通道：

- `onebot` 平台走 `OneBot -> icqq-compatible adapter`
- 其他平台走 AlemonJS 通用消息模型降级兼容

实现位置：

- OneBot adapter: [src/yunzai/adapters/onebot-icqq.ts](./src/yunzai/adapters/onebot-icqq.ts)
- 事件桥接分流: [src/yunzai/bridge.ts](./src/yunzai/bridge.ts)
- Worker 路由与通用兜底: [src/yunzai/worker.ts](./src/yunzai/worker.ts)

全局变量、`Bot.icqq`、`segment`、`logger`、`redis` 和平台差异说明：
[Yunzai 全局变量兼容说明](./docs/yunzai-global-compatibility.md)

插件及命令规则的 `event` 同时兼容 `notice.group.increase` 和 `notice.group_increase`，退群、禁言等含下划线的通知类型同样适用；也可追加具体子类型，例如 `notice.group.increase.invite`。原始 `notice_type` 保留 OneBot 的下划线格式，`Bot.on('notice.group.increase', ...)` 继续使用点号事件名。

## QQ Bot 图文与按钮

`qq-bot` 平台会将图片消息段上传为 QQ 官方 Markdown 素材，在同一条 Markdown 中发送图片、正文和可点击按钮，无需图床。相同图片按内容指纹复用素材引用；缓存按机器人隔离，重启后继续保留。插件回复、主动群聊/私聊发送和转发展开均适用。

每个机器人最多管理 50 张加载器素材，并检查官方 100 张总额；只淘汰自己创建并记录的素材，不删除其他插件的素材。官方限制为单图 10 MiB、PNG/JPEG/GIF/WebP，素材成功引用后有效期顺延 90 天。缓存命中不再上传，成功发送后才累计使用次数。

准备失败、配额被占用或开启 `markdownToText` 时，沿用独立图片发送。素材引用明确失效时最多重建并重试一次；超时等结果不确定的发送不重试。详细策略与缓存位置见 [QQ Markdown 素材缓存](./docs/qq-markdown-materials.md)。

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

`#yz安装` -> `#yz安装插件<别名>`（按需） -> `#yz启动/#yz重启`

依赖会在安装、启动、更新和插件安装或更新时自动在后台同步，用户无需单独执行安装依赖。`#yz安装依赖` 仅作为依赖损坏时的兼容修复命令保留；依赖安装失败不会删除已克隆的机器人目录。

TRSS-Yunzai 需要 pnpm 来处理其 `link:` 依赖。若系统未安装 pnpm，加载器会使用内置 Yarn 在插件运行目录中自动准备一份私有 pnpm，再继续安装依赖，无需全局安装。

- 如帮助、面板等图片指令提示 Chromium/Chrome 缺失，可发送 `#yz安装浏览器`。该指令会在 Yunzai 目录执行 `npx puppeteer browsers install chrome`。

## 配置项

在 `alemon.config.yaml` 中通过 `alemonjs-load-yunzai` 键进行配置，所有项均为可选：

```yaml
# https://alemonjs.com/docs/config
alemonjs-load-yunzai:
  # GitHub 代理前缀
  gh_proxy: https://ghfast.top/
  # Yunzai 仓库地址
  yunzai_repo: https://github.com/TimeRainStarSky/Yunzai.git
  # miao-plugin 仓库地址
  miao_plugin_repo: https://github.com/yoimiya-kokomi/miao-plugin.git
  # 同时进入 Yunzai Worker 的事件数，默认 1。
  # 降低共享 Puppeteer 被并发渲染中断的概率；最大值为 4。
  event_concurrency: 1
  # 自定义插件（会与内置插件列表合并，别名不区分大小写）
  plugins:
    my:
      repoUrl: https://github.com/xxx/my-plugin.git
      label: my-plugin
      # 可选：不填时自动使用仓库名
      # dirName: my-plugin
      # 别名
      aliases:
        - 我的插件
        - myplugin
```

> Redis 配置会自动从顶层 `redis` 配置同步到当前 Yunzai，无需重复配置。

```yaml
# https://alemonjs.com/docs/config
db:
  redis:
    host: 127.0.0.1
    port: 6379
    user: root
    db: 0
```
