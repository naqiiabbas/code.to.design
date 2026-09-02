import { useEffect, useMemo, useRef, useState } from 'react';
import type { ThemeId } from '@c2d/shared';
import { DesktopIcon, LaptopIcon, MoonIcon, PhoneIcon, SunIcon, TabletIcon } from './icons';

interface ViewportOption {
  id: string;
  width: number; // 0 = current browser window
  icon: 'desktop' | 'laptop' | 'tablet' | 'phone';
  editable: boolean;
}

const DEFAULT_VIEWPORTS: ViewportOption[] = [
  { id: 'browser', width: 0, icon: 'desktop', editable: false },
  { id: 'v1920', width: 1920, icon: 'desktop', editable: true },
  { id: 'v1440', width: 1440, icon: 'laptop', editable: true },
  { id: 'v1024', width: 1024, icon: 'tablet', editable: true },
  { id: 'v768', width: 768, icon: 'tablet', editable: true },
  { id: 'v390', width: 390, icon: 'phone', editable: true },
];

interface Summary {
  frames: number;
  nodes: number;
  images: number;
  bytes: number;
  durationMs: number;
  warnings: string[];
  title: string;
  copied: boolean;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; message: string }
  | { kind: 'done'; summary: Summary }
  | { kind: 'error'; message: string };

const ICONS = { desktop: DesktopIcon, laptop: LaptopIcon, tablet: TabletIcon, phone: PhoneIcon };

export function App() {
  const [viewports, setViewports] = useState<ViewportOption[]>(DEFAULT_VIEWPORTS);
  const [selectedViewports, setSelectedViewports] = useState<string[]>(['browser']);
  const [selectedThemes, setSelectedThemes] = useState<ThemeId[]>(['browser']);
  const [browserWidth, setBrowserWidth] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [hasPayload, setHasPayload] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.width) setBrowserWidth(tab.width);
      const stored = await chrome.storage.local.get(['ui']);
      const ui = stored.ui as
        | { viewports?: ViewportOption[]; selectedViewports?: string[]; selectedThemes?: ThemeId[] }
        | undefined;
      if (ui?.viewports?.length) setViewports(ui.viewports);
      if (ui?.selectedViewports?.length) setSelectedViewports(ui.selectedViewports);
      if (ui?.selectedThemes?.length) setSelectedThemes(ui.selectedThemes);
      const last = await chrome.runtime.sendMessage({ type: 'get-last' });
      setHasPayload(Boolean(last?.hasPayload));
      loaded.current = true;
    })();
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    chrome.storage.local.set({ ui: { viewports, selectedViewports, selectedThemes } });
  }, [viewports, selectedViewports, selectedThemes]);

  const needsDebugger = useMemo(
    () => selectedViewports.some((id) => id !== 'browser') || selectedThemes.some((t) => t !== 'browser'),
    [selectedViewports, selectedThemes],
  );

  const toggleViewport = (id: string) => {
    setSelectedViewports((prev) =>
      prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id],
    );
  };

  const toggleTheme = (theme: ThemeId) => {
    setSelectedThemes((prev) =>
      prev.includes(theme) ? prev.filter((t) => t !== theme) : [...prev, theme],
    );
  };

  const setWidth = (id: string, width: number) => {
    setViewports((prev) => prev.map((v) => (v.id === id ? { ...v, width } : v)));
  };

  async function capture(mode: 'page' | 'selection') {
    const chosen = selectedViewports.length ? selectedViewports : ['browser'];
    const themes = selectedThemes.length ? selectedThemes : (['browser'] as ThemeId[]);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setStatus({ kind: 'error', message: 'No active tab.' });
      return;
    }

    setStatus({
      kind: 'working',
      message: mode === 'selection' ? 'Pick an element on the page...' : 'Capturing...',
    });

    const options = {
      mode,
      viewports: chosen.map((id) => viewports.find((v) => v.id === id)?.width ?? 0),
      themes,
      maxImageDimension: 2400,
    };

    if (mode === 'selection') {
      // The popup is about to close as soon as the page takes focus, so hand the
      // work to the service worker and let the badge report the result.
      chrome.runtime.sendMessage({ type: 'capture', tabId: tab.id, options });
      setTimeout(() => window.close(), 80);
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({ type: 'capture', tabId: tab.id, options });
      if (response?.ok) {
        setStatus({ kind: 'done', summary: response.summary });
        setHasPayload(true);
      } else {
        setStatus({ kind: 'error', message: response?.error ?? 'Capture failed.' });
      }
    } catch (err) {
      // A dead service worker rejects instead of answering; without this the
      // popup would sit on "Capturing..." forever.
      const detail = err instanceof Error ? err.message : String(err);
      setStatus({
        kind: 'error',
        message: detail.includes('Receiving end does not exist')
          ? 'The extension’s background worker is not running. Reload the extension on chrome://extensions and try again.'
          : detail,
      });
    }
  }

  async function recopy() {
    const response = await chrome.runtime.sendMessage({ type: 'recopy' });
    if (!response?.ok) setStatus({ kind: 'error', message: 'Could not write to the clipboard.' });
  }

  async function saveFile() {
    const response = await chrome.runtime.sendMessage({ type: 'get-payload' });
    if (!response?.payload) return;
    const blob = new Blob([response.payload], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `capture-${Date.now()}.c2d`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  const working = status.kind === 'working';

  return (
    <div className="app">
      <header className="brand">
        <div className="brand-mark">
          <span>code.</span>
          <span>to.</span>
          <span>design</span>
        </div>
        <div className="brand-side">
          <span className="brand-note">Paste into Figma</span>
          <a
            className="brand-link"
            href="https://www.figma.com/plugin-docs/plugin-quickstart-guide/"
            target="_blank"
            rel="noreferrer"
          >
            Plugin setup
          </a>
        </div>
      </header>

      <div className="panels">
        <section className="panel">
          <h2>Viewports</h2>
          <ul className="options">
            {viewports.map((viewport) => {
              const Icon = ICONS[viewport.icon];
              const checked = selectedViewports.includes(viewport.id);
              return (
                <li key={viewport.id}>
                  <label className="row">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleViewport(viewport.id)}
                    />
                    <Icon />
                    {viewport.editable ? (
                      <>
                        <input
                          className="width-input"
                          type="number"
                          min={240}
                          max={4096}
                          value={viewport.width}
                          onChange={(e) => setWidth(viewport.id, Number(e.target.value) || 0)}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <span className="unit">px</span>
                      </>
                    ) : (
                      <span className="row-label">
                        Browser{browserWidth ? ` (${browserWidth}px)` : ''}
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="panel">
          <h2>Themes</h2>
          <ul className="options">
            <li>
              <label className="row">
                <input
                  type="checkbox"
                  checked={selectedThemes.includes('browser')}
                  onChange={() => toggleTheme('browser')}
                />
                <DesktopIcon />
                <span className="row-label">Browser theme</span>
              </label>
            </li>
            <li>
              <label className="row">
                <input
                  type="checkbox"
                  checked={selectedThemes.includes('light')}
                  onChange={() => toggleTheme('light')}
                />
                <SunIcon />
                <span className="row-label">Light</span>
              </label>
            </li>
            <li>
              <label className="row">
                <input
                  type="checkbox"
                  checked={selectedThemes.includes('dark')}
                  onChange={() => toggleTheme('dark')}
                />
                <MoonIcon />
                <span className="row-label">Dark</span>
              </label>
            </li>
          </ul>
        </section>
      </div>

      <div className="actions">
        <button className="cta cta-primary" disabled={working} onClick={() => capture('page')}>
          <span className="cta-title">Capture Current Page</span>
          <span className="cta-key">Keyboard: Alt+Shift+E</span>
        </button>
        <button className="cta cta-secondary" disabled={working} onClick={() => capture('selection')}>
          <span className="cta-title">Capture Selection</span>
          <span className="cta-key">Keyboard: Alt+Shift+D</span>
        </button>
      </div>

      {needsDebugger && status.kind === 'idle' && (
        <p className="hint">
          Extra viewports and themes are emulated through Chrome DevTools, so Chrome will ask for
          the debugger permission and show a banner on the tab while it captures.
        </p>
      )}

      <StatusView status={status} onRecopy={recopy} onSave={saveFile} hasPayload={hasPayload} />

      <footer className="footer">
        <span>Open the code.to.design plugin in Figma, then paste.</span>
      </footer>
    </div>
  );
}

function StatusView({
  status,
  onRecopy,
  onSave,
  hasPayload,
}: {
  status: Status;
  onRecopy: () => void;
  onSave: () => void;
  hasPayload: boolean;
}) {
  if (status.kind === 'working') {
    return (
      <div className="status status-working">
        <span className="spinner" />
        {status.message}
      </div>
    );
  }
  if (status.kind === 'error') {
    return <div className="status status-error">{status.message}</div>;
  }
  if (status.kind === 'done') {
    const { summary } = status;
    return (
      <div className="status status-done">
        <strong>
          {summary.copied ? 'Copied to clipboard.' : 'Captured, but the clipboard write failed.'}
        </strong>
        <div className="stats">
          {summary.frames} frame{summary.frames === 1 ? '' : 's'} · {summary.nodes} layers ·{' '}
          {summary.images} image{summary.images === 1 ? '' : 's'} · {formatBytes(summary.bytes)} ·{' '}
          {(summary.durationMs / 1000).toFixed(1)}s
        </div>
        {summary.warnings.length > 0 && (
          <details className="warnings">
            <summary>{summary.warnings.length} note{summary.warnings.length === 1 ? '' : 's'}</summary>
            <ul>
              {summary.warnings.slice(0, 12).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
        )}
        <div className="status-actions">
          <button onClick={onRecopy}>Copy again</button>
          <button onClick={onSave}>Save .c2d file</button>
        </div>
      </div>
    );
  }
  if (hasPayload) {
    return (
      <div className="status status-idle">
        <span>A previous capture is still on hand.</span>
        <div className="status-actions">
          <button onClick={onRecopy}>Copy again</button>
          <button onClick={onSave}>Save .c2d file</button>
        </div>
      </div>
    );
  }
  return null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
