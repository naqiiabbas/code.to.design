/**
 * Two ways scroll priming used to fail on real sites:
 *
 *  - the window does not scroll at all (an app shell scrolls an inner element),
 *    so nothing below the fold ever loaded and the capture held only what was
 *    already on screen;
 *  - the page keeps growing as you scroll, so priming ran for as long as the
 *    page cared to grow.
 *
 * Run with: node --test packages/extension/test/inner-scroll.e2e.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '../dist/capture.js');
const fixtureUrl = pathToFileURL(path.join(here, 'inner-scroll.html')).href;

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
let bundle;

test.before(async () => {
  const executablePath = await findChrome();
  assert.ok(executablePath, 'No Chrome or Edge found');
  browser = await chromium.launch({ executablePath, headless: true });
  bundle = await fs.readFile(bundlePath, 'utf8');
});

test.after(async () => {
  await browser?.close();
});

async function capturePage(setup) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.addInitScript(CHROME_STUB);
  await setup(page);
  await page.addScriptTag({ content: bundle });
  const started = Date.now();
  const capture = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        window.__c2dListener(
          { type: 'c2d-capture-page', request: { mode: 'page', label: 'Feed' } },
          {},
          (r) => (r.ok ? resolve(r.result) : reject(new Error(r.error))),
        );
      }),
  );
  const elapsed = Date.now() - started;
  await page.close();
  return { capture, elapsed };
}

function flatten(node, out = []) {
  out.push(node);
  if (node.type === 'FRAME') for (const child of node.children) flatten(child, out);
  return out;
}

const textsOf = (capture) =>
  flatten(capture.root)
    .filter((n) => n.type === 'TEXT')
    .map((n) => n.segments.map((s) => s.text).join(''));

/* ------------------------------------------------------------------ tests */

test('an app shell that scrolls an inner element is primed all the way down', async () => {
  const { capture } = await capturePage(async (page) => {
    await page.goto(fixtureUrl, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__fixtureReady === true);
    // Confirm the premise: the window itself cannot scroll here.
    const windowScrolls = await page.evaluate(() => {
      const doc = document.scrollingElement;
      return doc.scrollHeight > doc.clientHeight + 2;
    });
    assert.equal(windowScrolls, false, 'the fixture window scrolls, so this proves nothing');
  });

  const texts = textsOf(capture);
  // Card 1 is on screen from the start; 40 is far below and only an inner
  // scroll can reveal it.
  assert.ok(texts.some((t) => t.includes('Card 1 loaded')), 'the first card is missing');
  assert.ok(
    texts.some((t) => t.includes('Card 40 loaded')),
    `the last card never loaded, so the inner scroller was not primed. Got ${texts.length} text layers`,
  );

  const loaded = texts.filter((t) => /^Card \d+ loaded$/.test(t)).length;
  assert.equal(loaded, 40, `only ${loaded} of 40 cards were captured`);
});

test('the whole feed is inside the captured frame, not clipped to the viewport', async () => {
  const { capture } = await capturePage(async (page) => {
    await page.goto(fixtureUrl, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__fixtureReady === true);
  });

  // 40 cards at ~196px each: the frame has to be far taller than the 700px window.
  assert.ok(
    capture.root.height > 3000,
    `the capture is ${capture.root.height}px tall, so it was clipped to the viewport`,
  );

  const main = flatten(capture.root).find((n) => n.name === 'div#main');
  assert.ok(main, 'the scrolling region is missing');
  assert.ok(main.height > 3000, `the scroll region is only ${main.height}px tall`);
});

test('a page that grows forever is cut off in time, and says so', async () => {
  const { capture, elapsed } = await capturePage(async (page) => {
    await page.goto(fixtureUrl, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__fixtureReady === true);
    // Endless feed: every scroll appends another screenful.
    await page.evaluate(() => {
      const main = document.getElementById('main');
      const list = document.getElementById('list');
      main.addEventListener('scroll', () => {
        for (let i = 0; i < 4; i++) {
          const card = document.createElement('div');
          card.className = 'card';
          card.textContent = 'endless';
          list.appendChild(card);
        }
      });
    });
  });

  // The budget is 8s of scrolling; the whole capture must land near that, not run away.
  assert.ok(elapsed < 20000, `the capture took ${elapsed}ms, which is a hang`);
  assert.ok(
    capture.warnings.some((w) => w.includes('kept loading more content')),
    `no warning that the page was truncated: ${JSON.stringify(capture.warnings)}`,
  );
});

test('content driven by a scroll EVENT on the inner element is revealed', async () => {
  // This is what only priming can do. Expanding the container changes its size
  // but fires no scroll event, so anything wired to `scroll` stays unloaded
  // unless the element is genuinely scrolled.
  const { capture } = await capturePage(async (page) => {
    await page.goto(fixtureUrl, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__fixtureReady === true);
  });

  const texts = textsOf(capture);
  const loaded = texts.filter((t) => /^Scroll card \d+ loaded$/.test(t)).length;
  assert.equal(
    loaded,
    10,
    `only ${loaded} of 10 scroll-driven cards loaded, so the inner element was never actually scrolled`,
  );
});
