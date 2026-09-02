import type { Snapshot } from '@c2d/shared';
import { importSnapshot, type ImportOptions } from './builder';

/**
 * The plugin sandbox has no DOM and no atob/CompressionStream, so the UI iframe
 * decodes the clipboard payload and hands this side a plain snapshot plus raw
 * image bytes.
 */

interface ImportMessage {
  type: 'import';
  snapshot: Snapshot;
  images: Record<string, Uint8Array | number[]>;
  options: ImportOptions;
}

const DEFAULT_OPTIONS: ImportOptions = {
  autoLayout: true,
  groupFrames: true,
  keepLinks: true,
};

figma.showUI(__html__, { width: 420, height: 560, themeColors: true });

(async () => {
  const stored = (await figma.clientStorage.getAsync('options')) as Partial<ImportOptions> | undefined;
  figma.ui.postMessage({ type: 'ready', options: { ...DEFAULT_OPTIONS, ...stored } });
})();

/** Figma transports Uint8Array intact, but tolerate a serializer that does not. */
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return new Uint8Array(value);
  if (value && typeof value === 'object') {
    const indexed = value as Record<string, number>;
    const length = Object.keys(indexed).length;
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = indexed[i] ?? 0;
    return out;
  }
  return new Uint8Array(0);
}

figma.ui.onmessage = async (message: unknown) => {
  if (!message || typeof message !== 'object') return;
  const msg = message as { type: string } & Record<string, unknown>;

  if (msg.type === 'save-options') {
    await figma.clientStorage.setAsync('options', msg.options);
    return;
  }

  if (msg.type === 'close') {
    figma.closePlugin();
    return;
  }

  if (msg.type !== 'import') return;

  const { snapshot, images, options } = msg as unknown as ImportMessage;
  try {
    const bytes: Record<string, Uint8Array> = {};
    for (const [id, value] of Object.entries(images ?? {})) {
      bytes[id] = toBytes(value);
    }

    const report = await importSnapshot(
      snapshot,
      bytes,
      { ...DEFAULT_OPTIONS, ...options },
      (message, ratio) => figma.ui.postMessage({ type: 'progress', message, ratio }),
    );

    figma.ui.postMessage({ type: 'done', report });
    figma.notify(
      `Imported ${report.frames} frame${report.frames === 1 ? '' : 's'} · ${report.layers} layers`,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    figma.ui.postMessage({ type: 'error', message: detail });
    figma.notify(`Import failed: ${detail}`, { error: true });
  }
};
