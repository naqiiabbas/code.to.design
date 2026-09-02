import { useCallback, useEffect, useRef, useState } from 'react';
import type { Snapshot } from '@c2d/shared';
import { decodePayload, looksLikePayload } from '@c2d/shared';

interface Options {
  autoLayout: boolean;
  groupFrames: boolean;
  keepLinks: boolean;
}

interface Report {
  frames: number;
  layers: number;
  images: number;
  skipped: number;
  substitutions: string[];
  warnings: string[];
}

type Phase =
  | { kind: 'waiting' }
  | { kind: 'loaded'; snapshot: Snapshot; images: Record<string, Uint8Array> }
  | { kind: 'importing'; message: string; ratio: number }
  | { kind: 'done'; report: Report }
  | { kind: 'error'; message: string };

const post = (message: unknown) => parent.postMessage({ pluginMessage: message }, '*');

export function App() {
  const [options, setOptions] = useState<Options>({ autoLayout: true, groupFrames: true, keepLinks: true });
  const [phase, setPhase] = useState<Phase>({ kind: 'waiting' });
  const [dragging, setDragging] = useState(false);
  const pasteRef = useRef<HTMLTextAreaElement>(null);

  /** Decodes a clipboard payload into what the sandbox needs. */
  const decode = useCallback(async (text: string) => {
    const snapshot = await decodePayload(text);
    const images: Record<string, Uint8Array> = {};
    for (const [id, asset] of Object.entries(snapshot.assets ?? {})) {
      images[id] = base64ToBytes(asset.data);
    }
    // The base64 copies would double the message size crossing into the
    // sandbox; the bytes travel separately.
    const lean: Snapshot = {
      ...snapshot,
      assets: Object.fromEntries(
        Object.entries(snapshot.assets ?? {}).map(([id, a]) => [id, { ...a, data: '' }]),
      ),
    };
    return { snapshot: lean, images };
  }, []);

  const load = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      if (!looksLikePayload(text)) {
        setPhase({
          kind: 'error',
          message: 'That is not a code.to.design capture. Capture a page in Chrome first, then paste here.',
        });
        return;
      }
      setPhase({ kind: 'importing', message: 'Reading capture...', ratio: 0.02 });
      try {
        setPhase({ kind: 'loaded', ...(await decode(text)) });
      } catch (err) {
        setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    },
    [decode],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = event.data?.pluginMessage;
      if (!msg) return;
      if (msg.type === 'ready') setOptions(msg.options);
      if (msg.type === 'progress') setPhase({ kind: 'importing', message: msg.message, ratio: msg.ratio });
      if (msg.type === 'done') setPhase({ kind: 'done', report: msg.report });
      if (msg.type === 'error') setPhase({ kind: 'error', message: msg.message });

      if (msg.type === 'auto-import') {
        // A capture was pasted straight onto the canvas. Import it without ever
        // showing this panel; if it will not decode, ask to be revealed.
        setOptions(msg.options);
        setPhase({ kind: 'importing', message: 'Reading pasted capture...', ratio: 0.02 });
        decode(msg.payload)
          .then(({ snapshot, images }) => post({ type: 'import', snapshot, images, options: msg.options }))
          .catch((err) => {
            const detail = err instanceof Error ? err.message : String(err);
            setPhase({ kind: 'error', message: detail });
            post({ type: 'reveal', message: `That pasted layer is not a usable capture: ${detail}` });
          });
      }
    };
    window.addEventListener('message', onMessage);
    pasteRef.current?.focus();
    return () => window.removeEventListener('message', onMessage);
  }, [decode]);

  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      // Reading straight off the clipboard event keeps a multi-megabyte payload
      // out of React state and out of the DOM.
      event.preventDefault();
      void load(event.clipboardData.getData('text'));
    },
    [load],
  );

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files[0];
      if (file) void load(await file.text());
    },
    [load],
  );

  const startImport = () => {
    if (phase.kind !== 'loaded') return;
    post({ type: 'import', snapshot: phase.snapshot, images: phase.images, options });
    setPhase({ kind: 'importing', message: 'Starting...', ratio: 0.01 });
  };

  const update = (patch: Partial<Options>) => {
    const next = { ...options, ...patch };
    setOptions(next);
    post({ type: 'save-options', options: next });
  };

  return (
    <div
      className={`app${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <header>
        <h1>code.to.design</h1>
        <p>
          Paste on the canvas and run this plugin, and it imports without opening. Or paste
          here instead.
        </p>
      </header>

      {phase.kind === 'waiting' && (
        <label className="dropzone">
          <textarea
            ref={pasteRef}
            onPaste={onPaste}
            placeholder="Click here and press Ctrl+V / Cmd+V"
            spellCheck={false}
          />
          <div className="dropzone-hint">
            <strong>Paste your capture</strong>
            <span>or drop a .c2d file here</span>
          </div>
        </label>
      )}

      {phase.kind === 'loaded' && (
        <section className="loaded">
          <div className="meta">
            <strong>{phase.snapshot.source.title || phase.snapshot.source.url}</strong>
            <span>{phase.snapshot.source.url}</span>
            <span>
              {phase.snapshot.frames.length} frame{phase.snapshot.frames.length === 1 ? '' : 's'} ·{' '}
              {phase.snapshot.stats.nodes} layers · {Object.keys(phase.images).length} images
            </span>
            <ul className="frame-list">
              {phase.snapshot.frames.map((frame) => (
                <li key={frame.id}>
                  {frame.label} <em>{Math.round(frame.root.width)}×{Math.round(frame.root.height)}</em>
                </li>
              ))}
            </ul>
          </div>
          <button className="primary" onClick={startImport}>
            Import to canvas
          </button>
          <button className="ghost" onClick={() => setPhase({ kind: 'waiting' })}>
            Paste something else
          </button>
        </section>
      )}

      {phase.kind === 'importing' && (
        <section className="progress">
          <div className="bar">
            <div style={{ width: `${Math.round(phase.ratio * 100)}%` }} />
          </div>
          <span>{phase.message}</span>
        </section>
      )}

      {phase.kind === 'done' && (
        <section className="report">
          <strong>Imported.</strong>
          <span>
            {phase.report.frames} frame{phase.report.frames === 1 ? '' : 's'} · {phase.report.layers} layers ·{' '}
            {phase.report.images} images
            {phase.report.skipped ? ` · ${phase.report.skipped} skipped` : ''}
          </span>
          {phase.report.substitutions.length > 0 && (
            <details>
              <summary>{phase.report.substitutions.length} font substitutions</summary>
              <ul>{phase.report.substitutions.map((s) => <li key={s}>{s}</li>)}</ul>
            </details>
          )}
          {phase.report.warnings.length > 0 && (
            <details>
              <summary>{phase.report.warnings.length} notes</summary>
              <ul>{phase.report.warnings.slice(0, 20).map((w, i) => <li key={i}>{w}</li>)}</ul>
            </details>
          )}
          <button className="primary" onClick={() => setPhase({ kind: 'waiting' })}>
            Import another
          </button>
        </section>
      )}

      {phase.kind === 'error' && (
        <section className="error">
          <strong>Could not import</strong>
          <span>{phase.message}</span>
          <button className="ghost" onClick={() => setPhase({ kind: 'waiting' })}>
            Try again
          </button>
        </section>
      )}

      <footer>
        <label>
          <input
            type="checkbox"
            checked={options.autoLayout}
            onChange={(e) => update({ autoLayout: e.target.checked })}
          />
          Rebuild flex containers as auto layout
        </label>
        <label>
          <input
            type="checkbox"
            checked={options.groupFrames}
            onChange={(e) => update({ groupFrames: e.target.checked })}
          />
          Group all viewports in one frame
        </label>
        <label>
          <input
            type="checkbox"
            checked={options.keepLinks}
            onChange={(e) => update({ keepLinks: e.target.checked })}
          />
          Keep links as hyperlinks
        </label>
      </footer>
    </div>
  );
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
