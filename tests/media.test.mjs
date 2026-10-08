import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 支持构建后的测试，也支持没有安装依赖时直接用 Node 的 TS 类型剥离验证。
const moduleUrl = new URL(process.env.YUNZAI_MEDIA_TEST_SOURCE ? '../src/yunzai/media.ts' : '../lib/yunzai/media.js', import.meta.url);
const { resolveReplyMediaPath } = await import(moduleUrl.href);

test('媒体路径使用 Worker 目录，兼容 POSIX 与 Windows', () => {
  assert.equal(resolveReplyMediaPath('file://./temp/strategy/1/奥藏塔.jpg', '/app/Yunzai'), '/app/Yunzai/temp/strategy/1/奥藏塔.jpg');
  assert.equal(resolveReplyMediaPath('./temp/a.jpg', '/app/Yunzai'), '/app/Yunzai/temp/a.jpg');
  assert.equal(resolveReplyMediaPath('/tmp/a.jpg', '/app/Yunzai'), '/tmp/a.jpg');
  assert.equal(resolveReplyMediaPath('file:///tmp/%E5%A5%A5%20a.jpg', '/app/Yunzai'), '/tmp/奥 a.jpg');
  assert.equal(resolveReplyMediaPath('/9j/AAAAAAAAAAAAAAAA', '/app/Yunzai'), undefined);
  assert.equal(resolveReplyMediaPath('file://./temp/strategy/1/奥藏塔.jpg', 'C:\\alemon\\Yunzai'), 'C:\\alemon\\Yunzai\\temp\\strategy\\1\\奥藏塔.jpg');
  assert.equal(resolveReplyMediaPath('C:\\images\\a.jpg', 'C:\\alemon\\Yunzai'), 'C:\\images\\a.jpg');
  assert.equal(resolveReplyMediaPath('file://C:\\images\\a.jpg', 'C:\\alemon\\Yunzai'), 'C:\\images\\a.jpg');
  assert.equal(resolveReplyMediaPath('file:///C:/images/a.jpg', 'C:\\alemon\\Yunzai'), 'C:\\images\\a.jpg');
  assert.equal(resolveReplyMediaPath('\\\\server\\share\\a.jpg', 'C:\\alemon\\Yunzai'), '\\\\server\\share\\a.jpg');
  for (const source of ['https://example.com/a.jpg', 'base64://YWJj', 'buffer://YWJj', 'data:image/png;base64,YWJj', '']) {
    assert.equal(resolveReplyMediaPath(source, '/app/Yunzai'), undefined);
  }
});

test('跨进程发送前读到 Yunzai 图片，而不是父进程同名文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'yunzai-media-'));
  const workerDir = path.join(root, 'Yunzai');
  const relative = 'temp/strategy/1/奥藏塔.jpg';
  const expected = Buffer.from('worker image');
  try {
    await mkdir(path.dirname(path.join(workerDir, relative)), { recursive: true });
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(workerDir, relative), expected);
    await writeFile(path.join(root, relative), 'wrong parent image');
    const result = await new Promise((resolve, reject) => {
      const child = fork(fileURLToPath(new URL('./fixtures/media-worker.mjs', import.meta.url)), [moduleUrl.href, relative], {
        cwd: workerDir,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      });
      let data;
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('message', message => { data = message; });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve(data) : reject(new Error(stderr)));
    });
    assert.deepEqual(result.images, Array(3).fill(expected.toString('base64')));
    assert.equal(result.buffer, expected.toString('base64'));
    assert.equal(result.url, 'https://example.com/a.jpg');
    assert.equal(result.base64, 'base64://YWJj');
    assert.equal(result.missing, `file://${path.join(await realpath(workerDir), 'missing.jpg')}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
