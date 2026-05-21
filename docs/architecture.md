# 架构说明

## 总览

本项目当前以“机器人进程内统一控制核心”为边界，明确区分两条入口链路：

- `web -> api -> koa进程(机器人进程) -> Yunzai进程`
- `webview -> 桌面主进程 -> desktop子进程 -> 机器人进程 -> Yunzai子进程`

其中：

- `koa` 与机器人控制核心同进程
- `desktop子进程` 与机器人进程独立
- `Yunzai` 作为被托管的独立子进程运行

## 进程拓扑

```text
Web Frontend
  -> HTTP /api
    -> Koa Server (same process as Robot Core)
      -> Robot Control Service
        -> Yunzai Manager
          -> Yunzai Worker Process

WebView
  -> Desktop Main Process
    -> Desktop Child Process
      -> Robot Status Bridge (current scope)
        -> Yunzai Manager
          -> Yunzai Worker Process
```

## 职责边界

### Web 前端

- 只负责展示和交互
- 只通过 `/api` 访问机器人进程
- 不感知文件总线、IPC 目录或 Yunzai 子进程协议

### Koa 服务器 / 机器人进程

- 是 Web 链路唯一入口
- 承载统一的控制核心
- 负责状态聚合、配置读写、动作执行和错误转换
- 通过 `manager` 管理 Yunzai 子进程

### Desktop 子进程

- 是桌面链路的业务入口
- 当前跨进程交互范围只收口到“机器人状态”
- 不应被表述为已具备通用动作转发或完整控制桥

### Yunzai 子进程

- 只负责运行 Yunzai 生态代码
- 由机器人进程托管
- 不直接对 Web 或 desktop 暴露

## 协议边界

### 对外 HTTP 接口

以下接口是当前稳定的 Web 合约：

- `/api/repo`
- `/api/yunzai/config`
- `/api/yunzai/status`
- `/api/yunzai/action`

这些接口的调用方只能是前端或其他 HTTP 客户端，不应扩展为 bus 协议入口。

### 机器人控制核心

机器人进程内的统一控制核心当前由以下模块构成：

- `panel-service`
  负责对 `api-router` 和 `desktop` 暴露统一能力
- `yunzai/control`
  负责封装状态快照和动作执行
- `yunzai/manager`
  负责真正控制 Yunzai 子进程

`manager` 是唯一权威控制面；所有启动、停止、重启、插件安装、插件更新最终都应收敛到这里。

## 关于 src/bus/\*

`src/bus/*` 当前不属于 Web 主链路协议的一部分。

其保留定位是：

- 为 `desktop子进程 -> 机器人进程` 的状态桥接预留或服务
- 不应用于 `web -> api -> koa` 这条链路
- 不应让前端直接感知 bus 目录、bus 消息文件或 bus 事件协议

如果未来启用这套桥接，也必须保持下面这个边界不变：

- Web 继续走 HTTP `/api`
- 仅 desktop 独立进程场景走 bus
- 当前约束下，desktop 与机器人主进程的已定义交互仅为“机器人状态”

## 当前实现约束

- `panel-service` 被视为机器人进程内 service 聚合层，不再承担“web 进程客户端”角色
- `api-router` 只做 HTTP 入口，不引入 bus 事件接口
- `desktop` 文义上不是机器人进程本体；当前文档只承诺状态交互，不承诺完整动作桥接

## 升级路径

后续如需演进，优先顺序如下：

1. 标准化 desktop bridge
   先从状态同步协议开始标准化，再决定是否扩展到动作请求/响应

2. 统一 service 抽象
   让 Web 和 desktop 都只依赖同一组 service 语义，不复制控制逻辑

3. 固化 Yunzai 子进程边界
   继续限制 `worker` 只承担 Yunzai 运行时职责，不回流到上层入口逻辑

4. 若引入更多进程通信
   仍保持“Web 只经 `/api`、desktop 才可能经 bridge/bus”的边界，不把 bus 协议抬升为 Web API
