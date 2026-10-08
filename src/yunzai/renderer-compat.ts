const installed = new WeakSet<object>();

/** 为只有模板截图接口的渲染器补齐浏览器接口，真实页面操作交给 Puppeteer 后端。 */
export function installRendererBrowserCompat(loader: any, report: (message: string) => void): void {
  if (!loader || typeof loader.getRenderer !== 'function' || installed.has(loader)) {
    return;
  }
  installed.add(loader);
  const patched = new WeakSet<object>();
  const original = loader.getRenderer;

  function patch(renderer: any): any {
    if (!renderer || typeof renderer !== 'object' || typeof renderer.browserInit === 'function' || patched.has(renderer)) {
      return renderer;
    }
    patched.add(renderer);
    let pending: Promise<any> | undefined;
    let reportedUnavailable = false;
    let previousCount = Number(renderer.renderNum) || 0;
    const backend = () => Array.from(loader.renderers?.values?.() ?? []).find(
        (candidate: any) => candidate !== renderer && typeof candidate?.browserInit === 'function' && !patched.has(candidate)
      ) as any;

    if (renderer.renderNum === undefined) {
      renderer.renderNum = 0;
    }
    Object.defineProperty(renderer, 'browser', {
      configurable: true,
      get: () => backend()?.browser ?? false
    });
    renderer.browserInit = () => {
      const target = backend();

      if (!target) {
        if (!reportedUnavailable) {
          reportedUnavailable = true;
          report('当前渲染器需要浏览器接口，但没有可用的 Puppeteer 后端');
        }

        return Promise.resolve(false);
      }
      if (pending) {
        return pending;
      }
      pending = Promise.resolve()
        .then(() => target.browserInit())
        .catch(() => {
          report('Puppeteer 浏览器初始化失败，网页功能将使用插件原有降级流程');

          return false;
        })
        .finally(() => {
          pending = undefined;
        });

      return pending;
    };
    if (typeof renderer.restart !== 'function') {
      renderer.restart = (...args: any[]) => {
        const target = backend();

        if (!target || typeof target.restart !== 'function') {
          return;
        }
        const count = Number(renderer.renderNum) || 0;

        target.renderNum = (Number(target.renderNum) || 0) + Math.max(0, count - previousCount);
        previousCount = count;

        return Promise.resolve()
          .then(() => target.restart(...args))
          .catch(() => {
            report('Puppeteer 浏览器重启失败，下次调用将重新初始化');

            return false;
          });
      };
    }

    return renderer;
  }

  loader.getRenderer = function (...args: any[]) {
    return patch(Reflect.apply(original, this, args));
  };

  // lib/puppeteer 以及插件可能已经缓存对象引用；原地补齐，无需再次 getRenderer。
  patch(loader);
  for (const renderer of loader.renderers?.values?.() ?? []) {
    patch(renderer);
  }
  patch(Reflect.apply(original, loader, []));
}
