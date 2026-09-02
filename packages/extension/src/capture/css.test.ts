/**
 * Run with: node --test packages/extension/src/capture/css.test.ts
 *
 * Covers the conversions that are impossible to eyeball: the gradient handle
 * matrix, stop interpolation, shadow parsing and transform decomposition.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decomposeTransform,
  parseBoxShadow,
  parseColor,
  parseGradient,
  splitTopLevel,
} from './css.ts';

/** Figma recovers the gradient handles by inverting gradientTransform. */
function handlesOf(transform: number[][]): [number, number][] {
  const [[a, c, e], [b, d, f]] = transform as [[number, number, number], [number, number, number]];
  const det = a * d - b * c;
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  const ie = -(ia * e + ic * f);
  const iff = -(ib * e + id * f);
  const apply = (x: number, y: number): [number, number] => [ia * x + ic * y + ie, ib * x + id * y + iff];
  return [apply(0, 0), apply(1, 0), apply(0, 1)];
}

/** assert.ok does not narrow a property-access callee, so unwrap explicitly. */
function required<T>(value: T | null | undefined, message: string): T {
  if (value == null) throw new Error(message);
  return value;
}

const near = (actual: number, expected: number, message: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} != ${expected}`);

test('parseColor reads rgb and rgba', () => {
  assert.deepEqual(parseColor('rgb(255, 0, 0)'), { r: 1, g: 0, b: 0, a: 1 });
  const half = parseColor('rgba(0, 0, 0, 0.5)');
  near(half.a, 0.5, 'alpha');
  assert.deepEqual(parseColor('transparent'), { r: 0, g: 0, b: 0, a: 0 });
});

test('splitTopLevel ignores commas inside functions', () => {
  assert.deepEqual(
    splitTopLevel('linear-gradient(rgb(1, 2, 3), rgb(4, 5, 6)), url("a,b.png")'),
    ['linear-gradient(rgb(1, 2, 3), rgb(4, 5, 6))', 'url("a,b.png")'],
  );
});

test('linear gradient to bottom starts at top-centre and ends at bottom-centre', () => {
  const paint = required(
    parseGradient('linear-gradient(to bottom, rgb(255, 0, 0), rgb(0, 0, 255))', 100, 100),
    'no gradient parsed',
  );
  assert.equal(paint.type, 'GRADIENT_LINEAR');
  const [h0, h1] = handlesOf(paint.gradientTransform as unknown as number[][]);
  near(h0[0], 0.5, 'start x');
  near(h0[1], 0, 'start y');
  near(h1[0], 0.5, 'end x');
  near(h1[1], 1, 'end y');
});

test('linear gradient to right runs left to right', () => {
  const paint = required(
    parseGradient('linear-gradient(to right, rgb(0, 0, 0), rgb(255, 255, 255))', 200, 50),
    'no gradient parsed',
  );
  assert.equal(paint.type, 'GRADIENT_LINEAR');
  const [h0, h1] = handlesOf(paint.gradientTransform as unknown as number[][]);
  near(h0[0], 0, 'start x');
  near(h0[1], 0.5, 'start y');
  near(h1[0], 1, 'end x');
  near(h1[1], 0.5, 'end y');
});

test('default direction is to bottom', () => {
  const explicit = parseGradient('linear-gradient(to bottom, rgb(0,0,0), rgb(255,255,255))', 80, 120);
  const implied = parseGradient('linear-gradient(rgb(0,0,0), rgb(255,255,255))', 80, 120);
  assert.deepEqual(implied?.gradientTransform, explicit?.gradientTransform);
});

test('45deg gradient points up and to the right', () => {
  const paint = required(
    parseGradient('linear-gradient(45deg, rgb(0,0,0), rgb(255,255,255))', 100, 100),
    'no gradient parsed',
  );
  assert.equal(paint.type, 'GRADIENT_LINEAR');
  const [h0, h1] = handlesOf(paint.gradientTransform as unknown as number[][]);
  assert.ok(h1[0] > h0[0], 'ends further right');
  assert.ok(h1[1] < h0[1], 'ends further up');
});

test('gradient stops interpolate missing positions', () => {
  const paint = required(
    parseGradient('linear-gradient(to right, rgb(255,0,0), rgb(0,255,0), rgb(0,0,255))', 100, 100),
    'no gradient parsed',
  );
  assert.deepEqual(paint.gradientStops.map((s) => s.position), [0, 0.5, 1]);
});

test('gradient stops honour explicit percentages and stay monotonic', () => {
  const paint = required(
    parseGradient('linear-gradient(to right, rgb(255,0,0) 20%, rgb(0,0,255) 10%)', 100, 100),
    'no gradient parsed',
  );
  assert.deepEqual(paint.gradientStops.map((s) => s.position), [0.2, 0.2]);
});

test('a double-position stop expands into two stops', () => {
  const paint = required(
    parseGradient('linear-gradient(to right, rgb(255,0,0) 0% 40%, rgb(0,0,255) 40% 100%)', 100, 100),
    'no gradient parsed',
  );
  assert.deepEqual(paint.gradientStops.map((s) => s.position), [0, 0.4, 0.4, 1]);
});

test('radial gradient centres its first handle', () => {
  const paint = required(
    parseGradient('radial-gradient(circle at 50% 50%, rgb(255,255,255), rgb(0,0,0))', 100, 100),
    'no gradient parsed',
  );
  assert.equal(paint.type, 'GRADIENT_RADIAL');
  const [h0, h1] = handlesOf(paint.gradientTransform as unknown as number[][]);
  near(h0[0], 0.5, 'centre x');
  near(h0[1], 0.5, 'centre y');
  assert.ok(h1[0] > h0[0], 'radius handle points outward');
});

test('box-shadow parses offsets, blur, spread and inset', () => {
  const shadows = parseBoxShadow('rgba(0, 0, 0, 0.2) 0px 4px 12px -2px, rgb(255, 0, 0) 1px 2px 0px 0px inset');
  assert.equal(shadows.length, 2);
  assert.equal(shadows[0].type, 'DROP_SHADOW');
  assert.deepEqual(shadows[0].offset, { x: 0, y: 4 });
  near(shadows[0].radius, 6, 'blur halved for Figma');
  assert.equal(shadows[0].spread, -2);
  assert.equal(shadows[1].type, 'INNER_SHADOW');
});

test('fully transparent shadows are dropped', () => {
  assert.deepEqual(parseBoxShadow('rgba(0, 0, 0, 0) 0px 4px 12px'), []);
  assert.deepEqual(parseBoxShadow('none'), []);
});

test('transform decomposition flips the rotation direction for Figma', () => {
  // CSS rotate(30deg) is clockwise on screen; Figma counts counter-clockwise.
  const cos = Math.cos(Math.PI / 6);
  const sin = Math.sin(Math.PI / 6);
  const decomposed = decomposeTransform(`matrix(${cos}, ${sin}, ${-sin}, ${cos}, 0, 0)`);
  near(decomposed.rotationDeg, -30, 'rotation');
  near(decomposed.scaleX, 1, 'scale x');
  assert.equal(decomposed.identity, false);
  assert.equal(decomposeTransform('none').identity, true);
});
