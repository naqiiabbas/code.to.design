<div align="center">

# code.to.design

### Convert any website or Flutter app into editable Figma layers.
### Free, unlimited, and open source.

A **Chrome extension**, a **Flutter package** and a **Figma plugin** that turn a live UI into
real Figma frames, auto layout, text, images and vectors. Not a screenshot — every layer is
editable.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Chrome 116+](https://img.shields.io/badge/Chrome-116%2B-4285F4?logo=googlechrome&logoColor=white)](https://www.google.com/chrome/)
[![Figma Plugin](https://img.shields.io/badge/Figma-Plugin-F24E1E?logo=figma&logoColor=white)](https://www.figma.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

**No account. No server. No sign-up. No export limits.**

</div>

<!--
  Screenshots go here. Drop them in docs/ and reference them, e.g.:
  ![The code.to.design popup: viewports, themes, and the two capture buttons](docs/popup.png)
  ![A captured landing page imported into Figma as editable layers](docs/figma-import.png)
-->

---

## What it does

**html to figma**, **website to figma**, **web page to figma** — whatever you call it, this
does it locally on your machine:

1. You open any page in Chrome and click the extension.
2. It reads the live DOM and computed styles — every box, colour, font, shadow and image.
3. It puts a compressed snapshot on your clipboard.
4. You paste in Figma and the companion plugin rebuilds it as **real, editable layers**.

```
Chrome extension                      clipboard                  Figma plugin
────────────────                      ─────────                  ────────────
pick viewports + themes   ─────►   C2D1:<gzip+base64>   ─────►   Ctrl+V, run plugin
walk DOM + computed CSS                                          frames / text / images
fetch images as bytes                                            auto layout, hyperlinks
```

If you have used **html.to.design**, this is the same idea, built in the open and running
entirely on your own machine.

## Why this exists

Most website-to-Figma tools route your page through someone else's servers and meter how
many imports you get. This one does not have servers to route through:

| | code.to.design |
| --- | --- |
| **Cost** | Free, forever — it is MIT-licensed source code |
| **Import limit** | None. There is no quota to enforce because there is no backend |
| **Account** | None. Nothing to sign up for |
| **Where your page goes** | Nowhere. The capture never leaves your computer |
| **Pages behind a login** | Work fine — it reads the page *your* browser is already showing |
| **Internal / localhost sites** | Work fine, offline included |
| **Source code** | All of it, right here |

The whole pipeline is your browser → your clipboard → your Figma. The Figma plugin declares
`"networkAccess": { "allowedDomains": ["none"] }`, so it is not able to phone home even if
it wanted to.

## Table of contents

- [Install](#install)
- [How to use it](#how-to-use-it)
- [Flutter apps](#flutter-apps)
- [What comes across](#what-comes-across)
- [What does not](#what-does-not)
- [FAQ](#faq)
- [How it works](#how-it-works)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

---

## Install

You need [Node.js 20+](https://nodejs.org), Chrome 116+, and the **Figma desktop app**.
(The test suite executes TypeScript directly, so running `npm test` needs Node 22.6+.)

```bash
git clone https://github.com/naqiiabbas/code.to.design.git
cd code.to.design
npm install
npm run build
```

That produces two folders:

| Folder | What it is |
| --- | --- |
| `packages/extension/dist` | the unpacked Chrome extension |
| `packages/figma-plugin/dist` | the Figma plugin |

`npm run package` also zips both into `release/`, which is what you send a teammate.

### 1. The Chrome extension

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select `packages/extension/dist`
4. Pin it: puzzle-piece icon in the toolbar → pin **code.to.design**

### 2. The Figma plugin

Figma does not accept a zip directly, but a local install takes four clicks and needs no
publishing, no review and no approval:

1. Open the **Figma desktop app** (development plugins do not run at figma.com in a browser)
2. Menu → **Plugins → Development → Import plugin from manifest…**
3. Pick `manifest.json` inside `packages/figma-plugin/dist`

It now lives under **Plugins → Development → code.to.design**, permanently. To share it,
send someone `release/code-to-design-figma-plugin.zip` and have them unzip it and import the
manifest the same way.

---

## How to use it

Once both halves are installed, converting a website to a Figma design takes about ten
seconds. Open any page in Chrome and click the **code.to.design** icon. Tick the
**viewports** you want — `Browser` is whatever your window is right now, and the others
(1920, 1440, 1024, 768, 390) are emulated properly through Chrome DevTools so the page's own
media queries respond and you get the genuine mobile layout rather than a squashed desktop
one. Tick the **themes** you want too (`Browser`, `Light`, `Dark`), and every combination you
tick becomes its own Figma frame in a single import. Then press **Capture Current Page**
(`Alt+Shift+E`) for the whole scrollable page, or **Capture Selection** (`Alt+Shift+D`) to
pick one component: the popup closes, whatever you hover is outlined in blue with its tag
and pixel size, `↑`/`↓` step to the parent or first child, and a click confirms. The capture
lands on your clipboard. Switch to Figma, press **`Ctrl+V`** on the canvas, then run the
plugin — `Ctrl+Alt+P` re-runs the last plugin, so after the first time it is two keystrokes.
The plugin picks the pasted payload up, rebuilds it as layers, cleans up after itself and
closes without ever opening a window. Repeat as often as you like; nothing is counted.

**Keyboard shortcuts**

| Shortcut | What it does |
| --- | --- |
| `Alt` + `Shift` + `E` | Capture the current page |
| `Alt` + `Shift` + `D` | Capture a selection (element picker) |
| `Ctrl` + `V` / `Cmd` + `V` | Paste the capture onto the Figma canvas |
| `Ctrl` + `Alt` + `P` / `Cmd` + `Opt` + `P` | Re-run the last Figma plugin (imports it) |
| `↑` / `↓` | While picking: step to parent / first child |
| `Esc` | Cancel the picker |

**If the clipboard struggles** on a very large page, use **Save .c2d file** in the popup and
drag that file onto the plugin's panel instead. Running the plugin *before* pasting also
works — it opens a panel with a paste area, which is the fallback when there is nothing on
the canvas to pick up.

---

## Flutter apps

Flutter Web cannot be captured through Chrome: CanvasKit paints the whole app into one
`<canvas>` inside a shadow root, so there is no DOM to read. Measured on Flutter 3.44, a
running app exposes 29 DOM elements, none of them content, and zero text.

So the Flutter half reads Flutter’s **own render tree** instead, which is strictly better:
exact geometry from `localToGlobal` plus `size`, and widgets that already say what they are.
It emits the same clipboard payload, so **the Figma plugin imports it unchanged**.

```dart
dependencies:
  code_to_design: { path: packages/flutter_capture }

// main.dart — debug builds only, compiled out of release
runApp(const CaptureOverlay(child: MyApp()));
```

Icons and leaf `CustomPaint`s are rasterised to transparent PNGs, since a glyph from an icon
font would otherwise arrive in Figma as a random letter. Only the screen you are looking at is
captured: Flutter keeps a lot alive that nobody can see — routes you pushed over, every tab of a
bottom navigation bar, rows past the end of a list — and each is filtered out. A page behind a
dialog is kept, because that one really is on screen.

The screen's own background colour comes across, so a dark-themed app no longer lands on white.
`Row` and `Column` keep their `spacing:`. Layers are ordered by the order they are actually
painted in rather than the order they are listed — which is what used to drop a text field's
fill on top of its own placeholder. And text is imported hugging its content, so a font Figma
had to substitute cannot make a line wrap.

Press **Capture to Figma**, then `Ctrl+V` on the canvas and run the plugin. Works on Web,
Windows, macOS, Linux, Android and iOS. `Row`/`Column` become auto layout, `BoxDecoration`
becomes fills and shadows, `TextStyle` becomes real text styling, and the ~90% of a Flutter
tree that paints nothing (`Align`, `Padding`, `Semantics`…) is pruned away — a Material
screen goes from 130 layers to 15 without moving a pixel.

Full details: [packages/flutter_capture](packages/flutter_capture/README.md).

---

## What comes across

| Web | Figma |
| --- | --- |
| element boxes | frames with exact size and position |
| `display: flex` containers | auto layout (toggleable in the plugin) |
| `background-color`, `linear/radial/conic-gradient`, `background-image` | fills, in CSS paint order |
| `border` (per-side widths, dashed, dotted) | strokes, inside-aligned |
| `border-radius` | per-corner radii |
| `box-shadow`, `text-shadow`, `filter: blur`, `backdrop-filter: blur` | drop/inner shadows, layer blur, background blur |
| text with mixed inline styling | one text layer with per-range font, size, weight, colour, spacing, decoration, case |
| `background-clip: text` gradient headings | gradient text fills |
| `<img>`, `<canvas>`, `<video>` frames, CSS `url()` | image fills, pixel-exact — nothing is lossily re-compressed |
| inline `<svg>`, sprite icons (`<use href="#id">`), `.svg` sources | real vector layers |
| `<a href>` | Figma hyperlinks |
| `opacity`, `mix-blend-mode`, `transform: rotate()` | opacity, blend mode, rotation |
| `<input>`, `<textarea>`, `<select>` | box plus its value or placeholder as text |
| `overflow: hidden/auto` | clipping frames |
| internally scrolling boxes (dropdowns, popup lists, horizontal strips) | frames grown to their full content, with everything after them reflowed |

A few things worth knowing about how it gets there:

- **Modern colour spaces are handled properly.** Colours are resolved by painting a pixel
  and reading it back, not by parsing what `getComputedStyle` returns — the only approach
  that survives `oklch` (Tailwind v4's entire palette), `lab`, `lch`, `oklab`,
  `color(srgb …)`, `display-p3` and `color-mix()`.
- **Images are never re-compressed.** PNG, JPEG and GIF are handed to Figma as the exact
  bytes the site served. WebP and AVIF, which Figma cannot read, are decoded and re-encoded
  as *lossless* PNG. An `<img>` with a `srcset` is fetched at its sharpest candidate.
- **Scrolling content is captured in full.** Every scroller on the page is walked end to end
  first — not just the window, which on an app shell with a fixed-height body does not
  scroll at all — so lazy images and scroll-triggered content have rendered. Boxes with
  their own scrollbar are then temporarily expanded, so a dropdown showing 3 of 10 rows
  arrives with all 10 and a frame tall enough to hold them.
- **Fonts** are matched by family and numeric weight against what Figma actually has
  installed, falling back through the CSS font stack and then to Inter. Every substitution
  is reported after import.

## What does not

Real limitations, listed honestly. Each one is reported in the plugin's post-import notes
when it comes up:

- **In-flow `::before` / `::after`.** Only absolutely positioned pseudo elements are
  captured — no DOM API reports the geometry of an in-flow one, so icon fonts driven by
  `content:` in normal flow will be missing.
- **`<iframe>` content.** Cross-origin frames cannot be read; you get a placeholder.
- **List markers** (`<li>` bullets and numbers) are not drawn.
- **CSS grid** is captured with absolute positions rather than converted to auto layout.
- **`visibility: hidden` subtrees** are skipped whole.
- **Repeating gradients** fall back to a single pass of their stops.
- **Animations** are paused at whatever frame the page was on.
- **Endless feeds** are captured as far as 8 seconds of scrolling reaches. Scroll further
  yourself and capture again for the rest.
- **Tainted `<canvas>`** (drawn from cross-origin content) cannot be read.
- **Shadow DOM.** Content inside a shadow root is not traversed yet, so pages built from
  web components come through as empty boxes.
- **Canvas-rendered apps** (Unity, `<canvas>`-based editors) have no DOM to read. Flutter is
  handled separately — see [Flutter apps](#flutter-apps).

---

## FAQ

**Is it really free? What's the catch?**
It is MIT-licensed source code that runs on your machine. There is no backend to pay for and
therefore no quota to sell you. Capture as many pages as you like.

**Does my page data go anywhere?**
No. The capture goes browser → clipboard → Figma, entirely locally. The Figma plugin
declares no network access at all. The extension only makes requests to fetch the images the
page itself already loaded.

**Can I capture pages behind a login, or on localhost?**
Yes. It reads the page your browser is already showing, with your session, so authenticated
dashboards and `localhost` both work.

**Why does it need the `debugger` permission?**
Only to emulate viewports and themes, via `Emulation.setDeviceMetricsOverride` and
`setEmulatedMedia` — the only way to make the page's own media queries respond so you get a
genuine mobile layout. Chrome does not allow `debugger` to be an optional permission (it
silently drops it), so it must be declared up front. It is only *used* when you tick a
non-browser viewport or an explicit theme; capturing with `Browser` + `Browser theme` never
attaches at all. When it does, Chrome shows its own banner on the tab and the extension
detaches as soon as the capture ends.

**Why does my text look different in Figma?**
Figma can only use fonts installed on your computer. If the site uses a webfont you do not
have, Figma substitutes Inter or Roboto. The plugin tells you exactly which fonts it swapped
after each import — install those locally and re-import for an exact match.

**It looks blurry when I zoom in Figma. Is the capture low quality?**
Almost certainly not. Figma draws a low-resolution proxy while it catches up on a heavy
frame, and the more layers a frame holds, the longer that takes. Wait a few seconds after
zooming, or export the frame as PNG at 2x/4x — the export is the file's real quality.

**Can it capture a Flutter Web app (or Unity, or a canvas-based editor)?**
Not as editable layers, no. Modern Flutter Web renders everything with CanvasKit into a
single `<canvas>` inside a shadow root — measured on Flutter 3.44, a running app exposes 29
DOM elements, none of them content, and zero text. There is simply nothing to read: no
boxes, no fonts, no colours, just painted pixels. The same is true of any canvas-rendered
app. A capture of one currently produces a handful of empty frames. Design-to-code tools can
go the other way; going from a canvas back to structured layers is not something the DOM can
answer.

**Can I use it with Figma in a browser?**
The plugin needs the Figma **desktop app**, because that is where development plugins run.
The Chrome extension side works anywhere.

**Does it work on macOS / Windows / Linux?**
Yes, anywhere Chrome and the Figma desktop app run.

**Why isn't it on the Chrome Web Store / Figma Community?**
It is distributed as source you build and load yourself, which is what keeps it free of
accounts and limits. Anyone is welcome to publish a fork.

---

## How it works

```
packages/shared/          snapshot schema + clipboard codec, shared by both halves
packages/extension/       MV3 Chrome extension
  src/popup/              React popup (viewports, themes, the two capture buttons)
  src/background/         orchestration, DevTools emulation, image fetching, clipboard
  src/capture/            the DOM walker injected into the page
packages/flutter_capture/ Dart package: walks Flutter’s render tree, same payload
packages/figma-plugin/    Figma plugin
  src/ui/                 React iframe: paste, decode, options
  src/code/               sandbox: font resolution and node construction
```

The capture bundle runs inside the page, but every image is fetched by the **service worker**
instead. That is deliberate: the worker holds host permissions for all origins, so
cross-origin images come back as real bytes rather than tainting a canvas.

### Testing

The suite runs the **real built bundles**, not mocks talking to each other. It launches your
installed Chrome, injects the actual `capture.js` into fixture pages, pushes the result
through the real clipboard codec, and runs the actual plugin bundle against a deliberately
strict Figma API stand-in that throws wherever Figma throws — characters set before the font
is loaded, a non-PNG/JPEG/GIF handed to `createImage`, alignment set on a frame with no
`layoutMode`, a paint channel outside 0..1. With auto layout off, the resulting Figma tree is
compared to the capture **node for node**. The element picker is verified by screenshotting
the page and sampling real pixels, because a DOM assertion cannot tell you whether a human
can see the highlight.

What it does **not** prove: the stand-in enforces Figma's rules, it does not render. Nothing
in the suite confirms a gradient *looks* right on the canvas.

## Development

```bash
npm run build        # build both halves, plus icons
npm run build:ext    # extension only
npm run build:plugin # plugin only
npm run typecheck    # all packages
npm test             # unit + end-to-end tests (drives real Chrome)
npm run test:e2e     # end-to-end only
npm run test:flutter # the Dart package (needs Flutter installed)
npm run package      # zip both dist folders into release/
```

After rebuilding: hit **Reload** on the extension card in `chrome://extensions`, and in Figma
just run the plugin again — development plugins re-read from disk on every run.

> `npm audit` reports a moderate advisory against esbuild's dev server, reached through Vite.
> This project only ever runs `vite build`, never `vite dev`, so that server is never started.

## Contributing

Issues and pull requests are welcome. Useful things to know:

- Run `npm test` before opening a PR — it drives real Chrome, so it catches real regressions.
- New behaviour needs a test that **fails without the change**. Several bugs in this codebase
  were found because a test was checked against the broken build first.
- Fixture pages live in `packages/extension/test/*.html`. Adding a page that reproduces a
  site you had trouble with is a genuinely useful contribution on its own.

Good first issues: CSS grid → auto layout, `<li>` list markers, in-flow pseudo elements.

## License

[MIT](LICENSE) — do whatever you like with it, including commercially.

---

<div align="center">

**Keywords:** flutter to figma · html to figma · website to figma · web page to figma · convert website to figma ·
import website into figma · figma plugin · chrome extension · design to code · web to design ·
open source html.to.design alternative · free website to figma converter

If this saved you some time, a ⭐ helps other people find it.

</div>
