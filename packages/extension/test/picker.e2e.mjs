/**
 * Visual regression for the element picker.
 *
 * The highlight box was invisible on most real sites because it sat at
 * `z-index: auto` and every sticky header, nav and chat widget painted over it.
 * Asserting on the DOM would not have caught that, so this screenshots the page
 * and samples real pixels: the only question that matters is whether a human can
 * see the blue box.
 *
 * Run with: node --test packages/extension/test/picker.e2e.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '../dist/capture.js');
const fixtureUrl = pathToFileURL(path.join(here, 'picker.html')).href;

const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

async function findChrome() {
  for (const candidate of CHROME_PATHS) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

const CHROME_STUB = `
  window.__c2dListener = null;
  window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { window.__c2dListener = fn; } },
      sendMessage: async () => ({ kind: 'error', message: 'no assets' }),
    },
  };
`;

let browser;
let page;

test.before(async () => {
  const executablePath = await findChrome();
  assert.ok(executablePath, 'No Chrome or Edge found');
  browser = await chromium.launch({ executablePath, headless: true });
  page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.addInitScript(CHROME_STUB);
  await page.goto(fixtureUrl, { waitUntil: 'networkidle' });
  await page.addScriptTag({ content: await fs.readFile(bundlePath, 'utf8') });

  // Start the picker. It never resolves until something is clicked, so the
  // promise is deliberately left dangling.
  await page.evaluate(() => {
    window.__c2dPicked = null;
    window.__c2dListener(
      { type: 'c2d-pick-and-capture', request: { mode: 'selection', label: 'Pick' } },
      {},
      (r) => { window.__c2dPicked = r; },
    );
  });
});

test.after(async () => {
  await browser?.close();
});

/** Samples one pixel out of a real screenshot of the page. */
async function pixelAt(x, y) {
  const shot = (await page.screenshot({ type: 'png' })).toString('base64');
  return page.evaluate(
    ([b64, px, py]) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const d = ctx.getImageData(px, py, 1, 1).data;
          resolve([d[0], d[1], d[2]]);
        };
        img.onerror = () => reject(new Error('could not decode the screenshot'));
        img.src = `data:image/png;base64,${b64}`;
      }),
    [shot, x, y],
  );
}

async function hover(x, y) {
  await page.mouse.move(x, y);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** The highlight tints whatever is under it toward blue. */
function assertHighlighted(before, after, where) {
  assert.notDeepEqual(after, before, `${where}: the pixel did not change at all, so nothing was drawn`);
  const blueShift = after[2] - before[2] - (after[0] - before[0]);
  assert.ok(
    blueShift > 8,
    `${where}: expected a blue tint, went from rgb(${before}) to rgb(${after})`,
  );
}

/* ------------------------------------------------------------------ tests */

test('the picker is promoted to the top layer', async () => {
  const state = await page.evaluate(() => {
    const layer = document.getElementById('__c2d_picker__');
    if (!layer) return { present: false };
    return {
      present: true,
      inTopLayer: layer.matches(':popover-open'),
      children: layer.children.length,
      zIndex: getComputedStyle(layer).zIndex,
    };
  });
  assert.ok(state.present, 'the picker overlay was never added to the page');
  assert.equal(state.children, 3, 'the box, label and hint must live inside the one stacking context');
  assert.equal(state.zIndex, '2147483647');
  assert.ok(state.inTopLayer, 'the overlay is not in the top layer, so page z-indexes can cover it');
});

test('the highlight is visible over a plain element', async () => {
  const before = await pixelAt(450, 400);
  await hover(450, 400);
  const after = await pixelAt(450, 400);
  assertHighlighted(before, after, 'plain block');
});

test('the highlight is visible over a sticky header with z-index 999', async () => {
  // This is the case that failed in the wild: the header painted over the box.
  const before = await pixelAt(450, 60);
  await hover(450, 60);
  const after = await pixelAt(450, 60);
  assertHighlighted(before, after, 'sticky header');
});

test('the highlight is visible over an element at the maximum z-index', async () => {
  const before = await pixelAt(800, 600);
  await hover(800, 600);
  const after = await pixelAt(800, 600);
  assertHighlighted(before, after, 'chat widget');
});

test('the highlight tracks whatever is hovered, and reports its size', async () => {
  await hover(800, 600);
  const state = await page.evaluate(() => {
    const layer = document.getElementById('__c2d_picker__');
    const box = layer.children[0];
    const label = layer.children[1];
    return {
      box: box.getBoundingClientRect(),
      opacity: getComputedStyle(box).opacity,
      label: label.textContent,
    };
  });
  assert.equal(state.opacity, '1', 'the box is still hidden');
  // 200px content plus a 1px border each side: the highlight tracks the border box.
  assert.ok(Math.abs(state.box.width - 202) < 1, `box width ${state.box.width} should match the widget`);
  assert.ok(Math.abs(state.box.height - 202) < 1, `box height ${state.box.height} should match the widget`);
  assert.ok(state.label.includes('div#widget'), `label was "${state.label}"`);
  assert.ok(state.label.includes('202 × 202'), `label was "${state.label}"`);
});

test('the page still scrolls while picking', async () => {
  const before = await page.evaluate(() => window.scrollY);
  await page.mouse.move(450, 400);
  await page.mouse.wheel(0, 200);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 120)));
  const after = await page.evaluate(() => window.scrollY);
  assert.ok(after > before, `scroll did not move: ${before} -> ${after}`);
});

test('clicking picks the element instead of activating the page', async () => {
  await page.evaluate(() => {
    window.__pageSawClick = false;
    document.addEventListener('click', () => { window.__pageSawClick = true; });
  });
  await hover(800, 600);
  await page.mouse.click(800, 600);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 150)));

  const sawClick = await page.evaluate(() => window.__pageSawClick);
  assert.equal(sawClick, false, 'the click reached the page underneath');

  const gone = await page.evaluate(() => !document.getElementById('__c2d_picker__'));
  assert.ok(gone, 'the picker overlay was left behind after the pick');
});
