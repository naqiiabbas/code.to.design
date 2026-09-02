import type { Snapshot } from './types';

/**
 * Clipboard payload envelope.
 *
 * The extension copies `C2D1:<base64(gzip(json))>` as plain text. Gzip matters:
 * markup and style data compress ~8-12x, which keeps a full page under the size
 * where pasting into a textarea starts to feel slow.
 */
export const PAYLOAD_PREFIX = 'C2D1:';

const hasCompressionStream = typeof globalThis.CompressionStream === 'function';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunk) as unknown as number[],
    );
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function streamThrough(bytes: Uint8Array, stream: TransformStream): Promise<Uint8Array> {
  // TS models Uint8Array over ArrayBufferLike, which BlobPart will not accept.
  const blob = new Blob([bytes as unknown as BlobPart]);
  const piped = blob.stream().pipeThrough(stream);
  const buf = await new Response(piped).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Base64 is wrapped into lines. Pasting onto the Figma canvas turns the payload
 * into a text layer, and one multi-megabyte "word" is the worst possible input
 * for line breaking; wrapping costs under 1% of size and keeps that cheap.
 */
const LINE_WIDTH = 120;

function wrap(base64: string): string {
  if (base64.length <= LINE_WIDTH) return base64;
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += LINE_WIDTH) {
    lines.push(base64.slice(i, i + LINE_WIDTH));
  }
  return lines.join('\n');
}

export async function encodePayload(snapshot: Snapshot): Promise<string> {
  const json = JSON.stringify(snapshot);
  const raw = new TextEncoder().encode(json);
  if (!hasCompressionStream) return PAYLOAD_PREFIX + 'r\n' + wrap(bytesToBase64(raw));
  const gz = await streamThrough(raw, new CompressionStream('gzip'));
  return PAYLOAD_PREFIX + 'z\n' + wrap(bytesToBase64(gz));
}

export async function decodePayload(text: string): Promise<Snapshot> {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PAYLOAD_PREFIX)) {
    // Tolerate a raw JSON snapshot, which makes hand-testing easy.
    if (trimmed.startsWith('{')) return JSON.parse(trimmed) as Snapshot;
    throw new Error('That does not look like a code.to.design capture.');
  }
  const body = trimmed.slice(PAYLOAD_PREFIX.length);
  const mode = body[0];
  // Strip the line wrapping, plus anything Figma's text layout may have added.
  const bytes = base64ToBytes(body.slice(1).replace(/\s+/g, ''));
  let raw: Uint8Array;
  if (mode === 'z') {
    if (typeof globalThis.DecompressionStream !== 'function') {
      throw new Error('This browser cannot decompress the capture.');
    }
    raw = await streamThrough(bytes, new DecompressionStream('gzip'));
  } else if (mode === 'r') {
    raw = bytes;
  } else {
    throw new Error('Unsupported capture encoding.');
  }
  return JSON.parse(new TextDecoder().decode(raw)) as Snapshot;
}

export function looksLikePayload(text: string): boolean {
  const t = text.trim();
  return t.startsWith(PAYLOAD_PREFIX) || t.startsWith('{"version"');
}
