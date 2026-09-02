import type { CaptureFrame, FontRequest, Snapshot, ThemeId } from '@c2d/shared';
import { SNAPSHOT_VERSION, encodePayload } from '@c2d/shared';
import { fetchAsset } from './fetch-asset';
import { copyToClipboard } from './clipboard';

export interface CaptureOptions {
  mode: 'page' | 'selection';
  /** 0 means "whatever the browser window currently is" (no emulation). */
  viewports: number[];
  themes: ThemeId[];
  maxImageDimension: number;
}

export interface CaptureSummary {
  frames: number;
  nodes: number;
  images: number;
  bytes: number;
  durationMs: number;
  warnings: string[];
  title: string;
  url: string;
  copied: boolean;
}

let lastPayload: string | null = null;
let lastSummary: CaptureSummary | null = null;
let busy = false;

/* ------------------------------------------------------------- messaging */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined;

  switch (message.type) {
    case 'fetch-asset':
      fetchAsset(message.url, message.maxDimension)
        .then(sendResponse)
        .catch((err) => sendResponse({ kind: 'error', message: String(err) }));
      return true;

    case 'capture':
      runCapture(message.tabId, message.options as CaptureOptions)
        .then((summary) => sendResponse({ ok: true, summary }))
        .catch((err) => sendResponse({ ok: false, error: humanError(err) }));
      return true;

    case 'get-last':
      sendResponse({ summary: lastSummary, hasPayload: Boolean(lastPayload), busy });
      return false;

    case 'get-payload':
      sendResponse({ payload: lastPayload });
      return false;

    case 'recopy':
      (async () => {
        if (!lastPayload) return sendResponse({ ok: false, error: 'Nothing captured yet.' });
        const copied = await copyToClipboard(lastPayload);
        sendResponse({ ok: copied });
      })();
      return true;

    default:
      return undefined;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const stored = await chrome.storage.local.get('options');
  const options: CaptureOptions = {
    mode: command === 'capture-selection' ? 'selection' : 'page',
    viewports: [0],
    themes: ['browser'],
    maxImageDimension: 2400,
    ...(stored.options as Partial<CaptureOptions> | undefined),
  };
  options.mode = command === 'capture-selection' ? 'selection' : 'page';
  try {
    await runCapture(tab.id, options);
  } catch (err) {
    flashBadge('!', '#e5484d');
    console.error(err);
  }
});

/* --------------------------------------------------------------- capture */

async function runCapture(tabId: number, options: CaptureOptions): Promise<CaptureSummary> {
  if (busy) throw new Error('A capture is already running.');
  busy = true;
  const started = performance.now();

  try {
    const tab = await chrome.tabs.get(tabId);
    assertCapturable(tab.url ?? '');

    const combos = buildCombos(options);
    const needsEmulation = combos.some((c) => c.viewport > 0 || c.theme !== 'browser');
    const canEmulate = needsEmulation && typeof chrome.debugger !== 'undefined';

    let attached = false;
    if (needsEmulation && canEmulate) {
      attached = await attachDebugger(tabId);
    }

    const frames: CaptureFrame[] = [];
    const assets: Snapshot['assets'] = {};
    const fonts = new Map<string, FontRequest>();
    const warnings: string[] = [];
    let nodes = 0;
    let title = tab.title ?? '';
    let url = tab.url ?? '';

    if (needsEmulation && !attached) {
      warnings.push(
        'Viewport and theme emulation needs the "debugger" permission. Captured at the current window size instead.',
      );
    }

    for (const combo of combos) {
      if (attached) {
        await applyEmulation(tabId, combo.viewport, combo.theme);
        await settle(500);
      }
      await injectCaptureScript(tabId);

      const label = combo.label;
      const response = await sendToTab(tabId, {
        type: options.mode === 'selection' ? 'c2d-pick-and-capture' : 'c2d-capture-page',
        request: { mode: options.mode, label, maxImageDimension: options.maxImageDimension },
      });

      if (!response?.ok) {
        if (response?.cancelled) throw new Error('Capture cancelled.');
        throw new Error(response?.error || 'The page did not respond to the capture request.');
      }

      const result = response.result;
      nodes += result.nodeCount ?? 0;
      title = result.title || title;
      url = result.url || url;
      Object.assign(assets, result.assets);
      for (const warning of result.warnings ?? []) {
        if (!warnings.includes(warning)) warnings.push(warning);
      }
      for (const font of result.fonts ?? []) {
        const key = `${font.family}__${font.italic}`;
        const entry: FontRequest = fonts.get(key) ?? { family: font.family, weights: [], italic: font.italic };
        for (const w of font.weights) if (!entry.weights.includes(w)) entry.weights.push(w);
        fonts.set(key, entry);
      }
      frames.push({
        id: `f${frames.length + 1}`,
        label,
        viewportWidth: combo.viewport || result.root.width,
        theme: combo.theme,
        root: result.root,
      });
    }

    if (attached) await detachDebugger(tabId);

    const snapshot: Snapshot = {
      version: SNAPSHOT_VERSION,
      generator: `code.to.design ${chrome.runtime.getManifest().version}`,
      source: {
        url,
        origin: safeOrigin(url),
        title,
        capturedAt: new Date().toISOString(),
        mode: options.mode,
      },
      frames,
      assets,
      fonts: [...fonts.values()],
      stats: {
        nodes,
        images: Object.keys(assets).length,
        bytes: 0,
        durationMs: 0,
        warnings,
      },
    };

    const payload = await encodePayload(snapshot);
    snapshot.stats.bytes = payload.length;
    snapshot.stats.durationMs = Math.round(performance.now() - started);
    const finalPayload = await encodePayload(snapshot);

    lastPayload = finalPayload;
    const copied = await copyToClipboard(finalPayload);

    lastSummary = {
      frames: frames.length,
      nodes,
      images: Object.keys(assets).length,
      bytes: finalPayload.length,
      durationMs: snapshot.stats.durationMs,
      warnings,
      title,
      url,
      copied,
    };
    flashBadge(copied ? 'OK' : '!', copied ? '#12a150' : '#e5a23d');
    await chrome.storage.local.set({ options, lastSummary });
    return lastSummary;
  } finally {
    busy = false;
    try {
      await detachDebugger(tabId);
    } catch {
      /* already detached */
    }
  }
}

interface Combo { viewport: number; theme: ThemeId; label: string }

function buildCombos(options: CaptureOptions): Combo[] {
  // Picking an element once per viewport would mean N prompts; selection always
  // uses the window as it currently stands.
  const viewports = options.mode === 'selection' ? [0] : (options.viewports.length ? options.viewports : [0]);
  const themes = options.mode === 'selection' ? ['browser' as ThemeId] : (options.themes.length ? options.themes : ['browser' as ThemeId]);
  const combos: Combo[] = [];
  for (const viewport of viewports) {
    for (const theme of themes) {
      const parts = [viewport ? `${viewport}px` : 'Browser'];
      if (theme !== 'browser') parts.push(theme === 'dark' ? 'Dark' : 'Light');
      combos.push({ viewport, theme, label: parts.join(' · ') });
    }
  }
  return combos;
}

async function injectCaptureScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ['capture.js'],
    injectImmediately: true,
  });
}

function sendToTab(tabId: number, message: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

const settle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* -------------------------------------------------------------- debugger */

const attachedTabs = new Set<number>();

async function attachDebugger(tabId: number): Promise<boolean> {
  if (attachedTabs.has(tabId)) return true;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);
    return true;
  } catch (err) {
    console.warn('Could not attach the debugger:', err);
    return false;
  }
}

async function detachDebugger(tabId: number): Promise<void> {
  if (!attachedTabs.has(tabId)) return;
  attachedTabs.delete(tabId);
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride');
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setEmulatedMedia', { features: [] });
  } catch {
    /* the tab may already be gone */
  }
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* already detached */
  }
}

/**
 * Guarded on purpose. If the debugger permission is ever missing, `chrome.debugger`
 * is undefined and touching it here would throw during service-worker evaluation,
 * killing the whole extension rather than just the emulation feature.
 */
if (typeof chrome.debugger !== 'undefined') {
  chrome.debugger.onDetach.addListener(({ tabId }) => {
    if (tabId !== undefined) attachedTabs.delete(tabId);
  });
}

async function applyEmulation(tabId: number, viewport: number, theme: ThemeId): Promise<void> {
  if (viewport > 0) {
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
      width: viewport,
      // A tall window keeps sticky headers and viewport-unit layouts sane; the
      // capture reads the real scroll height anyway.
      height: 1200,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: viewport,
      screenHeight: 1200,
    });
  } else {
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride');
  }

  const features = theme === 'browser' ? [] : [{ name: 'prefers-color-scheme', value: theme }];
  await chrome.debugger.sendCommand({ tabId }, 'Emulation.setEmulatedMedia', { features });
}

/* ---------------------------------------------------------------- helpers */

function assertCapturable(url: string): void {
  if (!url) throw new Error('This tab has no page loaded.');
  if (/^(chrome|edge|about|devtools|chrome-extension|view-source):/i.test(url)) {
    throw new Error('Chrome blocks extensions on browser pages. Open a normal website and try again.');
  }
  if (url.startsWith('https://chromewebstore.google.com') || url.startsWith('https://chrome.google.com/webstore')) {
    throw new Error('Chrome blocks extensions on the Web Store. Open another site and try again.');
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function humanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('Receiving end does not exist')) {
    return 'The page reloaded during capture. Try again once it has finished loading.';
  }
  if (message.includes('Cannot access')) {
    return 'Chrome will not let extensions read this page.';
  }
  return message;
}

let badgeTimer: ReturnType<typeof setTimeout> | undefined;
function flashBadge(text: string, color: string): void {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
}
