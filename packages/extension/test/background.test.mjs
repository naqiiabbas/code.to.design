/**
 * The service worker either evaluates cleanly or the whole extension is dead:
 * Chrome reports "Service worker registration failed. Status code: 15" and every
 * message from the popup goes unanswered, which looks like a hang rather than a
 * crash. These tests load the real built bundle and check it survives.
 *
 * Run with: node --test packages/extension/test/background.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, '../dist');
const manifestPath = path.join(distDir, 'manifest.json');

/**
 * Chrome refuses to make these optional and silently drops them from the
 * manifest, which leaves the matching `chrome.*` namespace undefined at runtime.
 */
const NEVER_OPTIONAL = new Set(['debugger', 'declarativeNetRequest', 'devtools', 'geolocation']);

async function readManifest() {
  return JSON.parse(await fs.readFile(manifestPath, 'utf8'));
}

/** The smallest chrome API surface the worker touches while evaluating. */
function makeChromeStub({ withDebugger }) {
  const listeners = { message: [], command: [], detach: [] };
  const stub = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      getManifest: () => ({ version: '0.0.0' }),
      getURL: (p) => `chrome-extension://test/${p}`,
      sendMessage: async () => undefined,
      getContexts: async () => [],
      lastError: undefined,
    },
    commands: { onCommand: { addListener: (fn) => listeners.command.push(fn) } },
    tabs: { query: async () => [], get: async () => ({}), sendMessage: () => {} },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    scripting: { executeScript: async () => [] },
    action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
    permissions: { contains: async () => true },
    offscreen: { createDocument: async () => {} },
  };
  if (withDebugger) {
    stub.debugger = {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async () => {},
      onDetach: { addListener: (fn) => listeners.detach.push(fn) },
    };
  }
  return { stub, listeners };
}

async function loadWorker({ withDebugger }) {
  const { stub, listeners } = makeChromeStub({ withDebugger });
  globalThis.chrome = stub;
  // A fresh query string defeats the ES module cache between cases.
  const url = `${pathToFileURL(path.join(distDir, 'background.js')).href}?case=${withDebugger}-${Date.now()}`;
  await import(url);
  return listeners;
}

test('the manifest never asks for a permission Chrome refuses to make optional', async () => {
  const manifest = await readManifest();
  for (const permission of manifest.optional_permissions ?? []) {
    assert.ok(
      !NEVER_OPTIONAL.has(permission),
      `"${permission}" cannot be optional; Chrome drops it and the API becomes undefined`,
    );
  }
  // Viewport and theme emulation is built on it, so it has to be present somewhere.
  assert.ok(
    (manifest.permissions ?? []).includes('debugger'),
    'the debugger permission is required for viewport and theme emulation',
  );
});

test('the manifest declares every permission the worker relies on', async () => {
  const manifest = await readManifest();
  const source = await fs.readFile(path.join(distDir, 'background.js'), 'utf8');
  const granted = new Set([...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])]);
  // activeTab and host_permissions cover page access; these are the namespaced ones.
  for (const api of ['scripting', 'storage', 'tabs', 'offscreen', 'debugger']) {
    if (source.includes(`chrome.${api}`) || source.includes(`.${api}.`)) {
      assert.ok(granted.has(api), `background.js uses chrome.${api} but the manifest does not request it`);
    }
  }
});

test('the service worker evaluates cleanly with every permission granted', async () => {
  const listeners = await loadWorker({ withDebugger: true });
  assert.equal(listeners.message.length, 1, 'no message listener was registered');
  assert.equal(listeners.command.length, 1, 'no command listener was registered');
  assert.equal(listeners.detach.length, 1, 'the debugger detach listener was not registered');
});

test('the service worker still evaluates when chrome.debugger is missing', async () => {
  // This is the shipped failure: a dropped permission left chrome.debugger
  // undefined, a top-level property access threw, and the worker never started.
  const listeners = await loadWorker({ withDebugger: false });
  assert.equal(listeners.message.length, 1, 'the worker died before registering its message listener');
  assert.equal(listeners.command.length, 1, 'the worker died before registering its command listener');
  assert.equal(listeners.detach.length, 0, 'nothing should subscribe to a missing API');
});
