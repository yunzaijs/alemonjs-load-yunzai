import { PACKAGE_ROOT } from "../path.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

//#region src/bus/file-bus.ts
const ACTIVE_EVENT_FILE_LIMIT = 200;
const ARCHIVE_REQUEST_FILE_LIMIT = 200;
const ARCHIVE_RESPONSE_FILE_LIMIT = 200;
const ARCHIVE_EVENT_FILE_LIMIT = 400;
const PROCESSING_REQUEST_FILE_LIMIT = 100;
const PROCESSING_REQUEST_STALE_MS = 216e5;
const CLEANUP_INTERVAL_MS = 3e4;
const BUS_ROOT = resolve(PACKAGE_ROOT, "runtime", "ipc-bus");
const DIRS = {
	root: BUS_ROOT,
	requests: join(BUS_ROOT, "requests"),
	responses: join(BUS_ROOT, "responses"),
	events: join(BUS_ROOT, "events"),
	state: join(BUS_ROOT, "state"),
	processingRequests: join(BUS_ROOT, "processing", "requests"),
	archiveRequests: join(BUS_ROOT, "archive", "requests"),
	archiveResponses: join(BUS_ROOT, "archive", "responses"),
	archiveEvents: join(BUS_ROOT, "archive", "events")
};
let lastCleanupAt = 0;
function ensureDir(dir) {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
function ensureBusDirs() {
	for (const dir of Object.values(DIRS)) ensureDir(dir);
}
function atomicWriteJson(filePath, data) {
	ensureDir(dirname(filePath));
	const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
	writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
	renameSync(tmpPath, filePath);
}
function readJsonFile(filePath) {
	return JSON.parse(readFileSync(filePath, "utf-8"));
}
function listJsonFiles(dir) {
	return readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
}
function extractTimestamp(fileName) {
	const match = fileName.match(/(?:^|_)(\d{13})(?:_|\.json$)/);
	return match ? Number(match[1]) : 0;
}
function pruneDirectory(dir, maxFiles) {
	const files = listJsonFiles(dir);
	while (files.length > maxFiles) {
		const oldest = files.shift();
		if (!oldest) break;
		rmSync(join(dir, oldest), { force: true });
	}
}
function pruneProcessingRequests() {
	const now = Date.now();
	const files = listJsonFiles(DIRS.processingRequests);
	for (const fileName of files) if (now - extractTimestamp(fileName) > PROCESSING_REQUEST_STALE_MS) rmSync(join(DIRS.processingRequests, fileName), { force: true });
	pruneDirectory(DIRS.processingRequests, PROCESSING_REQUEST_FILE_LIMIT);
}
function cleanupBusStorage() {
	const now = Date.now();
	if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
	lastCleanupAt = now;
	ensureBusDirs();
	pruneDirectory(DIRS.archiveRequests, ARCHIVE_REQUEST_FILE_LIMIT);
	pruneDirectory(DIRS.archiveResponses, ARCHIVE_RESPONSE_FILE_LIMIT);
	pruneDirectory(DIRS.archiveEvents, ARCHIVE_EVENT_FILE_LIMIT);
	pruneProcessingRequests();
}
function createBusId(prefix) {
	return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
function responsePath(replyTo) {
	return join(DIRS.responses, `${replyTo}.json`);
}
function publishRequest(type, payload, source = "web", target = "host") {
	ensureBusDirs();
	cleanupBusStorage();
	const envelope = {
		id: createBusId("req"),
		type,
		source,
		target,
		createdAt: Date.now(),
		payload
	};
	atomicWriteJson(join(DIRS.requests, `${envelope.id}.json`), envelope);
	return envelope;
}
function writeResponse(replyTo, type, ok, payload, error) {
	ensureBusDirs();
	cleanupBusStorage();
	const envelope = {
		id: createBusId("res"),
		type,
		source: "host",
		target: "web",
		createdAt: Date.now(),
		replyTo,
		ok,
		payload,
		...error ? { error } : {}
	};
	atomicWriteJson(responsePath(replyTo), envelope);
	return envelope;
}
function emitEvent(type, payload) {
	ensureBusDirs();
	cleanupBusStorage();
	const envelope = {
		id: createBusId("evt"),
		type,
		source: "host",
		target: "web",
		createdAt: Date.now(),
		payload
	};
	atomicWriteJson(join(DIRS.events, `${envelope.createdAt}_${envelope.id}.json`), envelope);
	const files = listJsonFiles(DIRS.events);
	while (files.length > ACTIVE_EVENT_FILE_LIMIT) {
		const oldest = files.shift();
		if (!oldest) break;
		const from = join(DIRS.events, oldest);
		const to = join(DIRS.archiveEvents, oldest);
		try {
			renameSync(from, to);
		} catch {
			break;
		}
	}
}
function writeState(name, data) {
	ensureBusDirs();
	cleanupBusStorage();
	atomicWriteJson(join(DIRS.state, `${name}.json`), data);
}
function readState(name) {
	ensureBusDirs();
	const filePath = join(DIRS.state, `${name}.json`);
	if (!existsSync(filePath)) return null;
	try {
		return readJsonFile(filePath);
	} catch {
		return null;
	}
}
function waitForResponse(replyTo, timeoutMs = 3e4, pollMs = 200) {
	ensureBusDirs();
	cleanupBusStorage();
	const startedAt = Date.now();
	const filePath = responsePath(replyTo);
	return new Promise((resolvePromise, reject) => {
		const timer = setInterval(() => {
			if (!existsSync(filePath)) {
				if (Date.now() - startedAt >= timeoutMs) {
					clearInterval(timer);
					reject(/* @__PURE__ */ new Error(`文件总线响应超时: ${replyTo}`));
				}
				return;
			}
			clearInterval(timer);
			try {
				const envelope = readJsonFile(filePath);
				try {
					renameSync(filePath, join(DIRS.archiveResponses, `${replyTo}.json`));
				} catch {
					rmSync(filePath, { force: true });
				}
				resolvePromise(envelope);
			} catch (err) {
				reject(/* @__PURE__ */ new Error(`文件总线响应解析失败: ${err.message}`));
			}
		}, pollMs);
	});
}
function claimNextRequest() {
	ensureBusDirs();
	cleanupBusStorage();
	const files = listJsonFiles(DIRS.requests);
	for (const fileName of files) {
		const from = join(DIRS.requests, fileName);
		const claimedName = `${process.pid}_${Date.now()}_${fileName}`;
		const claimedPath = join(DIRS.processingRequests, claimedName);
		try {
			renameSync(from, claimedPath);
			return {
				envelope: readJsonFile(claimedPath),
				claimedPath,
				fileName
			};
		} catch {
			continue;
		}
	}
	return null;
}
function ackClaimedRequest(message) {
	ensureBusDirs();
	try {
		renameSync(message.claimedPath, join(DIRS.archiveRequests, message.fileName));
	} catch {
		rmSync(message.claimedPath, { force: true });
	}
	cleanupBusStorage();
}
function getBusRoot() {
	ensureBusDirs();
	return DIRS.root;
}

//#endregion
export { ackClaimedRequest, claimNextRequest, createBusId, emitEvent, ensureBusDirs, getBusRoot, publishRequest, readState, waitForResponse, writeResponse, writeState };