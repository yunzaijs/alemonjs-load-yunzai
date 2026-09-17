import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeGitFailure, repositoryGitArgs } from '../lib/yunzai/git.js';

test('目录信任允许操作所有权不明的目标仓库，但不信任其他仓库', () => {
  const root = mkdtempSync(join(tmpdir(), 'yunzai-git-test-'));
  const target = join(root, 'managed repo');
  const other = join(root, 'other');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'missing-config'), GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' };

  try {
    for (const dir of [target, other]) {
      execFileSync('git', ['init', dir], { stdio: 'pipe' });
    }
    assert.throws(() => execFileSync('git', ['status', '--porcelain'], { cwd: target, env, stdio: 'pipe' }), /dubious ownership/);
    execFileSync('git', repositoryGitArgs(['status', '--porcelain'], target), { cwd: target, env, stdio: 'pipe' });
    assert.throws(
      () => execFileSync('git', repositoryGitArgs(['status', '--porcelain'], target), { cwd: other, env, stdio: 'pipe' }),
      /dubious ownership/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Git 失败反馈包含操作、目录、可执行建议，不重复原始报错', () => {
  const message = describeGitFailure('pull', 'F:/bots/Yunzai', 'fatal: detected dubious ownership');

  assert.match(message, /pull/);
  assert.match(message, /F:\/bots\/Yunzai/);
  assert.match(message, /safe.directory/);
  assert.doesNotMatch(message, /fatal:/);
  assert.match(describeGitFailure('pull', '/bot', 'local changes would be overwritten'), /备份/);
  assert.match(describeGitFailure('fetch', '/bot', 'Could not resolve host'), /网络/);
});
