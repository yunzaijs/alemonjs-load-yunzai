import { join } from "node:path";
import { ResultCode } from "alemonjs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

//#region src/yunzai/qq-material-cache.ts
const MAX_BYTES = 10485760;
const WINDOW_MS = 7776e6;
const OWN_LIMIT = 50;
/** Only explicit platform rejections are safe to retry; never retry an uncertain send. */
function materialErrorCode(value) {
	if (Array.isArray(value)) {
		if (value.some((item) => item?.code === ResultCode.Ok)) return;
		return value.map(materialErrorCode).find((code) => code !== void 0);
	}
	if (!value || typeof value !== "object") return;
	const code = Number(value.code);
	if (code >= 40035001 && code <= 40035010) return code;
	return materialErrorCode(value.data) ?? materialErrorCode(value.response?.data) ?? materialErrorCode(value.cause) ?? materialErrorCode(value.message);
}
function unwrap(result) {
	if (result.code !== ResultCode.Ok || !result.data) throw Object.assign(/* @__PURE__ */ new Error("QQ material operation failed"), { cause: result });
	return result.data;
}
/** Content identity, not filenames or URLs: a changed panel must be uploaded again. */
async function readMaterialImage(source) {
	let bytes;
	if (/^https?:\/\//i.test(source)) {
		const response = await fetch(source, { signal: AbortSignal.timeout(2e4) });
		if (!response.ok || !response.body) throw new Error("Image download failed");
		const reader = response.body.getReader();
		const chunks = [];
		let length = 0;
		try {
			while (true) {
				const part = await reader.read();
				if (part.done) break;
				length += part.value.length;
				if (length > MAX_BYTES) throw new Error("Markdown image exceeds 10 MiB");
				chunks.push(Buffer.from(part.value));
			}
		} finally {
			await reader.cancel();
		}
		bytes = Buffer.concat(chunks);
	} else if (source.startsWith("file://")) {
		const path = fileURLToPath(source);
		const info = await stat(path);
		if (!info.isFile() || info.size > MAX_BYTES) throw new Error("Invalid Markdown image file");
		bytes = await readFile(path);
	} else {
		const data = source.replace(/^base64:\/\//, "").replace(/^data:image\/[a-z+.-]+;base64,/i, "");
		if (data.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) throw new Error("Invalid or oversized Markdown image data");
		bytes = Buffer.from(data, "base64");
	}
	if (!bytes.length || bytes.length > MAX_BYTES) throw new Error("Markdown image exceeds 10 MiB");
	const ext = bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ? "png" : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "jpeg" : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii")) ? "gif" : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" ? "webp" : void 0;
	if (!ext) throw new Error("Markdown image format must be PNG, JPEG, GIF or WebP");
	return {
		hash: createHash("sha256").update(bytes).digest("hex"),
		bytes,
		ext
	};
}
/** Per-bot persistent metadata only. All prepare/send/evict work is serialized in this process. */
var QQMaterialCache = class {
	directory;
	warn;
	now;
	queues = /* @__PURE__ */ new Map();
	constructor(directory, warn, now = Date.now) {
		this.directory = directory;
		this.warn = warn;
		this.now = now;
	}
	async run(botId, task, client) {
		const work = (this.queues.get(botId) ?? Promise.resolve()).catch(() => {}).then(async () => {
			const filename = join(this.directory, `${createHash("sha256").update(botId).digest("hex")}.json`);
			const state = {
				version: 1,
				botId,
				entries: []
			};
			try {
				if ((await stat(filename)).size > 1048576) throw new Error("Oversized material cache");
				const saved = JSON.parse(await readFile(filename, "utf8"));
				if (saved.version !== 1 || saved.botId !== botId || !Array.isArray(saved.entries) || saved.entries.length > OWN_LIMIT) throw new Error("Invalid material cache");
				state.entries = saved.entries.filter((entry) => {
					return /^[a-f0-9]{64}$/.test(entry.hash) && validResource(entry.resource, botId) && Number.isSafeInteger(entry.sends) && entry.sends >= 0 && Number.isFinite(entry.lastUsed) && Number.isFinite(entry.expiresAt);
				});
			} catch (error) {
				if (error?.code !== "ENOENT") this.warn("QQ 素材缓存无法读取，将仅管理本次新建的素材");
			}
			const save = async () => {
				await mkdir(this.directory, {
					recursive: true,
					mode: 448
				});
				const temp = `${filename}.${randomUUID()}.tmp`;
				await writeFile(temp, JSON.stringify(state), { mode: 384 });
				await rename(temp, filename);
			};
			return await task(new QQMaterialSession(state, client, save, this.now, this.warn));
		});
		this.queues.set(botId, work);
		try {
			return await work;
		} finally {
			if (this.queues.get(botId) === work) this.queues.delete(botId);
		}
	}
};
function validResource(resource, botId) {
	return resource?.kind === "media-resource" && resource.type === "image" && resource.usage === "markdown" && resource.owner?.platform === "qq-bot" && resource.owner.botId === botId && Boolean(resource.id) && /^qqbot-media:\/\/image\/v1\/[A-Za-z0-9_-]+$/.test(resource.reference);
}
var QQMaterialSession = class {
	state;
	client;
	save;
	now;
	warn;
	constructor(state, client, save, now, warn) {
		this.state = state;
		this.client = client;
		this.save = save;
		this.now = now;
		this.warn = warn;
	}
	async list() {
		const resources = /* @__PURE__ */ new Map();
		let cursor;
		let total = 0;
		const cursors = /* @__PURE__ */ new Set();
		do {
			const page = unwrap(await this.client.list({
				usage: "markdown",
				cursor
			}));
			for (const resource of page.Items) {
				if (!validResource(resource, this.state.botId)) throw new Error("Invalid material listing");
				resources.set(resource.id, resource);
			}
			total = Math.max(total, page.Total ?? resources.size);
			cursor = page.NextCursor;
			if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error("Invalid material pagination");
			if (cursor) cursors.add(cursor);
		} while (cursor);
		this.state.entries = this.state.entries.filter((entry) => resources.has(entry.resource.id));
		for (const entry of this.state.entries) {
			const expiresAt = resources.get(entry.resource.id)?.expiration?.expiresAt;
			if (expiresAt) entry.expiresAt = expiresAt;
		}
		return {
			total: Math.max(total, resources.size),
			resources
		};
	}
	async remove(entry) {
		const result = await this.client.delete(entry.resource);
		if (result.code !== ResultCode.Ok && materialErrorCode(result) !== 40035008) unwrap(result);
		this.state.entries = this.state.entries.filter((item) => item !== entry);
		await this.save();
	}
	async prepare(sources) {
		if (sources.length > OWN_LIMIT) throw new Error("Too many Markdown images in one reply");
		const images = [];
		let bytes = 0;
		for (const source of sources) {
			const image = await readMaterialImage(source);
			bytes += image.bytes.length;
			if (bytes > 20971520) throw new Error("Markdown reply image data exceeds 20 MiB");
			images.push(image);
		}
		const wanted = new Set(images.map((image) => image.hash));
		let listing;
		const used = [];
		for (const image of images) {
			let entry = this.state.entries.find((item) => item.hash === image.hash && item.expiresAt > this.now() + 6e4);
			if (!entry) {
				listing ??= await this.list();
				entry = this.state.entries.find((item) => item.hash === image.hash && item.expiresAt > this.now() + 6e4);
				if (!entry) {
					await this.save();
					const stale = this.state.entries.find((item) => item.hash === image.hash);
					if (stale) {
						await this.remove(stale);
						listing.total--;
					}
					while (this.state.entries.length >= OWN_LIMIT || listing.total >= 100) {
						const cutoff = this.now() - 6048e5;
						const victim = this.state.entries.filter((item) => !wanted.has(item.hash)).sort((a, b) => Number(b.lastUsed < cutoff) - Number(a.lastUsed < cutoff) || a.sends - b.sends || a.lastUsed - b.lastUsed)[0];
						if (!victim) throw new Error("QQ material quota is occupied by other resources");
						await this.remove(victim);
						listing.total--;
					}
					const resource = unwrap(await this.client.upload({
						type: "image",
						usage: "markdown",
						data: image.bytes.toString("base64"),
						name: `ly-${image.hash.slice(0, 16)}-${randomUUID()}.${image.ext}`
					}));
					if (!validResource(resource, this.state.botId)) throw new Error("Invalid material upload result");
					const window = Math.min(WINDOW_MS, (resource.expiration?.windowSeconds ?? WINDOW_MS / 1e3) * 1e3);
					entry = {
						hash: image.hash,
						resource,
						sends: 0,
						lastUsed: 0,
						expiresAt: resource.expiration?.expiresAt ?? this.now() + window
					};
					this.state.entries.push(entry);
					listing.total++;
					await this.save();
				}
			}
			used.push(entry);
		}
		return {
			references: used.map((entry) => entry.resource.reference),
			entries: [...new Set(used)]
		};
	}
	async success(entries) {
		for (const entry of entries) {
			entry.sends++;
			entry.lastUsed = this.now();
			entry.expiresAt = this.now() + Math.min(WINDOW_MS, (entry.resource.expiration?.windowSeconds ?? WINDOW_MS / 1e3) * 1e3);
		}
		try {
			await this.save();
		} catch {
			this.warn("QQ 消息已发送，但素材使用记录保存失败");
		}
	}
	async invalidate(entries) {
		for (const entry of entries) await this.remove(entry);
	}
};

//#endregion
export { QQMaterialCache, materialErrorCode, readMaterialImage };