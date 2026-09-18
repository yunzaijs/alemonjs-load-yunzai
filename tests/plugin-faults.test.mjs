import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {identifyPluginFault} from '../lib/yunzai/plugin-faults.js';

const root = resolve('plugins');
const pluginFile = pathToFileURL(resolve(root, 'guoba-plugin/framework/GitTools.js')).href;
const boundary = new URL('../lib/yunzai/plugin-faults.js', import.meta.url).href;

test('fault attribution requires a plugin stack frame inside the plugin root', () => {
  const error = new Error('git unavailable');

  error.stack = `Error: git unavailable\n    at GitTools.init (${pluginFile}:115:13)`;
  assert.equal(identifyPluginFault(error, root), 'guoba-plugin');
  assert.equal(identifyPluginFault(new Error(`plugins/guoba-plugin ${root}`), root), undefined);
  error.stack = `Error: fake\n    at init (${pathToFileURL(resolve(root + '-other', 'bad.js')).href}:1:1)`;
  assert.equal(identifyPluginFault(error, root), undefined);
});

function runFault(kind) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { installPluginFaultBoundary } from ${JSON.stringify(boundary)};
    installPluginFaultBoundary(${JSON.stringify(root)}, (plugin) => console.log('degraded:' + plugin));
    const error = new Error('git unavailable');
    if (${JSON.stringify(kind)} !== 'unknown') {
      error.stack = ${JSON.stringify(`Error: git unavailable\n    at GitTools.init (${pluginFile}:115:13)`)};
    }
    if (${JSON.stringify(kind)} === 'sync') {
      setImmediate(() => { throw error; });
    } else {
      Promise.reject(error);
    }
    setTimeout(() => console.log('other-plugin-still-running'), 50);
  `], { encoding: 'utf8', timeout: 5000 });
}

test('detached plugin rejection does not terminate other plugin work', () => {
  const result = runFault('plugin');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /degraded:guoba-plugin/);
  assert.match(result.stdout, /other-plugin-still-running/);
});

test('unknown rejections and synchronous exceptions remain fatal', () => {
  for (const kind of ['unknown', 'sync']) {
    const result = runFault(kind);

    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stdout, /other-plugin-still-running/);
  }
});
