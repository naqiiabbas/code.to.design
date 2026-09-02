import type { Asset } from '@c2d/shared';

/**
 * Result of asking the service worker to fetch a URL. SVG comes back as markup
 * so the walker can emit a real vector node instead of a raster fill.
 */
export type FetchedAsset =
  | { kind: 'raster'; mime: string; data: string; width: number; height: number }
  | { kind: 'svg'; markup: string; width: number; height: number }
  | { kind: 'error'; message: string };

export interface AssetRequest {
  url: string;
  maxDimension: number;
}

let counter = 0;

/**
 * Collects every image referenced during a walk, deduplicated by URL, and
 * resolves them all in parallel once the DOM pass is done. Fetching happens in
 * the service worker so cross-origin images are not blocked by CORS and never
 * taint a canvas.
 */
export class AssetRegistry {
  private byKey = new Map<string, string>();
  private pending = new Map<string, Promise<FetchedAsset>>();
  readonly assets: Record<string, Asset> = {};
  readonly warnings: string[] = [];

  constructor(private maxDimension = 2400) {}

  /** Returns a stable asset id for a URL, queueing the fetch if it is new. */
  request(url: string): string | null {
    if (!url) return null;
    const key = url;
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const id = `a${++counter}`;
    this.byKey.set(key, id);
    this.pending.set(id, this.load(url));
    return id;
  }

  /** Registers already-decoded bytes (canvas snapshots, video frames). */
  addInline(mime: string, data: string, width: number, height: number, src?: string): string {
    const id = `a${++counter}`;
    this.assets[id] = { id, mime, data, width, height, src };
    return id;
  }

  private async load(url: string): Promise<FetchedAsset> {
    if (url.startsWith('data:')) {
      const parsed = parseDataUrl(url);
      if (parsed) return parsed;
    }
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'fetch-asset',
        url,
        maxDimension: this.maxDimension,
      });
      return (response as FetchedAsset) ?? { kind: 'error', message: 'No response' };
    } catch (err) {
      return { kind: 'error', message: String(err) };
    }
  }

  /** Waits for every queued fetch and returns the ids that failed. */
  async settle(): Promise<{ failed: Set<string>; svg: Map<string, string> }> {
    const failed = new Set<string>();
    const svg = new Map<string, string>();
    const entries = [...this.pending.entries()];
    const results = await Promise.all(entries.map(([, p]) => p));
    const urlById = new Map<string, string>();
    for (const [url, id] of this.byKey) urlById.set(id, url);
    entries.forEach(([id], i) => {
      const result = results[i];
      const url = urlById.get(id);
      if (result.kind === 'raster') {
        this.assets[id] = {
          id,
          mime: result.mime,
          data: result.data,
          width: result.width,
          height: result.height,
          src: url,
        };
      } else if (result.kind === 'svg') {
        svg.set(id, result.markup);
        failed.add(id); // no raster asset was produced
      } else {
        failed.add(id);
        if (this.warnings.length < 20) {
          this.warnings.push(`Could not load image: ${shorten(url ?? '')}`);
        }
      }
    });
    return { failed, svg };
  }
}

function parseDataUrl(url: string): FetchedAsset | null {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(url);
  if (!m) return null;
  const mime = m[1] || 'text/plain';
  const isBase64 = Boolean(m[2]);
  if (mime === 'image/svg+xml') {
    const markup = isBase64 ? atob(m[3]) : decodeURIComponent(m[3]);
    return { kind: 'svg', markup, width: 0, height: 0 };
  }
  if (!isBase64) return null;
  return { kind: 'raster', mime, data: m[3], width: 0, height: 0 };
}

function shorten(url: string): string {
  return url.length > 80 ? `${url.slice(0, 77)}...` : url;
}

/** Pulls the URL out of a computed `background-image` layer. */
export function cssUrl(layer: string): string | null {
  const m = /^url\((['"]?)([\s\S]*?)\1\)$/i.exec(layer.trim());
  return m ? m[2] : null;
}

/** Snapshots a <canvas> in the page. Returns null when the canvas is tainted. */
export function canvasToAsset(
  canvas: HTMLCanvasElement,
  registry: AssetRegistry,
): string | null {
  try {
    const url = canvas.toDataURL('image/png');
    const comma = url.indexOf(',');
    if (comma < 0) return null;
    return registry.addInline('image/png', url.slice(comma + 1), canvas.width, canvas.height);
  } catch {
    return null;
  }
}

/** Grabs the current frame of a <video>, falling back to its poster. */
export function videoToAsset(video: HTMLVideoElement, registry: AssetRegistry): string | null {
  if (video.readyState >= 2 && video.videoWidth > 0) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0);
        return canvasToAsset(canvas, registry);
      }
    } catch {
      /* cross-origin video: fall through to the poster */
    }
  }
  return video.poster ? registry.request(video.poster) : null;
}
