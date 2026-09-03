import 'package:code_to_design/code_to_design.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'capture_test.dart' show decode, flatten, textOf;

Future<List<String>> capturedTexts() async {
  final result = await captureFlutterApp(label: 'Screen');
  final snapshot = decode(result.payload);
  return flatten(snapshot['frames'][0]['root'] as Map<String, dynamic>)
      .where((n) => n['type'] == 'TEXT')
      .map(textOf)
      .toList();
}

void main() {
  testWidgets('only the screen on top is captured, not every route pushed', (tester) async {
    final nav = GlobalKey<NavigatorState>();
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: nav,
        home: const Scaffold(body: Center(child: Text('Home screen'))),
      ),
    );
    await tester.pumpAndSettle();

    expect(await capturedTexts(), contains('Home screen'));

    nav.currentState!.push(
      MaterialPageRoute<void>(
        builder: (_) => const Scaffold(body: Center(child: Text('Details screen'))),
      ),
    );
    await tester.pumpAndSettle();

    final onDetails = await capturedTexts();
    expect(onDetails, contains('Details screen'));
    expect(
      onDetails,
      isNot(contains('Home screen')),
      reason: 'the route underneath was captured too: $onDetails',
    );

    // And popping brings the first screen back.
    nav.currentState!.pop();
    await tester.pumpAndSettle();

    final backHome = await capturedTexts();
    expect(backHome, contains('Home screen'));
    expect(backHome, isNot(contains('Details screen')));
  });

  testWidgets('three deep still captures only the top one', (tester) async {
    final nav = GlobalKey<NavigatorState>();
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: nav,
        home: const Scaffold(body: Center(child: Text('One'))),
      ),
    );
    await tester.pumpAndSettle();

    for (final label in ['Two', 'Three']) {
      nav.currentState!.push(
        MaterialPageRoute<void>(
          builder: (_) => Scaffold(body: Center(child: Text(label))),
        ),
      );
      await tester.pumpAndSettle();
    }

    final texts = await capturedTexts();
    expect(texts, contains('Three'));
    expect(texts, isNot(contains('One')));
    expect(texts, isNot(contains('Two')));
  });

  testWidgets('a dialog keeps the page behind it, which is genuinely on screen', (tester) async {
    final nav = GlobalKey<NavigatorState>();
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: nav,
        home: const Scaffold(body: Center(child: Text('Behind the dialog'))),
      ),
    );
    await tester.pumpAndSettle();

    showDialog<void>(
      context: nav.currentContext!,
      builder: (_) => const AlertDialog(title: Text('Are you sure?')),
    );
    await tester.pumpAndSettle();

    final texts = await capturedTexts();
    expect(texts, contains('Are you sure?'), reason: 'the dialog is missing');
    expect(
      texts,
      contains('Behind the dialog'),
      reason: 'the page behind a dialog is still visible and must be captured',
    );
  });

  testWidgets('an Offstage subtree is left out', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: Column(
            children: [
              Text('Shown'),
              Offstage(offstage: true, child: Text('Hidden away')),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final texts = await capturedTexts();
    expect(texts, contains('Shown'));
    expect(texts, isNot(contains('Hidden away')));
  });
}
