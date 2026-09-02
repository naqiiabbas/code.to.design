/**
 * Image fetching lives in the service worker on purpose: it has host permissions
 * for every origin, so cross-origin images come back as real bytes instead of
 * tainting a canvas the way a page-side fetch would.
 */

export type FetchedAsset =
  | { kind: 'raster'; mime: string; data: string; width: number; height: number }
  | { kind: 'svg'; markup: string; width: number; height: number }
  | { kind: 'error'; message: string };

/** Figma's createImage() accepts PNG, JPEG and GIF only - never WebP or AVIF. */
const FIGMA_SAFE = new Set(['image/png', 'image/jpeg', 'image/gif']);

const PNG_REENCODE_THRESHOLD = 400 * 1024;

export async function fetchAsset(url: string, maxDimension = 2400): Promise<FetchedAsset> {
  try {
    const response = await fetch(url, { credentials: 'include', cache: 'force-cache' });
    if (!response.ok) return { kind: 'error', message: `HTTP ${response.status}` };
    const blob = await response.blob();
    const mime = (blob.type || guessMime(url)).split(';')[0];

    if (mime === 'image/svg+xml') {
      const markup = await blob.text();
      return { kind: 'svg', markup, width: 0, height: 0 };
    }

    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const untouched = scale === 1 && FIGMA_SAFE.has(mime);

    if (untouched && blob.size < PNG_REENCODE_THRESHOLD) {
      bitmap.close();
      return { kind: 'raster', mime, data: await blobToBase64(blob), width, height };
    }

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      bitmap.close();
      return { kind: 'error', message: 'No 2D context available' };
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const transparent = hasAlpha(ctx, width, height);
    let out = await canvas.convertToBlob({ type: transparent ? 'image/png' : 'image/jpeg', quality: 0.86 });
    if (transparent && out.size > PNG_REENCODE_THRESHOLD * 2) {
      // Large translucent images are usually photos with a soft edge; PNG is the
      // wrong tool and blows up the clipboard payload.
      const flattened = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
      if (flattened.size < out.size / 2) out = flattened;
    }
    return {
      kind: 'raster',
      mime: out.type || 'image/png',
      data: await blobToBase64(out),
      width,
      height,
    };
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/** Samples the alpha channel; a full scan is wasted work on large images. */
function hasAlpha(ctx: OffscreenCanvasRenderingContext2D, width: number, height: number): boolean {
  try {
    const data = ctx.getImageData(0, 0, width, height).data;
    const stride = Math.max(4, Math.floor(data.length / 4 / 4096) * 4);
    for (let i = 3; i < data.length; i += stride) {
      if (data[i] < 250) return true;
    }
    return false;
  } catch {
    return true;
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode.apply(null, buffer.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(binary);
}

function guessMime(url: string): string {
  const ext = url.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'svg': return 'image/svg+xml';
    case 'webp': return 'image/webp';
    case 'avif': return 'image/avif';
    default: return 'application/octet-stream';
  }
}
