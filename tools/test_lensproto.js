/**
 * Decoder tests for the Lens protobuf engine, run against REAL captured responses.
 *
 * This is the strongest test in the project: the fixtures are genuine server
 * payloads from lensfrontend-pa.googleapis.com, so passing means the decoder
 * handles the actual wire format, not an assumption about it.
 *
 * Runs under jsc (no Node, no browser). Run via tools/verify.sh.
 */

globalThis.window = globalThis;

eval(readFile('src/background/protobuf.js'));
eval(readFile('src/background/lensProto.js'));
eval(readFile('src/background/translator.js'));
eval(readFile('tools/fixtures/lens_responses.js'));

var P = globalThis.CTProto;
var L = globalThis.CTLensProto;
var T = globalThis.CTTranslator;
var FIX = globalThis.CT_LENS_FIXTURES;
var CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

var pass = 0;
var fail = 0;

function check(name, actual, expected) {
  var a = JSON.stringify(actual);
  var e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    fail++;
    print('  FAIL ' + name + '\n         expected ' + e + '\n         actual   ' + a);
  }
}

function checkTruthy(name, value) {
  if (value) { pass++; }
  else { fail++; print('  FAIL ' + name + ' (got ' + JSON.stringify(value) + ')'); }
}

function hexToBytes(hex) {
  var out = new Uint8Array(hex.length / 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function indexOfBytes(haystack, needle) {
  outer:
  for (var i = 0; i <= haystack.length - needle.length; i++) {
    for (var j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// ------------------------------------------------------------ wire codec ----
print('--- protobuf wire codec ---');
check('varint 0', Array.from(P.varintBytes(0)), [0]);
check('varint 1', Array.from(P.varintBytes(1)), [1]);
check('varint 127', Array.from(P.varintBytes(127)), [127]);
check('varint 128 is two bytes', Array.from(P.varintBytes(128)), [0x80, 1]);
check('varint 300', Array.from(P.varintBytes(300)), [0xac, 2]);

var roundTrip = P.concat([P.fInt(1, 7), P.fBytes(2, 'hello'), P.fInt(3, 300)]);
var back = {};
new P.Reader(roundTrip).each(function (f, w, v) { back[f] = v; });
check('round trip int', back[1], 7);
check('round trip string', P.decodeUtf8(back[2]), 'hello');
check('round trip varint 300', back[3], 300);

print('--- Reader bounds safety ---');
var threw = false;
try {
  // field 2 with an absurd declared length: must throw, not read past the end.
  new P.Reader(new Uint8Array([0x12, 0xff, 0xff])).each(function () {});
} catch (e) {
  threw = true;
}
checkTruthy('overrunning length-delimited field throws instead of reading past the buffer', threw);

// -------------------------------------------------- real response: latin ----
print('--- REAL RESPONSE: latin fixture ---');
var enBytes = hexToBytes(FIX.en.hex);
check('fixture size matches bytes', enBytes.length, FIX.en.byteLength);

var en = L.parseResponse(enBytes);
check('detected language is en', en.language, 'en');
checkTruthy('no server error', !en.error);
checkTruthy('paragraphs parsed', en.paragraphs.length > 0);

// The typed parser is the primary path; the deep sweep is only a fallback for
// response variants that defeat it. Both must recover the real words.
var enRegions = L.regionsFromText(en, FIX.en.width, FIX.en.height);
check('three latin lines decoded exactly', enRegions.map(function (r) { return r.text; }),
      ['HELLO WORLD', 'HELLO WORLD', 'HELLO WORLD']);

var enWords = L.collectWordsDeep(enBytes, [], 0).map(function (w) { return w.text; });
print('  sweep found: ' + JSON.stringify(enWords));
checkTruthy('sweep fallback also finds HELLO', enWords.indexOf('HELLO') !== -1);
checkTruthy('sweep fallback also finds WORLD', enWords.indexOf('WORLD') !== -1);
// Opaque identifiers must not be mistaken for OCR text.
checkTruthy('no opaque "text:0:..." ids leaked into words',
  enWords.every(function (w) { return w.indexOf('text:0:') === -1; }));
checkTruthy('no opaque "text:0:..." ids leaked into regions',
  enRegions.every(function (r) { return r.text.indexOf('text:0:') === -1; }));
checkTruthy('every region has text',
  enRegions.every(function (r) { return r.text.trim().length > 0; }));
checkTruthy('every region has a box inside the image',
  enRegions.every(function (r) {
    return r.bbox.w > 1 && r.bbox.h > 1 &&
           r.bbox.x >= -5 && r.bbox.y >= -5 &&
           r.bbox.x < FIX.en.width && r.bbox.y < FIX.en.height;
  }));
// The fixture is three lines of text near the top of a 927x1200 page, so the
// boxes must land there - this is what proves the normalised-to-pixel maths.
checkTruthy('boxes land in the top-left region where the text was rendered',
  enRegions.every(function (r) { return r.bbox.x < 200 && r.bbox.y < 200; }));

print('--- word sweep is a tolerant fallback ---');
var enSweep = L.collectWordsDeep(enBytes, [], 0);
checkTruthy('sweep returns an array on the latin fixture',
  Object.prototype.toString.call(enSweep) === '[object Array]');
// The sweep probes chunks that are not necessarily protobuf messages, so
// arbitrary garbage must be ignored, never thrown: a truncated varint, a
// declared length that overruns the buffer, bare terminator bytes.
[Uint8Array.of(0xff, 0xff, 0xff, 0xff),
 Uint8Array.of(0x0a, 0xff, 0xff),
 Uint8Array.of(0x12, 0x80, 0x80, 0x80, 0x01, 0x00),
 Uint8Array.of(0x00)].forEach(function (g, i) {
  checkTruthy('sweep survives garbage input #' + i, (function () {
    L.collectWordsDeep(g, [], 0);
    return true;
  })());
});

// ------------------------------------------------- real response: japanese --
print('--- REAL RESPONSE: japanese fixture ---');
var jpBytes = hexToBytes(FIX.jp.hex);
check('fixture size matches bytes', jpBytes.length, FIX.jp.byteLength);

var jp = L.parseResponse(jpBytes);
check('detected language is ja', jp.language, 'ja');
checkTruthy('no server error', jp.error === null || jp.error === undefined);

var jpRegions = L.regionsFromText(jp, FIX.jp.width, FIX.jp.height);
print('  regions: ' + JSON.stringify(jpRegions.map(function (r) {
  return { text: r.text, bbox: r.bbox };
})));
check('japanese lines decoded exactly', jpRegions.map(function (r) { return r.text; }),
      ['こんにちは', '世界', 'さようなら']);
checkTruthy('japanese regions have sane boxes', jpRegions.every(function (r) {
  return r.bbox.w > 1 && r.bbox.h > 1 && r.bbox.x >= -5 && r.bbox.y >= -5;
}));
var jpWords = L.collectWordsDeep(jpBytes, [], 0).map(function (w) { return w.text; });
checkTruthy('japanese sweep finds CJK words', jpWords.some(function (w) { return CJK.test(w); }));
checkTruthy('japanese sweep does not throw', (function () {
  L.collectWordsDeep(jpBytes, [], 0);
  return true;
})());

// ------------------------------------------------------ geometry maths ------
print('--- normalised box to pixels ---');
check('centred half-size box',
  L.boxToPixels({ cx: 0.5, cy: 0.5, w: 0.5, h: 0.5 }, 1000, 1000),
  { x: 250, y: 250, w: 500, h: 500 });
check('box in the top-left corner',
  L.boxToPixels({ cx: 0.1, cy: 0.1, w: 0.2, h: 0.2 }, 1000, 1000),
  { x: 0, y: 0, w: 200, h: 200 });
check('non-square image scales axes independently',
  L.boxToPixels({ cx: 0.5, cy: 0.25, w: 1, h: 0.5 }, 800, 400),
  { x: 0, y: 0, w: 800, h: 200 });

print('--- rescaling regions back to the original image ---');
var up = L.rescaleRegions(
  [{ text: 'a', bbox: { x: 10, y: 20, w: 30, h: 40 }, translated: '' }],
  500, 1000, 1000, 2000);
check('2x upscale doubles boxes', up[0].bbox, { x: 20, y: 40, w: 60, h: 80 });
var same = [{ text: 'a', bbox: { x: 1, y: 1, w: 2, h: 2 } }];
check('same size returns input as-is',
  L.rescaleRegions(same, 100, 100, 100, 100)[0].bbox, { x: 1, y: 1, w: 2, h: 2 });
check('unknown original size returns input as-is',
  L.rescaleRegions(same, 100, 100, 0, 0)[0].bbox, { x: 1, y: 1, w: 2, h: 2 });

print('--- translator reply parsing ---');
check('pairs array',
  T.parseReply('[["你好","ja"],["世界","zh-CN"]]'), ['你好', '世界']);
check('bare strings array', T.parseReply('["a","b"]'), ['a', 'b']);
check('null entries become empty', T.parseReply('[["x","ja"],null]'), ['x', '']);
var trThrew = false;
try { T.parseReply('<html>Sorry...</html>'); } catch (e) { trThrew = true; }
checkTruthy('blocked-HTML reply throws instead of misaligning', trThrew);
trThrew = false;
try { T.parseReply('{"error":"nope"}'); } catch (e) { trThrew = true; }
checkTruthy('non-array JSON throws', trThrew);

print('--- translator batch planning ---');
var many = [];
for (var wi = 0; wi < 40; wi++) many.push('w' + wi);
var plan = T.planBatches(many, many.map(function (_, k) { return k; }), 0);
check('40 strings split into two batches', plan.length, 2);
check('first batch capped at 32', plan[0].length, 32);
var huge = [new Array(901).join('a'), new Array(901).join('b')];
plan = T.planBatches(huge, [0, 1], 0);
check('URL budget forces one string per batch', plan.length, 2);

// ------------------------------------------------------ request building ----
print('--- request building ---');
var req = L.buildRequest(new Uint8Array([1, 2, 3, 4]), 100, 200, {});
checkTruthy('request is non-empty', req.length > 20);
check('request starts with ServerRequest field 1 (ObjectsRequest)', req[0], 0x0a);
checkTruthy('image bytes are embedded', indexOfBytes(req, [1, 2, 3, 4]) !== -1);
checkTruthy('width embedded as a varint', indexOfBytes(req, [0x08, 100]) !== -1);
checkTruthy('height embedded as a varint', indexOfBytes(req, [0x10, 200]) !== -1);

print('--- API constants ---');
check('endpoint', L.PROTO_ENDPOINT, 'https://lensfrontend-pa.googleapis.com/v1/crupload');
check('auto filter id', L.FILTER_AUTO, 7);
check('translate filter id', L.FILTER_TRANSLATE, 2);

print('');
print('lensproto: PASSED ' + pass + ', FAILED ' + fail);
if (fail > 0) throw new Error('lens protobuf tests failed');