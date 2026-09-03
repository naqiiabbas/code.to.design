import 'dart:convert';
import 'dart:ui' as ui;

import 'package:code_to_design/code_to_design.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'capture_test.dart' show decode, flatten, textOf;

/// A painter Figma could never be told about: it just draws.
class _Disc extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawCircle(
      size.center(Offset.zero),
      size.shortestSide / 2,
      Paint()..color = const Color(0xFFFF00FF),
    );
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// The centre pixel of a captured PNG asset, as [r, g, b, a].
Future<List<int>> centrePixel(Map<String, dynamic> asset) async {
  final codec = await ui.instantiateImageCodec(base64.decode(asset['data'] as String));
  final frame = await codec.getNextFrame();
  final data = await frame.image.toByteData();
  final width = frame.image.width;
  final offset = ((frame.image.height ~/ 2) * width + (width ~/ 2)) * 4;
  return [
    data!.getUint8(offset),
    data.getUint8(offset + 1),
    data.getUint8(offset + 2),
    data.getUint8(offset + 3),
  ];
}

/// Captures, then decodes every rasterised asset. All of it needs real async -
/// the fake-async zone a widget test runs in deadlocks on engine calls.
Future<_Captured> captureAndDecode(WidgetTester tester, String label) async {
  late _Captured captured;
  await tester.runAsync(() async {
    final result = await captureFlutterApp(label: label);
    final snapshot = decode(result.payload);
    final nodes = flatten(snapshot['frames'][0]['root'] as Map<String, dynamic>);
    final images = nodes.where((n) => n['type'] == 'IMAGE').toList();
    final colours = <List<int>>[];
    for (final image in images) {
      final asset = (snapshot['assets'] as Map)[image['assetId']];
      if (asset == null) continue;
      colours.add(await centrePixel(asset as Map<String, dynamic>));
    }
    captured = _Captured(snapshot, nodes, images, colours);
  });
  return captured;
}

class _Captured {
  _Captured(this.snapshot, this.nodes, this.images, this.colours);

  final Map<String, dynamic> snapshot;
  final List<Map<String, dynamic>> nodes;
  final List<Map<String, dynamic>> images;
  final List<List<int>> colours;

  bool get anyOpaque => colours.any((c) => c[3] > 200);

  /// Whether any rasterised asset is roughly this colour at its centre.
  bool hasColour(int r, int g, int b) => colours.any((c) =>
      (c[0] - r).abs() < 60 && (c[1] - g).abs() < 60 && (c[2] - b).abs() < 60 && c[3] > 200);

  String describe() => colours.map((c) => 'rgba(${c.join(",")})').join(' ');
}

void main() {
  testWidgets('icons are rasterised instead of arriving as font glyphs', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          backgroundColor: Color(0xFFFFFFFF),
          body: Center(child: Icon(Icons.square, size: 96, color: Color(0xFFFF0000))),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final captured = await captureAndDecode(tester, 'Icons');

    // Nothing should reach Figma as a private-use glyph, which is what an icon
    // font is and what Figma cannot render without that exact font installed.
    for (final text in captured.nodes.where((n) => n['type'] == 'TEXT').map(textOf)) {
      for (final rune in text.runes) {
        expect(
          rune >= 0xE000 && rune <= 0xF8FF,
          isFalse,
          reason: 'an icon glyph survived as text: U+${rune.toRadixString(16)}',
        );
      }
    }

    expect(captured.images, isNotEmpty, reason: 'the icon was not rasterised');

    final icon = captured.images.first;
    final asset = (captured.snapshot['assets'] as Map)[icon['assetId']];
    expect(asset, isNotNull, reason: 'the icon node points at an asset that was never produced');
    expect(asset['width'], greaterThan(1));
    expect(asset['height'], greaterThan(1));

    // The pixels cannot be asserted here: `flutter test` runs without a real font
    // manager, so MaterialIcons draws nothing and the glyph comes out empty. The
    // CustomPaint case below exercises the same rasterisation path with shapes
    // that do render, which is what proves the pipeline produces real pixels.
  });

  testWidgets('an icon is rasterised above 1x so it stays crisp', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(body: Center(child: Icon(Icons.square, size: 48))),
      ),
    );
    await tester.pumpAndSettle();

    final captured = await captureAndDecode(tester, 'Icons');
    final icon = captured.images.first;
    final asset = (captured.snapshot['assets'] as Map)[icon['assetId']] as Map<String, dynamic>;

    expect(
      (asset['width'] as int) > (icon['width'] as num),
      isTrue,
      reason: 'rasterised at 1x (${asset['width']}px for a ${icon['width']}pt box), '
          'so it will look soft when zoomed',
    );
  });

  testWidgets('a leaf CustomPaint is rasterised instead of arriving empty', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          backgroundColor: const Color(0xFFFFFFFF),
          body: Center(child: CustomPaint(painter: _Disc(), size: const Size(120, 120))),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final captured = await captureAndDecode(tester, 'Painter');
    expect(captured.images, isNotEmpty, reason: 'the CustomPaint produced no image');
    expect(
      captured.hasColour(255, 0, 255),
      isTrue,
      reason: 'the painted disc did not come through. Got: ${captured.describe()}',
    );
  });

  testWidgets('a CustomPaint that decorates a child does not swallow it', (tester) async {
    // Framework internals wrap real content in a CustomPaint - Material draws its
    // border that way. Rasterising one of those would turn the whole screen into
    // a single picture.
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: CustomPaint(
            painter: _Disc(),
            child: const Center(child: Text('Still here')),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final captured = await captureAndDecode(tester, 'Decorated');
    expect(
      captured.nodes.where((n) => n['type'] == 'TEXT').map(textOf),
      contains('Still here'),
      reason: 'the child was swallowed into a rasterised picture',
    );
  });

  testWidgets('ordinary text and shapes are never rasterised', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(body: Center(child: Text('Still editable'))),
      ),
    );
    await tester.pumpAndSettle();

    final captured = await captureAndDecode(tester, 'Text');
    expect(
      captured.nodes.where((n) => n['type'] == 'TEXT').map(textOf),
      contains('Still editable'),
    );
    expect(captured.images, isEmpty, reason: 'plain text should never become a picture');
  });
}
