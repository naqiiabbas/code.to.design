import 'package:code_to_design/code_to_design.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'capture_test.dart' show decode, flatten, textOf;

void main() {
  _buttonPressSuite();

  testWidgets('the button shows when wrapping a MaterialApp, as the README says', (tester) async {
    // Exactly what a real app does: runApp(CaptureOverlay(child: MyApp())).
    await tester.pumpWidget(
      const CaptureOverlay(
        child: MaterialApp(
          home: Scaffold(body: Center(child: Text('My app'))),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('My app'), findsOneWidget, reason: 'the wrapped app did not render');
    expect(find.text('Capture to Figma'), findsOneWidget, reason: 'the capture button is missing');

    // It also has to be somewhere a thumb can reach, not off-screen or zero-sized.
    final box = tester.getRect(find.text('Capture to Figma'));
    final screen = tester.view.physicalSize / tester.view.devicePixelRatio;
    expect(box.width, greaterThan(0), reason: 'the button has no width');
    expect(box.height, greaterThan(0), reason: 'the button has no height');
    expect(box.right, lessThanOrEqualTo(screen.width + 1), reason: 'the button is off-screen right');
    expect(box.bottom, lessThanOrEqualTo(screen.height + 1), reason: 'the button is off-screen bottom');
    expect(box.left, greaterThanOrEqualTo(0), reason: 'the button is off-screen left');
    expect(box.top, greaterThanOrEqualTo(0), reason: 'the button is off-screen top');
  });

  testWidgets('the wrapped app still fills the screen', (tester) async {
    await tester.pumpWidget(
      const CaptureOverlay(
        child: MaterialApp(home: Scaffold(backgroundColor: Color(0xFF00FF00))),
      ),
    );
    await tester.pumpAndSettle();

    final screen = tester.view.physicalSize / tester.view.devicePixelRatio;
    final app = tester.getRect(find.byType(MaterialApp));
    expect(app.width, screen.width, reason: 'the wrapper squashed the app horizontally');
    expect(app.height, screen.height, reason: 'the wrapper squashed the app vertically');
  });

  testWidgets('nothing is added in release builds', (tester) async {
    await tester.pumpWidget(
      const CaptureOverlay(
        enabled: false,
        child: MaterialApp(home: Scaffold(body: Text('My app'))),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('My app'), findsOneWidget);
    expect(find.text('Capture to Figma'), findsNothing);
  });
}

void _buttonPressSuite() {
  testWidgets('pressing the button captures and copies, without capturing itself', (tester) async {
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          copied = (call.arguments as Map)['text'] as String;
        }
        return null;
      },
    );
    addTearDown(() {
      tester.binding.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null);
    });

    await tester.pumpWidget(
      const CaptureOverlay(
        child: MaterialApp(
          home: Scaffold(body: Center(child: Text('Checkout screen'))),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Capture to Figma'));
    await tester.pump();
    await tester.pump();
    await tester.pumpAndSettle();
    // Let the status toast time out, so no timer is left pending.
    await tester.pump(const Duration(seconds: 5));

    expect(copied, isNotNull, reason: 'nothing reached the clipboard');
    expect(copied, startsWith('C2D1:'), reason: 'wrong payload format');

    final snapshot = decode(copied!);
    final texts = flatten(snapshot['frames'][0]['root'] as Map<String, dynamic>)
        .where((n) => n['type'] == 'TEXT')
        .map(textOf)
        .toList();

    expect(texts, contains('Checkout screen'), reason: 'the app content is missing');
    // The overlay must hide itself first, or it lands in the design.
    expect(texts, isNot(contains('Capture to Figma')), reason: 'the button captured itself');
    expect(texts.any((t) => t.contains('layers copied')), isFalse,
        reason: 'the status toast captured itself');
  });

  testWidgets('the button comes back after a capture', (tester) async {
    tester.binding.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async => null);
    addTearDown(() {
      tester.binding.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null);
    });

    await tester.pumpWidget(
      const CaptureOverlay(child: MaterialApp(home: Scaffold())),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Capture to Figma'));
    await tester.pump();
    await tester.pump();
    await tester.pumpAndSettle();
    // Let the status toast time out, so no timer is left pending.
    await tester.pump(const Duration(seconds: 5));

    expect(find.text('Capture to Figma'), findsOneWidget, reason: 'the button never came back');
  });
}
