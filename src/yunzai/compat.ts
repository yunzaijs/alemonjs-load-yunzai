type CompatMissingKind = 'get' | 'call' | 'construct';

type CompatWarning = (kind: CompatMissingKind, label: string) => void;

/**
 * 为 icqq 行为对象提供缺失成员兜底。
 *
 * 仅代理 Bot、Group、Member 等行为对象本身，不递归代理方法返回值。资料对象、
 * 数组和 Promise 必须保持原生语义，否则 JSON 序列化和 await 会触发大量无意义的
 * `toJSON`、`then` 等属性探测。
 */
export function createCompatValueWrapper(onMissing: CompatWarning) {
  const proxyCache = new WeakMap<object, any>();

  const isSilentProbe = (prop: PropertyKey): boolean => prop === 'then' || prop === 'toJSON' || prop === 'inspect' || prop === Symbol.toStringTag || prop === Symbol.for('nodejs.util.inspect.custom');

  function createNoopCompatProxy(label: string): any {
    const emptyArrayMethods = {
      filter: (_fn?: any) => [],
      map: (_fn?: any) => [],
      flatMap: (_fn?: any) => [],
      slice: (..._args: any[]) => [],
      concat: (...args: any[]) => (args.flat ? ([] as any[]).concat(...args) : []),
      includes: (_value?: any) => false,
      indexOf: (_value?: any) => -1,
      find: (_fn?: any) => undefined,
      some: (_fn?: any) => false,
      every: (_fn?: any) => true,
      forEach: (_fn?: any) => undefined,
      reduce: (_fn?: any, initial?: any) => initial,
      join: (sep = ',') => ['', ''].join(sep).slice(0, 0),
      at: (_index: number) => undefined,
      values: function* values() {},
      entries: function* entries() {},
      keys: function* keys() {},
      [Symbol.iterator]: function* iterator() {}
    } as const;

    const fn = (() => undefined) as any;

    return new Proxy(fn, {
      get(_target, prop) {
        if (isSilentProbe(prop)) {
          return undefined;
        }
        if (prop === Symbol.toPrimitive) {
          return (hint: string) => (hint === 'number' ? 0 : '');
        }
        if (prop === Symbol.iterator) {
          return emptyArrayMethods[Symbol.iterator];
        }
        if (prop === 'toString') {
          return () => '';
        }
        if (prop === 'valueOf') {
          return () => 0;
        }
        if (prop === 'length') {
          return 0;
        }
        if (prop === '__compatLabel') {
          return label;
        }
        if (typeof prop === 'string' && prop in emptyArrayMethods) {
          return (emptyArrayMethods as any)[prop];
        }
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          return undefined;
        }

        onMissing('get', `${label}.${String(prop)}`);

        return createNoopCompatProxy(`${label}.${String(prop)}`);
      },
      apply() {
        onMissing('call', label);

        return createNoopCompatProxy(`${label}()`);
      },
      construct() {
        onMissing('construct', label);

        return createNoopCompatProxy(`new ${label}()`);
      },
      set() {
        return true;
      },
      has() {
        return false;
      },
      ownKeys() {
        return [];
      },
      getOwnPropertyDescriptor() {
        return {
          configurable: true,
          enumerable: false
        };
      }
    });
  }

  return function wrapCompatValue<T>(value: T, label: string): T {
    if (value === null || value === undefined) {
      return createNoopCompatProxy(label) as T;
    }

    const valueType = typeof value;

    if (valueType !== 'object' && valueType !== 'function') {
      return value;
    }

    const objectValue = value as object;

    if (proxyCache.has(objectValue)) {
      return proxyCache.get(objectValue);
    }

    const proxy = new Proxy(value as any, {
      get(target, prop, receiver) {
        if (!(prop in target)) {
          if (isSilentProbe(prop)) {
            return undefined;
          }

          onMissing('get', `${label}.${String(prop)}`);

          return createNoopCompatProxy(`${label}.${String(prop)}`);
        }

        const result = Reflect.get(target, prop, receiver);

        if (typeof result !== 'function') {
          return result;
        }

        return (...args: any[]) => {
          const called = Reflect.apply(result, target, args);

          // EventEmitter 风格 API 通常返回自身以便链式调用，继续暴露代理能力。
          return called === target ? receiver : called;
        };
      },
      set(target, prop, nextValue, receiver) {
        return Reflect.set(target, prop, nextValue, receiver);
      }
    });

    proxyCache.set(objectValue, proxy);

    return proxy;
  };
}
