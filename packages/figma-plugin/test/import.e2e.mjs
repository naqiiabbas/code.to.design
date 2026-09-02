/**
 * The full pipeline, end to end, with nothing stubbed in the middle:
 *
 *   real Chrome -> real capture bundle -> real clipboard payload
 *     -> the UI's decode step -> the real built plugin sandbox bundle
 *     -> a strict Figma API stand-in that throws where Figma throws
 *
 * Run with: node --test packages/figma-plugin/test/import.e2e.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createFigmaMock } from './figma-mock.mjs';
import { encodePayload, decodePayload } from '../../shared/src/payload.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const captureBundle = path.join(here, '../../extension/dist/capture.js');
const pluginBundle = path.join(here, '../dist/code.js');
const fixtureUrl = pathToFileURL(path.join(here, '../../extension/test/fixture.html')).href;

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
      sendMessage: async (message) => {
        if (message.type !== 'fetch-asset') return null;
        const response = await fetch(message.url);
        const blob = await response.blob();
        if (blob.type === 'image/svg+xml') {
          return { kind: 'svg', markup: await blob.text(), width: 0, height: 0 };
        }
        const bitmap = await createImageBitmap(blob);
        const buffer = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (const byte of buffer) binary += String.fromCharCode(byte);
        return {
          kind: 'raster',
          mime: blob.type || 'image/png',
          data: btoa(binary),
          width: bitmap.width,
          height: bitmap.height,
        };
      },
    },
  };
`;

/** Exactly what packages/figma-plugin/src/ui/App.tsx does before it posts. */
function splitAssets(snapshot) {
  const images = {};
  for (const [id, asset] of Object.entries(snapshot.assets ?? {})) {
    const binary = atob(asset.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    images[id] = bytes;
  }
  const lean = {
    ...snapshot,
    assets: Object.fromEntries(
      Object.entries(snapshot.assets ?? {}).map(([id, a]) => [id, { ...a, data: '' }]),
    ),
  };
  return { lean, images };
}

let pluginSource;
let snapshot;
let withLayout;
let plain;

/** Loads a fresh copy of the plugin bundle against a fresh Figma stand-in. */
async function runImport(options) {
  const mock = createFigmaMock();
  globalThis.figma = mock.figma;
  globalThis.__html__ = mock.html;
  // The bundle is an IIFE that reads the `figma` global at load time, so it has
  // to be re-evaluated for each stand-in.
  // eslint-disable-next-line no-eval
  (0, eval)(pluginSource);

  assert.ok(typeof mock.figma.ui.onmessage === 'function', 'the plugin never registered its handler');
  const { lean, images } = splitAssets(snapshot);
  await mock.figma.ui.onmessage({ type: 'import', snapshot: lean, images, options });

  const messages = mock.figma.__messages;
  const failed = messages.find((m) => m.type === 'error');
  assert.ok(!failed, `the import reported an error: ${failed?.message}`);
  const done = messages.find((m) => m.type === 'done');
  assert.ok(done, `the import never finished. Messages: ${JSON.stringify(messages)}`);
  return { mock, report: done.report, messages };
}

test.before(async () => {
  const executablePath = await findChrome();
  assert.ok(executablePath, 'No Chrome or Edge found');

  // 1. Capture a real page with the real bundle.
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(CHROME_STUB);
  await page.goto(fixtureUrl, { waitUntil: 'networkidle' });
  await page.addScriptTag({ content: await fs.readFile(captureBundle, 'utf8') });
  const capture = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        window.__c2dListener(
          { type: 'c2d-capture-page', request: { mode: 'page', label: '1280px', maxImageDimension: 2400 } },
          {},
          (r) => (r.ok ? resolve(r.result) : reject(new Error(r.error))),
        );
      }),
  );
  await browser.close();

  // 2. Through the clipboard codec, exactly as the extension writes it.
  const payload = await encodePayload({
    version: 1,
    generator: 'test',
    source: { url: fixtureUrl, origin: 'file://', title: 'Fixture', capturedAt: new Date().toISOString(), mode: 'page' },
    frames: [{ id: 'f1', label: '1280px', viewportWidth: 1280, theme: 'browser', root: capture.root }],
    assets: capture.assets,
    fonts: capture.fonts,
    stats: {
      nodes: capture.nodeCount,
      images: Object.keys(capture.assets).length,
      bytes: 0,
      durationMs: 0,
      warnings: capture.warnings,
    },
  });
  snapshot = await decodePayload(payload);

  // 3. Build it twice: once as the plugin ships (auto layout on), and once with
  //    auto layout off, where the result must match the capture node for node.
  pluginSource = await fs.readFile(pluginBundle, 'utf8');
  withLayout = await runImport({ autoLayout: true, groupFrames: true, keepLinks: true });
  plain = await runImport({ autoLayout: false, groupFrames: true, keepLinks: true });
});

/* ---------------------------------------------------------------- helpers */

function walk(node, out = []) {
  out.push(node);
  for (const child of node.children ?? []) walk(child, out);
  return out;
}

const built = (run) => walk(run.mock.page).slice(1);
const byName = (run, name) => built(run).find((n) => n.name === name);
const texts = (run) => built(run).filter((n) => n.type === 'TEXT');
const findText = (run, needle) => texts(run).find((n) => n.characters.includes(needle));

/* ------------------------------------------------------------------ tests */

test('the import completes and reports what it built', () => {
  const { report, mock } = withLayout;
  assert.equal(report.skipped, 0, `nodes were skipped: ${JSON.stringify(report.warnings)}`);
  assert.equal(report.frames, 1);
  assert.ok(report.layers > 30, `only ${report.layers} layers`);
  assert.equal(report.images, 1, 'the fixture image did not become a Figma image');
  assert.equal(mock.figma.__notifications.length, 1, 'no completion notice');
});

test('progress is reported to the UI throughout', () => {
  const progress = withLayout.messages.filter((m) => m.type === 'progress');
  assert.ok(progress.length >= 3, `only ${progress.length} progress updates`);
  for (const step of progress) {
    assert.ok(step.ratio >= 0 && step.ratio <= 1, `ratio out of range: ${step.ratio}`);
    assert.ok(typeof step.message === 'string' && step.message.length > 0);
  }
});

test('the page frame lands on the canvas at the captured size', () => {
  assert.equal(withLayout.mock.page.children.length, 1, 'expected exactly one root on the page');
  const root = withLayout.mock.page.children[0];
  const captured = snapshot.frames[0].root;
  assert.ok(Math.abs(root.width - captured.width) < 0.01, `${root.width} vs ${captured.width}`);
  assert.ok(Math.abs(root.height - captured.height) < 0.01, `${root.height} vs ${captured.height}`);
  assert.equal(withLayout.mock.page.selection.length, 1, 'the import did not select what it made');
});

test('every built node has a positive, finite size', () => {
  for (const node of built(withLayout)) {
    assert.ok(node.width > 0 && node.height > 0, `${node.name} is ${node.width}x${node.height}`);
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), `${node.name} has no position`);
  }
});

test('without auto layout the Figma tree mirrors the capture node for node', () => {
  // Walking both trees in parallel catches a dropped or reordered node, which a
  // name-based lookup would quietly paper over (sibling names repeat constantly).
  let compared = 0;

  const compare = (captured, node, trail) => {
    // The root frame is deliberately renamed to "<page title> — <label>".
    if (trail !== 'root') assert.equal(node.name, captured.name, `name mismatch at ${trail}`);
    assert.ok(
      Math.abs(node.width - captured.width) < 0.02,
      `${trail} width ${node.width} vs ${captured.width}`,
    );
    // Text captured without an explicit line-height is imported as hug-height on
    // purpose, so Figma's own metrics decide how tall it ends up.
    const hugsHeight = captured.type === 'TEXT' && captured.autoResize !== 'NONE';
    if (!hugsHeight) {
      assert.ok(
        Math.abs(node.height - captured.height) < 0.02,
        `${trail} height ${node.height} vs ${captured.height}`,
      );
    }
    // The root is re-centred on the viewport; a rotated node is placed by its
    // relativeTransform and is checked separately.
    if (!captured.rotation && trail !== 'root') {
      assert.ok(Math.abs(node.x - captured.x) < 0.02, `${trail} x ${node.x} vs ${captured.x}`);
      assert.ok(Math.abs(node.y - captured.y) < 0.02, `${trail} y ${node.y} vs ${captured.y}`);
    }
    compared++;

    const capturedChildren = captured.children ?? [];
    // An SVG import produces its own internal children, so only compare the ones
    // the builder was asked to make.
    if (captured.type !== 'SVG') {
      assert.equal(
        (node.children ?? []).length,
        capturedChildren.length,
        `${trail} has ${(node.children ?? []).length} children, expected ${capturedChildren.length}`,
      );
      capturedChildren.forEach((child, i) =>
        compare(child, node.children[i], `${trail} > ${child.name}`),
      );
    }
  };

  compare(snapshot.frames[0].root, plain.mock.page.children[0], 'root');
  assert.ok(compared > 30, `only compared ${compared} nodes`);
});

test('the hero keeps its gradient, radius and shadow', () => {
  const hero = byName(withLayout, 'header.hero');
  assert.ok(hero, 'hero frame missing');
  const gradient = hero.fills.find((f) => f.type === 'GRADIENT_LINEAR');
  assert.ok(gradient, `hero fills: ${JSON.stringify(hero.fills.map((f) => f.type))}`);
  assert.equal(hero.topLeftRadius, 20);
  assert.ok(hero.effects.some((e) => e.type === 'DROP_SHADOW'), 'shadow lost');
});

test('auto layout is applied to the flex row with the captured padding and gap', () => {
  const row = byName(withLayout, 'div.row');
  assert.ok(row, 'row missing');
  assert.equal(row.layoutMode, 'HORIZONTAL');
  assert.equal(row.itemSpacing, 24);
  assert.equal(row.primaryAxisAlignItems, 'SPACE_BETWEEN');
  assert.equal(row.primaryAxisSizingMode, 'FIXED');
  assert.equal(row.children.length, 3);

  // With auto layout off the same frame must be plain again.
  assert.equal(byName(plain, 'div.row').layoutMode, 'NONE');
});

test('text arrives with its characters, alignment and per-range styling', () => {
  const heading = findText(withLayout, 'Design systems');
  assert.ok(heading, `no heading. Texts: ${texts(withLayout).map((t) => t.characters).join(' | ')}`);
  assert.ok(heading.characters.includes('captured'), 'the inline <em> text was lost');
  const fontRanges = heading._ranges.filter((r) => r.what === 'setRangeFontName');
  assert.ok(fontRanges.length >= 2, `only ${fontRanges.length} styled ranges`);
  for (const range of heading._ranges) {
    assert.ok(range.end <= heading.characters.length, 'a range ran past the end of the text');
  }
  assert.equal(heading.textAlignHorizontal, 'LEFT');
});

test('fonts are resolved against what Figma actually has, and loaded first', () => {
  const loaded = withLayout.mock.figma.__state.loadedFonts;
  assert.ok(loaded.has('Georgia__Regular'), `loaded: ${[...loaded].join(', ')}`);
  assert.ok(loaded.has('Georgia__Bold'), 'the 700 weight was not resolved to Bold');
  for (const key of loaded) assert.ok(!key.includes('undefined'), `bogus font ${key}`);
});

test('the image becomes an image fill backed by real bytes', () => {
  const image = built(withLayout).find((n) => n.name.startsWith('img'));
  assert.ok(image, 'no image node');
  const fill = image.fills.find((f) => f.type === 'IMAGE');
  assert.ok(fill, 'image node has no image fill');
  assert.ok(
    withLayout.mock.figma.__state.imageHashes.has(fill.imageHash),
    'the fill points at an image that was never created',
  );
});

test('nothing invents a hyperlink on a fixture with no anchors', () => {
  const withHref = built(withLayout).filter((n) => n.getPluginData?.('href'));
  assert.equal(withHref.length, 0);
});

test('rotation is rebuilt as a relative transform around the same centre', () => {
  const rotated = byName(plain, 'div.rotated');
  assert.ok(rotated, 'rotated node missing');
  const t = rotated.relativeTransform;
  const angle = (Math.atan2(-t[1][0], t[0][0]) * 180) / Math.PI;
  assert.ok(Math.abs(angle + 15) < 0.1, `rebuilt rotation ${angle} should be -15`);

  const captured = walk(snapshot.frames[0].root).find((n) => n.name === 'div.rotated');
  const cx = t[0][2] + (t[0][0] * rotated.width) / 2 + (t[0][1] * rotated.height) / 2;
  const cy = t[1][2] + (t[1][0] * rotated.width) / 2 + (t[1][1] * rotated.height) / 2;
  assert.ok(
    Math.abs(cx - (captured.x + captured.width / 2)) < 0.1,
    `centre x ${cx} vs ${captured.x + captured.width / 2}`,
  );
  assert.ok(
    Math.abs(cy - (captured.y + captured.height / 2)) < 0.1,
    `centre y ${cy} vs ${captured.y + captured.height / 2}`,
  );
});

test('a rotated element is never folded into an auto layout container', () => {
  // Its bounding box would change in Figma and shove its siblings around.
  const split = byName(withLayout, 'div.split');
  assert.ok(split, 'split row missing');
  assert.equal(split.layoutMode, 'NONE', 'a flex row with a rotated child must stay absolute');
});

test('clipping and paint order are carried over', () => {
  assert.equal(byName(withLayout, 'div.clipped').clipsContent, true);
  const stacked = byName(withLayout, 'div.stacked');
  assert.deepEqual(stacked.children.map((c) => c.name), ['div.under', 'div.over']);
});

test('a font Figma does not have falls back instead of crashing the import', async () => {
  // The commonest way a Figma import dies is loadFontAsync on a web font that is
  // not installed, so make every single segment ask for one.
  const original = snapshot;
  try {
    snapshot = JSON.parse(JSON.stringify(original));
    for (const node of walk(snapshot.frames[0].root)) {
      if (node.type !== 'TEXT') continue;
      for (const segment of node.segments) {
        segment.fontFamily = 'Totally Not Installed Sans';
        segment.fontStack = ['Totally Not Installed Sans', 'Also Missing Display', 'sans-serif'];
      }
    }

    const run = await runImport({ autoLayout: true, groupFrames: true, keepLinks: true });
    assert.equal(run.report.skipped, 0, `nodes were skipped: ${JSON.stringify(run.report.warnings)}`);
    assert.ok(run.report.substitutions.length > 0, 'no substitution was reported to the user');
    assert.ok(
      run.report.substitutions.some((s) => s.startsWith('Totally Not Installed Sans ->')),
      `substitutions: ${run.report.substitutions.join(', ')}`,
    );
    // The generic tail of the stack should land on Inter, not on nothing.
    for (const key of run.mock.figma.__state.loadedFonts) {
      assert.ok(!key.startsWith('Totally'), `it tried to load a missing font: ${key}`);
    }
    assert.ok(findText(run, 'Design systems'), 'the heading did not survive the substitution');
  } finally {
    snapshot = original;
  }
});

test('an unsupported image format is reported, not fatal', async () => {
  const original = snapshot;
  try {
    // Figma's createImage takes PNG/JPEG/GIF only; a WebP must degrade gracefully.
    snapshot = JSON.parse(JSON.stringify(original));
    const first = Object.keys(snapshot.assets)[0];
    snapshot.assets[first].data = btoa('RIFF____WEBPVP8 ');

    const run = await runImport({ autoLayout: true, groupFrames: true, keepLinks: true });
    assert.equal(run.report.images, 0, 'the bad image should not have been created');
    assert.ok(
      run.report.warnings.some((w) => w.includes('could not be decoded')),
      `warnings: ${run.report.warnings.join(' | ')}`,
    );
    // Everything else must still be there.
    assert.ok(run.report.layers > 30, `only ${run.report.layers} layers survived`);
    assert.ok(findText(run, 'Design systems'), 'the page did not survive a bad image');
  } finally {
    snapshot = original;
  }
});
