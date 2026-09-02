/**
 * A deliberately strict stand-in for the Figma plugin API.
 *
 * The point is not to simulate Figma but to fail the same way it does: every
 * rule below is one the real API enforces at runtime, and getting any of them
 * wrong is the difference between an import that works and one that throws
 * halfway through building a page.
 */

const PAINT_TYPES = new Set([
  'SOLID', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND', 'IMAGE',
]);
const EFFECT_TYPES = new Set(['DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR', 'BACKGROUND_BLUR']);
const SCALE_MODES = new Set(['FILL', 'FIT', 'CROP', 'TILE']);
const BLEND_MODES = new Set([
  'PASS_THROUGH', 'NORMAL', 'DARKEN', 'MULTIPLY', 'LINEAR_BURN', 'COLOR_BURN', 'LIGHTEN',
  'SCREEN', 'LINEAR_DODGE', 'COLOR_DODGE', 'OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT', 'DIFFERENCE',
  'EXCLUSION', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY',
]);
const AUTO_RESIZE = new Set(['NONE', 'HEIGHT', 'WIDTH_AND_HEIGHT', 'TRUNCATE']);
const ALIGN_H = new Set(['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED']);
const ALIGN_V = new Set(['TOP', 'CENTER', 'BOTTOM']);
const PRIMARY_ALIGN = new Set(['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN']);
const COUNTER_ALIGN = new Set(['MIN', 'CENTER', 'MAX', 'BASELINE']);
const DECORATIONS = new Set(['NONE', 'UNDERLINE', 'STRIKETHROUGH']);
const TEXT_CASES = new Set(['ORIGINAL', 'UPPER', 'LOWER', 'TITLE', 'SMALL_CAPS']);

/** The image formats figma.createImage() actually accepts. */
const IMAGE_MAGIC = [
  { name: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { name: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { name: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
];

/** Roughly what a stock Figma install offers, plus a couple of web staples. */
const AVAILABLE_FONTS = [
  ['Inter', ['Thin', 'Light', 'Regular', 'Medium', 'Semi Bold', 'Bold', 'Extra Bold', 'Black', 'Italic', 'Bold Italic']],
  ['Roboto', ['Thin', 'Light', 'Regular', 'Medium', 'Bold', 'Black', 'Italic', 'Bold Italic']],
  ['Roboto Mono', ['Light', 'Regular', 'Medium', 'Bold']],
  ['Arial', ['Regular', 'Bold', 'Italic', 'Bold Italic']],
  ['Georgia', ['Regular', 'Bold', 'Italic', 'Bold Italic']],
  ['Helvetica', ['Regular', 'Bold', 'Oblique']],
  ['Times New Roman', ['Regular', 'Bold', 'Italic']],
];

export class FigmaViolation extends Error {}

function fail(message) {
  throw new FigmaViolation(message);
}

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a finite number, got ${value}`);
}

function checkColor(color, label) {
  if (!color || typeof color !== 'object') fail(`${label} needs an {r,g,b} colour`);
  for (const channel of ['r', 'g', 'b']) {
    finite(color[channel], `${label}.${channel}`);
    if (color[channel] < 0 || color[channel] > 1) fail(`${label}.${channel} must be 0..1, got ${color[channel]}`);
  }
}

function checkPaints(paints, label, state) {
  if (!Array.isArray(paints)) fail(`${label} must be an array`);
  for (const paint of paints) {
    if (!PAINT_TYPES.has(paint?.type)) fail(`${label}: unknown paint type ${paint?.type}`);
    if (paint.opacity !== undefined) {
      finite(paint.opacity, `${label}.opacity`);
      if (paint.opacity < 0 || paint.opacity > 1) fail(`${label}.opacity must be 0..1, got ${paint.opacity}`);
    }
    if (paint.blendMode !== undefined && !BLEND_MODES.has(paint.blendMode)) {
      fail(`${label}: unknown blend mode ${paint.blendMode}`);
    }
    if (paint.type === 'SOLID') {
      checkColor(paint.color, `${label}.color`);
    } else if (paint.type === 'IMAGE') {
      if (!SCALE_MODES.has(paint.scaleMode)) fail(`${label}: bad scaleMode ${paint.scaleMode}`);
      if (!state.imageHashes.has(paint.imageHash)) fail(`${label}: imageHash was never created`);
    } else {
      const t = paint.gradientTransform;
      if (!Array.isArray(t) || t.length !== 2 || t[0]?.length !== 3 || t[1]?.length !== 3) {
        fail(`${label}: gradientTransform must be a 2x3 matrix`);
      }
      for (const row of t) for (const n of row) finite(n, `${label}.gradientTransform`);
      const determinant = t[0][0] * t[1][1] - t[0][1] * t[1][0];
      if (Math.abs(determinant) < 1e-9) fail(`${label}: gradientTransform is singular`);
      if (!Array.isArray(paint.gradientStops) || paint.gradientStops.length < 2) {
        fail(`${label}: a gradient needs at least two stops`);
      }
      for (const stop of paint.gradientStops) {
        finite(stop.position, `${label} stop position`);
        checkColor(stop.color, `${label} stop colour`);
      }
    }
  }
}

function checkEffects(effects, label) {
  if (!Array.isArray(effects)) fail(`${label} must be an array`);
  for (const effect of effects) {
    if (!EFFECT_TYPES.has(effect?.type)) fail(`${label}: unknown effect type ${effect?.type}`);
    finite(effect.radius, `${label}.radius`);
    if (effect.radius < 0) fail(`${label}.radius must not be negative`);
    if (typeof effect.visible !== 'boolean') fail(`${label}.visible must be set`);
    if (effect.type.endsWith('SHADOW')) {
      checkColor(effect.color, `${label}.color`);
      finite(effect.offset?.x, `${label}.offset.x`);
      finite(effect.offset?.y, `${label}.offset.y`);
      finite(effect.spread, `${label}.spread`);
    }
  }
}

let idCounter = 0;

class BaseNode {
  constructor(type, state) {
    this.type = type;
    this.id = `${type}:${++idCounter}`;
    this.state = state;
    this.name = type;
    this.x = 0;
    this.y = 0;
    this.width = 100;
    this.height = 100;
    this.parent = null;
    this._opacity = 1;
    this._blendMode = 'PASS_THROUGH';
    this._effects = [];
    this._pluginData = {};
    state.created.push(this);
  }

  resizeWithoutConstraints(w, h) {
    finite(w, `${this.name}.resize width`);
    finite(h, `${this.name}.resize height`);
    if (w <= 0 || h <= 0) fail(`${this.name}: resize needs positive dimensions, got ${w}x${h}`);
    this.width = w;
    this.height = h;
  }

  resize(w, h) {
    this.resizeWithoutConstraints(w, h);
  }

  rescale(factor) {
    finite(factor, 'rescale factor');
    if (factor <= 0) fail('rescale needs a positive factor');
    this.width *= factor;
    this.height *= factor;
  }

  set opacity(value) {
    finite(value, `${this.name}.opacity`);
    if (value < 0 || value > 1) fail(`${this.name}.opacity must be 0..1, got ${value}`);
    this._opacity = value;
  }

  get opacity() { return this._opacity; }

  set blendMode(value) {
    if (!BLEND_MODES.has(value)) fail(`${this.name}: unknown blend mode ${value}`);
    this._blendMode = value;
  }

  get blendMode() { return this._blendMode; }

  set effects(value) {
    checkEffects(value, `${this.name}.effects`);
    this._effects = value;
  }

  get effects() { return this._effects; }

  set relativeTransform(value) {
    if (!Array.isArray(value) || value.length !== 2 || value[0].length !== 3) {
      fail(`${this.name}: relativeTransform must be a 2x3 matrix`);
    }
    for (const row of value) for (const n of row) finite(n, `${this.name}.relativeTransform`);
    this._relativeTransform = value;
    this.x = value[0][2];
    this.y = value[1][2];
  }

  get relativeTransform() {
    return this._relativeTransform ?? [[1, 0, this.x], [0, 1, this.y]];
  }

  set rotation(value) {
    finite(value, `${this.name}.rotation`);
    if (value < -180 || value > 180) fail(`${this.name}.rotation must be -180..180, got ${value}`);
    this._rotation = value;
  }

  get rotation() {
    if (this._rotation !== undefined) return this._rotation;
    const [[a], [b]] = this.relativeTransform;
    return (Math.atan2(-b, a) * 180) / Math.PI;
  }

  setPluginData(key, value) {
    if (typeof value !== 'string') fail('setPluginData only stores strings');
    this._pluginData[key] = value;
  }

  getPluginData(key) { return this._pluginData[key] ?? ''; }
}

class ShapeNode extends BaseNode {
  constructor(type, state) {
    super(type, state);
    this._fills = [];
    this._strokes = [];
    this.strokeWeight = 1;
    this.strokeAlign = 'INSIDE';
    this.dashPattern = [];
    this.topLeftRadius = 0;
    this.topRightRadius = 0;
    this.bottomRightRadius = 0;
    this.bottomLeftRadius = 0;
  }

  set fills(value) {
    checkPaints(value, `${this.name}.fills`, this.state);
    this._fills = value;
  }

  get fills() { return this._fills; }

  set strokes(value) {
    checkPaints(value, `${this.name}.strokes`, this.state);
    this._strokes = value;
  }

  get strokes() { return this._strokes; }
}

class FrameNode extends ShapeNode {
  constructor(state) {
    super('FRAME', state);
    this.children = [];
    this.clipsContent = true;
    this._layoutMode = 'NONE';
    this.itemSpacing = 0;
    this.counterAxisSpacing = 0;
    this.paddingTop = 0;
    this.paddingRight = 0;
    this.paddingBottom = 0;
    this.paddingLeft = 0;
    this.layoutWrap = 'NO_WRAP';
    this.primaryAxisSizingMode = 'AUTO';
    this.counterAxisSizingMode = 'AUTO';
  }

  appendChild(child) {
    if (!child) fail(`${this.name}.appendChild got nothing`);
    if (child === this) fail('a node cannot contain itself');
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = this;
    this.children.push(child);
  }

  set layoutMode(value) {
    if (!['NONE', 'HORIZONTAL', 'VERTICAL'].includes(value)) fail(`bad layoutMode ${value}`);
    this._layoutMode = value;
  }

  get layoutMode() { return this._layoutMode; }

  // Real Figma throws when these are set on a frame that is not auto layout.
  set primaryAxisAlignItems(value) {
    if (this._layoutMode === 'NONE') fail('primaryAxisAlignItems needs layoutMode set first');
    if (!PRIMARY_ALIGN.has(value)) fail(`bad primaryAxisAlignItems ${value}`);
    this._primaryAxisAlignItems = value;
  }

  get primaryAxisAlignItems() { return this._primaryAxisAlignItems ?? 'MIN'; }

  set counterAxisAlignItems(value) {
    if (this._layoutMode === 'NONE') fail('counterAxisAlignItems needs layoutMode set first');
    if (!COUNTER_ALIGN.has(value)) fail(`bad counterAxisAlignItems ${value}`);
    this._counterAxisAlignItems = value;
  }

  get counterAxisAlignItems() { return this._counterAxisAlignItems ?? 'MIN'; }
}

class TextNode extends ShapeNode {
  constructor(state) {
    super('TEXT', state);
    this._characters = '';
    this._fontName = { family: 'Inter', style: 'Regular' };
    this.textAutoResize = 'NONE';
    this._ranges = [];
    this.paragraphSpacing = 0;
  }

  set fontName(value) {
    if (!value?.family || !value?.style) fail('fontName needs {family, style}');
    this.state.requireLoaded(value, `${this.name}.fontName`);
    this._fontName = value;
  }

  get fontName() { return this._fontName; }

  set characters(value) {
    // The single most common cause of a failed import.
    this.state.requireLoaded(this._fontName, 'setting characters');
    if (typeof value !== 'string') fail('characters must be a string');
    this._characters = value;
  }

  get characters() { return this._characters; }

  _range(start, end, what) {
    if (!Number.isInteger(start) || !Number.isInteger(end)) fail(`${what}: range must be integers`);
    if (start < 0 || end > this._characters.length || start >= end) {
      fail(`${what}: range ${start}..${end} is outside 0..${this._characters.length}`);
    }
    this._ranges.push({ start, end, what });
  }

  setRangeFontName(start, end, font) {
    this.state.requireLoaded(font, 'setRangeFontName');
    this._range(start, end, 'setRangeFontName');
  }

  setRangeFontSize(start, end, size) {
    finite(size, 'setRangeFontSize');
    if (size <= 0) fail(`setRangeFontSize needs a positive size, got ${size}`);
    this._range(start, end, 'setRangeFontSize');
  }

  setRangeFills(start, end, paints) {
    checkPaints(paints, 'setRangeFills', this.state);
    if (!paints.length) fail('setRangeFills needs at least one paint');
    this._range(start, end, 'setRangeFills');
  }

  setRangeLetterSpacing(start, end, spacing) {
    if (!['PIXELS', 'PERCENT'].includes(spacing?.unit)) fail(`bad letterSpacing unit ${spacing?.unit}`);
    finite(spacing.value, 'letterSpacing value');
    this._range(start, end, 'setRangeLetterSpacing');
  }

  setRangeLineHeight(start, end, lineHeight) {
    if (!['PIXELS', 'PERCENT', 'AUTO'].includes(lineHeight?.unit)) fail(`bad lineHeight unit ${lineHeight?.unit}`);
    if (lineHeight.unit !== 'AUTO') {
      finite(lineHeight.value, 'lineHeight value');
      if (lineHeight.value <= 0) fail(`lineHeight must be positive, got ${lineHeight.value}`);
    }
    this._range(start, end, 'setRangeLineHeight');
  }

  setRangeTextDecoration(start, end, value) {
    if (!DECORATIONS.has(value)) fail(`bad textDecoration ${value}`);
    this._range(start, end, 'setRangeTextDecoration');
  }

  setRangeTextCase(start, end, value) {
    if (!TEXT_CASES.has(value)) fail(`bad textCase ${value}`);
    this._range(start, end, 'setRangeTextCase');
  }

  setRangeHyperlink(start, end, link) {
    if (link !== null && link?.type !== 'URL') fail('hyperlink must be {type:"URL", value}');
    this._range(start, end, 'setRangeHyperlink');
  }

  set textAlignHorizontal(value) {
    if (!ALIGN_H.has(value)) fail(`bad textAlignHorizontal ${value}`);
    this._alignH = value;
  }

  get textAlignHorizontal() { return this._alignH ?? 'LEFT'; }

  set textAlignVertical(value) {
    if (!ALIGN_V.has(value)) fail(`bad textAlignVertical ${value}`);
    this._alignV = value;
  }

  get textAlignVertical() { return this._alignV ?? 'TOP'; }

  set textAutoResize(value) {
    if (!AUTO_RESIZE.has(value)) fail(`bad textAutoResize ${value}`);
    this._autoResize = value;
  }

  get textAutoResize() { return this._autoResize ?? 'NONE'; }
}

export function createFigmaMock({ html = '<html></html>' } = {}) {
  const state = {
    created: [],
    imageHashes: new Set(),
    loadedFonts: new Set(),
    requireLoaded(font, what) {
      const key = `${font.family}__${font.style}`;
      if (!state.loadedFonts.has(key)) {
        fail(`${what}: font "${font.family} ${font.style}" was never loaded with loadFontAsync`);
      }
    },
  };

  const page = new FrameNode(state);
  page.type = 'PAGE';
  page.name = 'Page 1';

  const messages = [];
  const notifications = [];
  const clientStorage = new Map();

  const figma = {
    __state: state,
    __messages: messages,
    __notifications: notifications,

    showUI() {},
    ui: {
      onmessage: null,
      postMessage: (message) => messages.push(message),
    },

    currentPage: page,
    root: { children: [page] },
    viewport: {
      center: { x: 0, y: 0 },
      scrollAndZoomIntoView(nodes) {
        if (!Array.isArray(nodes) || !nodes.length) fail('scrollAndZoomIntoView needs nodes');
      },
    },

    createFrame: () => new FrameNode(state),
    createRectangle: () => new ShapeNode('RECTANGLE', state),
    createText: () => new TextNode(state),

    createImage(bytes) {
      if (!(bytes instanceof Uint8Array) && !ArrayBuffer.isView(bytes)) {
        fail('createImage needs a Uint8Array');
      }
      const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer);
      const match = IMAGE_MAGIC.find((format) =>
        format.bytes.every((byte, i) => view[i] === byte),
      );
      if (!match) {
        fail(
          `createImage only accepts PNG, JPEG or GIF; got bytes starting ${[...view.slice(0, 4)]
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ')}`,
        );
      }
      const hash = `img-${state.imageHashes.size + 1}`;
      state.imageHashes.add(hash);
      return { hash };
    },

    createNodeFromSvg(svg) {
      if (typeof svg !== 'string' || !svg.includes('<svg')) fail('createNodeFromSvg needs SVG markup');
      const frame = new FrameNode(state);
      frame.name = 'svg';
      frame.width = 24;
      frame.height = 24;
      return frame;
    },

    async listAvailableFontsAsync() {
      return AVAILABLE_FONTS.flatMap(([family, styles]) =>
        styles.map((style) => ({ fontName: { family, style } })),
      );
    },

    async loadFontAsync(font) {
      const family = AVAILABLE_FONTS.find(([name]) => name === font.family);
      if (!family || !family[1].includes(font.style)) {
        fail(`loadFontAsync: "${font.family} ${font.style}" is not installed`);
      }
      state.loadedFonts.add(`${font.family}__${font.style}`);
    },

    clientStorage: {
      async getAsync(key) { return clientStorage.get(key); },
      async setAsync(key, value) { clientStorage.set(key, value); },
    },

    notify: (message, options) => notifications.push({ message, options }),
    closePlugin: () => {},
  };

  Object.defineProperty(page, 'selection', {
    set(value) {
      if (!Array.isArray(value)) fail('selection must be an array');
      this._selection = value;
    },
    get() { return this._selection ?? []; },
  });

  return { figma, html, page };
}
