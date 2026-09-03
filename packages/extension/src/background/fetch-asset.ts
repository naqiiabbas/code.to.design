/**
 * Image fetching lives in the service worker on purpose: it has host permissions
 * for every origin, so cross-origin images come back as real bytes instead of
 * tainting a canvas the way a page-side fetch would.
 *
 * Nothing here is ever re-compressed lossily. The bytes the site served are
 * handed through untouched whenever Figma can read them, and anything else is
 * decoded and re-encoded as lossless PNG. That costs payload size and buys
 * pixel-exact images that stay sharp however far you zoom in Figma.
 */

export type FetchedAsset =
  | { kind: 'raster'; mime: string; data: string; width: number; height: number }
  | { kind: 'svg'; markup: string; width: number; height: number }
  | { kind: 'error'; message: string };

/** Figma's createImage() accepts PNG, JPEG and GIF only - never WebP or AVIF. */
const FIGMA_SAFE = new Set(['image/png', 'image/jpeg', 'image/gif']);

/** Figma will not accept an image larger than this on either axis. */
export const FIGMA_MAX_DIMENSION = 4096;

export async function fetchAsset(
  url: string,
  maxDimension = FIGMA_MAX_DIMENSION,
  fallbackUrl?: string,
): Promise<FetchedAsset> {
  try {
    const response = await fetchFirstAvailable(url, fallbackUrl);
    if (!response) return { kind: 'error', message: 'The image could not be fetched.' };

    const blob = await response.blob();
    const mime = (blob.type || guessMime(url)).split(';')[0];

    if (mime === 'image/svg+xml') {
      const markup = await blob.text();
      return { kind: 'svg', markup, width: 0, height: 0 };
    }

    const bitmap = await createImageBitmap(blob);
    const limit = Math.min(maxDimension, FIGMA_MAX_DIMENSION);
    const scale = Math.min(1, limit / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    // Nothing to do: hand back the exact bytes, at any size. Re-encoding a JPEG
    // would only add a second generation of loss, and re-encoding a PNG would
    // gain nothing at all.
    if (scale === 1 && FIGMA_SAFE.has(mime)) {
      bitmap.close();
      return { kind: 'raster', mime, data: await blobToBase64(blob), width, height };
    }

    // Either the format is one Figma cannot read (WebP, AVIF) or the image is
    // larger than Figma allows. Decode once, re-encode losslessly.
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return { kind: 'error', message: 'No 2D context available' };
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const out = await canvas.convertToBlob({ type: 'image/png' });
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

/**
 * The caller may ask for a higher-resolution source than the browser itself
 * chose. If that one will not load, fall back to the source actually on the
 * page, so reaching for a sharper image can never cost us the image.
 */
async function fetchFirstAvailable(url: string, fallbackUrl?: string): Promise<Response | null> {
  const candidates = fallbackUrl && fallbackUrl !== url ? [url, fallbackUrl] : [url];
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, { credentials: 'include', cache: 'force-cache' });
      if (response.ok) return response;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
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
