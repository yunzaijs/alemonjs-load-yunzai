import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('done without reply retains exact event routing until TTL or Worker exit', () => {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', fileURLToPath(new URL('./fixtures/bridge-context-worker.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 10_000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /bridge context lifecycle passed/);
});
