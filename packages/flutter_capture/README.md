# code_to_design (Flutter)

Capture a running **Flutter** app as editable **Figma** layers — frames, auto layout, text,
gradients, shadows and images. Not a screenshot.

This is the Flutter half of [code.to.design](https://github.com/naqiiabbas/code.to.design).
It produces exactly the same clipboard payload as the Chrome extension, so **the Figma plugin
imports it with no Flutter-specific code at all**.

Works on **Web, Windows, macOS, Linux, Android and iOS** — anywhere Flutter runs.

## Why not just capture Flutter Web in the browser?

Because there is nothing there to read. Modern Flutter Web renders through CanvasKit into a
single `<canvas>` inside a shadow root. Measured on Flutter 3.44, a running app exposes 29
DOM elements, **none of them content, and zero text**. A DOM-based capture of a Flutter app
produces a handful of empty boxes.

Reading Flutter's own render tree is not a workaround — it is strictly better. Flutter hands
over exact geometry (`localToGlobal` plus `size`) and widgets that already say what they are:
a `BoxDecoration` names its gradient, a `TextStyle` names its weight, a `Row` is
unambiguously a horizontal stack. The web side has to infer all of that from computed CSS.

## Install

```yaml
dependencies:
  code_to_design:
    path: ../code.to.design/packages/flutter_capture   # or a git/pub reference
```

## Use

Wrap your app once:

```dart
import 'package:code_to_design/code_to_design.dart';

void main() {
  runApp(const CaptureOverlay(child: MyApp()));
}
```

It goes in `dependencies`, not `dev_dependencies`: anything imported from `lib/` has to be a
real dependency or the analyzer rejects it. Nothing runs in release builds — `CaptureOverlay`
returns its child untouched when `kDebugMode` is false.

A **Capture to Figma** button then appears in the corner of debug builds.

Press it, then in Figma press `Ctrl+V` on the canvas and run the code.to.design plugin
(`Ctrl+Alt+P` re-runs the last one). The button hides itself for the duration of the capture,
so it never appears in your design.

Prefer to trigger it yourself?

```dart
// Straight to the clipboard
final result = await captureFlutterAppToClipboard(label: 'Checkout');
print('${result.layers} layers, ${result.images} images');

// Or take the payload and route it wherever you like
final capture = await captureFlutterApp();
await File('screen.c2d').writeAsString(capture.payload);   // drop this on the plugin
```

## What comes across

| Flutter | Figma |
| --- | --- |
| every `RenderBox` | a frame at its exact size and position |
| `Row`, `Column` | auto layout, with main/cross axis alignment |
| `BoxDecoration` | fills, border, corner radius, box shadows |
| `LinearGradient`, `RadialGradient`, `SweepGradient` | linear, radial and angular gradient fills |
| `Material`, `Card`, `AppBar`, buttons | surface colour, elevation shadow and shape |
| `ColoredBox`, `PhysicalModel`, `PhysicalShape` | fills, radius, elevation |
| `Text`, `RichText`, styled `TextSpan` runs | one text layer, per-range font, size, weight, colour, letter spacing, line height, decoration |
| `Image` | image fills, encoded as lossless PNG |
| `Opacity`, `Transform`, `ClipRRect`, `ClipRect` | opacity, rotation, corner radius, clipping |
| `Icon` and other icon-font glyphs | rasterised to a transparent PNG above 1x |
| a leaf `CustomPaint` (charts, progress rings) | rasterised to a PNG |

**Scaffolding is pruned.** Flutter wraps everything in `Align`, `Padding`, `ConstrainedBox`,
`Semantics` and friends, none of which paints anything. Because positions are derived from
global coordinates, those layers are dropped and their children reparented without moving a
pixel — a Material screen goes from **130 layers to 15**, keeping every painted surface, every
text layer and the auto layout. That is the difference between a readable Figma file and an
unusable one.

## What does not

- **A `CustomPaint` that wraps a child** is not rasterised, because its picture would
  swallow the content underneath. Only leaf painters are. The framework itself uses the
  wrapping kind (`Material` draws its border that way), so this matters.
- **Shaders and `BackdropFilter`** are not mapped.
- **Off-screen content** in a scrollable is not captured; only what is laid out.

**Icons and custom painters are rasterised.** An icon is a glyph from an icon font; kept as
text it would arrive in Figma as a random letter unless you happen to have that font
installed. A `CustomPaint` cannot be described at all. Both are painted into a layer of
their own and encoded as PNG above 1x, which keeps a transparent background around the
icon rather than baking in whatever was behind it.

**Only the screen you are looking at is captured.** `Navigator` keeps every route you have
pushed alive in the tree, so the capture asks each box whether its ancestors actually paint
it. Routes underneath and `Offstage` subtrees are dropped; the page behind a dialog is kept,
because that one is genuinely on screen.

## Testing

```bash
flutter test
```

Capturing a screen with icons or a `CustomPaint` does engine work (encoding a PNG), and the
fake-async zone a widget test runs in deadlocks on that. Wrap those captures in
`tester.runAsync(() async { ... })`.

The suite pumps real widget trees — a hand-built one and a realistic Material app — captures
them, and asserts on the decoded payload: geometry, colours, corner radii, shadows, gradient
stops, text styling and auto layout.

It also writes its payloads to `test/out/`, which the repo's Node suite then imports through
the **real, unmodified Figma plugin bundle** against a strict Figma API stand-in. That test
is the actual proof that a Flutter capture needs no special handling downstream.

## License

MIT, same as the rest of the project.
