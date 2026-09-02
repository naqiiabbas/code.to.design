import type { Snapshot } from '@c2d/shared';
import { PAYLOAD_PREFIX } from '@c2d/shared';
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

/**
 * The UI starts hidden. Pasting on the canvas leaves the payload as a selected
 * text layer, so the common path is: find it, import it, delete it, close -
 * without ever putting a window in front of the user. The panel is only revealed
 * when there is nothing to pick up.
 */
figma.showUI(__html__, { width: 420, height: 560, themeColors: true, visible: false });

/** The text layer the payload arrived on, removed once the import succeeds. */
let pastedNode: TextNode | null = null;
let autoImporting = false;

function carriesPayload(text: string): boolean {
  return text.slice(0, 32).trimStart().startsWith(PAYLOAD_PREFIX);
}

/**
 * Looks for a capture the user pasted onto the canvas. Selection first, since
 * Figma selects whatever it just pasted; then a bounded sweep of recent text
 * layers, matched on layer name (which Figma derives from the text) so a large
 * document is not dragged through `characters` node by node.
 */
function findPastedPayload(): TextNode | null {
  for (const node of figma.currentPage.selection) {
    if (node.type === 'TEXT' && carriesPayload(node.characters)) return node;
  }
  try {
    const texts = figma.currentPage.findAllWithCriteria({ types: ['TEXT'] });
    const floor = Math.max(0, texts.length - 500);
    for (let i = texts.length - 1; i >= floor; i--) {
      const node = texts[i];
      if (node.name.startsWith(PAYLOAD_PREFIX) && carriesPayload(node.characters)) return node;
    }
  } catch {
    /* an unloaded page or a stale node: fall through to the panel */
  }
  return null;
}

(async () => {
  const stored = (await figma.clientStorage.getAsync('options')) as Partial<ImportOptions> | undefined;
  const options = { ...DEFAULT_OPTIONS, ...stored };

  const pasted = findPastedPayload();
  if (pasted) {
    pastedNode = pasted;
    autoImporting = true;
    // The sandbox has no atob or DecompressionStream; the UI decodes for us.
    figma.ui.postMessage({ type: 'auto-import', payload: pasted.characters, options });
    return;
  }

  figma.ui.postMessage({ type: 'ready', options });
  figma.ui.show();
})();

/** Falls back to the panel when the pasted payload turns out to be unusable. */
function reveal(message?: string): void {
  autoImporting = false;
  pastedNode = null;
  figma.ui.show();
  if (message) figma.notify(message, { error: true });
}

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

  if (msg.type === 'reveal') {
    reveal(typeof msg.message === 'string' ? msg.message : undefined);
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

    const summary = `Imported ${report.frames} frame${report.frames === 1 ? '' : 's'} · ${report.layers} layers`;
    if (autoImporting) {
      // Clear the pasted payload layer, then get out of the way entirely.
      try {
        pastedNode?.remove();
      } catch {
        /* the user may have deleted it already */
      }
      figma.notify(summary);
      figma.closePlugin();
      return;
    }
    figma.notify(summary);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    figma.ui.postMessage({ type: 'error', message: detail });
    if (autoImporting) reveal();
    figma.notify(`Import failed: ${detail}`, { error: true });
  }
};
