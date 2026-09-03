# code.to.design

Capture any web page in Chrome and paste it into Figma as **editable layers** — frames,
auto layout, text, images, vectors — not a screenshot.

It works the same way html.to.design's extension does: the Chrome extension reads the live
DOM and computed styles, puts a compressed snapshot on your clipboard, and a companion
Figma plugin turns that snapshot into real Figma nodes.

```
Chrome extension                      clipboard                  Figma plugin
────────────────                      ─────────                  ────────────
pick viewports + themes   ─────►   C2D1:<gzip+base64>   ─────►   Ctrl+V, Import
walk DOM + computed CSS                                          frames / text / images
fetch images as bytes                                            auto layout, hyperlinks
```

---

## Install

```bash
npm install
npm run build
```

That produces two folders:

| Folder | What it is |
| --- | --- |
| `packages/extension/dist` | the unpacked Chrome extension |
| `packages/figma-plugin/dist` | the Figma plugin |

`npm run package` additionally zips both into `release/`.

### 1. The Chrome extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → select `packages/extension/dist`.

Requires Chrome 116 or newer.

### 2. The Figma plugin

Figma does not accept a zip directly, but a local install is one extra step and needs no
publishing, no review, and no account beyond your own:

1. Unzip `release/code-to-design-figma-plugin.zip` anywhere (or just use
   `packages/figma-plugin/dist` as-is).
2. Open the **Figma desktop app** (development plugins do not run in the browser).
3. Menu → **Plugins → Development → Import plugin from manifest…**
4. Pick `manifest.json` inside that folder.

It now appears under **Plugins → Development → code.to.design**. To share it with a
teammate, send them the zip and have them do the same four steps.

---

## Use

1. Open any page in Chrome and click the extension.
2. Tick the **viewports** you want (`Browser` is whatever your window is right now; the
   others are emulated) and the **themes** (`Browser`, `Light`, `Dark`).
3. **Capture Current Page** (`Alt+Shift+E`) captures the whole scrollable page, once per
   viewport × theme combination.
   **Capture Selection** (`Alt+Shift+D`) closes the popup and puts the page in picking
   mode: whatever you hover is outlined in blue with its tag and pixel size, `↑` / `↓` step
   to the parent or first child, click or `Enter` confirms, `Esc` cancels. The page still
   scrolls while you pick, and clicks never activate the link underneath.
4. The capture lands on your clipboard. In Figma, press `Ctrl+V` on the canvas, then run the
   plugin (`Ctrl+Alt+P` re-runs the last one). It imports without ever opening a window:
   the paste lands as a text layer, the plugin picks it up, imports it, deletes it and closes.

   Running the plugin *first* also works — it opens a panel you can paste into, which is the
   fallback when there is nothing on the canvas to pick up.

If the clipboard write fails (or the payload is enormous), use **Save .c2d file** in the
popup and drop that file onto the plugin instead.

### Why the debugger permission

Picking a viewport other than "Browser", or forcing Light/Dark, is done through Chrome
DevTools emulation (`Emulation.setDeviceMetricsOverride` and `setEmulatedMedia`). That is
the only way to make the page's own media queries respond, so it is the only way the
captured layout is genuinely the mobile layout rather than a scaled desktop one.

Chrome does not allow `debugger` in `optional_permissions` — it silently drops it and
leaves the API undefined — so it is declared as a required permission and you will see it
listed at install time. It is only ever *used* when you tick a non-browser viewport or an
explicit theme; Chrome then shows a "code.to.design started debugging this browser" bar on
the tab for the duration of the capture, and the extension detaches when it finishes.
Capturing with `Browser` + `Browser theme` never attaches at all.

---

## What comes across

| Web | Figma |
| --- | --- |
| element boxes | frames with exact size and position |
| `display: flex` containers | auto layout (toggleable in the plugin) |
| `background-color`, `linear/radial/conic-gradient`, `background-image` | fills, in CSS paint order |
| `border` (including per-side widths, dashed, dotted) | strokes, inside-aligned |
| `border-radius` | per-corner radii |
| `box-shadow`, `text-shadow`, `filter: blur`, `backdrop-filter: blur` | drop/inner shadows, layer blur, background blur |
| text with mixed inline styling | one text layer with per-range font, size, weight, colour, spacing, decoration, case |
| `background-clip: text` gradient headings | gradient text fills |
| `<img>`, `<canvas>`, `<video>` frames, CSS `url()` | image fills, pixel-exact — nothing is ever lossily re-compressed |
| inline `<svg>` and `.svg` sources | real vector layers |
| `<a href>` | Figma hyperlinks |
| `opacity`, `mix-blend-mode`, `transform: rotate()` | opacity, blend mode, rotation |
| `<input>`, `<textarea>`, `<select>` | box plus its value or placeholder as text |
| `overflow: hidden/auto` | clipping frames |
| internally scrolling boxes (dropdowns, popup lists, horizontal strips) | frames grown to their full content, with everything after them reflowed |

Before anything is measured, every scroller on the page is walked end to end so lazy images and anything driven by scrolling has rendered — not just the window, which on an app shell with a fixed-height body does not scroll at all. The walk re-measures as it goes, so a page that grows keeps going, and is bounded to 8 seconds so an endless feed cannot stall a capture; if it stops early it says so.

Anything with its own scrollbar is temporarily grown to its full content before the capture, so a dropdown showing 3 of 10 rows arrives in Figma with all 10 and a frame tall enough to hold them. The expansion happens in the page and the browser re-runs layout, so ancestors resize and following content moves down exactly as it would have; the page is restored afterwards.

Colours are resolved by painting a pixel and reading it back, not by parsing the string `getComputedStyle` returns. That is the only approach that handles `oklch` (Tailwind v4’s whole palette), `lab`, `lch`, `oklab`, `color(srgb ...)`, `display-p3` and `color-mix()` — Chrome hands all of those back verbatim, and so does canvas `fillStyle`.

Images are never re-compressed. PNG, JPEG and GIF are handed to Figma as the exact bytes the site served; WebP and AVIF (which Figma cannot read) are decoded and re-encoded as **lossless** PNG, adding zero error. Sources are capped at 4096px, which is Figma’s own limit, and an `<img>` with a `srcset` is fetched at its highest-resolution candidate rather than whichever one your display happened to load. Emulated viewports render at 2x so retina assets and canvases are picked up. All of that costs payload size — a lossy WebP can triple as lossless PNG — which is the price of exact pixels.

Fonts are matched by family and numeric weight against what Figma actually has installed,
falling back through the CSS font stack and then to Inter. The plugin lists every
substitution it made after import.

## What does not

These are real limitations, not oversights — each is listed in the plugin's post-import
notes when it hits one:

- **In-flow `::before` / `::after`.** Only absolutely positioned pseudo elements are
  captured; there is no DOM API that reports the geometry of an in-flow one. Icon fonts
  driven by `content:` in normal flow will be missing.
- **`<iframe>` content.** Cross-origin frames cannot be read; you get a dashed placeholder.
- **List markers** (`<li>` bullets and numbers) are not drawn.
- **CSS grid** is captured with absolute positions rather than converted to auto layout.
- **`visibility: hidden` subtrees** are skipped whole, so a visible descendant inside a
  hidden ancestor is lost.
- **Repeating gradients** fall back to a single pass of their stops.
- **Animations** are paused at whatever frame the page was on.
- **Endless feeds** are captured only as far as 8 seconds of scrolling reaches; scroll further yourself and capture again for the rest.
- **Tainted `<canvas>`** (cross-origin drawing) cannot be read and becomes a placeholder.

---

## Layout of the repo

```
packages/shared/          snapshot schema + clipboard codec, shared by both halves
packages/extension/       MV3 Chrome extension
  src/popup/              React popup (viewports, themes, the two capture buttons)
  src/background/         orchestration, DevTools emulation, image fetching, clipboard
  src/capture/            the DOM walker injected into the page
packages/figma-plugin/    Figma plugin
  src/ui/                 React iframe: paste, decode, options
  src/code/               sandbox: font resolution and node construction
```

The extension's capture bundle runs in the page, but every image is fetched by the service
worker instead. That is deliberate: the worker holds host permissions for all origins, so
cross-origin images come back as real bytes rather than tainting a canvas.

## How much of this is actually verified

84 tests, all passing. The suite is not a set of mocks talking to each other — it runs the
real built bundles:

- **Service worker** (`packages/extension/test/background.test.mjs`) loads the built worker with and without `chrome.debugger` present and asserts it still registers its listeners, and checks the manifest never requests a permission Chrome refuses to make optional.
- **Colour resolution** (`packages/extension/test/modern-colors.e2e.mjs`) captures a fixture whose entire palette is `oklch`, plus `lab`, `lch`, `color(srgb)`, `display-p3` and `color-mix`, and checks the results against the CSS Color 4 conversion worked out independently in the test.
- **The paste-on-canvas flow** (`packages/figma-plugin/test/import.e2e.mjs`) boots the real plugin bundle with a payload sitting on the canvas as a pasted text layer and checks it imports with the panel never shown, clears the payload layer and closes — plus that it reveals the panel when there is nothing to pick up, or when what was pasted will not decode.
- **Scroll priming** (`packages/extension/test/inner-scroll.e2e.mjs`) captures an app shell whose window cannot scroll at all, and checks content wired to a scroll event on the inner element still loads — 0 of 10 before the fix, 10 of 10 after — plus that an endless feed is cut off in time and reported rather than hanging.
- **Scroll expansion** (`packages/extension/test/scroller.e2e.mjs`) drives the real picker onto a popup whose list shows 3 of 10 rows, and checks all ten arrive, the frame grows to fit, the footer moves below it, horizontal strips expand too, and the page is left as it was found.
- **The picker** (`packages/extension/test/picker.e2e.mjs`) screenshots the page and samples real pixels to confirm the blue highlight is actually visible over a sticky header and over an element at the maximum z-index. A DOM assertion would not have caught the bug it covers.
- **Capture** (`packages/extension/test/`) launches your installed Chrome, loads a fixture
  page, injects the real `dist/capture.js` and asserts on what comes out: gradients,
  shadows, rotation, z-index paint order, whitespace collapsing across inline elements,
  auto-layout inference, SVG, images, form controls, hidden-subtree exclusion.
- **Import** (`packages/figma-plugin/test/`) takes that capture, pushes it through the real
  clipboard codec, and runs the real built `dist/code.js` against a deliberately strict
  Figma API stand-in — one that throws where Figma throws (characters set before the font
  is loaded, a non-PNG/JPEG/GIF handed to `createImage`, alignment set on a frame with no
  `layoutMode`, a zero-size resize, a paint channel outside 0..1). With auto layout off,
  the resulting Figma tree is compared to the capture **node for node**.
- Font fallback and unsupported image formats are tested as failure paths: a font Figma
  does not have must substitute and report, not crash the import.

**What that still does not prove:** the stand-in enforces Figma's rules, it does not render.
Nothing here confirms a gradient *looks* right on the canvas, or that Figma's text metrics
land where Chrome's did. Those need your eyes on a real import. Start with a simple page.

## Development

```bash
npm run build        # build both, plus icons
npm run build:ext    # extension only
npm run build:plugin # plugin only
npm run typecheck    # all three packages
npm test             # unit + end-to-end tests
npm run test:unit    # CSS -> Figma conversion (gradients, shadows, transforms)
npm run test:e2e     # capture in real Chrome + import through the real plugin bundle
npm run package      # zip both dist folders into release/
```

After rebuilding, hit **Reload** on the extension card in `chrome://extensions`, and in
Figma run the plugin again (development plugins re-read from disk each run).

> `npm audit` reports a moderate advisory against esbuild's dev server, reached through
> Vite. This project only ever runs `vite build`, never `vite dev`, so the dev server is
> never started.
