import type { BlendMode, GradientPaint, GradientStop, Paint, RGBA, ShadowEffect, Transform } from '@c2d/shared';

/* ------------------------------------------------------------------ colors */

let normalizerCtx: CanvasRenderingContext2D | null | undefined;

function getNormalizer(): CanvasRenderingContext2D | null {
  if (normalizerCtx === undefined) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    normalizerCtx = canvas.getContext('2d', { willReadFrequently: true });
  }
  return normalizerCtx;
}

const RGB_RE = /^rgba?\(\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)(?:[\s,/]+([-\d.%]+))?\s*\)$/i;

export const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };

/** A page reuses a handful of colours across thousands of nodes. */
const colorCache = new Map<string, RGBA | null>();

/**
 * Paints one pixel in the requested colour and reads it back.
 *
 * String parsing is not enough. `getComputedStyle` hands back `oklch(...)`,
 * `lab(...)`, `oklab(...)` and `color(srgb ...)` verbatim - Tailwind v4's entire
 * default palette is oklch - and canvas `fillStyle` echoes them unchanged too.
 * Rendering a pixel works for every colour space Chrome supports, including ones
 * that do not exist yet, and clamps into sRGB exactly as Figma would.
 */
function measureColor(value: string): RGBA | null {
  const ctx = getNormalizer();
  if (!ctx) return null;

  // An invalid colour leaves fillStyle untouched, so probe from two different
  // starting values and only trust a result both probes agree on.
  ctx.fillStyle = '#010203';
  ctx.fillStyle = value;
  const first = ctx.fillStyle as string;
  ctx.fillStyle = '#040506';
  ctx.fillStyle = value;
  if (first !== (ctx.fillStyle as string)) return null;

  try {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
  } catch {
    return null;
  }
}

/**
 * Resolves any CSS colour, or null when Chrome gave us something unrenderable.
 * Callers that must stay visible (text) can tell "could not resolve" apart from
 * "deliberately transparent".
 */
export function resolveColor(input: string | null | undefined): RGBA | null {
  if (!input) return null;
  const value = input.trim();
  if (!value || value === 'none') return null;
  if (value === 'transparent') return TRANSPARENT;

  const cached = colorCache.get(value);
  if (cached !== undefined) return cached;

  let result: RGBA | null = null;
  const m = RGB_RE.exec(value);
  if (m) {
    // Fast path for the overwhelmingly common case, and it keeps full alpha
    // precision rather than rounding through an 8-bit pixel.
    let a = 1;
    if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    result = {
      r: clamp01(parseFloat(m[1]) / 255),
      g: clamp01(parseFloat(m[2]) / 255),
      b: clamp01(parseFloat(m[3]) / 255),
      a: clamp01(Number.isFinite(a) ? a : 1),
    };
  } else {
    result = measureColor(value);
  }

  colorCache.set(value, result);
  return result;
}

/** Resolves a colour, treating anything unresolvable as fully transparent. */
export function parseColor(input: string | null | undefined): RGBA {
  return resolveColor(input) ?? TRANSPARENT;
}

export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function isVisibleColor(c: RGBA): boolean {
  return c.a > 0.001;
}

/** Figma keeps alpha on the paint, not the color. */
export function solid(color: RGBA): Paint {
  return { type: 'SOLID', color: { r: color.r, g: color.g, b: color.b, a: 1 }, opacity: color.a };
}

/* ------------------------------------------------------------- value lists */

/** Splits "a(1, 2), b(3, 4)" on top-level commas only. */
export function splitTopLevel(value: string, separator = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | null = null;
  for (const ch of value) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '\'') { quote = ch; current += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === separator && depth === 0) { out.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export function px(value: string | null | undefined): number {
  if (!value) return 0;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/* --------------------------------------------------------------- gradients */

interface Mat2x3 { a: number; b: number; c: number; d: number; e: number; f: number }

function invert(m: Mat2x3): Transform {
  const det = m.a * m.d - m.b * m.c;
  if (!det || !Number.isFinite(det)) return [[1, 0, 0], [0, 1, 0]];
  const ia = m.d / det;
  const ib = -m.b / det;
  const ic = -m.c / det;
  const id = m.a / det;
  const ie = -(ia * m.e + ic * m.f);
  const iff = -(ib * m.e + id * m.f);
  return [[ia, ic, ie], [ib, id, iff]];
}

/**
 * Figma derives the gradient handles by inverting `gradientTransform`, so we
 * build the forward matrix from the three handles and invert it. Handles are in
 * the layer's normalized 0..1 space.
 */
function handlesToTransform(
  h0: [number, number],
  h1: [number, number],
  h2: [number, number],
): Transform {
  return invert({
    a: h1[0] - h0[0], b: h1[1] - h0[1],
    c: h2[0] - h0[0], d: h2[1] - h0[1],
    e: h0[0], f: h0[1],
  });
}

const NAMED_ANGLES: Record<string, number> = {
  'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270,
};

function parseAngle(token: string, w: number, h: number): number | null {
  const t = token.trim().toLowerCase().replace(/\s+/g, ' ');
  if (t in NAMED_ANGLES) return NAMED_ANGLES[t];
  if (t.startsWith('to ') && t.split(' ').length === 3) {
    // Corner keywords aim at the corner, so the angle depends on the box ratio.
    const toRight = t.includes('right');
    const toTop = t.includes('top');
    const angle = (Math.atan2(toRight ? w : -w, toTop ? h : -h) * 180) / Math.PI;
    return (angle + 360) % 360;
  }
  const m = /^([-\d.]+)(deg|grad|rad|turn)$/.exec(t);
  if (!m) return null;
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case 'deg': return n;
    case 'grad': return (n * 360) / 400;
    case 'rad': return (n * 180) / Math.PI;
    case 'turn': return n * 360;
  }
  return null;
}

const COLOR_FN = /^(?:rgba?|hsla?|hwb|color|oklch|oklab|lab|lch|var)\(/i;

function parseStops(tokens: string[], boxLength: number): GradientStop[] {
  const raw: { color: RGBA; position: number | null }[] = [];
  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    // Split the colour from its position(s). A stop may declare two positions
    // ("red 0% 40%"), which expands into two stops.
    let colorText = trimmed;
    let rest = '';
    if (COLOR_FN.test(trimmed)) {
      const close = matchingParen(trimmed);
      colorText = trimmed.slice(0, close + 1);
      rest = trimmed.slice(close + 1);
    } else {
      const parts = trimmed.split(/\s+/);
      colorText = parts[0];
      rest = parts.slice(1).join(' ');
    }
    const color = parseColor(colorText);
    const positions = rest.trim() ? rest.trim().split(/\s+/) : [];
    if (positions.length === 0) {
      raw.push({ color, position: null });
    } else {
      for (const p of positions) raw.push({ color, position: readStopPosition(p, boxLength) });
    }
  }
  if (!raw.length) return [];

  // Fill implicit positions the way the CSS images spec does.
  if (raw[0].position === null) raw[0].position = 0;
  if (raw[raw.length - 1].position === null) raw[raw.length - 1].position = 1;
  let lastKnown = 0;
  for (let i = 1; i < raw.length; i++) {
    if (raw[i].position !== null) {
      const gap = i - lastKnown;
      const start = raw[lastKnown].position as number;
      const end = raw[i].position as number;
      for (let j = lastKnown + 1; j < i; j++) {
        raw[j].position = start + ((end - start) * (j - lastKnown)) / gap;
      }
      lastKnown = i;
    }
  }
  let running = 0;
  return raw.map((s) => {
    const position = clamp01(Math.max(running, s.position ?? 0));
    running = position;
    return { position, color: s.color };
  });
}

function matchingParen(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

function readStopPosition(token: string, boxLength: number): number | null {
  const t = token.trim();
  if (t.endsWith('%')) return parseFloat(t) / 100;
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return null;
  return boxLength > 0 ? n / boxLength : 0;
}

/**
 * Converts one CSS gradient function into a Figma gradient paint, or null when
 * the shape is not representable (callers then fall back to a flat colour).
 */
export function parseGradient(value: string, w: number, h: number): GradientPaint | null {
  if (w <= 0 || h <= 0) return null;
  const m = /^(repeating-)?(linear|radial|conic)-gradient\(([\s\S]*)\)$/i.exec(value.trim());
  if (!m) return null;
  const kind = m[2].toLowerCase();
  const args = splitTopLevel(m[3]);
  if (!args.length) return null;

  if (kind === 'linear') {
    let angle = 180; // CSS default is "to bottom"
    let stopTokens = args;
    const maybeAngle = parseAngle(args[0], w, h);
    if (maybeAngle !== null) { angle = maybeAngle; stopTokens = args.slice(1); }

    const rad = (angle * Math.PI) / 180;
    // CSS angles run clockwise from "to top" in a y-down coordinate system.
    const dir: [number, number] = [Math.sin(rad), -Math.cos(rad)];
    const lineLength = Math.abs(w * dir[0]) + Math.abs(h * dir[1]);
    const cx = w / 2;
    const cy = h / 2;
    const p0: [number, number] = [cx - (dir[0] * lineLength) / 2, cy - (dir[1] * lineLength) / 2];
    const p1: [number, number] = [cx + (dir[0] * lineLength) / 2, cy + (dir[1] * lineLength) / 2];
    const p2: [number, number] = [p0[0] - (p1[1] - p0[1]), p0[1] + (p1[0] - p0[0])];

    const stops = parseStops(stopTokens, lineLength);
    if (stops.length < 2) return null;
    return {
      type: 'GRADIENT_LINEAR',
      gradientStops: stops,
      gradientTransform: handlesToTransform(
        [p0[0] / w, p0[1] / h],
        [p1[0] / w, p1[1] / h],
        [p2[0] / w, p2[1] / h],
      ),
    };
  }

  if (kind === 'radial') {
    let stopTokens = args;
    let cx = w / 2;
    let cy = h / 2;
    let rx = Math.hypot(w / 2, h / 2);
    let ry = rx;
    if (/(circle|ellipse|closest|farthest|\sat\s)/i.test(args[0]) || /^[\d.]+(px|%)/.test(args[0])) {
      const spec = args[0];
      const [shapePart, positionPart] = spec.split(/\s+at\s+/i);
      if (positionPart) {
        const tokens = positionPart.trim().split(/\s+/);
        cx = lengthToPx(tokens[0], w);
        cy = lengthToPx(tokens[1] ?? '50%', h);
      }
      const sizes = (shapePart || '').match(/[-\d.]+(?:px|%)/g);
      if (sizes && sizes.length) {
        rx = lengthToPx(sizes[0], w);
        ry = sizes[1] ? lengthToPx(sizes[1], h) : rx;
      } else if (/closest-side/i.test(shapePart)) {
        rx = Math.min(cx, w - cx); ry = Math.min(cy, h - cy);
      } else if (/closest-corner/i.test(shapePart)) {
        rx = ry = Math.hypot(Math.min(cx, w - cx), Math.min(cy, h - cy));
      } else if (/farthest-side/i.test(shapePart)) {
        rx = Math.max(cx, w - cx); ry = Math.max(cy, h - cy);
      } else {
        rx = ry = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
      }
      if (/circle/i.test(shapePart)) { const r = Math.max(rx, ry); rx = r; ry = r; }
      stopTokens = args.slice(1);
    }
    rx = Math.max(rx, 0.001);
    ry = Math.max(ry, 0.001);
    const stops = parseStops(stopTokens, Math.max(rx, ry));
    if (stops.length < 2) return null;
    return {
      type: 'GRADIENT_RADIAL',
      gradientStops: stops,
      gradientTransform: handlesToTransform(
        [cx / w, cy / h],
        [(cx + rx) / w, cy / h],
        [cx / w, (cy + ry) / h],
      ),
    };
  }

  // conic
  let stopTokens = args;
  let cx = w / 2;
  let cy = h / 2;
  if (/^(from\s|at\s)/i.test(args[0])) {
    const positionPart = /at\s+([\s\S]*)$/i.exec(args[0]);
    if (positionPart) {
      const tokens = positionPart[1].trim().split(/\s+/);
      cx = lengthToPx(tokens[0], w);
      cy = lengthToPx(tokens[1] ?? '50%', h);
    }
    stopTokens = args.slice(1);
  }
  const stops = parseStops(stopTokens, 360);
  if (stops.length < 2) return null;
  const r = Math.max(w, h) / 2;
  return {
    type: 'GRADIENT_ANGULAR',
    gradientStops: stops,
    gradientTransform: handlesToTransform(
      [cx / w, cy / h],
      [cx / w, (cy - r) / h],
      [(cx + r) / w, cy / h],
    ),
  };
}

function lengthToPx(token: string, basis: number): number {
  const t = (token || '').trim().toLowerCase();
  if (t === 'left' || t === 'top') return 0;
  if (t === 'center' || t === '') return basis / 2;
  if (t === 'right' || t === 'bottom') return basis;
  if (t.endsWith('%')) return (parseFloat(t) / 100) * basis;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : basis / 2;
}

/* ----------------------------------------------------------------- shadows */

/**
 * A CSS blur radius spans the whole transition band; Figma's radius is about
 * half of that, so shadows keep their weight after import.
 */
export const BLUR_SCALE = 0.5;

const COLOR_TOKEN = /((?:rgba?|hsla?|hwb|color|oklch|oklab|lab|lch)\([^)]*\)|#[0-9a-fA-F]{3,8}|\b[a-z]{3,20}\b(?!\())/;

export function parseBoxShadow(value: string): ShadowEffect[] {
  if (!value || value === 'none') return [];
  const out: ShadowEffect[] = [];
  for (const part of splitTopLevel(value)) {
    const inset = /(^|\s)inset(\s|$)/i.test(part);
    const withoutInset = part.replace(/(^|\s)inset(\s|$)/i, ' ');
    const colorMatch = COLOR_TOKEN.exec(withoutInset);
    const color = colorMatch ? parseColor(colorMatch[1]) : { r: 0, g: 0, b: 0, a: 1 };
    const numbers = (colorMatch ? withoutInset.replace(colorMatch[1], ' ') : withoutInset)
      .match(/-?[\d.]+px/g);
    if (!numbers || numbers.length < 2) continue;
    if (color.a <= 0.001) continue;
    const [ox, oy, blur = '0', spread = '0'] = numbers;
    out.push({
      type: inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
      color,
      offset: { x: px(ox), y: px(oy) },
      radius: Math.max(0, px(blur) * BLUR_SCALE),
      spread: px(spread),
    });
  }
  return out;
}

export function parseFilterBlur(value: string): number {
  if (!value || value === 'none') return 0;
  const m = /blur\(\s*([-\d.]+)px\s*\)/i.exec(value);
  return m ? Math.max(0, parseFloat(m[1]) * BLUR_SCALE) : 0;
}

/* -------------------------------------------------------------- transforms */

export interface DecomposedTransform {
  /** Figma convention: counter-clockwise positive. */
  rotationDeg: number;
  scaleX: number;
  scaleY: number;
  identity: boolean;
}

export function decomposeTransform(value: string): DecomposedTransform {
  const none: DecomposedTransform = { rotationDeg: 0, scaleX: 1, scaleY: 1, identity: true };
  if (!value || value === 'none') return none;
  const m = /^matrix(3d)?\(([^)]+)\)$/i.exec(value.trim());
  if (!m) return none;
  const nums = m[2].split(',').map((n) => parseFloat(n.trim()));
  let a: number; let b: number; let c: number; let d: number;
  if (m[1]) {
    if (nums.length < 16) return none;
    a = nums[0]; b = nums[1]; c = nums[4]; d = nums[5];
  } else {
    if (nums.length < 6) return none;
    a = nums[0]; b = nums[1]; c = nums[2]; d = nums[3];
  }
  const scaleX = Math.hypot(a, b) || 1;
  const scaleY = Math.hypot(c, d) || 1;
  // atan2(b, a) is clockwise-positive in a y-down space; Figma is the opposite.
  const rotationDeg = -((Math.atan2(b, a) * 180) / Math.PI);
  const identity =
    Math.abs(rotationDeg) < 0.01 &&
    Math.abs(scaleX - 1) < 0.001 &&
    Math.abs(scaleY - 1) < 0.001;
  return { rotationDeg, scaleX, scaleY, identity };
}

/* -------------------------------------------------------------- blend mode */

const BLEND_MAP: Record<string, BlendMode> = {
  normal: 'NORMAL', multiply: 'MULTIPLY', screen: 'SCREEN', overlay: 'OVERLAY',
  darken: 'DARKEN', lighten: 'LIGHTEN', 'color-dodge': 'COLOR_DODGE',
  'color-burn': 'COLOR_BURN', 'hard-light': 'HARD_LIGHT', 'soft-light': 'SOFT_LIGHT',
  difference: 'DIFFERENCE', exclusion: 'EXCLUSION', hue: 'HUE',
  saturation: 'SATURATION', color: 'COLOR', luminosity: 'LUMINOSITY',
};

export function parseBlendMode(value: string): BlendMode | undefined {
  const mode = BLEND_MAP[(value || '').trim().toLowerCase()];
  return mode && mode !== 'NORMAL' ? mode : undefined;
}
