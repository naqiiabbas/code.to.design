import 'dart:convert';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import 'snapshot.dart';

/// Reads a running Flutter app straight off its render tree.
///
/// This is the counterpart to the Chrome extension's DOM walker, and it has an
/// easier job: where the web side has to infer intent from computed CSS, Flutter
/// hands over exact geometry (`localToGlobal` plus `size`) and widgets that
/// already say what they are - a `BoxDecoration` names its gradient, a
/// `TextStyle` names its weight, a `Row` is unambiguously a horizontal stack.
class FlutterCapture {
  FlutterCapture({this.label = 'Flutter'});

  final String label;

  final Map<String, CapturedAsset> _assets = {};
  final Map<String, Set<int>> _fonts = {};
  final List<String> _warnings = [];
  final List<_PendingImage> _pendingImages = [];
  int _nodeCounter = 0;
  int _assetCounter = 0;
  int _nodeCount = 0;

  String _nextId() => 'n${++_nodeCounter}';

  /// Walks the tree below [rootElement] and returns a snapshot the Figma plugin
  /// can import unchanged.
  Future<Snapshot> capture(Element rootElement) async {
    final rootBox = _firstBox(rootElement);
    if (rootBox == null) {
      throw StateError('The widget tree has no laid-out RenderBox to capture.');
    }

    final origin = _globalOf(rootBox) ?? Offset.zero;
    final root = SceneNode(
      id: 'root',
      name: label,
      type: 'FRAME',
      x: 0,
      y: 0,
      width: rootBox.size.width,
      height: rootBox.size.height,
    )
      ..fills = [solidPaint(const ui.Color(0xFFFFFFFF))]
      ..clipsContent = true;
    _nodeCount++;

    rootElement.visitChildren((child) => _visit(child, rootBox, origin, root));

    // A Flutter tree is mostly scaffolding - Align, Padding, ConstrainedBox,
    // Semantics - none of which paints anything. Positions are derived from
    // global coordinates, so those layers can be dropped and their children
    // reparented without moving a pixel. It typically removes 80% of the layers,
    // which is the difference between a readable Figma file and an unusable one.
    root.children = [for (final child in root.children) ..._prune(child, false)];
    _nodeCount = _count(root);

    // Image bytes only become available asynchronously, so they are gathered
    // during the walk and encoded once it is done.
    for (final pending in _pendingImages) {
      final data = await _encodePng(pending.image);
      if (data == null) {
        _warn('An image could not be encoded and was left blank.');
        continue;
      }
      _assets[pending.id] = CapturedAsset(
        id: pending.id,
        data: data,
        width: pending.image.width,
        height: pending.image.height,
      );
    }

    return Snapshot(
      root: root,
      assets: _assets,
      fonts: [
        for (final entry in _fonts.entries)
          {
            'family': entry.key,
            'weights': entry.value.toList()..sort(),
            'italic': false,
          },
      ],
      label: label,
      title: label,
      nodeCount: _nodeCount,
      warnings: _warnings,
    );
  }

  /* ------------------------------------------------------------------ walk */

  void _visit(Element element, RenderBox ancestorBox, Offset ancestorOrigin, SceneNode parent) {
    final render = element.renderObject;

    // Elements that build other widgets have no render object of their own; walk
    // straight through them so only real boxes become layers.
    if (render is! RenderBox || identical(render, ancestorBox)) {
      element.visitChildren((child) => _visit(child, ancestorBox, ancestorOrigin, parent));
      return;
    }
    if (!render.attached || !render.hasSize) return;

    final global = _globalOf(render);
    if (global == null) return;

    final size = render.size;
    if (size.width <= 0 || size.height <= 0) {
      // A zero-size box still positions its children; hoist them up rather than
      // emitting a layer Figma would reject.
      element.visitChildren((child) => _visit(child, render, global, parent));
      return;
    }

    final node = SceneNode(
      id: _nextId(),
      name: element.widget.runtimeType.toString(),
      type: 'FRAME',
      x: global.dx - ancestorOrigin.dx,
      y: global.dy - ancestorOrigin.dy,
      width: size.width,
      height: size.height,
    );
    _nodeCount++;

    final widget = element.widget;
    var descend = true;

    if (render is RenderParagraph) {
      _applyText(node, render);
      descend = false;
    } else if (render is RenderImage) {
      _applyImage(node, render);
      descend = false;
    } else if (widget is DecoratedBox) {
      _applyDecoration(node, widget.decoration, size);
    } else if (widget is ColoredBox) {
      node.fills = [solidPaint(widget.color)];
    } else if (widget is Material) {
      // Material 3 paints app bars, cards, sheets and buttons through `Material`
      // rather than a DecoratedBox, and it does it inside a private painter. The
      // widget itself is public and says everything we need.
      _applyMaterial(node, widget, size);
    } else if (widget is PhysicalShape) {
      _applyPhysical(node, widget.color, widget.elevation, widget.shadowColor, null);
    } else if (widget is PhysicalModel) {
      _applyPhysical(node, widget.color, widget.elevation, widget.shadowColor, widget.borderRadius);
    } else if (widget is Opacity) {
      node.opacity = widget.opacity;
    } else if (widget is Transform) {
      _applyRotation(node, widget.transform);
    } else if (widget is ClipRRect) {
      node.clipsContent = true;
      node.corners = _corners(widget.borderRadius.resolve(TextDirection.ltr));
    } else if (widget is ClipRect || widget is ClipOval || widget is ClipPath) {
      node.clipsContent = true;
    }

    parent.children.add(node);

    if (descend) {
      element.visitChildren((child) => _visit(child, render, global, node));
    }

    // Auto layout is applied after the children exist, because it needs their ids.
    if (render is RenderFlex && node.children.isNotEmpty) {
      _applyFlex(node, render);
    }
  }

  /// True when a frame would look like something on the canvas.
  bool _paintsSomething(SceneNode node) =>
      (node.fills?.isNotEmpty ?? false) ||
      (node.strokes?.isNotEmpty ?? false) ||
      (node.effects?.isNotEmpty ?? false) ||
      node.corners != null ||
      (node.clipsContent ?? false) ||
      node.layout != null ||
      node.rotation != null ||
      (node.opacity != null && node.opacity! < 1);

  /// Drops frames that paint nothing, hoisting their children into the parent.
  ///
  /// [parentHasLayout] keeps the direct children of an auto-layout frame intact:
  /// that frame's `order` refers to them by id, so removing one would break it.
  List<SceneNode> _prune(SceneNode node, bool parentHasLayout) {
    final keepChildren = node.layout != null;
    node.children = [
      for (final child in node.children) ..._prune(child, keepChildren),
    ];

    if (node.type != 'FRAME' || parentHasLayout || _paintsSomething(node)) return [node];

    for (final child in node.children) {
      child.x += node.x;
      child.y += node.y;
    }
    return node.children;
  }

  int _count(SceneNode node) {
    var total = 1;
    for (final child in node.children) {
      total += _count(child);
    }
    return total;
  }

  RenderBox? _firstBox(Element element) {
    RenderBox? found;
    void search(Element candidate) {
      if (found != null) return;
      final render = candidate.renderObject;
      if (render is RenderBox && render.attached && render.hasSize) {
        found = render;
        return;
      }
      candidate.visitChildren(search);
    }

    search(element);
    return found;
  }

  Offset? _globalOf(RenderBox box) {
    try {
      return box.localToGlobal(Offset.zero);
    } catch (_) {
      // Not attached to a view yet.
      return null;
    }
  }

  /* ------------------------------------------------------------------ text */

  void _applyText(SceneNode node, RenderParagraph paragraph) {
    node.type = 'TEXT';
    final segments = <Map<String, dynamic>>[];
    _collectSpans(paragraph.text, null, segments);
    if (segments.isEmpty) {
      node.type = 'FRAME';
      return;
    }
    node.segments = segments;
    node.name = _shortName(segments.map((s) => s['text'] as String).join());
    node.textAlignHorizontal = switch (paragraph.textAlign) {
      TextAlign.center => 'CENTER',
      TextAlign.right => 'RIGHT',
      TextAlign.end => 'RIGHT',
      TextAlign.justify => 'JUSTIFIED',
      _ => 'LEFT',
    };
    node.textAlignVertical = 'TOP';
    node.autoResize = 'NONE';
    // A hair of slack absorbs metric differences between Flutter and Figma so a
    // line that just fits does not wrap on import.
    node.width = node.width + 1;
  }

  void _collectSpans(InlineSpan span, TextStyle? inherited, List<Map<String, dynamic>> out) {
    if (span is TextSpan) {
      final style = inherited == null ? span.style : inherited.merge(span.style);
      final text = span.text;
      if (text != null && text.isNotEmpty) {
        out.add(_segment(text, style));
      }
      for (final child in span.children ?? const <InlineSpan>[]) {
        _collectSpans(child, style, out);
      }
    }
  }

  Map<String, dynamic> _segment(String text, TextStyle? style) {
    final family = style?.fontFamily ?? 'Roboto';
    final weight = style?.fontWeight?.value ?? 400;
    final fontSize = style?.fontSize ?? 14.0;
    _fonts.putIfAbsent(family, () => <int>{}).add(weight);

    final decoration = style?.decoration;
    final decorationName = decoration == null
        ? 'NONE'
        : decoration.contains(TextDecoration.lineThrough)
            ? 'STRIKETHROUGH'
            : decoration.contains(TextDecoration.underline)
                ? 'UNDERLINE'
                : 'NONE';

    return {
      'text': text,
      'fontFamily': family,
      'fontStack': [family],
      'fontWeight': weight,
      'italic': style?.fontStyle == FontStyle.italic,
      'fontSize': fontSize,
      'letterSpacing': style?.letterSpacing ?? 0,
      // Flutter's `height` is a multiple of the font size; Figma wants pixels.
      'lineHeight': style?.height == null ? null : style!.height! * fontSize,
      'fills': [solidPaint(style?.color ?? const ui.Color(0xFF000000))],
      'textDecoration': decorationName,
      'textCase': 'ORIGINAL',
    };
  }

  /* ----------------------------------------------------------------- image */

  void _applyImage(SceneNode node, RenderImage render) {
    final image = render.image;
    if (image == null) {
      _warn('An image had not finished loading and was left blank.');
      return;
    }
    final id = 'a${++_assetCounter}';
    _pendingImages.add(_PendingImage(id, image));
    node.type = 'IMAGE';
    node.assetId = id;
    node.scaleMode = switch (render.fit) {
      BoxFit.contain || BoxFit.scaleDown || BoxFit.none => 'FIT',
      _ => 'FILL',
    };
  }

  Future<String?> _encodePng(ui.Image image) async {
    try {
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      if (data == null) return null;
      return base64Encode(data.buffer.asUint8List());
    } catch (_) {
      return null;
    }
  }

  /* ------------------------------------------------------------ decoration */

  void _applyDecoration(SceneNode node, Decoration decoration, Size size) {
    if (decoration is! BoxDecoration) return;

    final fills = <Map<String, dynamic>>[];
    if (decoration.color != null) fills.add(solidPaint(decoration.color!));
    final gradient = decoration.gradient;
    if (gradient != null) {
      final paint = _gradient(gradient, size);
      if (paint != null) fills.add(paint);
    }
    if (fills.isNotEmpty) node.fills = fills;

    final border = decoration.border;
    if (border is Border && border.top.style != BorderStyle.none && border.top.width > 0) {
      node.strokes = [solidPaint(border.top.color)];
      node.strokeWeight = border.top.width;
      node.strokeAlign = 'INSIDE';
    }

    final radius = decoration.borderRadius?.resolve(TextDirection.ltr);
    if (radius != null) node.corners = _corners(radius);
    if (decoration.shape == BoxShape.circle) {
      final r = math.min(size.width, size.height) / 2;
      node.corners = {'tl': r, 'tr': r, 'br': r, 'bl': r};
    }

    final shadows = decoration.boxShadow;
    if (shadows != null && shadows.isNotEmpty) {
      node.effects = [
        for (final shadow in shadows)
          dropShadow(
            color: shadow.color,
            dx: shadow.offset.dx,
            dy: shadow.offset.dy,
            radius: shadow.blurRadius / 2,
            spread: shadow.spreadRadius,
          ),
      ];
    }
  }

  void _applyPhysical(
    SceneNode node,
    ui.Color color,
    double elevation,
    ui.Color shadowColor,
    BorderRadius? radius,
  ) {
    node.fills = [solidPaint(color)];
    if (radius != null) node.corners = _corners(radius);
    if (elevation > 0) {
      // Material elevation is not a blur radius; this is the usual approximation
      // and lands close to what the app looks like.
      node.effects = [
        dropShadow(
          color: shadowColor.withValues(alpha: 0.28),
          dx: 0,
          dy: elevation / 2,
          radius: elevation,
        ),
      ];
    }
  }

  void _applyMaterial(SceneNode node, Material material, Size size) {
    if (material.color != null) node.fills = [solidPaint(material.color!)];

    final radius = material.borderRadius?.resolve(TextDirection.ltr) ?? _shapeRadius(material.shape, size);
    if (radius != null) node.corners = _corners(radius);

    if (material.elevation > 0) {
      node.effects = [
        dropShadow(
          color: (material.shadowColor ?? const ui.Color(0xFF000000)).withValues(alpha: 0.24),
          dx: 0,
          dy: material.elevation / 2,
          radius: material.elevation,
        ),
      ];
    }
  }

  /// Turns the shapes Material actually uses into corner radii.
  BorderRadius? _shapeRadius(ShapeBorder? shape, Size size) {
    if (shape is RoundedRectangleBorder) {
      return shape.borderRadius.resolve(TextDirection.ltr);
    }
    if (shape is StadiumBorder) {
      return BorderRadius.circular(math.min(size.width, size.height) / 2);
    }
    if (shape is CircleBorder) {
      return BorderRadius.circular(math.min(size.width, size.height) / 2);
    }
    return null;
  }

  Map<String, double> _corners(BorderRadius radius) => {
        'tl': radius.topLeft.x,
        'tr': radius.topRight.x,
        'br': radius.bottomRight.x,
        'bl': radius.bottomLeft.x,
      };

  void _applyRotation(SceneNode node, Matrix4 matrix) {
    final a = matrix.storage[0];
    final b = matrix.storage[1];
    final degrees = -math.atan2(b, a) * 180 / math.pi;
    if (degrees.abs() > 0.01) node.rotation = degrees;
  }

  /* -------------------------------------------------------------- gradients */

  Map<String, dynamic>? _gradient(Gradient gradient, Size size) {
    final stops = _stops(gradient.colors.length, gradient.stops);
    if (gradient is LinearGradient) {
      final begin = _alignmentToPixels(gradient.begin, size);
      final end = _alignmentToPixels(gradient.end, size);
      return gradientPaint(
        type: 'GRADIENT_LINEAR',
        transform: _handlesToTransform(begin, end, _perpendicular(begin, end), size),
        colors: gradient.colors,
        stops: stops,
      );
    }
    if (gradient is RadialGradient) {
      final center = _alignmentToPixels(gradient.center, size);
      final r = gradient.radius * math.max(size.width, size.height);
      return gradientPaint(
        type: 'GRADIENT_RADIAL',
        transform: _handlesToTransform(
          center,
          Offset(center.dx + r, center.dy),
          Offset(center.dx, center.dy + r),
          size,
        ),
        colors: gradient.colors,
        stops: stops,
      );
    }
    if (gradient is SweepGradient) {
      final center = _alignmentToPixels(gradient.center, size);
      final r = math.max(size.width, size.height) / 2;
      return gradientPaint(
        type: 'GRADIENT_ANGULAR',
        transform: _handlesToTransform(
          center,
          Offset(center.dx, center.dy - r),
          Offset(center.dx + r, center.dy),
          size,
        ),
        colors: gradient.colors,
        stops: stops,
      );
    }
    return null;
  }

  List<double> _stops(int count, List<double>? declared) {
    if (declared != null && declared.length == count) return declared;
    if (count == 1) return [0];
    return [for (var i = 0; i < count; i++) i / (count - 1)];
  }

  Offset _alignmentToPixels(AlignmentGeometry geometry, Size size) {
    final alignment = geometry.resolve(TextDirection.ltr);
    return Offset(
      (alignment.x + 1) / 2 * size.width,
      (alignment.y + 1) / 2 * size.height,
    );
  }

  Offset _perpendicular(Offset from, Offset to) =>
      Offset(from.dx - (to.dy - from.dy), from.dy + (to.dx - from.dx));

  /// Figma derives the gradient handles by inverting `gradientTransform`, so the
  /// forward matrix is built from the handles and inverted. Same maths as the
  /// web side, in normalised 0..1 space.
  List<List<double>> _handlesToTransform(Offset h0, Offset h1, Offset h2, Size size) {
    final w = size.width == 0 ? 1 : size.width;
    final h = size.height == 0 ? 1 : size.height;
    final n0 = Offset(h0.dx / w, h0.dy / h);
    final n1 = Offset(h1.dx / w, h1.dy / h);
    final n2 = Offset(h2.dx / w, h2.dy / h);

    final a = n1.dx - n0.dx;
    final b = n1.dy - n0.dy;
    final c = n2.dx - n0.dx;
    final d = n2.dy - n0.dy;
    final det = a * d - b * c;
    if (det == 0 || !det.isFinite) {
      return [
        [1, 0, 0],
        [0, 1, 0],
      ];
    }
    final ia = d / det;
    final ib = -b / det;
    final ic = -c / det;
    final id = a / det;
    return [
      [ia, ic, -(ia * n0.dx + ic * n0.dy)],
      [ib, id, -(ib * n0.dx + id * n0.dy)],
    ];
  }

  /* ------------------------------------------------------------ auto layout */

  void _applyFlex(SceneNode node, RenderFlex flex) {
    node.layout = {
      'mode': flex.direction == Axis.horizontal ? 'HORIZONTAL' : 'VERTICAL',
      'primaryAxisAlignItems': switch (flex.mainAxisAlignment) {
        MainAxisAlignment.center => 'CENTER',
        MainAxisAlignment.end => 'MAX',
        MainAxisAlignment.spaceBetween ||
        MainAxisAlignment.spaceAround ||
        MainAxisAlignment.spaceEvenly =>
          'SPACE_BETWEEN',
        _ => 'MIN',
      },
      'counterAxisAlignItems': switch (flex.crossAxisAlignment) {
        CrossAxisAlignment.center => 'CENTER',
        CrossAxisAlignment.end => 'MAX',
        CrossAxisAlignment.baseline => 'BASELINE',
        _ => 'MIN',
      },
      // Flutter expresses gaps as real SizedBox children, which become real
      // layers, so the spacing between items is already accounted for.
      'itemSpacing': 0,
      'counterAxisSpacing': 0,
      'wrap': false,
      'padding': {'top': 0, 'right': 0, 'bottom': 0, 'left': 0},
      'order': [for (final child in node.children) child.id],
    };
  }

  /* ---------------------------------------------------------------- helpers */

  void _warn(String message) {
    if (_warnings.length < 20 && !_warnings.contains(message)) _warnings.add(message);
  }

  String _shortName(String text) {
    final clean = text.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (clean.isEmpty) return 'Text';
    return clean.length > 30 ? '${clean.substring(0, 30)}...' : clean;
  }
}

class _PendingImage {
  _PendingImage(this.id, this.image);

  final String id;
  final ui.Image image;
}

