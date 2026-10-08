import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const guardedPluginClasses = new WeakSet<object>();

/** loader 在每条消息里重新构造插件实例，需同时覆盖原型方法与构造器内的 accept。 */
export function protectPluginAcceptHandlers(loader: any, report: (plugin: string, error: Error) => void): void {
  for (const entry of loader?.priority ?? []) {
    const Plugin = entry.class;

    if (typeof Plugin !== 'function' || guardedPluginClasses.has(Plugin)) {
      continue;
    }
    const GuardedPlugin = new Proxy(Plugin, {
      construct(target, args, newTarget) {
        const instance = Reflect.construct(target, args, newTarget);
        const accept = instance.accept;

        if (typeof accept === 'function') {
          instance.accept = async function (...acceptArgs: any[]) {
            try {
              return await accept.apply(this, acceptArgs);
            } catch (reason) {
              report(String(this.name ?? entry.plugin?.name ?? target.name), reason instanceof Error ? reason : new Error(String(reason)));

              // 与未匹配的 accept 一致，让 loader 继续处理后续插件。
              return false;
            }
          };
        }

        return instance;
      }
    });

    guardedPluginClasses.add(GuardedPlugin);
    entry.class = GuardedPlugin;
  }
}

/** 只依据实际插件目录的堆栈帧归因，不能仅凭错误消息包含 plugins 字样。 */
export function identifyPluginFault(reason: unknown, root: string): string | undefined {
  if (!(reason instanceof Error) || !reason.stack) {
    return undefined;
  }
  const prefix = `${resolve(root).replace(/\\/g, '/')}/`;

  for (const line of reason.stack.split('\n').slice(1)) {
    const match = line.match(/^\s+at\s+(?:.*?\()?((?:file:\/\/\/|\/|[A-Za-z]:[\\/]).*?):\d+:\d+\)?$/);

    if (!match) {
      continue;
    }
    let filename: string;

    try {
      filename = match[1].startsWith('file:') ? fileURLToPath(match[1]) : match[1];
    } catch {
      continue;
    }
    filename = resolve(filename).replace(/\\/g, '/');
    const canonical = process.platform === 'win32' ? filename.toLowerCase() : filename;
    const base = process.platform === 'win32' ? prefix.toLowerCase() : prefix;

    if (canonical.startsWith(base)) {
      const plugin = filename.slice(prefix.length).split('/')[0];

      if (plugin) {
        return plugin;
      }
    }
  }

  return undefined;
}

/**
 * 同进程插件的有限故障边界：只恢复可归因的异步拒绝。
 * 同步异常及无法归因的拒绝保持致命语义；这里不尝试卸载插件共享状态。
 */
export function installPluginFaultBoundary(root: string, report: (plugin: string, error: Error) => void): () => void {
  const onRejection = (reason: unknown) => {
    const plugin = identifyPluginFault(reason, root);

    if (plugin && reason instanceof Error) {
      report(plugin, reason);

      return;
    }
    // 保留默认致命退出行为，不使用全局 uncaughtException 吞掉未知故障。
    setImmediate(() => {
      throw reason instanceof Error ? reason : new Error(String(reason));
    });
  };

  process.on('unhandledRejection', onRejection);

  return () => process.off('unhandledRejection', onRejection);
}
