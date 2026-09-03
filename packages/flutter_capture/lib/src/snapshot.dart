/// The capture format, mirrored from `packages/shared/src/types.ts`.
///
/// That TypeScript file is the source of truth: the Figma plugin reads whatever
/// it describes, and it does not care whether a snapshot came from a web page or
/// from a Flutter app. Keep the two in step.
library;

import 'dart:ui' as ui;

const int snapshotVersion = 1;

/// Figma keeps alpha on the paint rather than the colour, so this drops it.
Map<String, double> _rgb(ui.Color color) => {
      'r': (color.r * 255).round() / 255,
      'g': (color.g * 255).round() / 255,
      'b': (color.b * 255).round() / 255,
      'a': 1,
    };

Map<String, dynamic> solidPaint(ui.Color color) => {
      'type': 'SOLID',
      'color': _rgb(color),
      'opacity': color.a,
    };

Map<String, dynamic> gradientPaint({
  required String type,
  required List<List<double>> transform,
  required List<ui.Color> colors,
  required List<double> stops,
}) =>
    {
      'type': type,
      'gradientTransform': transform,
      'gradientStops': [
        for (var i = 0; i < colors.length; i++)
          {
            'position': stops[i].clamp(0.0, 1.0),
            'color': {
              ..._rgb(colors[i]),
              'a': colors[i].a,
            },
          },
      ],
    };

Map<String, dynamic> imagePaint(String assetId, {String scaleMode = 'FILL'}) => {
      'type': 'IMAGE',
      'assetId': assetId,
      'scaleMode': scaleMode,
    };

Map<String, dynamic> dropShadow({
  required ui.Color color,
  required double dx,
  required double dy,
  required double radius,
  double spread = 0,
}) =>
    {
      'type': 'DROP_SHADOW',
      'color': {..._rgb(color), 'a': color.a},
      'offset': {'x': dx, 'y': dy},
      // A Flutter blur radius is a sigma-based Gaussian; Figma's radius reads
      // about half of it, matching the CSS mapping on the web side.
      'radius': radius,
      'spread': spread,
    };

/// One node in the tree the Figma plugin will build.
class SceneNode {
  SceneNode({
    required this.id,
    required this.name,
    required this.type,
    required this.x,
    required this.y,
    required this.width,
    required this.height,
  });

  final String id;
  String name;
  String type;
  double x;
  double y;
  double width;
  double height;

  double? rotation;
  double? opacity;

  List<Map<String, dynamic>>? fills;
  List<Map<String, dynamic>>? strokes;
  double? strokeWeight;
  String? strokeAlign;
  Map<String, double>? corners;
  List<Map<String, dynamic>>? effects;
  bool? clipsContent;

  /// TEXT only.
  List<Map<String, dynamic>>? segments;
  String? textAlignHorizontal;
  String? textAlignVertical;
  String? autoResize;

  /// IMAGE only.
  String? assetId;
  String? scaleMode;

  /// FRAME only.
  List<SceneNode> children = [];
  Map<String, dynamic>? layout;

  Map<String, dynamic> toJson() {
    final json = <String, dynamic>{
      'id': id,
      'name': name,
      'type': type,
      'x': _round(x),
      'y': _round(y),
      'width': _round(width),
      'height': _round(height),
    };
    if (rotation != null && rotation != 0) json['rotation'] = _round(rotation!);
    if (opacity != null && opacity! < 1) json['opacity'] = opacity;
    if (fills != null && fills!.isNotEmpty) json['fills'] = fills;
    if (strokes != null && strokes!.isNotEmpty) {
      json['strokes'] = strokes;
      json['strokeWeight'] = strokeWeight ?? 1;
      json['strokeAlign'] = strokeAlign ?? 'INSIDE';
    }
    if (corners != null) json['corners'] = corners;
    if (effects != null && effects!.isNotEmpty) json['effects'] = effects;
    if (clipsContent != null) json['clipsContent'] = clipsContent;

    if (type == 'TEXT') {
      json['segments'] = segments ?? const [];
      json['textAlignHorizontal'] = textAlignHorizontal ?? 'LEFT';
      json['textAlignVertical'] = textAlignVertical ?? 'TOP';
      json['autoResize'] = autoResize ?? 'NONE';
    }
    if (type == 'IMAGE') {
      json['assetId'] = assetId;
      json['scaleMode'] = scaleMode ?? 'FILL';
    }
    if (type == 'FRAME') {
      json['children'] = [for (final child in children) child.toJson()];
      if (layout != null) json['layout'] = layout;
    }
    return json;
  }
}

double _round(double value) => (value * 100).roundToDouble() / 100;

class CapturedAsset {
  CapturedAsset({
    required this.id,
    required this.data,
    required this.width,
    required this.height,
  });

  final String id;
  final String data;
  final int width;
  final int height;

  Map<String, dynamic> toJson() => {
        'id': id,
        'mime': 'image/png',
        'data': data,
        'width': width,
        'height': height,
      };
}

class Snapshot {
  Snapshot({
    required this.root,
    required this.assets,
    required this.fonts,
    required this.label,
    required this.title,
    required this.nodeCount,
    this.warnings = const [],
  });

  final SceneNode root;
  final Map<String, CapturedAsset> assets;
  final List<Map<String, dynamic>> fonts;
  final String label;
  final String title;
  final int nodeCount;
  final List<String> warnings;

  Map<String, dynamic> toJson() => {
        'version': snapshotVersion,
        'generator': 'code.to.design flutter 0.1.0',
        'source': {
          'url': 'flutter://$title',
          'origin': 'flutter',
          'title': title,
          'capturedAt': DateTime.now().toUtc().toIso8601String(),
          'mode': 'page',
        },
        'frames': [
          {
            'id': 'f1',
            'label': label,
            'viewportWidth': _round(root.width),
            'theme': 'browser',
            'root': root.toJson(),
          }
        ],
        'assets': {
          for (final entry in assets.entries) entry.key: entry.value.toJson(),
        },
        'fonts': fonts,
        'stats': {
          'nodes': nodeCount,
          'images': assets.length,
          'bytes': 0,
          'durationMs': 0,
          'warnings': warnings,
        },
      };
}
