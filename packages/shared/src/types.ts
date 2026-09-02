/**
 * The capture format shared by the Chrome extension (producer) and the
 * Figma plugin (consumer). Geometry is in CSS pixels; every node's x/y is
 * relative to its parent frame's top-left corner.
 */

export const SNAPSHOT_VERSION = 1 as const;

export interface RGBA {
  r: number; // 0..1
  g: number;
  b: number;
  a: number;
}

export type BlendMode =
  | 'NORMAL' | 'MULTIPLY' | 'SCREEN' | 'OVERLAY' | 'DARKEN' | 'LIGHTEN'
  | 'COLOR_DODGE' | 'COLOR_BURN' | 'HARD_LIGHT' | 'SOFT_LIGHT' | 'DIFFERENCE'
  | 'EXCLUSION' | 'HUE' | 'SATURATION' | 'COLOR' | 'LUMINOSITY';

export interface GradientStop {
  position: number; // 0..1
  color: RGBA;
}

/** Figma's 2x3 affine transform, row-major. */
export type Transform = [[number, number, number], [number, number, number]];

export type SolidPaint = {
  type: 'SOLID';
  color: RGBA;
  opacity?: number;
  blendMode?: BlendMode;
};

export type GradientPaint = {
  type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND';
  gradientTransform: Transform;
  gradientStops: GradientStop[];
  opacity?: number;
  blendMode?: BlendMode;
};

export type ImagePaint = {
  type: 'IMAGE';
  assetId: string;
  scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE';
  /** Only for scaleMode CROP. */
  imageTransform?: Transform;
  /** Only for scaleMode TILE. */
  scalingFactor?: number;
  opacity?: number;
  blendMode?: BlendMode;
};

export type Paint = SolidPaint | GradientPaint | ImagePaint;

export type ShadowEffect = {
  type: 'DROP_SHADOW' | 'INNER_SHADOW';
  color: RGBA;
  offset: { x: number; y: number };
  radius: number;
  spread: number;
  blendMode?: BlendMode;
};

export type BlurEffect = {
  type: 'LAYER_BLUR' | 'BACKGROUND_BLUR';
  radius: number;
};

export type Effect = ShadowEffect | BlurEffect;

export interface Corners {
  tl: number;
  tr: number;
  br: number;
  bl: number;
}

export interface Sides {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface AutoLayout {
  mode: 'HORIZONTAL' | 'VERTICAL';
  primaryAxisAlignItems: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
  counterAxisAlignItems: 'MIN' | 'CENTER' | 'MAX' | 'BASELINE';
  itemSpacing: number;
  padding: Sides;
  wrap: boolean;
  counterAxisSpacing: number;
  /** Children in DOM/flex visual order; ids reference child nodes. */
  order: string[];
}

export interface NodeBase {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, counter-clockwise (Figma convention). */
  rotation?: number;
  opacity?: number;
  blendMode?: BlendMode;
  effects?: Effect[];
  /** Anchor href, applied as a Figma hyperlink / plugin data. */
  link?: string;
  /** CSS selector-ish trail, useful for debugging. */
  trail?: string;
}

export interface BoxStyle {
  fills?: Paint[];
  strokes?: Paint[];
  strokeWeight?: number;
  /** Per-side weights when the CSS border is not uniform. */
  strokeSides?: Sides;
  strokeAlign?: 'INSIDE' | 'OUTSIDE' | 'CENTER';
  strokeDashes?: number[];
  corners?: Corners;
  clipsContent?: boolean;
}

export interface FrameNode extends NodeBase, BoxStyle {
  type: 'FRAME';
  children: SceneNode[];
  layout?: AutoLayout;
}

export interface TextSegment {
  text: string;
  fontFamily: string;
  /** Ordered fallback families straight from `font-family`. */
  fontStack?: string[];
  fontWeight: number;
  italic: boolean;
  fontSize: number;
  /** px */
  letterSpacing: number;
  /** px, or null for "auto" */
  lineHeight: number | null;
  fills: Paint[];
  textDecoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  textCase: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE' | 'SMALL_CAPS';
  link?: string;
}

export interface TextNode extends NodeBase {
  type: 'TEXT';
  segments: TextSegment[];
  textAlignHorizontal: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  textAlignVertical: 'TOP' | 'CENTER' | 'BOTTOM';
  /** Set when the box is a single line so Figma can hug instead of clipping. */
  autoResize?: 'NONE' | 'HEIGHT' | 'WIDTH_AND_HEIGHT';
  paragraphSpacing?: number;
}

export interface ImageNode extends NodeBase, BoxStyle {
  type: 'IMAGE';
  assetId: string;
  scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE';
  /** Original alt/title text, kept as the layer name hint. */
  alt?: string;
}

export interface SvgNode extends NodeBase {
  type: 'SVG';
  svg: string;
}

export type SceneNode = FrameNode | TextNode | ImageNode | SvgNode;

export interface Asset {
  id: string;
  mime: string;
  /** base64, no data: prefix */
  data: string;
  width: number;
  height: number;
  /** Original URL, for debugging + dedupe. */
  src?: string;
}

export type ThemeId = 'browser' | 'light' | 'dark';

export interface CaptureFrame {
  id: string;
  /** e.g. "1440px · Dark" */
  label: string;
  viewportWidth: number;
  theme: ThemeId;
  root: FrameNode;
}

export interface FontRequest {
  family: string;
  weights: number[];
  italic: boolean;
}

export interface Snapshot {
  version: typeof SNAPSHOT_VERSION;
  generator: string;
  source: {
    url: string;
    origin: string;
    title: string;
    capturedAt: string;
    mode: 'page' | 'selection';
  };
  frames: CaptureFrame[];
  assets: Record<string, Asset>;
  fonts: FontRequest[];
  stats: {
    nodes: number;
    images: number;
    bytes: number;
    durationMs: number;
    warnings: string[];
  };
}
