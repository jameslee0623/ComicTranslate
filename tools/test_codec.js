/**
 * test_codec.js - the byte transport that makes Chrome possible at all.
 *
 * Firefox serialises extension messages with the structured clone algorithm, so
 * an ArrayBuffer survives the trip. Chrome serialises with JSON, so a typed
 * array arrives as {}. Every byte-carrying reply therefore goes through
 * CTCodec.packReply before it is sent, and unpackReply on receipt.
 *
 * The decisive test is the JSON round trip - it is literally what Chrome does to
 * a message. The "control" case asserts that bytes ARE destroyed without the
 * codec; if that ever stops being true then codec.js's whole reason for
 * existing has changed and its comment is lying.
 *
 * Runs under jsc. Run via tools/verify.sh from the repository root.
 */

var failures = 0;
function check(name, ok) { print((ok ? '  ok   ' : '  FAIL ') + name); if (!ok) failures++; }
function eq(name, actual, expected) {
  check(name + (actual === expected ? '' : ' (got ' + actual + ', want ' + expected + ')'),
        actual === expected);
}

// --- base64, implemented here because jsc provides neither btoa nor atob ----
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function btoaPoly(binary) {
  var out = '';
  for (var i = 0; i < binary.length; i += 3) {
    var c1 = binary.charCodeAt(i);
    var has2 = i + 1 < binary.length;
    var has3 = i + 2 < binary.length;
    var c2 = has2 ? binary.charCodeAt(i + 1) : 0;
    var c3 = has3 ? binary.charCodeAt(i + 2) : 0;
    out += B64.charAt(c1 >> 2);
    out += B64.charAt(((c1 & 3) << 4) | (c2 >> 4));
    out += has2 ? B64.charAt(((c2 & 15) << 2) | (c3 >> 6)) : '=';
    out += has3 ? B64.charAt(c3 & 63) : '=';
  }
  return out;
}

function atobPoly(str) {
  var s = String(str).replace(/[^A-Za-z0-9+/]/g, '');
  var out = '';
  for (var i = 0; i < s.length; i += 4) {
    var n = (B64.indexOf(s.charAt(i)) << 18) |
            (B64.indexOf(s.charAt(i + 1)) << 12) |
            ((i + 2 < s.length ? B64.indexOf(s.charAt(i + 2)) : 0) << 6) |
            (i + 3 < s.length ? B64.indexOf(s.charAt(i + 3)) : 0);
    out += String.fromCharCode((n >> 16) & 255);
    if (i + 2 < s.length) out += String.fromCharCode((n >> 8) & 255);
    if (i + 3 < s.length) out += String.fromCharCode(n & 255);
  }
  return out;
}

globalThis.window = globalThis;
globalThis.btoa = btoaPoly;
globalThis.atob = atobPoly;

(0, eval)(readFile('src/shared/codec.js'));

function bytesOf(arr) { return new Uint8Array(arr); }

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) { if (a[i] !== b[i]) return false; }
  return true;
}

/** Exactly Chrome's message serialisation: JSON in, JSON out. */
function viaJson(value) { return JSON.parse(JSON.stringify(value)); }

// --- base64 primitives ------------------------------------------------------
eq('base64: empty encodes to empty', CTCodec.toBase64(bytesOf([])), '');
eq('base64: empty decodes to empty', CTCodec.fromBase64('').length, 0);
eq('base64: one byte ("f") is Zg==', CTCodec.toBase64(bytesOf([102])), 'Zg==');
eq('base64: two bytes ("fo") are Zm8=', CTCodec.toBase64(bytesOf([102, 111])), 'Zm8=');
eq('base64: three bytes ("foo") are Zm9v', CTCodec.toBase64(bytesOf([102, 111, 111])), 'Zm9v');
check('base64: fromBase64 returns a Uint8Array, not an ArrayBuffer',
      CTCodec.fromBase64('Zm9v') instanceof Uint8Array);

var all = [];
for (var i = 0; i < 256; i++) all.push(i);
check('base64: all 256 byte values round trip',
      sameBytes(CTCodec.fromBase64(CTCodec.toBase64(bytesOf(all))), bytesOf(all)));

var big = [];
for (var j = 0; j < 70000; j++) big.push((j * 37) & 255);
var bigBytes = bytesOf(big);
check('base64: 70,000 bytes round trip (exercises 0x8000 chunking)',
      sameBytes(CTCodec.fromBase64(CTCodec.toBase64(bigBytes)), bigBytes));

check('base64: accepts a raw ArrayBuffer as well as a Uint8Array',
      CTCodec.toBase64(new Uint8Array([102, 111, 111]).buffer) === 'Zm9v');

// --- a fetched image, as imageFetch sends it back ---------------------------
var pixelBytes = bytesOf([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
var packed = CTCodec.packReply({ ok: true, bytes: pixelBytes, mime: 'image/png' });

check('packReply: removes `bytes` from the wire form', packed.bytes === undefined);
eq('packReply: adds a bytesB64 string', typeof packed.bytesB64, 'string');
eq('packReply: keeps unrelated fields', packed.ok, true);
eq('packReply: keeps the mime type', packed.mime, 'image/png');

var restored = CTCodec.unpackReply(viaJson(packed));
check('unpackReply: bytes survive a JSON round trip (what Chrome does)',
      sameBytes(restored.bytes, pixelBytes));
eq('unpackReply: mime survives', restored.mime, 'image/png');
eq('unpackReply: consumes bytesB64', restored.bytesB64, undefined);

// Control: proves the codec is load-bearing rather than decorative.
var control = viaJson({ ok: true, bytes: pixelBytes, mime: 'image/png' });
check('control: an UNPACKED reply loses its bytes through JSON',
      !sameBytes(control.bytes, pixelBytes));

// --- a full-image engine result (Lara), which nests its bytes ---------------
var imageResult = {
  regions: [],
  targetLang: 'zh-TW',
  image: { bytes: bytesOf([1, 2, 3, 4, 5]), mime: 'image/png' },
  diagnostics: { model: 'inpainting' }
};
var packedImage = CTCodec.packReply(imageResult);
check('packReply: encodes a nested image.bytes', packedImage.image.bytes === undefined);

var backImage = CTCodec.unpackReply(viaJson(packedImage));
check('unpackReply: nested image bytes survive JSON',
      sameBytes(backImage.image.bytes, bytesOf([1, 2, 3, 4, 5])));
eq('unpackReply: nested mime survives', backImage.image.mime, 'image/png');
eq('unpackReply: regions survive', backImage.regions.length, 0);
eq('unpackReply: diagnostics survive', backImage.diagnostics.model, 'inpainting');

// --- byte-free replies must be untouched ------------------------------------
var plain = { stats: { translated: 2 }, lastError: null };
check('packReply: leaves byte-free replies byte-identical',
      JSON.stringify(CTCodec.packReply(plain)) === JSON.stringify(plain));
check('packReply: null passes through', CTCodec.packReply(null) === null);
check('unpackReply: null passes through', CTCodec.unpackReply(null) === null);
check('packReply: an object with no bytes gains no bytesB64',
      CTCodec.packReply({ ok: true }).bytesB64 === undefined);

print('');
if (failures) {
  print('codec: ' + failures + ' FAILURE(S)');
  throw new Error('codec tests failed');
}
print('codec: PASSED');
