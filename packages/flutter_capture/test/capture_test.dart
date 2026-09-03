import 'dart:convert';
import 'dart:io';

import 'package:code_to_design/code_to_design.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// Pulls the snapshot back out of the clipboard payload, exactly as the Figma
/// plugin's UI does.
Map<String, dynamic> decode(String payload) {
  expect(payload.startsWith('C2D1:'), isTrue, reason: 'wrong envelope: ${payload.substring(0, 10)}');
  final body = payload.substring('C2D1:'.length);
  expect(body[0], 'r', reason: 'Dart writes raw payloads');
  final base64Text = body.substring(1).replaceAll(RegExp(r'\s+'), '');
  return jsonDecode(utf8.decode(base64.decode(base64Text))) as Map<String, dynamic>;
}

List<Map<String, dynamic>> flatten(Map<String, dynamic> node, [List<Map<String, dynamic>>? into]) {
  final out = into ?? <Map<String, dynamic>>[];
  out.add(node);
  for (final child in (node['children'] as List? ?? const [])) {
    flatten(child as Map<String, dynamic>, out);
  }
  return out;
}

String textOf(Map<String, dynamic> node) =>
    (node['segments'] as List).map((s) => (s as Map)['text']).join();

/// Colour helper: the snapshot stores 0..1 channels.
List<int> rgb(Map<String, dynamic> paint) {
  final color = paint['color'] as Map<String, dynamic>;
  return [
    ((color['r'] as num) * 255).round(),
    ((color['g'] as num) * 255).round(),
    ((color['b'] as num) * 255).round(),
  ];
}

void main() {
  _materialSuite();

  late Map<String, dynamic> snapshot;
  late List<Map<String, dynamic>> nodes;
  late String payload;

  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
  });

  testWidgets('captures a known widget tree', (tester) async {
    await tester.pumpWidget(
      Directionality(
        textDirection: TextDirection.ltr,
        child: Align(
          alignment: Alignment.topLeft,
          child: Container(
            width: 320,
            height: 240,
            decoration: BoxDecoration(
              color: const Color(0xFF1E9BF5),
              borderRadius: BorderRadius.circular(12),
              boxShadow: const [
                BoxShadow(color: Color(0x33000000), offset: Offset(0, 4), blurRadius: 12),
              ],
            ),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                const Text(
                  'Hello Figma',
                  style: TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.w700,
                    color: Color(0xFFFFFFFF),
                    letterSpacing: 1.5,
                  ),
                ),
                Container(
                  width: 200,
                  height: 60,
                  decoration: const BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.centerLeft,
                      end: Alignment.centerRight,
                      colors: [Color(0xFFFF0000), Color(0xFF0000FF)],
                    ),
                  ),
                ),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: const [
                    Text('Left', style: TextStyle(fontSize: 12, color: Color(0xFF111111))),
                    SizedBox(width: 16),
                    Text('Right', style: TextStyle(fontSize: 12, color: Color(0xFF111111))),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final result = await captureFlutterApp(label: 'Test');
    payload = result.payload;
    snapshot = decode(payload);
    nodes = flatten(
      (snapshot['frames'] as List).first['root'] as Map<String, dynamic>,
    );

    // Hand the payload to the Node side so the real Figma plugin can import it.
    final out = File('test/out/flutter-payload.c2d');
    out.parent.createSync(recursive: true);
    out.writeAsStringSync(payload);
  });

  test('the payload is the same format the Chrome extension writes', () {
    expect(snapshot['version'], 1);
    expect(snapshot['source']['mode'], 'page');
    expect((snapshot['frames'] as List).length, 1);
    expect(snapshot['frames'][0]['label'], 'Test');
  });

  test('geometry comes straight from the render tree', () {
    final card = nodes.firstWhere(
      (n) => (n['width'] as num) == 320 && (n['height'] as num) == 240,
      orElse: () => throw StateError('the 320x240 container is missing'),
    );
    // Aligned top-left, so it sits at the origin of the capture.
    expect(card['x'], 0);
    expect(card['y'], 0);
  });

  test('a BoxDecoration becomes fills, corners and a shadow', () {
    final card = nodes.firstWhere((n) {
      final fills = n['fills'] as List?;
      if (fills == null || fills.isEmpty) return false;
      return rgb(fills.first as Map<String, dynamic>).toString() == [30, 155, 245].toString();
    }, orElse: () => throw StateError('no node carries the container colour'));

    expect((card['corners'] as Map)['tl'], 12);
    final effects = card['effects'] as List;
    expect(effects.length, 1);
    expect(effects.first['type'], 'DROP_SHADOW');
    expect(effects.first['offset']['y'], 4);
    // Flutter's blurRadius is halved, matching the CSS mapping on the web side.
    expect(effects.first['radius'], 6);
  });

  test('text arrives as a text layer with its real style', () {
    final heading = nodes.firstWhere(
      (n) => n['type'] == 'TEXT' && textOf(n) == 'Hello Figma',
      orElse: () => throw StateError('the heading is missing'),
    );
    final segment = (heading['segments'] as List).first as Map<String, dynamic>;
    expect(segment['fontSize'], 20);
    expect(segment['fontWeight'], 700);
    expect(segment['letterSpacing'], 1.5);
    expect(rgb((segment['fills'] as List).first as Map<String, dynamic>), [255, 255, 255]);
    expect(heading['textAlignHorizontal'], 'LEFT');
  });

  test('every text layer is real text, never an image', () {
    final texts = nodes.where((n) => n['type'] == 'TEXT').map(textOf).toList();
    expect(texts, containsAll(['Hello Figma', 'Left', 'Right']));
    expect(nodes.where((n) => n['type'] == 'IMAGE'), isEmpty);
  });

  test('a LinearGradient becomes a Figma gradient paint', () {
    final gradientNode = nodes.firstWhere(
      (n) => (n['fills'] as List? ?? []).any((f) => (f as Map)['type'] == 'GRADIENT_LINEAR'),
      orElse: () => throw StateError('the gradient container is missing'),
    );
    final paint = (gradientNode['fills'] as List)
        .firstWhere((f) => (f as Map)['type'] == 'GRADIENT_LINEAR') as Map<String, dynamic>;

    final stops = paint['gradientStops'] as List;
    expect(stops.length, 2);
    expect(((stops.first as Map)['color']['r'] as num).round(), 1); // red
    expect(((stops.last as Map)['color']['b'] as num).round(), 1); // blue
    expect(stops.first['position'], 0);
    expect(stops.last['position'], 1);

    final transform = paint['gradientTransform'] as List;
    expect(transform.length, 2);
    expect((transform.first as List).length, 3);
  });

  test('Row and Column become auto layout', () {
    final column = nodes.firstWhere(
      (n) => n['layout'] != null && n['layout']['mode'] == 'VERTICAL',
      orElse: () => throw StateError('the Column produced no auto layout'),
    );
    expect(column['layout']['primaryAxisAlignItems'], 'SPACE_BETWEEN');
    expect(column['layout']['counterAxisAlignItems'], 'CENTER');
    expect((column['layout']['order'] as List).length, (column['children'] as List).length);

    final row = nodes.firstWhere(
      (n) => n['layout'] != null && n['layout']['mode'] == 'HORIZONTAL',
      orElse: () => throw StateError('the Row produced no auto layout'),
    );
    expect(row['layout']['primaryAxisAlignItems'], 'CENTER');
  });

  test('fonts used are reported for the plugin to resolve', () {
    final fonts = snapshot['fonts'] as List;
    expect(fonts, isNotEmpty);
    final weights = (fonts.first as Map)['weights'] as List;
    expect(weights, contains(700));
  });

  test('nothing is silently dropped', () {
    expect(snapshot['stats']['warnings'], isEmpty);
    expect(snapshot['stats']['nodes'], greaterThan(5));
  });
}

/// The tree everyone actually has: Scaffold, AppBar, buttons, icons, list.
void _materialSuite() {
  late List<Map<String, dynamic>> nodes;
  late Map<String, dynamic> snapshot;

  testWidgets('captures a realistic Material app', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData(useMaterial3: true, colorSchemeSeed: const Color(0xFF6750A4)),
        home: Scaffold(
          appBar: AppBar(title: const Text('Dashboard')),
          body: ListView(
            children: [
              const ListTile(
                leading: Icon(Icons.person),
                title: Text('Naqi Abbas'),
                subtitle: Text('Product designer'),
              ),
              Card(
                margin: const EdgeInsets.all(16),
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Revenue'),
                      const SizedBox(height: 8),
                      const Text(
                        '\$12,480',
                        style: TextStyle(fontSize: 28, fontWeight: FontWeight.w600),
                      ),
                    ],
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(16),
                child: FilledButton(onPressed: () {}, child: const Text('Export')),
              ),
            ],
          ),
          floatingActionButton: FloatingActionButton(
            onPressed: () {},
            child: const Icon(Icons.add),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // This screen has icons, which are rasterised. Encoding an image is engine
    // work, and the fake-async zone a widget test runs in deadlocks on it, so the
    // capture has to happen inside runAsync.
    await tester.runAsync(() async {
      final result = await captureFlutterApp(label: 'Material');
      snapshot = decode(result.payload);
      nodes = flatten((snapshot['frames'] as List).first['root'] as Map<String, dynamic>);

      File('test/out/material-payload.c2d')
        ..parent.createSync(recursive: true)
        ..writeAsStringSync(result.payload);
    });
  });

  test('a Material tree captures without warnings or losses', () {
    expect(snapshot['stats']['warnings'], isEmpty);
    expect(nodes.length, greaterThan(8), reason: 'the screen collapsed to almost nothing');
  });

  test('scaffolding layers are pruned away', () {
    // Flutter wraps everything in Align, Padding, Semantics and friends. None of
    // them paints anything, so none should reach Figma: this screen produces well
    // over a hundred such boxes, and they make the layer tree unusable.
    expect(nodes.length, lessThan(40), reason: 'too much scaffolding survived');

    for (final node in nodes.skip(1)) {
      if (node['type'] != 'FRAME') continue;
      final paints = (node['fills'] as List? ?? []).isNotEmpty ||
          (node['strokes'] as List? ?? []).isNotEmpty ||
          (node['effects'] as List? ?? []).isNotEmpty ||
          node['corners'] != null ||
          node['clipsContent'] == true ||
          node['layout'] != null ||
          node['rotation'] != null ||
          node['opacity'] != null;
      expect(paints, isTrue, reason: '${node['name']} paints nothing and should have been pruned');
    }
  });

  test('every visible label arrives as editable text', () {
    final texts = nodes.where((n) => n['type'] == 'TEXT').map(textOf).toList();
    for (final expected in ['Dashboard', 'Naqi Abbas', 'Product designer', 'Revenue', 'Export']) {
      expect(texts, contains(expected), reason: 'texts were: $texts');
    }
  });

  test('the app bar and card carry their real colours', () {
    final coloured = nodes.where((n) => (n['fills'] as List? ?? []).isNotEmpty).length;
    expect(coloured, greaterThan(2), reason: 'almost nothing was painted');
  });

  test('every node has a usable size and position', () {
    for (final node in nodes) {
      expect(node['width'], greaterThan(0), reason: '${node['name']} has no width');
      expect(node['height'], greaterThan(0), reason: '${node['name']} has no height');
      expect((node['x'] as num).isFinite, isTrue);
      expect((node['y'] as num).isFinite, isTrue);
    }
  });
}
