import type {
  Effect as C2DEffect,
  FrameNode as C2DFrame,
  ImageNode as C2DImage,
  Paint as C2DPaint,
  SceneNode as C2DNode,
  ShadowEffect as C2DShadowEffect,
  SvgNode as C2DSvg,
  TextNode as C2DText,
  Snapshot,
} from '@c2d/shared';
import { FontResolver } from './fonts';

export interface ImportOptions {
  /** Rebuild flex containers as Figma auto layout instead of absolute positions. */
  autoLayout: boolean;
  /** Wrap every captured frame in one parent frame on the canvas. */
  groupFrames: boolean;
  /** Keep anchors as Figma hyperlinks. */
  keepLinks: boolean;
}

export interface ImportReport {
  frames: number;
  layers: number;
  images: number;
  skipped: number;
  substitutions: string[];
  warnings: string[];
}

const FRAME_GAP = 160;

export async function importSnapshot(
  snapshot: Snapshot,
  images: Record<string, Uint8Array>,
  options: ImportOptions,
  onProgress: (message: string, ratio: number) => void,
): Promise<ImportReport> {
  const report: ImportReport = {
    frames: 0,
    layers: 0,
    images: 0,
    skipped: 0,
    substitutions: [],
    warnings: [...(snapshot.stats?.warnings ?? [])],
  };

  onProgress('Loading fonts...', 0.05);
  const fonts = new FontResolver();
  await fonts.init();
  // Every font is loaded up front: Figma refuses to set characters on a text
  // node whose font is not loaded, and interleaving loads with node creation
  // makes a large import crawl.
  await preloadFonts(snapshot, fonts);

  onProgress('Decoding images...', 0.2);
  const imageHashes = new Map<string, string>();
  for (const [id, bytes] of Object.entries(images)) {
    try {
      imageHashes.set(id, figma.createImage(bytes).hash);
      report.images++;
    } catch (err) {
      report.warnings.push(`An image could not be decoded and was skipped (${id}).`);
    }
  }

  const ctx: BuildContext = { fonts, imageHashes, options, report };

  const roots: FrameNode[] = [];
  let cursorX = 0;
  for (let i = 0; i < snapshot.frames.length; i++) {
    const captured = snapshot.frames[i];
    onProgress(
      `Building ${captured.label} (${i + 1}/${snapshot.frames.length})...`,
      0.25 + (0.7 * i) / snapshot.frames.length,
    );
    const built = (await buildNode(captured.root, ctx)) as FrameNode | null;
    if (!built) continue;
    built.name = `${snapshot.source.title || 'Capture'} — ${captured.label}`;
    built.x = cursorX;
    built.y = 0;
    cursorX += built.width + FRAME_GAP;
    roots.push(built);
    report.frames++;
  }

  if (!roots.length) throw new Error('The capture contained no frames.');

  onProgress('Placing on canvas...', 0.97);
  const page = figma.currentPage;
  let placed: SceneNode[] = roots;

  if (options.groupFrames && roots.length > 1) {
    const wrapper = figma.createFrame();
    wrapper.name = snapshot.source.title || snapshot.source.url;
    wrapper.fills = [];
    wrapper.clipsContent = false;
    const width = cursorX - FRAME_GAP;
    const height = Math.max(...roots.map((r) => r.height));
    wrapper.resizeWithoutConstraints(Math.max(width, 1), Math.max(height, 1));
    for (const root of roots) wrapper.appendChild(root);
    page.appendChild(wrapper);
    placed = [wrapper];
  } else {
    for (const root of roots) page.appendChild(root);
  }

  positionAtViewport(placed);
  figma.currentPage.selection = placed;
  figma.viewport.scrollAndZoomIntoView(placed);

  for (const [from, to] of ctx.fonts.substitutions) {
    report.substitutions.push(`${from} -> ${to}`);
  }
  return report;
}

interface BuildContext {
  fonts: FontResolver;
  imageHashes: Map<string, string>;
  options: ImportOptions;
  report: ImportReport;
}

async function preloadFonts(snapshot: Snapshot, fonts: FontResolver): Promise<void> {
  const seen = new Set<string>();
  const walk = async (node: C2DNode): Promise<void> => {
    if (node.type === 'TEXT') {
      for (const segment of node.segments) {
        const key = `${segment.fontFamily}|${segment.fontWeight}|${segment.italic}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await fonts.fontFor(segment);
      }
      return;
    }
    if (node.type === 'FRAME') {
      for (const child of node.children) await walk(child);
    }
  };
  for (const frame of snapshot.frames) await walk(frame.root);
}

/* ------------------------------------------------------------------ nodes */

async function buildNode(node: C2DNode, ctx: BuildContext): Promise<SceneNode | null> {
  try {
    switch (node.type) {
      case 'FRAME': return await buildFrame(node, ctx);
      case 'TEXT': return await buildText(node, ctx);
      case 'IMAGE': return buildImage(node, ctx);
      case 'SVG': return buildSvg(node, ctx);
      default: return null;
    }
  } catch (err) {
    ctx.report.skipped++;
    if (ctx.report.warnings.length < 30) {
      ctx.report.warnings.push(`Skipped "${node.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
}

async function buildFrame(node: C2DFrame, ctx: BuildContext): Promise<FrameNode> {
  const frame = figma.createFrame();
  frame.name = node.name;
  frame.fills = [];
  frame.clipsContent = false;
  resize(frame, node.width, node.height);

  applyBoxStyle(frame, node, ctx);
  frame.clipsContent = Boolean(node.clipsContent);

  const children: SceneNode[] = [];
  const byId = new Map<string, SceneNode>();
  for (const childSpec of node.children) {
    const child = await buildNode(childSpec, ctx);
    if (!child) continue;
    children.push(child);
    byId.set(childSpec.id, child);
  }

  const layout = ctx.options.autoLayout ? node.layout : undefined;
  const ordered = layout
    ? layout.order.map((id) => byId.get(id)).filter((c): c is SceneNode => Boolean(c))
        .concat(children.filter((c) => !layout.order.includes(idOf(node, c, byId))))
    : children;

  for (const child of ordered) frame.appendChild(child);

  if (layout) {
    applyAutoLayout(frame, node);
    // Auto layout owns x/y, but it does not touch rotation, which would
    // otherwise be dropped for any transformed child.
    for (const childSpec of node.children) {
      const child = byId.get(childSpec.id);
      if (child && childSpec.rotation && 'rotation' in child) {
        child.rotation = childSpec.rotation;
      }
    }
  } else {
    // Absolute placement: positions were captured relative to this frame.
    for (const childSpec of node.children) {
      const child = byId.get(childSpec.id);
      if (child) placeChild(child, childSpec);
    }
  }

  ctx.report.layers += 1 + children.length;
  return frame;
}

function idOf(parent: C2DFrame, child: SceneNode, byId: Map<string, SceneNode>): string {
  for (const [id, node] of byId) if (node === child) return id;
  return '';
}

function applyAutoLayout(frame: FrameNode, node: C2DFrame): void {
  const layout = node.layout;
  if (!layout) return;
  frame.layoutMode = layout.mode;
  frame.primaryAxisAlignItems = layout.primaryAxisAlignItems;
  frame.counterAxisAlignItems = layout.counterAxisAlignItems;
  frame.itemSpacing = layout.itemSpacing;
  frame.paddingTop = layout.padding.top;
  frame.paddingRight = layout.padding.right;
  frame.paddingBottom = layout.padding.bottom;
  frame.paddingLeft = layout.padding.left;
  try {
    frame.layoutWrap = layout.wrap ? 'WRAP' : 'NO_WRAP';
    if (layout.wrap) frame.counterAxisSpacing = layout.counterAxisSpacing;
  } catch {
    /* older Figma builds have no wrap support */
  }
  // Keep the frame at the size the browser measured rather than letting Figma
  // re-derive it from the children.
  frame.primaryAxisSizingMode = 'FIXED';
  frame.counterAxisSizingMode = 'FIXED';
  resize(frame, node.width, node.height);
}

function placeChild(child: SceneNode, spec: C2DNode): void {
  if (spec.rotation) {
    // Figma's relativeTransform maps node-local coordinates into the parent, so
    // building it directly avoids the ambiguity of setting `rotation` after x/y.
    const angle = (spec.rotation * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const w = child.width;
    const h = child.height;
    const cx = spec.x + spec.width / 2;
    const cy = spec.y + spec.height / 2;
    const tx = cx - (cos * w) / 2 - (sin * h) / 2;
    const ty = cy + (sin * w) / 2 - (cos * h) / 2;
    child.relativeTransform = [
      [cos, sin, tx],
      [-sin, cos, ty],
    ];
    return;
  }
  child.x = spec.x;
  child.y = spec.y;
}

async function buildText(node: C2DText, ctx: BuildContext): Promise<TextNode> {
  const text = figma.createText();
  text.name = node.name;

  const firstFont = await ctx.fonts.fontFor(node.segments[0]);
  text.fontName = firstFont;
  text.characters = node.segments.map((s) => s.text).join('');

  let cursor = 0;
  for (const segment of node.segments) {
    const start = cursor;
    const end = cursor + segment.text.length;
    cursor = end;
    if (end <= start) continue;

    text.setRangeFontName(start, end, await ctx.fonts.fontFor(segment));
    text.setRangeFontSize(start, end, Math.max(segment.fontSize, 1));
    text.setRangeFills(start, end, segment.fills.map((p) => toPaint(p, ctx)).filter(Boolean) as Paint[]);
    text.setRangeLetterSpacing(start, end, { unit: 'PIXELS', value: segment.letterSpacing });
    text.setRangeLineHeight(
      start,
      end,
      segment.lineHeight === null
        ? { unit: 'AUTO' }
        : { unit: 'PIXELS', value: Math.max(segment.lineHeight, 1) },
    );
    text.setRangeTextDecoration(start, end, segment.textDecoration);
    text.setRangeTextCase(start, end, segment.textCase === 'SMALL_CAPS' ? 'ORIGINAL' : segment.textCase);
    if (ctx.options.keepLinks && segment.link) {
      try {
        text.setRangeHyperlink(start, end, { type: 'URL', value: segment.link });
      } catch {
        /* Figma rejects some URL shapes; the text itself is unaffected */
      }
    }
  }

  text.textAlignHorizontal = node.textAlignHorizontal;
  text.textAlignVertical = node.textAlignVertical;
  if (node.paragraphSpacing) text.paragraphSpacing = node.paragraphSpacing;

  text.textAutoResize = node.autoResize ?? 'NONE';
  if (text.textAutoResize === 'NONE') {
    resize(text, node.width, node.height);
  } else if (text.textAutoResize === 'HEIGHT') {
    text.resizeWithoutConstraints(Math.max(node.width, 1), text.height);
  }

  if (node.effects?.length) text.effects = node.effects.map(toEffect);
  if (node.opacity !== undefined) text.opacity = node.opacity;
  if (node.blendMode) text.blendMode = node.blendMode;

  ctx.report.layers++;
  return text;
}

function buildImage(node: C2DImage, ctx: BuildContext): SceneNode | null {
  const hash = ctx.imageHashes.get(node.assetId);
  const rect = figma.createRectangle();
  rect.name = node.name;
  resize(rect, node.width, node.height);
  if (hash) {
    rect.fills = [{ type: 'IMAGE', imageHash: hash, scaleMode: node.scaleMode }];
  } else {
    rect.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.92 }, opacity: 1 }];
  }
  applyBoxStyle(rect, node, ctx, /* skipFills */ true);
  ctx.report.layers++;
  return rect;
}

function buildSvg(node: C2DSvg, ctx: BuildContext): SceneNode | null {
  let created: FrameNode;
  try {
    created = figma.createNodeFromSvg(node.svg);
  } catch {
    ctx.report.skipped++;
    return null;
  }
  created.name = node.name;
  created.fills = [];
  if (created.width > 0 && created.height > 0) {
    // createNodeFromSvg honours the SVG's own size; rescale to the measured box.
    created.rescale(Math.max(node.width / created.width, 0.01));
    resize(created, node.width, node.height);
  }
  if (node.opacity !== undefined) created.opacity = node.opacity;
  if (node.effects?.length) created.effects = node.effects.map(toEffect);
  ctx.report.layers++;
  return created;
}

/* ----------------------------------------------------------------- styles */

type Boxy = FrameNode | RectangleNode;

function applyBoxStyle(
  target: Boxy,
  node: C2DFrame | C2DImage,
  ctx: BuildContext,
  skipFills = false,
): void {
  if (!skipFills) {
    const fills = (node.fills ?? []).map((p) => toPaint(p, ctx)).filter(Boolean) as Paint[];
    target.fills = fills;
  }

  if (node.strokes?.length) {
    const strokes = node.strokes.map((p) => toPaint(p, ctx)).filter(Boolean) as Paint[];
    if (strokes.length) {
      target.strokes = strokes;
      target.strokeAlign = node.strokeAlign ?? 'INSIDE';
      if (node.strokeDashes?.length) target.dashPattern = node.strokeDashes;
      if (node.strokeSides) {
        try {
          target.strokeTopWeight = node.strokeSides.top;
          target.strokeRightWeight = node.strokeSides.right;
          target.strokeBottomWeight = node.strokeSides.bottom;
          target.strokeLeftWeight = node.strokeSides.left;
        } catch {
          target.strokeWeight = Math.max(
            node.strokeSides.top,
            node.strokeSides.right,
            node.strokeSides.bottom,
            node.strokeSides.left,
          );
        }
      } else if (node.strokeWeight !== undefined) {
        target.strokeWeight = Math.max(node.strokeWeight, 0);
      }
    }
  }

  if (node.corners) {
    const max = Math.min(target.width, target.height) / 2;
    target.topLeftRadius = Math.min(node.corners.tl, max);
    target.topRightRadius = Math.min(node.corners.tr, max);
    target.bottomRightRadius = Math.min(node.corners.br, max);
    target.bottomLeftRadius = Math.min(node.corners.bl, max);
  }

  if (node.effects?.length) target.effects = node.effects.map(toEffect);
  if (node.opacity !== undefined) target.opacity = node.opacity;
  if (node.blendMode) target.blendMode = node.blendMode;
  if (ctx.options.keepLinks && 'link' in node && node.link) {
    target.setPluginData('href', node.link);
  }
}

function toPaint(paint: C2DPaint, ctx: BuildContext): Paint | null {
  switch (paint.type) {
    case 'SOLID':
      return {
        type: 'SOLID',
        color: { r: paint.color.r, g: paint.color.g, b: paint.color.b },
        opacity: paint.opacity ?? paint.color.a ?? 1,
        blendMode: paint.blendMode ?? 'NORMAL',
      };

    case 'GRADIENT_LINEAR':
    case 'GRADIENT_RADIAL':
    case 'GRADIENT_ANGULAR':
    case 'GRADIENT_DIAMOND':
      return {
        type: paint.type,
        gradientTransform: paint.gradientTransform as Transform,
        gradientStops: paint.gradientStops.map((stop) => ({
          position: stop.position,
          color: { r: stop.color.r, g: stop.color.g, b: stop.color.b, a: stop.color.a },
        })),
        opacity: paint.opacity ?? 1,
        blendMode: paint.blendMode ?? 'NORMAL',
      };

    case 'IMAGE': {
      const hash = ctx.imageHashes.get(paint.assetId);
      if (!hash) return null;
      const base = {
        type: 'IMAGE' as const,
        imageHash: hash,
        scaleMode: paint.scaleMode,
        opacity: paint.opacity ?? 1,
        blendMode: paint.blendMode ?? ('NORMAL' as BlendMode),
      };
      if (paint.scaleMode === 'TILE') {
        return { ...base, scaleMode: 'TILE', scalingFactor: paint.scalingFactor ?? 1 };
      }
      return base;
    }

    default:
      return null;
  }
}

function toEffect(effect: C2DEffect): Effect {
  if (effect.type === 'LAYER_BLUR' || effect.type === 'BACKGROUND_BLUR') {
    return { type: effect.type, radius: Math.max(effect.radius, 0), visible: true } as Effect;
  }
  // TypeScript cannot drop BlurEffect from the union above because its own
  // `type` is a two-literal union, so name the remaining shape explicitly.
  const shadow = effect as C2DShadowEffect;
  return {
    type: shadow.type,
    color: shadow.color,
    offset: shadow.offset,
    radius: Math.max(shadow.radius, 0),
    spread: shadow.spread,
    visible: true,
    blendMode: shadow.blendMode ?? 'NORMAL',
    showShadowBehindNode: false,
  } as Effect;
}

function resize(node: SceneNode & { resizeWithoutConstraints(w: number, h: number): void }, w: number, h: number): void {
  node.resizeWithoutConstraints(Math.max(w, 0.01), Math.max(h, 0.01));
}

function positionAtViewport(nodes: SceneNode[]): void {
  const center = figma.viewport.center;
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.width));
  const maxY = Math.max(...nodes.map((n) => n.y + n.height));
  const dx = center.x - (minX + maxX) / 2;
  const dy = center.y - (minY + maxY) / 2;
  for (const node of nodes) {
    node.x += dx;
    node.y += dy;
  }
}
