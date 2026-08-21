//#region src/yunzai/compat.ts
/**
* 为 icqq 行为对象提供缺失成员兜底。
*
* 仅代理 Bot、Group、Member 等行为对象本身，不递归代理方法返回值。资料对象、
* 数组和 Promise 必须保持原生语义，否则 JSON 序列化和 await 会触发大量无意义的
* `toJSON`、`then` 等属性探测。
*/
function createCompatValueWrapper(onMissing) {
	const proxyCache = /* @__PURE__ */ new WeakMap();
	const isSilentProbe = (prop) => prop === "then" || prop === "toJSON" || prop === "inspect" || prop === Symbol.toStringTag || prop === Symbol.for("nodejs.util.inspect.custom");
	function createNoopCompatProxy(label) {
		const emptyArrayMethods = {
			filter: (_fn) => [],
			map: (_fn) => [],
			flatMap: (_fn) => [],
			slice: (..._args) => [],
			concat: (...args) => args.flat ? [].concat(...args) : [],
			includes: (_value) => false,
			indexOf: (_value) => -1,
			find: (_fn) => void 0,
			some: (_fn) => false,
			every: (_fn) => true,
			forEach: (_fn) => void 0,
			reduce: (_fn, initial) => initial,
			join: (sep = ",") => ["", ""].join(sep).slice(0, 0),
			at: (_index) => void 0,
			values: function* values() {},
			entries: function* entries() {},
			keys: function* keys() {},
			[Symbol.iterator]: function* iterator() {}
		};
		const fn = (() => void 0);
		return new Proxy(fn, {
			get(_target, prop) {
				if (isSilentProbe(prop)) return;
				if (prop === Symbol.toPrimitive) return (hint) => hint === "number" ? 0 : "";
				if (prop === Symbol.iterator) return emptyArrayMethods[Symbol.iterator];
				if (prop === "toString") return () => "";
				if (prop === "valueOf") return () => 0;
				if (prop === "length") return 0;
				if (prop === "__compatLabel") return label;
				if (typeof prop === "string" && prop in emptyArrayMethods) return emptyArrayMethods[prop];
				if (typeof prop === "string" && /^\d+$/.test(prop)) return;
				onMissing("get", `${label}.${String(prop)}`);
				return createNoopCompatProxy(`${label}.${String(prop)}`);
			},
			apply() {
				onMissing("call", label);
				return createNoopCompatProxy(`${label}()`);
			},
			construct() {
				onMissing("construct", label);
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
	return function wrapCompatValue(value, label) {
		if (value === null || value === void 0) return createNoopCompatProxy(label);
		const valueType = typeof value;
		if (valueType !== "object" && valueType !== "function") return value;
		const objectValue = value;
		if (proxyCache.has(objectValue)) return proxyCache.get(objectValue);
		const proxy = new Proxy(value, {
			get(target, prop, receiver) {
				if (!(prop in target)) {
					if (isSilentProbe(prop)) return;
					onMissing("get", `${label}.${String(prop)}`);
					return createNoopCompatProxy(`${label}.${String(prop)}`);
				}
				const result = Reflect.get(target, prop, receiver);
				if (typeof result !== "function") return result;
				return (...args) => {
					const called = Reflect.apply(result, target, args);
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

//#endregion
export { createCompatValueWrapper };