/**
 * Regression cover for the fidelity bug found on a real Tailwind v4 app: every
 * colour was oklch, the string parser could not read it, and the whole page came
 * into Figma with invisible text and no backgrounds or borders.
 *
 * Run with: node --test packages/extension/test/modern-colors.e2e.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '../dist/capture.js');
const fixtureUrl = pathToFileURL(path.join(here, 'modern-colors.html')).href;

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
      sendMessage: async () => ({ kind: 'error', message: 'no assets in this fixture' }),
    },
  };
`;

let browser;
let capture;

test.before(async () => {
  const executablePath = await findChrome();
  assert.ok(executablePath, 'No Chrome or Edge found');
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  await page.addInitScript(CHROME_STUB);
  await page.goto(fixtureUrl, { waitUntil: 'networkidle' });
  await page.addScriptTag({ content: await fs.readFile(bundlePath, 'utf8') });
  capture = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        window.__c2dListener(
          { type: 'c2d-capture-page', request: { mode: 'page', label: 'Colours' } },
          {},
          (r) => (r.ok ? resolve(r.result) : reject(new Error(r.error))),
        );
      }),
  );
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
const byName = (name) => all().find((n) => n.name === name);
const textOf = (node) => node.segments.map((s) => s.text).join('');
const findText = (needle) => all().find((n) => n.type === 'TEXT' && textOf(n).includes(needle));

const to255 = (c) => [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];

/**
 * Independent oracle: the CSS Color 4 oklch -> sRGB conversion, worked out here
 * rather than asked of Chrome or of the capture code. If both agree, the colour
 * really did survive intact.
 */
function oklch(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];

  return linear.map((c) => {
    const encoded = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.abs(c) ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(Math.max(encoded, 0), 1) * 255);
  });
}

function assertRgb(color, expected, label) {
  const actual = to255(color);
  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= 2,
      `${label}: got rgb(${actual}) expected rgb(${expected})`,
    );
  }
}

const solidOf = (node, which = 'fills') => {
  const paint = (node[which] ?? []).find((p) => p.type === 'SOLID');
  assert.ok(paint, `${node.name} has no solid ${which}: ${JSON.stringify(node[which])}`);
  return paint;
};

const textFill = (node) => {
  const paint = node.segments[0].fills.find((p) => p.type === 'SOLID');
  assert.ok(paint, `text "${textOf(node)}" has no solid fill`);
  return paint;
};

/* ------------------------------------------------------------------ tests */

test('oklch text is resolved, not dropped to an invisible layer', () => {
  const active = findText('Dispatch');
  assert.ok(active, 'the oklch-coloured nav label went missing entirely');
  const fill = textFill(active);
  assert.ok((fill.opacity ?? 1) > 0.99, 'oklch text was emitted at zero opacity');
  assertRgb(fill.color, oklch(1, 0, 0), 'oklch(1 0 0) white text');

  const idle = findText('Bookings');
  assertRgb(textFill(idle).color, oklch(0.872, 0.01, 258.338), 'oklch light-grey text');
});

test('oklch backgrounds survive on frames', () => {
  assertRgb(solidOf(byName('nav#nav')).color, oklch(0.13, 0.028, 261.692), 'oklch near-black nav');
  assertRgb(solidOf(byName('span#nav-active')).color, oklch(0.546, 0.245, 262.881), 'oklch blue pill');
});

test('oklch borders survive as strokes', () => {
  const field = byName('span#field');
  assert.ok(field.strokes?.length, 'the oklch border was dropped');
  assertRgb(solidOf(field, 'strokes').color, oklch(0.928, 0.006, 264.531), 'oklch border colour');
  assert.equal(field.strokeWeight, 1);
});

test('lab, lch, color(srgb), display-p3 and color-mix all resolve', () => {
  // color(srgb ...) is exact by definition; the rest only have to come through
  // opaque and in the right part of the spectrum.
  assertRgb(solidOf(byName('div#srgb-box')).color, [51, 102, 153], 'color(srgb) background');

  const lab = textFill(findText('Lab text'));
  assert.ok((lab.opacity ?? 1) > 0.99, 'lab() text was emitted invisible');
  assert.ok(lab.color.r > lab.color.g && lab.color.g > lab.color.b, `lab() looks wrong: ${to255(lab.color)}`);

  const lch = solidOf(byName('div#lch-box')).color;
  assert.ok(lch.g > lch.r && lch.g > lch.b, `lch() should be green: ${to255(lch)}`);

  const mix = solidOf(byName('div#mix-box')).color;
  assert.ok(mix.r > 0.2 && mix.b > 0.5, `color-mix() should be purple: ${to255(mix)}`);

  assertRgb(textFill(findText('HWB text')).color, [51, 170, 230], 'hwb() text');

  // display-p3 is outside sRGB, so it clamps - but it must not vanish.
  const p3 = textFill(findText('Display P3 text'));
  assert.ok((p3.opacity ?? 1) > 0.99, 'display-p3 text was emitted invisible');
  assert.ok(p3.color.r > 0.85 && p3.color.g < 0.35, `display-p3 clamped oddly: ${to255(p3.color)}`);
});

test('deliberately transparent text stays invisible', () => {
  // The fallback must not "rescue" text the page meant to hide.
  const hidden = findText('Invisible on purpose');
  assert.ok(hidden, 'the transparent text node should still exist');
  assert.equal(textFill(hidden).opacity, 0);
});

test('an oklch shadow colour and an oklch gradient both come through', () => {
  const shadowed = byName('div#shadowed');
  const shadow = shadowed.effects?.find((e) => e.type === 'DROP_SHADOW');
  assert.ok(shadow, 'the oklch box-shadow was dropped');
  assertRgb(shadow.color, oklch(0.546, 0.245, 262.881), 'oklch shadow colour');
  assert.ok(Math.abs(shadow.color.a - 0.4) < 0.02, `shadow alpha ${shadow.color.a}`);

  const gradient = (byName('div#gradient').fills ?? []).find((f) => f.type === 'GRADIENT_LINEAR');
  assert.ok(gradient, 'the oklch gradient was dropped');
  assertRgb(gradient.gradientStops[0].color, oklch(0.546, 0.245, 262.881), 'first oklch gradient stop');
  assert.ok(gradient.gradientStops[1].color.r > 0.8, 'second oklch gradient stop looks wrong');
});

test('uppercase small-caps labels keep their colour and transform', () => {
  const label = findText('Pickup time');
  assert.ok(label, 'the uppercase label went missing');
  assert.equal(label.segments[0].textCase, 'UPPER');
  assertRgb(textFill(label).color, oklch(0.551, 0.027, 264.364), 'oklch mid-grey label');
});

test('currentColor in an inline SVG is baked to plain rgb', () => {
  // Figma's SVG importer resolves neither currentColor nor oklch, so the capture
  // has to hand it a literal colour or the icon imports black (or not at all).
  const icon = all().find((n) => n.type === 'SVG');
  assert.ok(icon, 'the inline SVG was not captured');
  assert.ok(!/currentcolor/i.test(icon.svg), `currentColor survived: ${icon.svg}`);
  assert.ok(!/oklch|lab\(|lch\(|color\(/i.test(icon.svg), `an unparseable colour survived: ${icon.svg}`);

  const [r, g, b] = oklch(0.546, 0.245, 262.881);
  assert.ok(
    icon.svg.includes(`rgb(${r}, ${g}, ${b})`),
    `expected rgb(${r}, ${g}, ${b}) baked into the markup, got: ${icon.svg}`,
  );
  // Both the attribute and the inline style should have been rewritten.
  assert.equal((icon.svg.match(/rgb\(/g) ?? []).length, 2, 'only one of the two paints was baked');
});
