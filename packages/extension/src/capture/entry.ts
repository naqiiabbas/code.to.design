import type { FontRequest, FrameNode, Paint, SceneNode } from '@c2d/shared';
import { AssetRegistry } from './assets';
import { isVisibleColor, parseColor, solid } from './css';
import { resetIds, round, walkElement } from './walker';

export interface CaptureRequest {
  mode: 'page' | 'selection';
  /** Label used for the produced frame, e.g. "1440px · Dark". */
  label: string;
  maxImageDimension?: number;
}

export interface CaptureResult {
  root: FrameNode;
  assets: Record<string, unknown>;
  svgAssets: Record<string, string>;
  fonts: FontRequest[];
  warnings: string[];
  nodeCount: number;
  title: string;
  url: string;
}

const STYLE_ID = '__c2d_freeze_style__';
const OVERLAY_ID = '__c2d_picker__';

/* --------------------------------------------------------------- freezing */

function freezePage(): () => void {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    *, *::before, *::after {
      animation-play-state: paused !important;
      transition: none !important;
      caret-color: transparent !important;
    }
    html { scroll-behavior: auto !important; }
  `;
  document.documentElement.appendChild(style);
  return () => style.remove();
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Scrolls the page end to end so lazy-loaded images and IO-triggered UI render. */
async function primeLazyContent(): Promise<void> {
  const originalX = window.scrollX;
  const originalY = window.scrollY;
  const total = Math.max(
    document.documentElement.scrollHeight,
    document.body?.scrollHeight ?? 0,
  );
  const step = Math.max(window.innerHeight * 0.8, 200);

  for (const img of Array.from(document.images)) {
    if (img.loading === 'lazy') img.loading = 'eager';
    img.decoding = 'sync';
  }

  for (let y = 0; y < total; y += step) {
    window.scrollTo(0, y);
    await wait(60);
  }
  window.scrollTo(0, total);
  await wait(120);
  window.scrollTo(originalX, 0);
  await wait(120);
  void originalY;

  try {
    await document.fonts.ready;
  } catch {
    /* fonts API unavailable */
  }

  await Promise.all(
    Array.from(document.images).map((img) =>
      img.complete ? Promise.resolve() : img.decode().catch(() => undefined),
    ),
  );
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

/* --------------------------------------------------------------- document */

function pageBackground(): Paint[] {
  const htmlStyle = getComputedStyle(document.documentElement);
  const htmlBg = parseColor(htmlStyle.backgroundColor);
  if (isVisibleColor(htmlBg)) return [solid(htmlBg)];
  if (document.body) {
    const bodyBg = parseColor(getComputedStyle(document.body).backgroundColor);
    if (isVisibleColor(bodyBg)) return [solid(bodyBg)];
  }
  return [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1 }];
}

function collectFonts(node: SceneNode, into: Map<string, FontRequest>): number {
  let count = 1;
  if (node.type === 'TEXT') {
    for (const segment of node.segments) {
      const key = `${segment.fontFamily}__${segment.italic}`;
      const entry: FontRequest = into.get(key) ?? { family: segment.fontFamily, weights: [], italic: segment.italic };
      if (!entry.weights.includes(segment.fontWeight)) entry.weights.push(segment.fontWeight);
      into.set(key, entry);
    }
  } else if (node.type === 'FRAME') {
    for (const child of node.children) count += collectFonts(child, into);
  }
  return count;
}

async function capture(request: CaptureRequest, target?: Element): Promise<CaptureResult> {
  resetIds();
  const unfreeze = freezePage();
  const registry = new AssetRegistry(request.maxImageDimension ?? 2400);
  const warnings: string[] = [];

  try {
    await primeLazyContent();

    let root: FrameNode;
    if (request.mode === 'selection' && target) {
      const rect = target.getBoundingClientRect();
      const children = walkElement(target, { originX: rect.left, originY: rect.top }, { registry, warnings });
      // walkElement already produced the target's own frame; re-home it at 0,0.
      const first = children[0];
      if (first && first.type === 'FRAME' && children.length === 1) {
        first.x = 0;
        first.y = 0;
        first.name = request.label;
        root = first;
      } else {
        root = {
          id: 'root',
          name: request.label,
          x: 0,
          y: 0,
          width: round(Math.max(rect.width, 1)),
          height: round(Math.max(rect.height, 1)),
          type: 'FRAME',
          children,
          fills: [],
          clipsContent: false,
        };
      }
    } else {
      const width = Math.max(
        document.documentElement.scrollWidth,
        document.body?.scrollWidth ?? 0,
        window.innerWidth,
      );
      const height = Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight ?? 0,
        window.innerHeight,
      );
      const children = document.body
        ? walkElement(document.body, { originX: 0, originY: 0 }, { registry, warnings })
        : [];
      // The body's background propagates to the page canvas in CSS; painting it
      // twice would double up on translucent colours.
      const bodyFrame = children[0];
      if (bodyFrame && bodyFrame.type === 'FRAME') delete bodyFrame.fills;
      root = {
        id: 'root',
        name: request.label,
        x: 0,
        y: 0,
        width: round(width),
        height: round(height),
        type: 'FRAME',
        children,
        fills: pageBackground(),
        clipsContent: true,
      };
    }

    const { failed, svg } = await registry.settle();
    stripFailedAssets(root, failed, svg);
    warnings.push(...registry.warnings);

    const fontMap = new Map<string, FontRequest>();
    const nodeCount = collectFonts(root, fontMap);

    return {
      root,
      assets: registry.assets,
      svgAssets: Object.fromEntries(svg),
      fonts: [...fontMap.values()],
      warnings,
      nodeCount,
      title: document.title,
      url: location.href,
    };
  } finally {
    unfreeze();
  }
}

/**
 * Drops image paints whose bytes never arrived, and swaps in real vector nodes
 * where the "image" turned out to be an SVG file.
 */
function stripFailedAssets(node: SceneNode, failed: Set<string>, svg: Map<string, string>): void {
  if (node.type === 'IMAGE') {
    if (svg.has(node.assetId)) {
      const markup = svg.get(node.assetId) as string;
      const replacement = node as unknown as SceneNode & { type: string; svg?: string; assetId?: string };
      replacement.type = 'SVG';
      replacement.svg = markup;
      delete replacement.assetId;
      return;
    }
    return;
  }
  if (node.type !== 'FRAME') return;
  if (node.fills) {
    node.fills = node.fills.filter((f) => f.type !== 'IMAGE' || !failed.has(f.assetId));
    if (!node.fills.length) delete node.fills;
  }
  node.children = node.children.filter((child) => {
    if (child.type === 'IMAGE' && failed.has(child.assetId) && !svg.has(child.assetId)) return false;
    return true;
  });
  for (const child of node.children) stripFailedAssets(child, failed, svg);
}

/* ----------------------------------------------------------------- picker */

let pickerCleanup: (() => void) | null = null;

const ACCENT = '#0d99ff';

/** "section.card" / "button#submit" - enough to tell two siblings apart. */
function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = (el as HTMLElement).id;
  if (id) return `${tag}#${id}`;
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
  return cls ? `${tag}.${cls}` : tag;
}

/**
 * The overlay never intercepts pointer events. Everything is read from
 * `elementFromPoint` and swallowed on the capture phase instead, which keeps the
 * page scrollable while picking and stops a click from following a link.
 */
function startPicker(): Promise<Element | null> {
  pickerCleanup?.();
  return new Promise((resolve) => {
    /**
     * One container holds the whole picker so a single stacking context covers
     * all of it, and it is promoted to the browser's top layer via the popover
     * API. z-index alone is not enough: plenty of sites use 2147483647 too, and
     * anything appended after us would win the tie. The top layer paints above
     * every z-index on the page, full stop.
     */
    const layer = document.createElement('div');
    layer.id = OVERLAY_ID;
    layer.style.cssText = [
      'position:fixed', 'inset:0', 'width:100vw', 'height:100vh',
      'margin:0', 'padding:0', 'border:0', 'background:transparent',
      'overflow:visible', 'pointer-events:none', 'z-index:2147483647',
      // [popover] is display:none until shown; this keeps the fallback visible.
      'display:block',
    ].join(';');
    layer.setAttribute('popover', 'manual');

    const box = document.createElement('div');
    box.style.cssText = [
      'position:absolute', 'left:0', 'top:0', 'pointer-events:none', 'opacity:0',
      `border:2px solid ${ACCENT}`, 'background:rgba(13,153,255,0.16)',
      'border-radius:2px', 'box-sizing:border-box',
      // A white halo keeps the outline readable on dark and busy pages alike.
      'box-shadow:0 0 0 1px rgba(255,255,255,0.9), 0 0 0 3px rgba(13,153,255,0.28)',
      'transition:none', 'will-change:transform,width,height',
    ].join(';');

    const label = document.createElement('div');
    label.style.cssText = [
      'position:absolute', 'left:0', 'top:0', 'pointer-events:none', 'opacity:0',
      `background:${ACCENT}`, 'color:#fff', 'white-space:nowrap',
      'font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'padding:5px 7px', 'border-radius:4px', 'box-shadow:0 2px 8px rgba(0,0,0,.3)',
    ].join(';');

    const hint = document.createElement('div');
    hint.innerHTML =
      '<b>Click</b> to capture an element &nbsp;·&nbsp; <b>&uarr;/&darr;</b> parent / child &nbsp;·&nbsp; <b>Esc</b> to cancel';
    hint.style.cssText = [
      'position:absolute', 'left:50%', 'top:16px', 'transform:translateX(-50%)',
      'background:#0b0b0d', 'color:#fff',
      'font:400 12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
      'padding:8px 14px', 'border-radius:999px', 'pointer-events:none',
      'box-shadow:0 4px 16px rgba(0,0,0,.35)', 'letter-spacing:.01em',
    ].join(';');

    let current: Element | null = null;
    let settled = false;
    let lastX = 0;
    let lastY = 0;
    // The overlay cannot show a cursor, since it takes no pointer events.
    const previousCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = 'crosshair';

    const isOurs = (el: Element | null) => !el || el === layer || el === box || el === label || el === hint;

    const highlight = (el: Element | null) => {
      if (isOurs(el)) return;
      current = el;
      draw();
    };

    const draw = () => {
      if (!current) return;
      const r = current.getBoundingClientRect();
      box.style.transform = `translate(${r.left}px, ${r.top}px)`;
      box.style.width = `${Math.max(r.width, 1)}px`;
      box.style.height = `${Math.max(r.height, 1)}px`;
      box.style.opacity = '1';

      label.textContent = `${describeElement(current)}  ${Math.round(r.width)} × ${Math.round(r.height)}`;
      // Sit above the box, unless it is against the top of the viewport.
      const labelHeight = 22;
      const above = r.top > labelHeight + 4;
      const y = above ? r.top - labelHeight - 2 : Math.min(r.bottom + 4, window.innerHeight - labelHeight - 4);
      const x = Math.min(Math.max(r.left, 4), Math.max(window.innerWidth - label.offsetWidth - 4, 4));
      label.style.transform = `translate(${x}px, ${Math.max(y, 4)}px)`;
      label.style.opacity = '1';
    };

    const finish = (result: Element | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onMove = (e: MouseEvent) => {
      lastX = e.clientX;
      lastY = e.clientY;
      highlight(document.elementFromPoint(lastX, lastY));
    };

    // Swallowed so a pick never activates a link, button or drag on the page.
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onClick = (e: MouseEvent) => {
      swallow(e);
      finish(current ?? document.elementFromPoint(e.clientX, e.clientY));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { swallow(e); finish(null); return; }
      if (e.key === 'Enter' && current) { swallow(e); finish(current); return; }
      if (e.key === 'ArrowUp' && current?.parentElement) {
        swallow(e);
        highlight(current.parentElement);
        return;
      }
      if (e.key === 'ArrowDown' && current?.firstElementChild) {
        swallow(e);
        highlight(current.firstElementChild);
      }
    };
    const onScroll = () => {
      // The element under the cursor changes as the page moves beneath it.
      highlight(document.elementFromPoint(lastX, lastY) ?? current);
    };

    const SWALLOWED = ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'pointerdown', 'pointerup'];

    const cleanup = () => {
      window.removeEventListener('mousemove', onMove, true);
      for (const type of SWALLOWED) {
        window.removeEventListener(type, type === 'click' ? (onClick as EventListener) : swallow, true);
      }
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', draw, true);
      document.documentElement.style.cursor = previousCursor;
      try {
        (layer as HTMLElement & { hidePopover?: () => void }).hidePopover?.();
      } catch {
        /* never opened */
      }
      layer.remove();
      pickerCleanup = null;
    };
    pickerCleanup = () => finish(null);

    window.addEventListener('mousemove', onMove, true);
    for (const type of SWALLOWED) {
      window.addEventListener(type, type === 'click' ? (onClick as EventListener) : swallow, true);
    }
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', draw, true);

    layer.append(box, label, hint);
    document.documentElement.appendChild(layer);
    try {
      // Puts the whole picker in the top layer, above every z-index on the page.
      (layer as HTMLElement & { showPopover?: () => void }).showPopover?.();
    } catch {
      /* Older Chrome, or popover already open: the z-index fallback still applies. */
    }
    // The popup has just closed, so the page may not have keyboard focus yet.
    window.focus();
  });
}

/* ---------------------------------------------------------------- wiring */

declare global {
  interface Window { __C2D_READY__?: boolean }
}

if (!window.__C2D_READY__) {
  window.__C2D_READY__ = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return undefined;

    if (message.type === 'c2d-capture-page') {
      capture(message.request as CaptureRequest)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.stack || err) }));
      return true;
    }

    if (message.type === 'c2d-pick-and-capture') {
      startPicker()
        .then(async (element) => {
          if (!element) return sendResponse({ ok: false, cancelled: true });
          const result = await capture(message.request as CaptureRequest, element);
          sendResponse({ ok: true, result });
        })
        .catch((err) => sendResponse({ ok: false, error: String(err?.stack || err) }));
      return true;
    }

    if (message.type === 'c2d-cancel-picker') {
      pickerCleanup?.();
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'c2d-ping') {
      sendResponse({ ok: true });
      return false;
    }
    return undefined;
  });
}
