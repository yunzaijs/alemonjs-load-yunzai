import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PACKAGE_ROOT } from '../path';
import type { BusEnvelope, BusPayload } from './schema';

type ClaimedMessage = {
  envelope: BusEnvelope;
  claimedPath: string;
  fileName: string;
};

const ACTIVE_EVENT_FILE_LIMIT = 200;
const ARCHIVE_REQUEST_FILE_LIMIT = 200;
const ARCHIVE_RESPONSE_FILE_LIMIT = 200;
const ARCHIVE_EVENT_FILE_LIMIT = 400;
const PROCESSING_REQUEST_FILE_LIMIT = 100;
const PROCESSING_REQUEST_STALE_MS = 6 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 30 * 1000;

const BUS_ROOT = resolve(PACKAGE_ROOT, 'runtime', 'ipc-bus');
const DIRS = {
  root: BUS_ROOT,
  requests: join(BUS_ROOT, 'requests'),
  responses: join(BUS_ROOT, 'responses'),
  events: join(BUS_ROOT, 'events'),
  state: join(BUS_ROOT, 'state'),
  processingRequests: join(BUS_ROOT, 'processing', 'requests'),
  archiveRequests: join(BUS_ROOT, 'archive', 'requests'),
  archiveResponses: join(BUS_ROOT, 'archive', 'responses'),
  archiveEvents: join(BUS_ROOT, 'archive', 'events')
} as const;

let lastCleanupAt = 0;

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function ensureBusDirs(): void {
  for (const dir of Object.values(DIRS)) {
    ensureDir(dir);
  }
}

function atomicWriteJson(filePath: string, data: unknown): void {
  ensureDir(dirname(filePath));
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;

  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, filePath);
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
}

function listJsonFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .sort();
}

function extractTimestamp(fileName: string): number {
  const match = fileName.match(/(?:^|_)(\d{13})(?:_|\.json$)/);

  return match ? Number(match[1]) : 0;
}

function pruneDirectory(dir: string, maxFiles: number): void {
  const files = listJsonFiles(dir);

  while (files.length > maxFiles) {
    const oldest = files.shift();

    if (!oldest) {
      break;
    }

    rmSync(join(dir, oldest), { force: true });
  }
}

function pruneProcessingRequests(): void {
  const now = Date.now();
  const files = listJsonFiles(DIRS.processingRequests);

  for (const fileName of files) {
    if (now - extractTimestamp(fileName) > PROCESSING_REQUEST_STALE_MS) {
      rmSync(join(DIRS.processingRequests, fileName), { force: true });
    }
  }

  pruneDirectory(DIRS.processingRequests, PROCESSING_REQUEST_FILE_LIMIT);
}

function cleanupBusStorage(): void {
  const now = Date.now();

  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) {
    return;
  }

  lastCleanupAt = now;
  ensureBusDirs();
  pruneDirectory(DIRS.archiveRequests, ARCHIVE_REQUEST_FILE_LIMIT);
  pruneDirectory(DIRS.archiveResponses, ARCHIVE_RESPONSE_FILE_LIMIT);
  pruneDirectory(DIRS.archiveEvents, ARCHIVE_EVENT_FILE_LIMIT);
  pruneProcessingRequests();
}

export function createBusId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function responsePath(replyTo: string): string {
  return join(DIRS.responses, `${replyTo}.json`);
}

export function publishRequest<TPayload extends BusPayload>(
  type: BusEnvelope<TPayload>['type'],
  payload: TPayload,
  source: 'web' | 'host' = 'web',
  target: 'web' | 'host' = 'host'
): BusEnvelope<TPayload> {
  ensureBusDirs();
  cleanupBusStorage();
  const envelope: BusEnvelope<TPayload> = {
    id: createBusId('req'),
    type,
    source,
    target,
    createdAt: Date.now(),
    payload
  };

  atomicWriteJson(join(DIRS.requests, `${envelope.id}.json`), envelope);

  return envelope;
}

export function writeResponse<TPayload extends BusPayload>(
  replyTo: string,
  type: BusEnvelope<TPayload>['type'],
  ok: boolean,
  payload: TPayload,
  error?: { code: string; message: string }
): BusEnvelope<TPayload> {
  ensureBusDirs();
  cleanupBusStorage();
  const envelope: BusEnvelope<TPayload> = {
    id: createBusId('res'),
    type,
    source: 'host',
    target: 'web',
    createdAt: Date.now(),
    replyTo,
    ok,
    payload,
    ...(error ? { error } : {})
  };

  atomicWriteJson(responsePath(replyTo), envelope);

  return envelope;
}

export function emitEvent<TPayload extends BusPayload>(type: BusEnvelope<TPayload>['type'], payload: TPayload): void {
  ensureBusDirs();
  cleanupBusStorage();
  const envelope: BusEnvelope<TPayload> = {
    id: createBusId('evt'),
    type,
    source: 'host',
    target: 'web',
    createdAt: Date.now(),
    payload
  };
  const eventPath = join(DIRS.events, `${envelope.createdAt}_${envelope.id}.json`);

  atomicWriteJson(eventPath, envelope);

  const files = listJsonFiles(DIRS.events);

  while (files.length > ACTIVE_EVENT_FILE_LIMIT) {
    const oldest = files.shift();

    if (!oldest) {
      break;
    }
    const from = join(DIRS.events, oldest);
    const to = join(DIRS.archiveEvents, oldest);

    try {
      renameSync(from, to);
    } catch {
      break;
    }
  }
}

export function writeState<T>(name: string, data: T): void {
  ensureBusDirs();
  cleanupBusStorage();
  atomicWriteJson(join(DIRS.state, `${name}.json`), data);
}

export function readState<T>(name: string): T | null {
  ensureBusDirs();
  const filePath = join(DIRS.state, `${name}.json`);

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return readJsonFile<T>(filePath);
  } catch {
    return null;
  }
}

export function waitForResponse<TPayload extends BusPayload>(replyTo: string, timeoutMs = 30_000, pollMs = 200): Promise<BusEnvelope<TPayload>> {
  ensureBusDirs();
  cleanupBusStorage();
  const startedAt = Date.now();
  const filePath = responsePath(replyTo);

  return new Promise((resolvePromise, reject) => {
    const timer = setInterval(() => {
      if (!existsSync(filePath)) {
        if (Date.now() - startedAt >= timeoutMs) {
          clearInterval(timer);
          reject(new Error(`文件总线响应超时: ${replyTo}`));
        }

        return;
      }

      clearInterval(timer);
      try {
        const envelope = readJsonFile<BusEnvelope<TPayload>>(filePath);

        try {
          renameSync(filePath, join(DIRS.archiveResponses, `${replyTo}.json`));
        } catch {
          rmSync(filePath, { force: true });
        }
        resolvePromise(envelope);
      } catch (err: any) {
        reject(new Error(`文件总线响应解析失败: ${err.message}`));
      }
    }, pollMs);
  });
}

export function claimNextRequest(): ClaimedMessage | null {
  ensureBusDirs();
  cleanupBusStorage();
  const files = listJsonFiles(DIRS.requests);

  for (const fileName of files) {
    const from = join(DIRS.requests, fileName);
    const claimedName = `${process.pid}_${Date.now()}_${fileName}`;
    const claimedPath = join(DIRS.processingRequests, claimedName);

    try {
      renameSync(from, claimedPath);
      const envelope = readJsonFile<BusEnvelope>(claimedPath);

      return { envelope, claimedPath, fileName };
    } catch {
      continue;
    }
  }

  return null;
}

export function ackClaimedRequest(message: ClaimedMessage): void {
  ensureBusDirs();

  try {
    renameSync(message.claimedPath, join(DIRS.archiveRequests, message.fileName));
  } catch {
    rmSync(message.claimedPath, { force: true });
  }

  cleanupBusStorage();
}

export function getBusRoot(): string {
  ensureBusDirs();

  return DIRS.root;
}
