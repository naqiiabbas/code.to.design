/// Only what is on screen right now belongs in a capture.
///
/// Flutter keeps a great deal alive that nobody can see: a route you pushed over
/// is still laid out, every tab of a bottom navigation bar exists at once, and a
/// list builds a little beyond its viewport. Each of these leaked into captures
/// at some point, and each needs a different signal to catch.
import 'package:code_to_design/code_to_design.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'capture_test.dart' show decode, flatten, textOf;

Future<List<String>> capturedTexts(WidgetTester tester) async {
  late List<String> texts;
  await tester.runAsync(() async {
    final result = await captureFlutterApp(label: 'Screen');
    texts = flatten(decode(result.payload)['frames'][0]['root'] as Map<String, dynamic>)
        .where((node) => node['type'] == 'TEXT')
        .map(textOf)
        .toList();
  });
  return texts;
}

void main() {
  testWidgets('an iOS-style push hides the page underneath', (tester) async {
    // The catch: on iOS a pushed-over page is slid aside, not faded, so it stays
    // painted and still overlaps the screen. Neither "does the parent paint it"
    // nor "is it off screen" catches that - only the covered route's ticker does.
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    final nav = GlobalKey<NavigatorState>();
    await tester.pumpWidget(MaterialApp(
      navigatorKey: nav,
      home: const Scaffold(body: Center(child: Text('Page one'))),
    ));
    await tester.pumpAndSettle();

    nav.currentState!.push(MaterialPageRoute<void>(
      builder: (_) => const Scaffold(body: Center(child: Text('Page two'))),
    ));
    await tester.pumpAndSettle();

    final texts = await capturedTexts(tester);
    expect(texts, contains('Page two'));
    expect(texts, isNot(contains('Page one')), reason: 'the covered page came too: $texts');

    // Reset inside the body: the framework checks debug variables before tearDown.
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('an Android-style push hides the page underneath', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    final nav = GlobalKey<NavigatorState>();
    await tester.pumpWidget(MaterialApp(
      navigatorKey: nav,
      home: const Scaffold(body: Center(child: Text('Page one'))),
    ));
    await tester.pumpAndSettle();

    nav.currentState!.push(MaterialPageRoute<void>(
      builder: (_) => const Scaffold(body: Center(child: Text('Page two'))),
    ));
    await tester.pumpAndSettle();

    final texts = await capturedTexts(tester);
    expect(texts, contains('Page two'));
    expect(texts, isNot(contains('Page one')));

    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('only the selected tab of an IndexedStack is captured', (tester) async {
    // Every tab is alive, laid out, and at the same coordinates as the others.
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(
        body: IndexedStack(
          index: 1,
          children: [
            Center(child: Text('Tab home')),
            Center(child: Text('Tab search')),
            Center(child: Text('Tab profile')),
          ],
        ),
      ),
    ));
    await tester.pumpAndSettle();

    final texts = await capturedTexts(tester);
    expect(texts, contains('Tab search'));
    expect(texts, isNot(contains('Tab home')), reason: 'a hidden tab came too: $texts');
    expect(texts, isNot(contains('Tab profile')));
  });

  testWidgets('only the current page of a PageView is captured', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: PageView(
          controller: PageController(initialPage: 1),
          children: const [
            Center(child: Text('Slide A')),
            Center(child: Text('Slide B')),
            Center(child: Text('Slide C')),
          ],
        ),
      ),
    ));
    await tester.pumpAndSettle();

    final texts = await capturedTexts(tester);
    expect(texts, contains('Slide B'));
    expect(texts, isNot(contains('Slide A')));
    expect(texts, isNot(contains('Slide C')));
  });

  testWidgets('a long list stops at the bottom of the screen', (tester) async {
    // A ListView builds a little past its viewport. Those rows are laid out but
    // nobody can see them, so they are outside the captured frame.
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: ListView.builder(
          itemCount: 60,
          itemExtent: 100,
          itemBuilder: (_, index) => Center(child: Text('Row $index')),
        ),
      ),
    ));
    await tester.pumpAndSettle();

    final texts = (await capturedTexts(tester)).where((t) => t.startsWith('Row ')).toList();
    final screenHeight = tester.view.physicalSize.height / tester.view.devicePixelRatio;
    final fits = (screenHeight / 100).ceil();

    expect(texts, contains('Row 0'));
    expect(
      texts.length,
      lessThanOrEqualTo(fits),
      reason: 'captured $texts, but only $fits rows fit on screen',
    );
    expect(texts, isNot(contains('Row 30')), reason: 'a row far below the fold came too');
  });

  testWidgets('a Visibility(visible: false) branch is left out', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(
        body: Column(
          children: [
            Text('Shown'),
            Visibility(visible: false, maintainState: true, child: Text('Hidden')),
          ],
        ),
      ),
    ));
    await tester.pumpAndSettle();

    final texts = await capturedTexts(tester);
    expect(texts, contains('Shown'));
    expect(texts, isNot(contains('Hidden')));
  });
}
