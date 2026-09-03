import 'dart:convert';

import 'snapshot.dart';

/// Must match `PAYLOAD_PREFIX` in `packages/shared/src/payload.ts`.
const String payloadPrefix = 'C2D1:';

/// The envelope marks its own encoding: `z` is gzipped, `r` is raw. Dart has no
/// gzip on the web, so this side always writes `r`, which the Figma plugin has
/// always accepted.
const String _rawMarker = 'r';

/// Base64 is wrapped into lines for the same reason the web side wraps it:
/// pasting onto the Figma canvas makes a text layer, and one multi-megabyte
/// "word" is the worst possible input for a line breaker.
const int _lineWidth = 120;

String encodePayload(Snapshot snapshot) {
  final json = jsonEncode(snapshot.toJson());
  final encoded = base64.encode(utf8.encode(json));

  final buffer = StringBuffer(payloadPrefix)
    ..write(_rawMarker)
    ..write('\n');
  for (var i = 0; i < encoded.length; i += _lineWidth) {
    final end = i + _lineWidth < encoded.length ? i + _lineWidth : encoded.length;
    buffer.write(encoded.substring(i, end));
    if (end < encoded.length) buffer.write('\n');
  }
  return buffer.toString();
}
