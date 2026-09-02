import type { TextSegment } from '@c2d/shared';

/**
 * Web fonts and Figma fonts do not line up: the browser has a numeric weight and
 * a family that may not exist in Figma at all. This resolves each requested
 * (family, weight, italic) triple to a font Figma can actually load, caching the
 * answer so a page with thousands of text nodes only pays for it once.
 */

interface FamilyIndex {
  /** Lower-cased style name -> exact style name as Figma spells it. */
  styles: Map<string, string>;
  exactName: string;
}

const WEIGHT_NAMES: Record<number, string[]> = {
  100: ['thin', 'hairline'],
  200: ['extralight', 'extra light', 'ultralight', 'ultra light'],
  300: ['light'],
  400: ['regular', 'normal', 'book', 'roman'],
  500: ['medium'],
  600: ['semibold', 'semi bold', 'demibold', 'demi bold'],
  700: ['bold'],
  800: ['extrabold', 'extra bold', 'ultrabold', 'ultra bold'],
  900: ['black', 'heavy', 'extrablack'],
};

const GENERIC_FALLBACKS: Record<string, string[]> = {
  'sans-serif': ['Inter', 'Roboto', 'Helvetica Neue', 'Arial'],
  'system-ui': ['Inter', 'Roboto', 'Helvetica Neue', 'Arial'],
  '-apple-system': ['Inter', 'Roboto', 'Helvetica Neue', 'Arial'],
  'blinkmacsystemfont': ['Inter', 'Roboto', 'Helvetica Neue', 'Arial'],
  'ui-sans-serif': ['Inter', 'Roboto', 'Arial'],
  serif: ['Georgia', 'Times New Roman', 'Noto Serif', 'Source Serif Pro'],
  'ui-serif': ['Georgia', 'Times New Roman', 'Noto Serif'],
  monospace: ['Roboto Mono', 'Source Code Pro', 'Courier New', 'IBM Plex Mono'],
  'ui-monospace': ['Roboto Mono', 'Source Code Pro', 'Courier New'],
  cursive: ['Comic Sans MS', 'Inter'],
  fantasy: ['Inter'],
  'emoji': ['Inter'],
};

const LAST_RESORT = ['Inter', 'Roboto', 'Arial', 'Helvetica'];

export class FontResolver {
  private families = new Map<string, FamilyIndex>();
  private cache = new Map<string, FontName>();
  private loaded = new Set<string>();
  readonly substitutions = new Map<string, string>();

  async init(): Promise<void> {
    const available = await figma.listAvailableFontsAsync();
    for (const entry of available) {
      const key = entry.fontName.family.toLowerCase();
      let index = this.families.get(key);
      if (!index) {
        index = { styles: new Map(), exactName: entry.fontName.family };
        this.families.set(key, index);
      }
      index.styles.set(entry.fontName.style.toLowerCase(), entry.fontName.style);
    }
  }

  /** Resolves and loads the font for a segment, returning what Figma will use. */
  async fontFor(segment: TextSegment): Promise<FontName> {
    const key = `${segment.fontFamily}|${segment.fontWeight}|${segment.italic}`;
    const cached = this.cache.get(key);
    if (cached) {
      await this.load(cached);
      return cached;
    }

    const candidates = this.familyCandidates(segment);
    let resolved: FontName | null = null;
    for (const family of candidates) {
      const index = this.families.get(family.toLowerCase());
      if (!index) continue;
      const style = this.pickStyle(index, segment.fontWeight, segment.italic);
      if (style) {
        resolved = { family: index.exactName, style };
        if (index.exactName.toLowerCase() !== segment.fontFamily.toLowerCase()) {
          this.substitutions.set(segment.fontFamily, index.exactName);
        }
        break;
      }
    }
    if (!resolved) resolved = { family: 'Inter', style: 'Regular' };

    this.cache.set(key, resolved);
    await this.load(resolved);
    return resolved;
  }

  private familyCandidates(segment: TextSegment): string[] {
    const out: string[] = [];
    const push = (name: string) => {
      if (name && !out.includes(name)) out.push(name);
    };
    push(segment.fontFamily);
    for (const family of segment.fontStack ?? []) {
      const generic = GENERIC_FALLBACKS[family.toLowerCase()];
      if (generic) generic.forEach(push);
      else push(family);
    }
    LAST_RESORT.forEach(push);
    return out;
  }

  private pickStyle(index: FamilyIndex, weight: number, italic: boolean): string | null {
    const bucket = Math.min(900, Math.max(100, Math.round(weight / 100) * 100));
    const order = weightSearchOrder(bucket);

    for (const candidateWeight of order) {
      for (const name of WEIGHT_NAMES[candidateWeight]) {
        if (italic) {
          const withItalic = index.styles.get(`${name} italic`);
          if (withItalic) return withItalic;
          if (name === 'regular') {
            const plainItalic = index.styles.get('italic');
            if (plainItalic) return plainItalic;
          }
        } else {
          const plain = index.styles.get(name);
          if (plain) return plain;
        }
      }
    }
    // Nothing matched by weight: take whatever the family does offer.
    if (italic) {
      for (const [lower, exact] of index.styles) {
        if (lower.includes('italic')) return exact;
      }
    }
    const first = index.styles.values().next();
    return first.done ? null : first.value;
  }

  private async load(font: FontName): Promise<void> {
    const key = `${font.family}__${font.style}`;
    if (this.loaded.has(key)) return;
    try {
      await figma.loadFontAsync(font);
      this.loaded.add(key);
    } catch {
      const fallback: FontName = { family: 'Inter', style: 'Regular' };
      await figma.loadFontAsync(fallback);
      this.loaded.add(`${fallback.family}__${fallback.style}`);
      this.cache.set(key, fallback);
    }
  }
}

/** Nearest-weight search: same, then heavier, then lighter. */
function weightSearchOrder(bucket: number): number[] {
  const all = [100, 200, 300, 400, 500, 600, 700, 800, 900];
  return all.slice().sort((a, b) => {
    const da = Math.abs(a - bucket);
    const db = Math.abs(b - bucket);
    if (da !== db) return da - db;
    return b - a; // prefer the heavier of two equidistant options
  });
}
