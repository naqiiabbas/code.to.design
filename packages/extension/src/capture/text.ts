import type { Paint, TextSegment } from '@c2d/shared';
import { isVisibleColor, parseGradient, px, resolveColor, solid, splitTopLevel } from './css';

const WHITESPACE_RE = /[\t\n\r\f\v ]+/g;

export interface TextBlock {
  segments: TextSegment[];
  rect: DOMRect;
  textAlignHorizontal: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  paragraphSpacing: number;
}

/** True when the node holds at least one character that survives collapsing. */
export function hasRenderedText(node: Text): boolean {
  const style = node.parentElement ? getComputedStyle(node.parentElement) : null;
  const preserves = style ? /^(pre|pre-wrap|break-spaces)$/.test(style.whiteSpace) : false;
  return preserves ? node.data.length > 0 : node.data.trim().length > 0;
}

export function parseFontStack(fontFamily: string): string[] {
  return splitTopLevel(fontFamily)
    .map((f) => f.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function textCaseOf(transform: string): TextSegment['textCase'] {
  switch (transform) {
    case 'uppercase': return 'UPPER';
    case 'lowercase': return 'LOWER';
    case 'capitalize': return 'TITLE';
    default: return 'ORIGINAL';
  }
}

function decorationOf(style: CSSStyleDeclaration): TextSegment['textDecoration'] {
  const line = style.textDecorationLine || style.textDecoration || '';
  if (line.includes('line-through')) return 'STRIKETHROUGH';
  if (line.includes('underline')) return 'UNDERLINE';
  return 'NONE';
}

/**
 * Text fills. Handles the common `background-clip: text` gradient-heading trick
 * by promoting the element's gradient background onto the text itself.
 */
function fillsOf(style: CSSStyleDeclaration, el: Element): Paint[] {
  const fillColor = style.getPropertyValue('-webkit-text-fill-color') || style.color;
  const clip = style.getPropertyValue('-webkit-background-clip') || style.backgroundClip;
  if (clip === 'text') {
    const rect = el.getBoundingClientRect();
    for (const layer of splitTopLevel(style.backgroundImage)) {
      const gradient = parseGradient(layer, Math.max(rect.width, 1), Math.max(rect.height, 1));
      if (gradient) return [gradient];
    }
  }
  const color = resolveColor(fillColor);
  if (!color) {
    // Chrome handed back something we could not render. Losing the exact shade is
    // far better than emitting an invisible text layer, so fall back to near-black.
    return [solid({ r: 0.07, g: 0.07, b: 0.08, a: 1 })];
  }
  if (!isVisibleColor(color)) {
    // Deliberately transparent text: keep the layer, keep it invisible.
    return [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 0 }];
  }
  return [solid(color)];
}

function lineHeightOf(style: CSSStyleDeclaration): number | null {
  const raw = style.lineHeight;
  if (!raw || raw === 'normal') return null;
  const value = px(raw);
  return value > 0 ? value : null;
}

function letterSpacingOf(style: CSSStyleDeclaration): number {
  const raw = style.letterSpacing;
  if (!raw || raw === 'normal') return 0;
  return px(raw);
}

function segmentStyle(el: Element, text: string, link?: string): TextSegment {
  const style = getComputedStyle(el);
  const stack = parseFontStack(style.fontFamily);
  return {
    text,
    fontFamily: stack[0] || 'Inter',
    fontStack: stack,
    fontWeight: parseInt(style.fontWeight, 10) || 400,
    italic: style.fontStyle === 'italic' || style.fontStyle.startsWith('oblique'),
    fontSize: px(style.fontSize) || 16,
    letterSpacing: letterSpacingOf(style),
    lineHeight: lineHeightOf(style),
    fills: fillsOf(style, el),
    textDecoration: decorationOf(style),
    textCase: textCaseOf(style.textTransform),
    link,
  };
}

function sameStyle(a: TextSegment, b: TextSegment): boolean {
  return (
    a.fontFamily === b.fontFamily &&
    a.fontWeight === b.fontWeight &&
    a.italic === b.italic &&
    a.fontSize === b.fontSize &&
    a.letterSpacing === b.letterSpacing &&
    a.lineHeight === b.lineHeight &&
    a.textDecoration === b.textDecoration &&
    a.textCase === b.textCase &&
    a.link === b.link &&
    JSON.stringify(a.fills) === JSON.stringify(b.fills)
  );
}

/**
 * Collapses whitespace the way CSS does, threading the "previous character was
 * a space" state across segment boundaries so `<b>a</b> <i>b</i>` keeps one gap.
 */
class Collapser {
  private pendingSpace = false;
  private emittedAny = false;

  push(raw: string, preserve: boolean): string {
    if (preserve) {
      this.pendingSpace = false;
      this.emittedAny = this.emittedAny || raw.length > 0;
      return raw;
    }
    const collapsed = raw.replace(WHITESPACE_RE, ' ');
    if (!collapsed) return '';
    let out = collapsed;
    const leading = out.startsWith(' ');
    const trailing = out.endsWith(' ');
    out = out.trim();
    if (!out) {
      if (this.emittedAny) this.pendingSpace = true;
      return '';
    }
    let prefix = '';
    if ((leading || this.pendingSpace) && this.emittedAny) prefix = ' ';
    this.pendingSpace = trailing;
    this.emittedAny = true;
    return prefix + out;
  }
}

/** Nearest ancestor anchor href, so links survive as Figma hyperlinks. */
function linkFor(el: Element | null, stopAt: Element): string | undefined {
  let cursor: Element | null = el;
  while (cursor && cursor !== stopAt.parentElement) {
    if (cursor instanceof HTMLAnchorElement && cursor.href) return cursor.href;
    cursor = cursor.parentElement;
  }
  return undefined;
}

/**
 * Builds the styled segment list for a run of inline nodes. `nodes` must be in
 * document order and share one inline formatting context.
 */
export function buildSegments(nodes: Node[], host: Element): TextSegment[] {
  const collapser = new Collapser();
  const segments: TextSegment[] = [];

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const textNode = node as Text;
      const parent = textNode.parentElement;
      if (!parent) return;
      const style = getComputedStyle(parent);
      const preserve = /^(pre|pre-wrap|break-spaces)$/.test(style.whiteSpace);
      const text = collapser.push(textNode.data, preserve);
      if (!text) return;
      const segment = segmentStyle(parent, text, linkFor(parent, host));
      const last = segments[segments.length - 1];
      if (last && sameStyle(last, segment)) last.text += segment.text;
      else segments.push(segment);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (el.tagName === 'BR') {
      const last = segments[segments.length - 1];
      if (last) last.text += '\n';
      return;
    }
    const style = getComputedStyle(el);
    if (style.display === 'none') return;
    for (const child of Array.from(el.childNodes)) visit(child);
  };

  for (const node of nodes) visit(node);

  // Trim the very ends, which CSS would not paint.
  if (segments.length) {
    segments[0].text = segments[0].text.replace(/^[ ]+/, '');
    const last = segments[segments.length - 1];
    last.text = last.text.replace(/[ ]+$/, '');
  }
  return segments.filter((s) => s.text.length > 0);
}

export function alignmentOf(style: CSSStyleDeclaration): TextBlock['textAlignHorizontal'] {
  switch (style.textAlign) {
    case 'center': return 'CENTER';
    case 'right': return 'RIGHT';
    case 'end': return 'RIGHT';
    case 'justify': return 'JUSTIFIED';
    case 'start': return style.direction === 'rtl' ? 'RIGHT' : 'LEFT';
    default: return 'LEFT';
  }
}

/**
 * Union of the client rects a range paints. Used when inline content sits
 * alongside block content and there is no clean content box to borrow.
 */
export function rangeRect(nodes: Node[]): DOMRect | null {
  let left = Infinity; let top = Infinity; let right = -Infinity; let bottom = -Infinity;
  const range = document.createRange();
  for (const node of nodes) {
    try {
      range.selectNodeContents(node);
    } catch {
      continue;
    }
    for (const r of Array.from(range.getClientRects())) {
      if (r.width === 0 && r.height === 0) continue;
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
  }
  range.detach?.();
  if (!Number.isFinite(left)) return null;
  return new DOMRect(left, top, right - left, bottom - top);
}
