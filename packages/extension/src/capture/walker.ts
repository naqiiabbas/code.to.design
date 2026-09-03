import type {
  AutoLayout,
  BlendMode,
  Corners,
  Effect,
  FrameNode,
  ImageNode,
  Paint,
  SceneNode,
  Sides,
  SvgNode,
  TextNode,
} from '@c2d/shared';
import {
  AssetRegistry,
  canvasToAsset,
  cssUrl,
  videoToAsset,
} from './assets';
import {
  decomposeTransform,
  isVisibleColor,
  parseBlendMode,
  parseBoxShadow,
  parseColor,
  parseFilterBlur,
  parseGradient,
  px,
  resolveColor,
  solid,
  splitTopLevel,
} from './css';
import { alignmentOf, buildSegments, hasRenderedText, rangeRect } from './text';

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD', 'TITLE',
  'BASE', 'PARAM', 'TRACK', 'SOURCE', 'MAP', 'AREA', 'DATALIST', 'DIALOG',
]);

const REPLACED_TAGS = new Set(['IMG', 'CANVAS', 'VIDEO', 'IFRAME', 'EMBED', 'OBJECT', 'INPUT', 'TEXTAREA', 'SELECT']);

let nodeCounter = 0;
const nextId = () => `n${++nodeCounter}`;

export interface WalkOptions {
  registry: AssetRegistry;
  warnings: string[];
  /** Elements the picker asked us to exclude (our own overlay, for example). */
  exclude?: Set<Element>;
}

interface Frame {
  /** Absolute page coordinates of this container's top-left. */
  originX: number;
  originY: number;
}

/** The fields every node carries, before the type-specific ones are added. */
type BaseFields = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  opacity?: number;
  blendMode?: BlendMode;
};

/* ------------------------------------------------------------------ styles */

function cornersOf(style: CSSStyleDeclaration): Corners | undefined {
  const read = (value: string) => Math.max(0, px(value.split(' ')[0]));
  const c: Corners = {
    tl: read(style.borderTopLeftRadius),
    tr: read(style.borderTopRightRadius),
    br: read(style.borderBottomRightRadius),
    bl: read(style.borderBottomLeftRadius),
  };
  return c.tl || c.tr || c.br || c.bl ? c : undefined;
}

function sidesEqual(s: Sides): boolean {
  return s.top === s.right && s.right === s.bottom && s.bottom === s.left;
}

interface StrokeInfo {
  strokes?: Paint[];
  strokeWeight?: number;
  strokeSides?: Sides;
  strokeAlign?: 'INSIDE';
  strokeDashes?: number[];
}

function strokesOf(style: CSSStyleDeclaration): StrokeInfo {
  const sides: Sides = {
    top: style.borderTopStyle === 'none' ? 0 : px(style.borderTopWidth),
    right: style.borderRightStyle === 'none' ? 0 : px(style.borderRightWidth),
    bottom: style.borderBottomStyle === 'none' ? 0 : px(style.borderBottomWidth),
    left: style.borderLeftStyle === 'none' ? 0 : px(style.borderLeftWidth),
  };
  if (!sides.top && !sides.right && !sides.bottom && !sides.left) return {};

  const colors = [
    { w: sides.top, c: parseColor(style.borderTopColor), s: style.borderTopStyle },
    { w: sides.right, c: parseColor(style.borderRightColor), s: style.borderRightStyle },
    { w: sides.bottom, c: parseColor(style.borderBottomColor), s: style.borderBottomStyle },
    { w: sides.left, c: parseColor(style.borderLeftColor), s: style.borderLeftStyle },
  ].filter((e) => e.w > 0 && isVisibleColor(e.c));
  if (!colors.length) return {};

  const first = colors[0];
  const info: StrokeInfo = {
    strokes: [solid(first.c)],
    strokeAlign: 'INSIDE',
  };
  if (sidesEqual(sides)) info.strokeWeight = sides.top;
  else info.strokeSides = sides;

  if (first.s === 'dashed') info.strokeDashes = [Math.max(first.w * 3, 4), Math.max(first.w * 2, 3)];
  else if (first.s === 'dotted') info.strokeDashes = [Math.max(first.w, 1), Math.max(first.w * 2, 2)];
  return info;
}

function backgroundPaints(
  style: CSSStyleDeclaration,
  width: number,
  height: number,
  registry: AssetRegistry,
): Paint[] {
  const fills: Paint[] = [];
  const bg = parseColor(style.backgroundColor);
  if (isVisibleColor(bg)) fills.push(solid(bg));

  const image = style.backgroundImage;
  if (image && image !== 'none') {
    const layers = splitTopLevel(image);
    const sizes = splitTopLevel(style.backgroundSize || 'auto');
    const repeats = splitTopLevel(style.backgroundRepeat || 'repeat');
    // CSS paints the first layer on top; Figma paints the last fill on top.
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      const gradient = parseGradient(layer, width, height);
      if (gradient) { fills.push(gradient); continue; }
      const url = cssUrl(layer);
      if (!url) continue;
      const assetId = registry.request(url);
      if (!assetId) continue;
      const size = (sizes[i] ?? sizes[0] ?? 'auto').trim();
      const repeat = (repeats[i] ?? repeats[0] ?? 'repeat').trim();
      let scaleMode: 'FILL' | 'FIT' | 'TILE' = 'FILL';
      if (size === 'contain') scaleMode = 'FIT';
      else if (size === 'cover') scaleMode = 'FILL';
      else if (repeat.startsWith('repeat')) scaleMode = 'TILE';
      fills.push({ type: 'IMAGE', assetId, scaleMode });
    }
  }
  return fills;
}

function effectsOf(style: CSSStyleDeclaration): Effect[] {
  const effects: Effect[] = [...parseBoxShadow(style.boxShadow)];
  const blur = parseFilterBlur(style.filter);
  if (blur > 0) effects.push({ type: 'LAYER_BLUR', radius: blur });
  const backdrop = parseFilterBlur(style.backdropFilter || (style as any).webkitBackdropFilter || '');
  if (backdrop > 0) effects.push({ type: 'BACKGROUND_BLUR', radius: backdrop });
  return effects;
}

function textShadowEffects(style: CSSStyleDeclaration): Effect[] {
  return parseBoxShadow(style.textShadow).map((s) => ({ ...s, type: 'DROP_SHADOW' as const }));
}

/* ------------------------------------------------------------ auto layout */

function autoLayoutOf(el: Element, style: CSSStyleDeclaration, childIds: string[]): AutoLayout | undefined {
  if (!/^(inline-)?flex$/.test(style.display)) return undefined;
  if (!childIds.length) return undefined;

  const kids = Array.from(el.children).filter((c) => {
    const s = getComputedStyle(c);
    return s.display !== 'none';
  });
  // Figma has no per-child margin and no out-of-flow children inside auto layout.
  for (const kid of kids) {
    const s = getComputedStyle(kid);
    if (s.position === 'absolute' || s.position === 'fixed') return undefined;
    if (px(s.marginTop) || px(s.marginRight) || px(s.marginBottom) || px(s.marginLeft)) return undefined;
    // A CSS transform does not affect the flex slot, but a rotated child does
    // change its bounding box in Figma, which would push its siblings around.
    if (!decomposeTransform(s.transform).identity) return undefined;
  }

  const direction = style.flexDirection || 'row';
  const mode: AutoLayout['mode'] = direction.startsWith('column') ? 'VERTICAL' : 'HORIZONTAL';
  const reversed = direction.endsWith('-reverse');

  const justify = style.justifyContent || 'flex-start';
  const primary: AutoLayout['primaryAxisAlignItems'] =
    justify === 'center' ? 'CENTER'
      : justify === 'flex-end' || justify === 'end' || justify === 'right' ? 'MAX'
        : justify === 'space-between' || justify === 'space-around' || justify === 'space-evenly' ? 'SPACE_BETWEEN'
          : 'MIN';

  const align = style.alignItems || 'stretch';
  const counter: AutoLayout['counterAxisAlignItems'] =
    align === 'center' ? 'CENTER'
      : align === 'flex-end' || align === 'end' ? 'MAX'
        : align === 'baseline' ? 'BASELINE'
          : 'MIN';

  const gapPrimary = mode === 'HORIZONTAL' ? px(style.columnGap) : px(style.rowGap);
  const gapCounter = mode === 'HORIZONTAL' ? px(style.rowGap) : px(style.columnGap);

  return {
    mode,
    primaryAxisAlignItems: primary,
    counterAxisAlignItems: counter,
    itemSpacing: Number.isFinite(gapPrimary) ? gapPrimary : 0,
    counterAxisSpacing: Number.isFinite(gapCounter) ? gapCounter : 0,
    wrap: style.flexWrap === 'wrap' || style.flexWrap === 'wrap-reverse',
    // Figma auto layout measures padding from the frame edge, and an inside
    // stroke sits on top of it, so the border width belongs in the padding.
    padding: {
      top: px(style.paddingTop) + px(style.borderTopWidth),
      right: px(style.paddingRight) + px(style.borderRightWidth),
      bottom: px(style.paddingBottom) + px(style.borderBottomWidth),
      left: px(style.paddingLeft) + px(style.borderLeftWidth),
    },
    order: reversed ? [...childIds].reverse() : childIds,
  };
}

/* -------------------------------------------------------------- classifier */

function isHidden(el: Element, style: CSSStyleDeclaration): boolean {
  if (style.display === 'none') return true;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
  if (style.contentVisibility === 'hidden') return true;
  if (el instanceof HTMLElement && el.hidden) return true;
  return false;
}

/** An inline element whose whole subtree is plain text can be folded into a run. */
function isFoldableInline(el: Element): boolean {
  const style = getComputedStyle(el);
  if (!style.display.startsWith('inline')) return false;
  if (style.display === 'inline-block' || style.display === 'inline-flex' || style.display === 'inline-grid') return false;
  if (isVisibleColor(parseColor(style.backgroundColor))) return false;
  if (style.backgroundImage && style.backgroundImage !== 'none') return false;
  if (style.boxShadow && style.boxShadow !== 'none') return false;
  if (strokesOf(style).strokes) return false;
  if (parseFloat(style.opacity) < 1) return false;
  for (const descendant of Array.from(el.querySelectorAll('*'))) {
    if (REPLACED_TAGS.has(descendant.tagName) || descendant.tagName === 'SVG' || descendant instanceof SVGElement) return false;
    const ds = getComputedStyle(descendant);
    if (ds.display !== 'none' && !ds.display.startsWith('inline')) return false;
  }
  return true;
}

function nameFor(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = (el as HTMLElement).id;
  if (id) return `${tag}#${id}`;
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
  return cls ? `${tag}.${cls}` : tag;
}

function textName(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 30 ? `${clean.slice(0, 30)}...` : clean || 'Text';
}

/* ---------------------------------------------------------------- geometry */

interface Placed {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}

function place(rect: DOMRect, el: Element, style: CSSStyleDeclaration, parent: Frame): Placed {
  const t = decomposeTransform(style.transform);
  if (!t.identity && Math.abs(t.rotationDeg) > 0.01 && el instanceof HTMLElement) {
    // getBoundingClientRect returns the axis-aligned hull of a rotated box, so
    // rebuild the real box from the untransformed size around the same centre.
    const w = el.offsetWidth * t.scaleX;
    const h = el.offsetHeight * t.scaleY;
    const cx = rect.left + rect.width / 2 - parent.originX;
    const cy = rect.top + rect.height / 2 - parent.originY;
    return { x: cx - w / 2, y: cy - h / 2, width: w, height: h, rotation: t.rotationDeg };
  }
  return {
    x: rect.left - parent.originX,
    y: rect.top - parent.originY,
    width: rect.width,
    height: rect.height,
  };
}

/* ------------------------------------------------------------------ walker */

export function walkElement(el: Element, parent: Frame, opts: WalkOptions): SceneNode[] {
  if (opts.exclude?.has(el)) return [];
  if (SKIP_TAGS.has(el.tagName)) return [];

  const style = getComputedStyle(el);
  if (isHidden(el, style)) return [];

  const rect = el.getBoundingClientRect();
  const opacity = parseFloat(style.opacity);
  if (opacity === 0) return [];

  // Zero-sized wrappers still position their (overflowing) children, so hoist
  // the children up rather than emitting an invalid zero-size frame.
  if (rect.width < 0.5 || rect.height < 0.5) {
    const out: SceneNode[] = [];
    for (const child of Array.from(el.children)) out.push(...walkElement(child, parent, opts));
    return out;
  }

  const placed = place(rect, el, style, parent);
  const base: BaseFields = {
    id: nextId(),
    name: nameFor(el),
    x: round(placed.x),
    y: round(placed.y),
    width: round(Math.max(placed.width, 0.5)),
    height: round(Math.max(placed.height, 0.5)),
    ...(placed.rotation ? { rotation: round(placed.rotation) } : {}),
    ...(opacity < 1 ? { opacity } : {}),
    ...(parseBlendMode(style.mixBlendMode) ? { blendMode: parseBlendMode(style.mixBlendMode) } : {}),
  };

  const replaced = replacedNode(el, style, base, opts);
  if (replaced) return [replaced];

  const frame: FrameNode = {
    ...base,
    type: 'FRAME',
    children: [],
    corners: cornersOf(style),
    ...strokesOf(style),
    fills: backgroundPaints(style, base.width, base.height, opts.registry),
    effects: effectsOf(style),
    clipsContent: /hidden|clip|auto|scroll/.test(style.overflow),
  };
  if (!frame.effects?.length) delete frame.effects;
  if (!frame.fills?.length) delete frame.fills;
  if (el instanceof HTMLAnchorElement && el.href) frame.link = el.href;

  const childOrigin: Frame = {
    originX: parent.originX + placed.x,
    originY: parent.originY + placed.y,
  };
  frame.children = walkChildren(el, style, childOrigin, opts);

  const layout = autoLayoutOf(el, style, frame.children.map((c) => c.id));
  if (layout) frame.layout = layout;

  return [frame];
}

/**
 * Splits an element's children into runs of inline text (one TEXT node each)
 * and everything else (recursed), then sorts the result into paint order.
 */
function walkChildren(el: Element, style: CSSStyleDeclaration, origin: Frame, opts: WalkOptions): SceneNode[] {
  const out: SceneNode[] = [];
  // Paint order is tracked per produced node rather than looked up by name:
  // sibling elements very often share a tag and class.
  const paintKey = new Map<string, number>();
  const childNodes = Array.from(el.childNodes);

  const inlineRun: Node[] = [];
  const flushInline = () => {
    if (!inlineRun.length) return;
    const node = buildTextNode(el, style, inlineRun, origin, opts, inlineRun.length === childNodes.length);
    if (node) { out.push(node); paintKey.set(node.id, 0); }
    inlineRun.length = 0;
  };

  for (const child of childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (hasRenderedText(child as Text)) inlineRun.push(child);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const childEl = child as Element;
    if (opts.exclude?.has(childEl)) continue;
    if (SKIP_TAGS.has(childEl.tagName)) continue;
    if (childEl.tagName === 'BR') { inlineRun.push(childEl); continue; }
    const childStyle = getComputedStyle(childEl);
    if (isHidden(childEl, childStyle)) continue;
    if (isFoldableInline(childEl)) { inlineRun.push(childEl); continue; }
    flushInline();
    const key = stackingKey(childStyle);
    for (const node of walkElement(childEl, origin, opts)) {
      out.push(node);
      paintKey.set(node.id, key);
    }
  }
  flushInline();

  for (const { node, key } of pseudoNodes(el, origin, opts)) {
    out.push(node);
    paintKey.set(node.id, key);
  }

  return out
    .map((node, index) => ({ node, index, key: paintKey.get(node.id) ?? 0 }))
    .sort((a, b) => a.key - b.key || a.index - b.index)
    .map((e) => e.node);
}

/**
 * Approximates CSS stacking: negative z-index below, then in-flow content, then
 * positioned elements, then explicit positive z-index.
 */
function stackingKey(style: CSSStyleDeclaration): number {
  const positioned = style.position !== 'static';
  if (style.zIndex === 'auto' || style.zIndex === '') return positioned ? 0.5 : 0;
  return parseInt(style.zIndex, 10) || 0;
}

function buildTextNode(
  host: Element,
  hostStyle: CSSStyleDeclaration,
  nodes: Node[],
  origin: Frame,
  opts: WalkOptions,
  ownsWholeBox: boolean,
): TextNode | null {
  const segments = buildSegments(nodes, host);
  if (!segments.length) return null;

  let x: number; let y: number; let width: number; let height: number;
  if (ownsWholeBox && host instanceof HTMLElement) {
    // The element holds nothing but this text, so its content box is exactly the
    // block of line boxes - the most accurate geometry available.
    const rect = host.getBoundingClientRect();
    const padL = px(hostStyle.paddingLeft) + px(hostStyle.borderLeftWidth);
    const padT = px(hostStyle.paddingTop) + px(hostStyle.borderTopWidth);
    const padR = px(hostStyle.paddingRight) + px(hostStyle.borderRightWidth);
    const padB = px(hostStyle.paddingBottom) + px(hostStyle.borderBottomWidth);
    x = rect.left + padL - origin.originX;
    y = rect.top + padT - origin.originY;
    width = Math.max(rect.width - padL - padR, 1);
    height = Math.max(rect.height - padT - padB, 1);
  } else {
    const measured = rangeRect(nodes);
    if (!measured) return null;
    x = measured.left - origin.originX;
    y = measured.top - origin.originY;
    width = Math.max(measured.width, 1);
    height = Math.max(measured.height, 1);
  }

  const effects = textShadowEffects(hostStyle);
  const lineHeight = segments[0].lineHeight;
  const node: TextNode = {
    type: 'TEXT',
    id: nextId(),
    name: textName(segments.map((s) => s.text).join('')),
    x: round(x),
    y: round(y),
    // A hair of slack absorbs font-metric differences between Chrome and Figma
    // so a line that just fits does not wrap on import.
    width: round(width + 1),
    height: round(height),
    segments,
    textAlignHorizontal: alignmentOf(hostStyle),
    textAlignVertical: 'TOP',
    autoResize: 'NONE',
    paragraphSpacing: 0,
  };
  if (effects.length) node.effects = effects;
  if (lineHeight === null) {
    // Figma's automatic line height is close to Chrome's `normal`; let it hug so
    // a metric mismatch does not clip the last line.
    node.autoResize = 'HEIGHT';
  }
  return node;
}

/* --------------------------------------------------------------- replaced */

function replacedNode(
  el: Element,
  style: CSSStyleDeclaration,
  base: BaseFields,
  opts: WalkOptions,
): SceneNode | null {
  const { registry } = opts;
  const boxStyle = {
    corners: cornersOf(style),
    ...strokesOf(style),
    effects: effectsOf(style).length ? effectsOf(style) : undefined,
  };

  if (el instanceof SVGSVGElement) {
    const svg: SvgNode = { ...base, type: 'SVG', svg: serializeSvg(el) };
    return svg;
  }

  if (el instanceof HTMLImageElement) {
    const src = el.currentSrc || el.src;
    if (!src) return { ...base, type: 'FRAME', children: [], fills: [] } as FrameNode;
    // The browser loads whatever suits the current display; Figma should get
    // the sharpest source on offer, with the loaded one kept as a fallback.
    const assetId = registry.request(bestImageSource(el, src), src);
    if (!assetId) return null;
    const image: ImageNode = {
      ...base,
      type: 'IMAGE',
      assetId,
      scaleMode: objectFitToScaleMode(style.objectFit),
      alt: el.alt || undefined,
      ...boxStyle,
    };
    if (el.alt) image.name = `img · ${textName(el.alt)}`;
    return image;
  }

  if (el instanceof HTMLCanvasElement) {
    const assetId = canvasToAsset(el, registry);
    if (!assetId) {
      opts.warnings.push('A <canvas> could not be read (tainted by cross-origin content).');
      return placeholder(base, 'canvas');
    }
    return { ...base, type: 'IMAGE', assetId, scaleMode: 'FILL', ...boxStyle } as ImageNode;
  }

  if (el instanceof HTMLVideoElement) {
    const assetId = videoToAsset(el, registry);
    if (!assetId) return placeholder(base, 'video');
    return { ...base, type: 'IMAGE', assetId, scaleMode: objectFitToScaleMode(style.objectFit), ...boxStyle } as ImageNode;
  }

  if (el instanceof HTMLIFrameElement || el.tagName === 'EMBED' || el.tagName === 'OBJECT') {
    opts.warnings.push(`Embedded ${el.tagName.toLowerCase()} content cannot be captured; a placeholder was used.`);
    return placeholder(base, el.tagName.toLowerCase());
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return formControl(el, style, base, opts);
  }

  return null;
}

/**
 * Picks the highest-resolution candidate from an <img>'s own srcset.
 *
 * Only `srcset` on the image itself is considered, never `<picture><source>`:
 * those exist for art direction, so a different source can be a deliberately
 * different crop rather than the same picture at another size.
 */
function bestImageSource(img: HTMLImageElement, loaded: string): string {
  const srcset = img.srcset;
  if (!srcset) return loaded;

  const basis = img.naturalWidth || img.width || img.clientWidth || 1;
  let best = loaded;
  let bestScore = img.naturalWidth || basis;

  for (const entry of srcset.split(',')) {
    const parts = entry.trim().split(/s+/);
    if (!parts[0]) continue;
    let url: string;
    try {
      url = new URL(parts[0], document.baseURI).href;
    } catch {
      continue;
    }
    const descriptor = parts[1] ?? '1x';
    const value = parseFloat(descriptor);
    if (!Number.isFinite(value) || value <= 0) continue;
    // Normalise "2x" against the rendered width so it can be compared with "800w".
    const score = descriptor.endsWith('w') ? value : value * basis;
    if (score > bestScore) {
      bestScore = score;
      best = url;
    }
  }
  return best;
}

function objectFitToScaleMode(fit: string): 'FILL' | 'FIT' | 'CROP' | 'TILE' {
  switch (fit) {
    case 'contain':
    case 'scale-down':
    case 'none':
      return 'FIT';
    default:
      return 'FILL';
  }
}

function placeholder(base: BaseFields, label: string): FrameNode {
  return {
    ...base,
    name: `${label} (placeholder)`,
    type: 'FRAME',
    children: [],
    fills: [{ type: 'SOLID', color: { r: 0.93, g: 0.93, b: 0.95, a: 1 }, opacity: 1 }],
    strokes: [{ type: 'SOLID', color: { r: 0.8, g: 0.8, b: 0.85, a: 1 }, opacity: 1 }],
    strokeWeight: 1,
    strokeAlign: 'INSIDE',
    strokeDashes: [4, 4],
  };
}

/**
 * Form controls render their value through shadow DOM, so build the box from the
 * element's own styles and add the visible text as a child.
 */
function formControl(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  style: CSSStyleDeclaration,
  base: BaseFields,
  opts: WalkOptions,
): SceneNode {
  const frame: FrameNode = {
    ...base,
    type: 'FRAME',
    children: [],
    corners: cornersOf(style),
    ...strokesOf(style),
    fills: backgroundPaints(style, base.width, base.height, opts.registry),
    effects: effectsOf(style),
    clipsContent: true,
  };
  if (!frame.effects?.length) delete frame.effects;

  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    if (el.type === 'radio') frame.corners = { tl: 999, tr: 999, br: 999, bl: 999 };
    if (el.checked) {
      frame.fills = [{ type: 'SOLID', color: { r: 0.14, g: 0.39, b: 0.92, a: 1 }, opacity: 1 }];
    }
    return frame;
  }

  const value = el instanceof HTMLSelectElement
    ? (el.selectedOptions[0]?.text ?? '')
    : (el.value || el.placeholder || '');
  if (!value.trim()) return frame;

  const isPlaceholder = !(el as HTMLInputElement).value;
  const color = parseColor(isPlaceholder ? 'rgba(0,0,0,0.45)' : style.color);
  const fontSize = px(style.fontSize) || 14;
  const padL = px(style.paddingLeft) + px(style.borderLeftWidth);
  const padT = px(style.paddingTop) + px(style.borderTopWidth);
  const padR = px(style.paddingRight) + px(style.borderRightWidth);

  frame.children.push({
    id: nextId(),
    name: textName(value),
    x: round(padL),
    y: round(el instanceof HTMLTextAreaElement ? padT : Math.max((base.height - fontSize * 1.4) / 2, padT)),
    width: round(Math.max(base.width - padL - padR, 1)),
    height: round(el instanceof HTMLTextAreaElement ? base.height - padT * 2 : fontSize * 1.4),
    type: 'TEXT',
    segments: [{
      text: value,
      fontFamily: style.fontFamily.split(',')[0].replace(/['"]/g, '').trim() || 'Inter',
      fontWeight: parseInt(style.fontWeight, 10) || 400,
      italic: style.fontStyle === 'italic',
      fontSize,
      letterSpacing: style.letterSpacing === 'normal' ? 0 : px(style.letterSpacing),
      lineHeight: null,
      fills: [solid(color)],
      textDecoration: 'NONE',
      textCase: 'ORIGINAL',
    }],
    textAlignHorizontal: alignmentOf(style),
    textAlignVertical: 'TOP',
    autoResize: 'HEIGHT',
  } satisfies TextNode);

  return frame;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function serializeSvg(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  // Order matters: baking pairs the original and the clone up by index, so it
  // has to happen before anything is added to the clone.
  bakeCurrentColor(svg, clone);
  inlineExternalRefs(svg, clone);
  const rect = svg.getBoundingClientRect();
  if (!clone.getAttribute('viewBox') && rect.width && rect.height) {
    clone.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
  }
  clone.setAttribute('width', String(Math.max(rect.width, 1)));
  clone.setAttribute('height', String(Math.max(rect.height, 1)));
  return new XMLSerializer().serializeToString(clone);
}

/**
 * Icon sprites live once in the document and are pulled in with
 * `<use href="#id">`; gradients, masks and filters are referenced the same way
 * with `url(#id)`. Serialising the `<svg>` on its own leaves those references
 * dangling, and Figma imports an empty or mangled icon. Copy whatever they point
 * at into the markup so it stands alone.
 */
function inlineExternalRefs(original: SVGSVGElement, clone: SVGSVGElement): void {
  const paintedColor = resolveColor(getComputedStyle(original).color);
  const replacement = paintedColor && paintedColor.a > 0.001 ? rgbString(paintedColor) : null;

  // A referenced symbol can itself reference more, so resolve until it settles.
  for (let pass = 0; pass < 4; pass++) {
    const missing = referencedIds(clone).filter((id) => !hasId(clone, id));
    if (!missing.length) return;

    let defs = clone.querySelector('defs');
    if (!defs) {
      defs = document.createElementNS(SVG_NS, 'defs');
      clone.insertBefore(defs, clone.firstChild);
    }

    let added = 0;
    for (const id of missing) {
      const source = document.getElementById(id);
      if (!source) continue;
      const copy = source.cloneNode(true) as Element;
      // The symbol is never rendered itself, so `currentColor` inside it has no
      // computed value to read; use the colour at the point of use.
      if (replacement) {
        for (const el of [copy, ...Array.from(copy.querySelectorAll('*'))]) {
          for (const attr of PAINT_ATTRS) {
            if (/^currentcolor$/i.test(el.getAttribute(attr) ?? '')) el.setAttribute(attr, replacement);
          }
          const style = el.getAttribute('style');
          if (style && /currentcolor/i.test(style)) {
            el.setAttribute('style', style.replace(/currentcolor/gi, replacement));
          }
        }
      }
      defs.appendChild(copy);
      added++;
    }
    if (!added) return;
  }
}

function hasId(root: Element, id: string): boolean {
  if (root.getAttribute('id') === id) return true;
  try {
    return Boolean(root.querySelector(`#${CSS.escape(id)}`));
  } catch {
    return false;
  }
}

/** Every local `#id` an element tree points at, via href or url(#id). */
function referencedIds(root: Element): string[] {
  const ids = new Set<string>();
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attr of Array.from(el.attributes)) {
      const value = attr.value;
      if (!value) continue;
      if ((attr.localName === 'href' || attr.name === 'xlink:href') && value.startsWith('#')) {
        ids.add(value.slice(1));
      }
      for (const match of value.matchAll(/url\(\s*['"]?#([^'")\s]+)/g)) ids.add(match[1]);
    }
  }
  return [...ids];
}

const PAINT_ATTRS = ['fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color'];

/**
 * Icon sets (Lucide, Heroicons, Feather) paint with `currentColor`, which Figma's
 * SVG importer cannot resolve - and the inherited value is often `oklch(...)`,
 * which it cannot read either. Bake each element's real painted colour into the
 * markup as plain rgb.
 */
function bakeCurrentColor(original: SVGSVGElement, clone: SVGSVGElement): void {
  const originals: Element[] = [original, ...Array.from(original.querySelectorAll('*'))];
  const clones: Element[] = [clone, ...Array.from(clone.querySelectorAll('*'))];

  for (let i = 0; i < clones.length && i < originals.length; i++) {
    const source = originals[i];
    const target = clones[i];
    let resolved: string | null | undefined;

    const currentColor = () => {
      if (resolved === undefined) {
        const color = resolveColor(getComputedStyle(source).color);
        resolved = color && color.a > 0.001 ? rgbString(color) : null;
      }
      return resolved;
    };

    for (const attr of PAINT_ATTRS) {
      const value = target.getAttribute(attr);
      if (!value) continue;
      if (/^currentcolor$/i.test(value.trim())) {
        const color = currentColor();
        if (color) target.setAttribute(attr, color);
      } else {
        // Attribute paints can also be oklch/lab, which Figma will not parse.
        const color = resolveColor(value);
        if (color && !/^(#|rgb|none|url\()/i.test(value.trim())) {
          target.setAttribute(attr, rgbString(color));
        }
      }
    }

    const style = target.getAttribute('style');
    if (style && /currentcolor/i.test(style)) {
      const color = currentColor();
      if (color) target.setAttribute('style', style.replace(/currentcolor/gi, color));
    }
  }
}

function rgbString(color: { r: number; g: number; b: number; a: number }): string {
  const to255 = (n: number) => Math.round(Math.min(Math.max(n, 0), 1) * 255);
  return color.a >= 0.999
    ? `rgb(${to255(color.r)}, ${to255(color.g)}, ${to255(color.b)})`
    : `rgba(${to255(color.r)}, ${to255(color.g)}, ${to255(color.b)}, ${Math.round(color.a * 1000) / 1000})`;
}

/* -------------------------------------------------------- pseudo elements */

/**
 * Only absolutely positioned pseudo elements get captured: they are the ones
 * whose geometry can be derived without a layout pass we do not have access to.
 * Inline pseudo content (icon fonts in flow) is reported as a warning instead of
 * guessed at.
 */
function pseudoNodes(el: Element, origin: Frame, opts: WalkOptions): { node: SceneNode; key: number }[] {
  const out: { node: SceneNode; key: number }[] = [];
  for (const which of ['::before', '::after'] as const) {
    let style: CSSStyleDeclaration;
    try {
      style = getComputedStyle(el, which);
    } catch {
      continue;
    }
    const content = style.content;
    if (!content || content === 'none' || content === 'normal') continue;
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    if (style.position !== 'absolute' && style.position !== 'fixed') {
      if (opts.warnings.length < 20) {
        opts.warnings.push(`Skipped an in-flow ${which} on ${nameFor(el)} (its position cannot be measured).`);
      }
      continue;
    }

    const host = el.getBoundingClientRect();
    const w = px(style.width);
    const h = px(style.height);
    if (!(w > 0 && h > 0)) continue;

    const left = style.left !== 'auto' ? px(style.left)
      : style.right !== 'auto' ? host.width - px(style.right) - w
        : 0;
    const top = style.top !== 'auto' ? px(style.top)
      : style.bottom !== 'auto' ? host.height - px(style.bottom) - h
        : 0;

    const base = {
      id: nextId(),
      name: `${nameFor(el)}${which}`,
      x: round(host.left + left - origin.originX),
      y: round(host.top + top - origin.originY),
      width: round(w),
      height: round(h),
    };
    const frame: FrameNode = {
      ...base,
      type: 'FRAME',
      children: [],
      corners: cornersOf(style),
      ...strokesOf(style),
      fills: backgroundPaints(style, w, h, opts.registry),
      effects: effectsOf(style),
    };
    if (!frame.effects?.length) delete frame.effects;

    const literal = /^["']([\s\S]*)["']$/.exec(content);
    if (literal && literal[1]) {
      frame.children.push({
        id: nextId(),
        name: textName(literal[1]),
        x: 0,
        y: 0,
        width: round(w),
        height: round(h),
        type: 'TEXT',
        segments: [{
          text: literal[1],
          fontFamily: style.fontFamily.split(',')[0].replace(/['"]/g, '').trim() || 'Inter',
          fontWeight: parseInt(style.fontWeight, 10) || 400,
          italic: style.fontStyle === 'italic',
          fontSize: px(style.fontSize) || 14,
          letterSpacing: style.letterSpacing === 'normal' ? 0 : px(style.letterSpacing),
          lineHeight: null,
          fills: [solid(parseColor(style.color))],
          textDecoration: 'NONE',
          textCase: 'ORIGINAL',
        }],
        textAlignHorizontal: 'CENTER',
        textAlignVertical: 'CENTER',
        autoResize: 'NONE',
      } satisfies TextNode);
    }
    out.push({ node: frame, key: stackingKey(style) });
  }
  return out;
}

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function resetIds(): void {
  nodeCounter = 0;
}
