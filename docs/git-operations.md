# Git 操作与失败处理

Web 的 `/api/yunzai/action` 根据请求体的 `action` 进入 control，再调用 manager；聊天管理指令也调用 manager。

| 操作 | Git 行为 |
| --- | --- |
| 安装本体、安装插件 | clone |
| update / #yz更新 | 本体目录 pull，然后同步依赖；原来运行则重新启动 |
| force_update / #yz强制更新 | 本体目录 fetch --all、reset --hard origin/HEAD、pull |
| update_plugin / 更新插件 | 插件目录 pull |
| force_update_plugin / 强制更新插件 | 插件目录 fetch、reset、pull |
| ZIP 修复仓库来源 | init、remote remove/add origin |

只凭 `Command failed: git pull` 无法区分普通更新与强制更新；结合请求体 action 和报错目录可定位入口及目标。

原生 Git 对有工作目录的调用使用 `-c safe.directory=<绝对目录>`，兜底兼容 Windows 不记录所有权的文件系统。配置只在当前命令有效，不写全局配置，不使用通配符。未安装 Git 时保留原有 isomorphic-git 回退；运行失败不会自动强制重置或切换实现重做更新。

若目录信任仍失败，反馈提示在机器人运行账户下信任该精确目录，或迁移到支持所有权的磁盘。反馈还区分本地冲突、仓库配置、权限与网络问题，原始错误写入机器人日志。更新会先停止 Worker，失败后可能保持停止，接口会提示当前停止状态。

验证：`yarn test:git`。测试使用 Git 的所有权测试开关模拟拒绝，并验证目录例外不会信任其他仓库。
