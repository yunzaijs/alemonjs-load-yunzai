import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { promisify } from 'node:util';
import { decodeCommandOutput, installWindowsCommandDecoding, repairWindowsCommandPath } from '../lib/yunzai/command-output.js';

// GBK 字节：“不是内部或外部命令”
const bytes = Buffer.from('b2bbcac7c4dab2bfbbf2cde2b2bfc3fcc1ee', 'hex');

test('UTF-8 中文与表情保持原样，GBK 命令输出回退解码', () => {
  assert.equal(decodeCommandOutput(Buffer.from('中文日志 😀'), 'win32'), '中文日志 😀');
  assert.equal(decodeCommandOutput(bytes, 'win32'), '不是内部或外部命令');
});

test('插件 execFile 的回调、Promise、异常与二进制选项兼容', async () => {
  const restore = installWindowsCommandDecoding('win32');
  const script = `process.stderr.write(Buffer.from('${bytes.toString('hex')}', 'hex')); process.exit(1)`;

  try {
    await new Promise((resolve, reject) => {
      cp.execFile(process.execPath, ['-e', script], (error, stdout, stderr) => {
        try {
          assert.equal(stdout, '');
          assert.equal(stderr, '不是内部或外部命令');
          assert.match(error.message, /不是内部或外部命令/);
          assert.doesNotMatch(error.stack, /�/);
          resolve();
        } catch (e) { reject(e); }
      });
    });
    const pending = promisify(cp.execFile)(process.execPath, ['-e', script]);
    assert.ok(pending.child);
    await assert.rejects(pending, error => error.stderr === '不是内部或外部命令');
    await assert.rejects(promisify(cp.execFile)(process.execPath, ['-e', script], { encoding: 'buffer' }), error => Buffer.isBuffer(error.stderr));
    const result = await promisify(cp.exec)('echo hello');
    assert.equal(result.stdout.trim(), 'hello');
  } finally {
    restore();
  }
});

test('插件同步命令同样按 GB18030 解码并保留显式二进制输出', () => {
  const restore = installWindowsCommandDecoding('win32');
  const script = `process.stderr.write(Buffer.from('${bytes.toString('hex')}', 'hex')); process.exit(1)`;

  try {
    assert.throws(
      () => cp.execFileSync(process.execPath, ['-e', script], { stdio: 'pipe' }),
      error => error.stderr === '不是内部或外部命令' && !error.message.includes('�')
    );
    assert.throws(
      () => cp.execSync(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, { stdio: 'pipe' }),
      error => error.stderr === '不是内部或外部命令' && !error.message.includes('�')
    );
    assert.throws(
      () => cp.execFileSync(process.execPath, ['-e', script], { encoding: 'buffer', stdio: 'pipe' }),
      error => Buffer.isBuffer(error.stderr)
    );
  } finally {
    restore();
  }
});

test('Windows PATH 补回系统命令目录，并仅添加实际存在的 Git 目录', () => {
  const env = {
    Path: 'D:\\runtime\\bin',
    SystemRoot: 'C:\\Windows',
    ProgramFiles: 'C:\\Program Files'
  };
  const available = new Set([
    'C:\\Windows\\System32',
    'C:\\Windows',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
    'C:\\Program Files\\Git\\cmd'
  ]);

  const additions = repairWindowsCommandPath('win32', env, value => available.has(value));

  assert.deepEqual(additions, [...available]);
  assert.equal(env.Path, 'D:\\runtime\\bin;C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Program Files\\Git\\cmd');
});
