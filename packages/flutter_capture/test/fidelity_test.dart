/// Four things that were wrong the first time this ran against a real app.
import 'package:code_to_design/code_to_design.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'capture_test.dart' show decode, flatten, textOf;

class _Fill extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) =>
      canvas.drawRect(Offset.zero & size, Paint()..color = const Color(0xFF333333));

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

Future<Map<String, dynamic>> capture(WidgetTester tester) async {
  late Map<String, dynamic> snapshot;
  await tester.runAsync(() async {
    snapshot = decode((await captureFlutterApp(label: 'App')).payload);
  });
  return snapshot;
}

List<int> rgb(Map paint) {
  final colour = paint['color'] as Map;
  return [
    ((colour['r'] as num) * 255).round(),
    ((colour['g'] as num) * 255).round(),
    ((colour['b'] as num) * 255).round(),
  ];
}

void main() {
  testWidgets('the page background is read, not assumed to be white', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData.dark(useMaterial3: true),
        home: const Scaffold(body: Center(child: Text('Dark app'))),
      ),
    );
    await tester.pumpAndSettle();

    final root = (await capture(tester))['frames'][0]['root'] as Map<String, dynamic>;
    final colour = rgb((root['fills'] as List).first as Map);
    expect(
      colour.reduce((a, b) => a + b) < 200,
      isTrue,
      reason: 'the frame came through light (rgb $colour) for a dark-themed app',
    );
  });

  testWidgets('a light app still reads as light', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData.light(useMaterial3: true),
        home: const Scaffold(body: Center(child: Text('Light app'))),
      ),
    );
    await tester.pumpAndSettle();

    final root = (await capture(tester))['frames'][0]['root'] as Map<String, dynamic>;
    final colour = rgb((root['fills'] as List).first as Map);
    expect(colour.reduce((a, b) => a + b) > 500, isTrue, reason: 'rgb $colour is not light');
  });

  testWidgets('Row and Column spacing reaches auto layout', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: Column(
            spacing: 32,
            children: [
              Row(spacing: 24, children: [Text('A'), Text('B')]),
              Text('C'),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final nodes = flatten((await capture(tester))['frames'][0]['root'] as Map<String, dynamic>);
    final layouts = nodes.where((n) => n['layout'] != null).toList();

    final row = layouts.firstWhere((n) => n['layout']['mode'] == 'HORIZONTAL');
    expect(row['layout']['itemSpacing'], 24, reason: 'Row(spacing: 24) was lost');

    final column = layouts.firstWhere((n) => n['layout']['mode'] == 'VERTICAL');
    expect(column['layout']['itemSpacing'], 32, reason: 'Column(spacing: 32) was lost');
  });

  testWidgets('a single line of text is left free to size itself', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: Center(child: Text('A single line that must never wrap in Figma')),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final nodes = flatten((await capture(tester))['frames'][0]['root'] as Map<String, dynamic>);
    final text = nodes.firstWhere((n) => n['type'] == 'TEXT');
    expect(
      text['autoResize'],
      'WIDTH_AND_HEIGHT',
      reason: 'a fixed width plus a wider substituted font is what makes text wrap',
    );
  });

  testWidgets('text that already wraps keeps its width', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 120,
            child: Text('This sentence is long enough that it has to run onto several lines'),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final nodes = flatten((await capture(tester))['frames'][0]['root'] as Map<String, dynamic>);
    final text = nodes.firstWhere((n) => n['type'] == 'TEXT');
    expect(
      text['autoResize'],
      'HEIGHT',
      reason: 'wrapped text must keep the width that produced the line breaks',
    );
  });

  testWidgets('a field background is painted behind its placeholder, not over it', (tester) async {
    // InputDecorator lists its filled background last among its children but
    // paints it first, so following child order buries the hint underneath it.
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData.dark(useMaterial3: true),
        home: const Scaffold(
          body: Center(
            child: SizedBox(
              width: 300,
              child: TextField(
                decoration: InputDecoration(hintText: 'Enter your name', filled: true),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final snapshot = await capture(tester);

    Map<String, dynamic>? parent;
    void search(Map<String, dynamic> node) {
      for (final child in (node['children'] as List? ?? const [])) {
        final map = child as Map<String, dynamic>;
        if (map['type'] == 'TEXT' && textOf(map).contains('Enter your name')) parent = node;
        search(map);
      }
    }

    search(snapshot['frames'][0]['root'] as Map<String, dynamic>);
    expect(parent, isNotNull, reason: 'the placeholder was not captured at all');

    final children = parent!['children'] as List;
    final hint = children.indexWhere((c) =>
        (c as Map)['type'] == 'TEXT' &&
        textOf(c as Map<String, dynamic>).contains('Enter your name'));
    final background = children.indexWhere((c) => (c as Map)['type'] == 'IMAGE');

    expect(hint, greaterThanOrEqualTo(0));
    if (background >= 0) {
      expect(
        background,
        lessThan(hint),
        reason: 'the field background is listed after the placeholder, so it hides it',
      );
    }
  });

  testWidgets('a painted panel stays behind the label on top of it', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: Stack(
              children: [
                CustomPaint(painter: _Fill(), size: const Size(200, 80)),
                const Positioned(left: 8, top: 8, child: Text('On top')),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final nodes = flatten((await capture(tester))['frames'][0]['root'] as Map<String, dynamic>);
    final stack = nodes.firstWhere((n) =>
        (n['children'] as List? ?? const []).any((c) => (c as Map)['type'] == 'IMAGE') &&
        (n['children'] as List).any((c) => (c as Map)['type'] == 'TEXT'));

    final children = stack['children'] as List;
    expect((children.first as Map)['type'], 'IMAGE', reason: 'the painted panel should be behind');
    expect((children.last as Map)['type'], 'TEXT', reason: 'the label should be on top');
  });
}
