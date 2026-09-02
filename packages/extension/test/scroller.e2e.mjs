/**
 * Content hidden inside an internally scrolling box - a dropdown, a popup list,
 * a horizontal strip - has to reach Figma too, and the frame has to be tall
 * enough to show it.
 *
 * Run with: node --test packages/extension/test/scroller.e2e.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '../dist/capture.js');
const fixtureUrl = pathToFileURL(path.join(here, 'scroller.html')).href;

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
let pageCapture;
let selectionCapture;
/** What the DOM looked like before any capture ran. */
let baseline;

function flatten(node, out = []) {
  out.push(node);
  if (node.type === 'FRAME') for (const child of node.children) flatten(child, out);
  return out;
}

const textOf = (node) => node.segments.map((s) => s.text).join('');
const findNode = (capture, name) => flatten(capture.root).find((n) => n.name === name);
const findText = (capture, needle) =>
  flatten(capture.root).find((n) => n.type === 'TEXT' && textOf(n).includes(needle));

async function readDom() {
  return page.evaluate(() => {
    const list = document.getElementById('list');
    const strip = document.getElementById('strip');
    return {
      listHeight: list.getBoundingClientRect().height,
      listStyle: list.getAttribute('style'),
      listScrollTop: list.scrollTop,
      listOverflow: getComputedStyle(list).overflowY,
      stripWidth: strip.getBoundingClientRect().width,
      stripStyle: strip.getAttribute('style'),
      // What matters is that no expansion property is left behind. Chrome can
      // keep an inert style="" on an element that had no style attribute, which
      // changes nothing about how the page renders or behaves.
      leftovers: [...document.querySelectorAll('[style]')]
        .flatMap((el) => [...el.style].map((p) => `${el.id || el.tagName}:${p}`))
        .filter((entry) => !entry.startsWith('HTML:')),
      afterTop: document.getElementById('after').getBoundingClientRect().top,
    };
  });
}

test.before(async () => {
  const executablePath = await findChrome();
  assert.ok(executablePath, 'No Chrome or Edge found');
  browser = await chromium.launch({ executablePath, headless: true });
  page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.addInitScript(CHROME_STUB);
  await page.goto(fixtureUrl, { waitUntil: 'networkidle' });
  await page.addScriptTag({ content: await fs.readFile(bundlePath, 'utf8') });

  // Scroll the list part-way, so restoring has something to restore.
  await page.evaluate(() => { document.getElementById('list').scrollTop = 40; });
  baseline = await readDom();

  pageCapture = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        window.__c2dListener(
          { type: 'c2d-capture-page', request: { mode: 'page', label: 'Page' } },
          {},
          (r) => (r.ok ? resolve(r.result) : reject(new Error(r.error))),
        );
      }),
  );

  // Now the real selection path: start the picker, hover the popup, click it.
  const pick = page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        window.__c2dListener(
          { type: 'c2d-pick-and-capture', request: { mode: 'selection', label: 'Popup' } },
          {},
          (r) => (r.ok ? resolve(r.result) : reject(new Error(r.error || 'cancelled'))),
        );
      }),
  );
  // Hovering the title selects the title; one step up the tree reaches the
  // popup itself, which is what a user would do here too.
  const popup = await page.locator('#popup').boundingBox();
  await page.mouse.move(popup.x + popup.width / 2, popup.y + 20);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  selectionCapture = await pick;
});

test.after(async () => {
  await browser?.close();
});

/* ------------------------------------------------------------------ tests */

test('every row of a scrolling list is captured, not just the visible ones', () => {
  const names = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  for (const name of names) {
    assert.ok(
      findText(selectionCapture, `Driver ${name}`),
      `"Driver ${name}" is missing; only the rows above the fold were captured`,
    );
  }
});

test('the scrolling box grows to its full content height', () => {
  const list = findNode(selectionCapture, 'div#list');
  assert.ok(list, 'the list frame is missing');
  // Ten rows at roughly 47px each, versus the 160px the browser showed.
  assert.ok(list.height > 400, `list height ${list.height} was not expanded`);
  assert.equal(list.clipsContent, false, 'the expanded list still clips its content');

  // Every row sits inside the frame, so nothing needs clipping away.
  for (const row of list.children) {
    assert.ok(
      row.y >= -1 && row.y + row.height <= list.height + 1,
      `a row at y=${row.y} h=${row.height} falls outside the ${list.height}px frame`,
    );
  }
});

test('the popup frame and everything after it move with the expansion', () => {
  const popup = selectionCapture.root;
  const list = findNode(selectionCapture, 'div#list');
  const footer = findNode(selectionCapture, 'div#popup-footer');

  assert.ok(popup.height > list.height, `popup ${popup.height} should contain the list ${list.height}`);
  assert.ok(
    footer.y >= list.y + list.height - 1,
    `the footer at y=${footer.y} did not move below the expanded list (ends at ${list.y + list.height})`,
  );
  assert.ok(
    footer.y + footer.height <= popup.height + 1,
    'the footer falls outside the popup frame',
  );
});

test('horizontal scrollers expand too', () => {
  const strip = findNode(pageCapture, 'div#strip');
  assert.ok(strip, 'the strip frame is missing');
  assert.ok(strip.width > 320, `strip width ${strip.width} was not expanded`);
  assert.ok(findText(pageCapture, 'Eight seater'), 'the last chip was cut off');
});

test('a page capture reflows the content that follows an expanded box', () => {
  const after = findNode(pageCapture, 'div#after');
  const strip = findNode(pageCapture, 'div#strip');
  assert.ok(after, 'the trailing block is missing');
  assert.ok(
    after.y > strip.y + strip.height - 1,
    `the trailing block at y=${after.y} overlaps the strip ending at ${strip.y + strip.height}`,
  );
  // It has to have moved down relative to where the browser was showing it.
  assert.ok(after.y > baseline.afterTop, `trailing block did not move: ${after.y} vs ${baseline.afterTop}`);
});

test('the capture reports what it expanded', () => {
  const note = selectionCapture.warnings.find((w) => w.includes('Expanded'));
  assert.ok(note, `no expansion note. Warnings: ${JSON.stringify(selectionCapture.warnings)}`);
  assert.ok(/Expanded 1 scrollable area\b/.test(note), `unexpected note: ${note}`);
});

test('the page is left exactly as it was found', async () => {
  const now = await readDom();
  assert.deepEqual(now.leftovers, [], 'expansion properties were left on the page');
  // An empty style="" may survive where there was no attribute at all; anything
  // with actual declarations in it is a leak.
  for (const [label, value] of [['list', now.listStyle], ['strip', now.stripStyle]]) {
    assert.ok(!value, `${label} kept inline declarations: ${JSON.stringify(value)}`);
  }
  assert.equal(now.listOverflow, baseline.listOverflow, 'the list overflow was not restored');
  assert.ok(
    Math.abs(now.listHeight - baseline.listHeight) < 1,
    `list height not restored: ${now.listHeight} vs ${baseline.listHeight}`,
  );
  assert.ok(
    Math.abs(now.stripWidth - baseline.stripWidth) < 1,
    `strip width not restored: ${now.stripWidth} vs ${baseline.stripWidth}`,
  );
  assert.equal(now.listScrollTop, baseline.listScrollTop, 'the scroll position was not restored');
  assert.ok(
    Math.abs(now.afterTop - baseline.afterTop) < 1,
    `the page layout did not settle back: ${now.afterTop} vs ${baseline.afterTop}`,
  );
});
