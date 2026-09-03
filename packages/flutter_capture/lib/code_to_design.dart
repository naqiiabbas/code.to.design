/// Capture a running Flutter app as editable Figma layers.
///
/// Wrap your app once:
///
/// ```dart
/// runApp(const CaptureOverlay(child: MyApp()));
/// ```
///
/// A capture button appears in debug builds only. Press it, then paste into
/// Figma and run the code.to.design plugin — the same plugin that imports
/// captures from the Chrome extension, unchanged.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'src/capture.dart';
import 'src/payload.dart';

export 'src/snapshot.dart' show Snapshot, SceneNode, CapturedAsset;

/// What a capture produced, for callers that want to route it somewhere other
/// than the clipboard.
class CaptureResult {
  const CaptureResult({
    required this.payload,
    required this.layers,
    required this.images,
    required this.warnings,
  });

  /// The `C2D1:` clipboard payload the Figma plugin reads.
  final String payload;
  final int layers;
  final int images;
  final List<String> warnings;
}

/// Reads the live widget tree and returns a payload ready for Figma.
///
/// Call it any time after the first frame. Throws [StateError] if the tree has
/// not been laid out yet.
Future<CaptureResult> captureFlutterApp({String label = 'Flutter'}) async {
  final root = WidgetsBinding.instance.rootElement;
  if (root == null) {
    throw StateError('No widget tree is mounted yet. Capture after the first frame.');
  }

  final snapshot = await FlutterCapture(label: label).capture(root);
  return CaptureResult(
    payload: encodePayload(snapshot),
    layers: snapshot.nodeCount,
    images: snapshot.assets.length,
    warnings: snapshot.warnings,
  );
}

/// Captures the app and puts the payload straight on the clipboard.
Future<CaptureResult> captureFlutterAppToClipboard({String label = 'Flutter'}) async {
  final result = await captureFlutterApp(label: label);
  await Clipboard.setData(ClipboardData(text: result.payload));
  return result;
}

/// Wraps your app with a floating capture button.
///
/// The button is compiled out of release builds entirely, so shipping this
/// wrapper costs nothing: in release it returns [child] untouched.
class CaptureOverlay extends StatefulWidget {
  const CaptureOverlay({
    super.key,
    required this.child,
    this.label = 'Flutter',
    this.alignment = Alignment.bottomRight,
    this.enabled,
  });

  final Widget child;

  /// Name given to the frame that lands on the Figma canvas.
  final String label;

  final Alignment alignment;

  /// Defaults to debug builds only.
  final bool? enabled;

  @override
  State<CaptureOverlay> createState() => _CaptureOverlayState();
}

class _CaptureOverlayState extends State<CaptureOverlay> {
  String? _status;
  bool _busy = false;

  bool get _enabled => widget.enabled ?? kDebugMode;

  Future<void> _capture() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _status = 'Capturing…';
    });
    try {
      // Hide the button first: it is not part of the design, and the capture
      // reads the live tree. This needs setState and a frame to actually take
      // effect - just flipping the field would leave the button in the capture.
      setState(() => _hidden = true);
      await _nextFrame();
      final result = await captureFlutterAppToClipboard(label: widget.label);
      setState(() {
        _status = '${result.layers} layers copied — paste in Figma';
      });
    } catch (error) {
      setState(() => _status = 'Capture failed: $error');
    } finally {
      if (mounted) {
        setState(() {
          _hidden = false;
          _busy = false;
        });
      }
      // A cancellable timer rather than an awaited delay: the capture call should
      // not stay open for four seconds, and the toast must not outlive the widget.
      _statusTimer?.cancel();
      _statusTimer = Timer(const Duration(seconds: 4), () {
        if (mounted) setState(() => _status = null);
      });
    }
  }

  Timer? _statusTimer;

  @override
  void dispose() {
    _statusTimer?.cancel();
    super.dispose();
  }

  bool _hidden = false;

  Future<void> _nextFrame() {
    final completer = Completer<void>();
    WidgetsBinding.instance.addPostFrameCallback((_) => completer.complete());
    WidgetsBinding.instance.scheduleFrame();
    return completer.future;
  }

  @override
  Widget build(BuildContext context) {
    if (!_enabled) return widget.child;

    // This wrapper sits above MaterialApp, so there is no Directionality or
    // MediaQuery inherited from anywhere: the overlay has to bring its own.
    // Without it, the button's Column throws during layout and nothing appears.
    final insets = MediaQuery.maybeOf(context)?.padding ?? EdgeInsets.zero;

    return Directionality(
      textDirection: TextDirection.ltr,
      child: Stack(
        // Tight constraints, so the wrapped app fills the screen exactly as it
        // would have without this wrapper.
        fit: StackFit.expand,
        children: [
          widget.child,
          if (!_hidden)
            Positioned.fill(
              child: Align(
                alignment: widget.alignment,
                child: Padding(
                  // Keep clear of notches, home indicators and nav bars.
                  padding: EdgeInsets.only(
                    left: insets.left + 16,
                    right: insets.right + 16,
                    top: insets.top + 16,
                    bottom: insets.bottom + 16,
                  ),
                  child: _CaptureButton(
                    busy: _busy,
                    status: _status,
                    onPressed: _capture,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _CaptureButton extends StatelessWidget {
  const _CaptureButton({required this.busy, required this.status, required this.onPressed});

  final bool busy;
  final String? status;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        if (status != null)
          Container(
            margin: const EdgeInsets.only(bottom: 8),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: const Color(0xE60B0B0D),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(
              status!,
              textDirection: TextDirection.ltr,
              style: const TextStyle(color: Color(0xFFFFFFFF), fontSize: 12),
            ),
          ),
        GestureDetector(
          onTap: busy ? null : onPressed,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            decoration: BoxDecoration(
              color: busy ? const Color(0xFF6B7280) : const Color(0xFF0D99FF),
              borderRadius: BorderRadius.circular(999),
            ),
            child: Text(
              busy ? 'Capturing…' : 'Capture to Figma',
              textDirection: TextDirection.ltr,
              style: const TextStyle(
                color: Color(0xFFFFFFFF),
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ),
      ],
    );
  }
}
