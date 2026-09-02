/**
 * Drives the real capture bundle in real Chrome against test/fixture.html.
 *
 * The bundle expects to run as an injected content script, so the harness stubs
 * the two chrome.* surfaces it touches: runtime.onMessage (to grab the listener)
 * and runtime.sendMessage (to serve image fetches from the page instead of the
 * service worker).
 *
 * Run with: node --test packages/extension/test/capture.e2e.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '../dist/capture.js');
const fixtureUrl = pathToFileURL(path.join(here, 'fixture.html')).href;

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
      /* try the next one */
    }
  }
  return null;
}

/** Replaces the service-worker asset fetch with an in-page one. */
const CHROME_STUB = `
  window.__c2dListener = null;
  window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { window.__c2dListener = fn; } },
      sendMessage: async (message) => {
        if (message.type !== 'fetch-asset') return null;
        try {
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
        } catch (err) {
          return { kind: 'error', message: String(err) };
        }
      },
    },
  };
`;

let browser;
let capture;

test.before(async () => {
  const executablePath = await findChrome();
  assert.ok(executablePath, 'No Chrome or Edge found to run the capture against');

  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(CHROME_STUB);
  await page.goto(fixtureUrl, { waitUntil: 'networkidle' });
  await page.addScriptTag({ content: await fs.readFile(bundlePath, 'utf8') });

  capture = await page.evaluate(async () => {
    const listener = window.__c2dListener;
    if (!listener) throw new Error('The capture bundle never registered its listener');
    return await new Promise((resolve, reject) => {
      const handled = listener(
        { type: 'c2d-capture-page', request: { mode: 'page', label: 'Test', maxImageDimension: 2400 } },
        {},
        (response) => (response.ok ? resolve(response.result) : reject(new Error(response.error))),
      );
      if (handled !== true) reject(new Error('The listener did not take the message'));
    });
  });
});

test.after(async () => {
  await browser?.close();
});

/* ---------------------------------------------------------------- helpers */

function flatten(node, out = []) {
  out.push(node);
  if (node.type === 'FRAME') for (const child of node.children) flatten(child, out);
  return out;
}

const all = () => flatten(capture.root);
const ofType = (type) => all().filter((n) => n.type === type);
const textOf = (node) => node.segments.map((s) => s.text).join('');
const findText = (needle) => ofType('TEXT').find((n) => textOf(n).includes(needle));

/* ------------------------------------------------------------------ tests */

test('captures the full page at its real size', () => {
  assert.equal(capture.root.type, 'FRAME');
  assert.ok(capture.root.width >= 1280, `page width ${capture.root.width}`);
  assert.ok(capture.root.height > 500, `page height ${capture.root.height}`);
  assert.ok(capture.nodeCount > 30, `only ${capture.nodeCount} nodes`);
});

test('every node has a real, positive size', () => {
  for (const node of all()) {
    assert.ok(node.width > 0 && node.height > 0, `${node.name} is ${node.width}x${node.height}`);
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), `${node.name} has no position`);
  }
});

test('heading text keeps its content, size and inline styling', () => {
  const heading = findText('Design systems');
  assert.ok(heading, 'heading text node missing');
  assert.ok(textOf(heading).includes('captured'), 'inline <em> text was dropped');
  assert.ok(heading.segments.length >= 2, 'inline styling was flattened into one segment');
  const italic = heading.segments.find((s) => s.italic);
  assert.ok(italic, 'the <em> segment lost its italic');
  assert.equal(italic.textDecoration, 'UNDERLINE');
  assert.ok(heading.segments[0].fontSize > 30, `heading font size ${heading.segments[0].fontSize}`);
  assert.equal(heading.segments[0].fontFamily, 'Georgia');
});

test('text collapses whitespace across inline element boundaries', () => {
  const body = findText('Pull any page into Figma');
  assert.ok(body, 'body copy missing');
  const text = textOf(body);
  assert.ok(!/\s{2,}/.test(text), `collapsed text still has runs of spaces: ${JSON.stringify(text)}`);
  assert.ok(text.includes('layers. No screenshots, no'), `unexpected text: ${JSON.stringify(text)}`);
  const upper = body.segments.find((s) => s.textCase === 'UPPER');
  assert.ok(upper, 'text-transform: uppercase was lost');
  assert.equal(upper.fontWeight, 700);
});

test('the hero gradient becomes a linear gradient fill', () => {
  const hero = all().find((n) => n.name.includes('hero'));
  assert.ok(hero, 'hero frame missing');
  const gradient = hero.fills?.find((f) => f.type === 'GRADIENT_LINEAR');
  assert.ok(gradient, `hero fills: ${JSON.stringify(hero.fills)}`);
  assert.equal(gradient.gradientStops.length, 2);
  assert.ok(gradient.gradientStops[0].color.b > 0.7, 'first stop should be indigo');
  assert.ok(hero.corners && hero.corners.tl === 20, 'border radius lost');
  assert.ok(hero.effects?.some((e) => e.type === 'DROP_SHADOW'), 'hero shadow lost');
});

test('cards carry borders, radius and shadow, and expose auto layout on the row', () => {
  const row = all().find((n) => n.name === 'div.row');
  assert.ok(row, 'row frame missing');
  assert.ok(row.layout, 'flex row produced no auto layout hint');
  assert.equal(row.layout.mode, 'HORIZONTAL');
  assert.equal(row.layout.itemSpacing, 24);
  assert.equal(row.layout.primaryAxisAlignItems, 'SPACE_BETWEEN');
  assert.equal(row.layout.order.length, 3);

  const card = all().find((n) => n.name.startsWith('section.card'));
  assert.ok(card.strokes?.length, 'card border lost');
  assert.equal(card.strokeWeight, 1);
  assert.equal(card.corners.tl, 12);
});

test('dashed pill border survives as a dash pattern', () => {
  const badge = all().find((n) => n.name === 'span.badge');
  assert.ok(badge, 'badge missing');
  assert.ok(badge.strokeDashes?.length, 'dashed border lost');
  assert.equal(badge.strokeWeight, 2);
  assert.ok(badge.corners.tl > 50, 'pill radius lost');
});

test('rotated elements keep their unrotated box plus a rotation', () => {
  const rotated = all().find((n) => n.name === 'div.rotated');
  assert.ok(rotated, 'rotated box missing');
  assert.ok(Math.abs(rotated.width - 120) < 1, `width ${rotated.width} should stay 120`);
  assert.ok(Math.abs(rotated.height - 120) < 1, `height ${rotated.height} should stay 120`);
  // CSS rotate(15deg) is clockwise; Figma counts the other way.
  assert.ok(Math.abs(rotated.rotation + 15) < 0.1, `rotation ${rotated.rotation}`);
});

test('overflow: hidden clips, and radial gradients are converted', () => {
  const clipped = all().find((n) => n.name === 'div.clipped');
  assert.ok(clipped.clipsContent, 'overflow: hidden did not set clipsContent');
  assert.ok(
    clipped.fills?.some((f) => f.type === 'GRADIENT_RADIAL'),
    `expected a radial fill, got ${JSON.stringify(clipped.fills)}`,
  );
  assert.equal(clipped.children.length, 1, 'the overflowing child was dropped');
});

test('z-index decides sibling paint order, not DOM order', () => {
  const stacked = all().find((n) => n.name === 'div.stacked');
  assert.ok(stacked, 'stacked frame missing');
  // .over comes first in the DOM but has the higher z-index, so it must be last.
  assert.deepEqual(
    stacked.children.map((c) => c.name),
    ['div.under', 'div.over'],
  );
});

test('an absolutely positioned ::after is captured', () => {
  const pseudo = all().find((n) => n.name.endsWith('::after'));
  assert.ok(pseudo, 'positioned pseudo element missing');
  assert.ok(Math.abs(pseudo.width - 10) < 0.5, `pseudo width ${pseudo.width}`);
  assert.ok(pseudo.fills?.[0]?.type === 'SOLID', 'pseudo background lost');
});

test('inline SVG becomes a vector node, and images become image nodes', () => {
  const svg = ofType('SVG')[0];
  assert.ok(svg, 'inline <svg> was not captured');
  assert.ok(svg.svg.includes('<circle'), 'svg markup lost its contents');
  assert.ok(svg.svg.includes('viewBox'), 'svg lost its viewBox');

  const image = ofType('IMAGE')[0];
  assert.ok(image, 'the <img> was not captured');
  assert.ok(capture.assets[image.assetId], 'the image bytes were never registered');
  assert.ok(image.name.includes('A red dot'), `alt text lost: ${image.name}`);
});

test('form controls keep their value and placeholder as text', () => {
  assert.ok(findText('hello@studio.com'), 'input value lost');
  assert.ok(findText('Your name'), 'placeholder lost');
  assert.ok(findText('Subscribe'), 'button label lost');
});

test('display:none and visibility:hidden subtrees are excluded', () => {
  assert.equal(findText('never captured'), undefined);
  assert.equal(findText('also never captured'), undefined);
});

test('the font manifest lists every family and weight used', () => {
  const families = capture.fonts.map((f) => f.family);
  assert.ok(families.includes('Georgia'), `families: ${families.join(', ')}`);
  assert.ok(families.includes('Arial'), `families: ${families.join(', ')}`);
  const georgia = capture.fonts.find((f) => f.family === 'Georgia' && !f.italic);
  assert.ok(georgia.weights.includes(700), `Georgia weights: ${georgia.weights.join(', ')}`);
});

/* ------------------------------------------- clipboard + plugin contract */

test('the capture survives the clipboard round trip', async () => {
  const { encodePayload, decodePayload, looksLikePayload } = await import('../../shared/src/payload.ts');

  const snapshot = {
    version: 1,
    generator: 'test',
    source: { url: fixtureUrl, origin: 'file://', title: 'Fixture', capturedAt: new Date().toISOString(), mode: 'page' },
    frames: [{ id: 'f1', label: 'Test', viewportWidth: 1280, theme: 'browser', root: capture.root }],
    assets: capture.assets,
    fonts: capture.fonts,
    stats: { nodes: capture.nodeCount, images: Object.keys(capture.assets).length, bytes: 0, durationMs: 0, warnings: capture.warnings },
  };

  const payload = await encodePayload(snapshot);
  assert.ok(looksLikePayload(payload), 'payload is not recognisable');
  assert.ok(payload.startsWith('C2D1:z'), 'payload was not gzipped');
  // Style-heavy JSON should compress hard; if it does not, the clipboard hurts.
  const raw = JSON.stringify(snapshot).length;
  assert.ok(payload.length < raw / 2, `payload ${payload.length} vs raw ${raw}`);

  const decoded = await decodePayload(payload);
  // JSON drops explicitly-undefined properties, so compare against the same normalisation.
  assert.deepEqual(decoded, JSON.parse(JSON.stringify(snapshot)), 'the snapshot changed crossing the clipboard');
});

test('every node carries the fields the Figma builder reads', () => {
  const NODE_TYPES = new Set(['FRAME', 'TEXT', 'IMAGE', 'SVG']);
  const ALIGN_H = new Set(['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED']);
  const SCALE_MODES = new Set(['FILL', 'FIT', 'CROP', 'TILE']);
  const seenIds = new Set();

  for (const node of all()) {
    assert.ok(NODE_TYPES.has(node.type), `unknown node type ${node.type}`);
    assert.ok(node.id && !seenIds.has(node.id), `duplicate or missing id on ${node.name}`);
    seenIds.add(node.id);
    assert.equal(typeof node.name, 'string');

    for (const paint of [...(node.fills ?? []), ...(node.strokes ?? [])]) {
      if (paint.type === 'SOLID') {
        for (const channel of ['r', 'g', 'b', 'a']) {
          const value = paint.color[channel];
          assert.ok(value >= 0 && value <= 1, `${node.name} colour ${channel}=${value} out of range`);
        }
      } else if (paint.type === 'IMAGE') {
        assert.ok(SCALE_MODES.has(paint.scaleMode), `bad scaleMode ${paint.scaleMode}`);
        assert.ok(capture.assets[paint.assetId], `${node.name} references a missing asset`);
      } else {
        assert.equal(paint.gradientTransform.length, 2, 'gradient transform must be 2x3');
        assert.equal(paint.gradientTransform[0].length, 3);
        assert.ok(paint.gradientStops.length >= 2, 'a gradient needs at least two stops');
        let previous = -1;
        for (const stop of paint.gradientStops) {
          assert.ok(stop.position >= previous, 'gradient stops must not go backwards');
          assert.ok(stop.position >= 0 && stop.position <= 1, `stop ${stop.position} out of range`);
          previous = stop.position;
        }
      }
    }

    for (const effect of node.effects ?? []) {
      assert.ok(effect.radius >= 0, `${node.name} has a negative blur radius`);
      if (effect.type.endsWith('SHADOW')) {
        assert.ok(effect.color && effect.offset, `${node.name} shadow is missing colour or offset`);
      }
    }

    if (node.type === 'TEXT') {
      assert.ok(node.segments.length > 0, `${node.name} has no segments`);
      assert.ok(ALIGN_H.has(node.textAlignHorizontal), `bad alignment ${node.textAlignHorizontal}`);
      for (const segment of node.segments) {
        assert.ok(segment.text.length > 0, 'empty segment');
        assert.ok(segment.fontSize > 0, 'segment has no font size');
        assert.ok(segment.fills.length > 0, 'segment has no fill');
        assert.ok(
          segment.lineHeight === null || segment.lineHeight > 0,
          `bad line height ${segment.lineHeight}`,
        );
      }
    }

    if (node.type === 'FRAME' && node.layout) {
      assert.ok(node.layout.order.length > 0, 'auto layout without an order');
      const childIds = new Set(node.children.map((c) => c.id));
      for (const id of node.layout.order) {
        assert.ok(childIds.has(id), `auto layout order references a node that is not a child (${id})`);
      }
    }
  }
});
