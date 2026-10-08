import test from 'node:test';
import assert from 'node:assert/strict';
import { installRendererBrowserCompat } from '../lib/yunzai/renderer-compat.js';

function fixture() {
  const page = { screenshot: async () => 'image' };
  const browser = { newPage: async () => page };
  const shotium = { id: 'shotium', renderNum: 8, render: () => 'template' };
  const puppeteer = {
    browser: false, renderNum: 0, starts: 0, restarts: 0,
    async browserInit() { this.starts++; this.browser = browser; return browser; },
    restart() { this.restarts++; }
  };
  const loader = { renderers: new Map([['shotium', shotium], ['puppeteer', puppeteer]]), getRenderer(name = 'shotium') { return this.renderers.get(name) ?? this; } };
  return { loader, shotium, puppeteer, browser, page };
}

test('Shotium retains template rendering while browser calls delegate to real Puppeteer', async () => {
  const { loader, shotium, puppeteer, browser, page } = fixture();
  installRendererBrowserCompat(loader, assert.fail);
  const selected = loader.getRenderer();
  assert.equal(selected, shotium);
  assert.equal(selected.render(), 'template');
  assert.equal(selected.browser, false);
  await Promise.all([selected.browserInit(), selected.browserInit()]);
  assert.equal(puppeteer.starts, 1);
  assert.equal(selected.browser, browser);
  assert.equal(await selected.browser.newPage(), page);
  selected.renderNum++;
  await selected.restart();
  assert.equal(puppeteer.renderNum, 1);
  assert.equal(puppeteer.restarts, 1);
  puppeteer.browser = false;
  assert.equal(selected.browser, false);
  assert.equal(loader.getRenderer('puppeteer'), puppeteer);
});

test('default renderer loader and repeated installation retain working browser interfaces', async () => {
  const { loader, browser } = fixture();
  installRendererBrowserCompat(loader, assert.fail);
  const getRenderer = loader.getRenderer;
  installRendererBrowserCompat(loader, assert.fail);
  assert.equal(loader.getRenderer, getRenderer);
  const selected = loader.getRenderer('missing');
  assert.equal(selected, loader);
  await selected.browserInit();
  assert.equal(selected.browser, browser);
});

test('missing or failed browser backend returns false so plugins can use their fallback', async () => {
  const { loader, puppeteer } = fixture();
  const reports = [];
  installRendererBrowserCompat(loader, message => reports.push(message));
  const selected = loader.getRenderer();
  loader.renderers.delete('puppeteer');
  assert.equal(await selected.browserInit(), false);
  assert.equal(await selected.browserInit(), false);
  assert.equal(reports.length, 1);
  assert.equal(selected.browser, false);
  loader.renderers.set('puppeteer', puppeteer);
  puppeteer.browserInit = async () => { throw new Error('launch failed'); };
  assert.equal(await selected.browserInit(), false);
  assert.equal(reports.length, 2);
  const browser = { newPage() {} };
  puppeteer.browserInit = async () => { puppeteer.browser = browser; return browser; };
  assert.equal(await selected.browserInit(), browser);
  puppeteer.restart = () => { throw new Error('restart failed'); };
  assert.equal(await selected.restart(), false);
});

test('references captured before installation receive browserInit in place', async () => {
  const { loader, puppeteer, browser } = fixture();
  // 对应 PluginsLoader -> runtime -> lib/puppeteer 在模块顶层缓存引用。
  const cachedRenderer = loader.getRenderer();
  const cachedLoader = loader.getRenderer('missing');
  const nativeInit = puppeteer.browserInit;
  assert.equal(cachedRenderer.browserInit, undefined);
  installRendererBrowserCompat(loader, assert.fail);
  // 不再次调用 getRenderer：直接重现插件的 launch 流程。
  if (!cachedRenderer.browser) assert.ok(await cachedRenderer.browserInit());
  assert.equal(cachedRenderer.browser, browser);
  assert.equal(typeof cachedLoader.browserInit, 'function');
  assert.equal(cachedLoader.browser, browser);
  assert.equal(puppeteer.browserInit, nativeInit);
  assert.equal(cachedRenderer.render(), 'template');
});

test('renderer stored only as the default selection is patched eagerly', async () => {
  const { puppeteer, browser, shotium } = fixture();
  const loader = { renderers: new Map([['puppeteer', puppeteer]]), getRenderer() { return shotium; } };
  const cached = loader.getRenderer();
  installRendererBrowserCompat(loader, assert.fail);
  assert.equal(await cached.browserInit(), browser);
  assert.equal(cached.browser, browser);
});
