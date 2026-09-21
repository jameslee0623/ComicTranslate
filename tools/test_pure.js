/**
 * Functional tests for the dependency-free pure logic in the content scripts.
 *
 * Runs under jsc (JavaScriptCore) so it needs no Node and no browser. It covers
 * the parts that are easy to get subtly wrong and hard to see on screen: script
 * tokenisation, line wrapping, font-size fitting, and bubble colour sampling.
 *
 * Run via tools/verify.sh from the repository root.
 */
var ROOT = 'src/content/';

eval(readFile(ROOT + 'textLayout.js'));
eval(readFile(ROOT + 'painter.js'));

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

/** A stand-in canvas context: every glyph is 10px wide. */
function fakeCtx(charWidth) {
  var w = charWidth === undefined ? 10 : charWidth;
  return {
    font: '',
    measureText: function (text) { return { width: String(text).length * w }; }
  };
}

var TL = globalThis.CTTextLayout;
var P = globalThis.CTPainter;

print('--- tokenize ---');
check('latin split on spaces',
  TL.tokenize('Hello there world').map(function (t) { return t.text; }),
  ['Hello', ' ', 'there', ' ', 'world']);
check('CJK split per character',
  TL.tokenize('こんにちは').map(function (t) { return t.text; }),
  ['こ', 'ん', 'に', 'ち', 'は']);
check('whitespace collapsed',
  TL.tokenize('  a   b  ').map(function (t) { return t.text; }),
  ['a', ' ', 'b']);
check('empty input yields nothing', TL.tokenize('   '), []);

print('--- isRtl ---');
check('hebrew is rtl', TL.isRtl('שלום'), true);
check('arabic is rtl', TL.isRtl('مرحبا'), true);
check('english is not rtl', TL.isRtl('hello'), false);
check('japanese is not rtl', TL.isRtl('日本語'), false);

print('--- wrapTokens (10px per char) ---');
var ctx = fakeCtx(10);
check('wraps at width, keeps words whole',
  TL.wrapTokens(ctx, TL.tokenize('aaaa bbbb cccc'), 100),
  ['aaaa bbbb', 'cccc']);
// Regression: a word wider than the line must be hard-broken, otherwise it
// overflows the box and fitText shrinks the entire block to compensate.
check('long word is hard-broken',
  TL.wrapTokens(ctx, TL.tokenize('aaaaaaaaaaaaaaaaaaaa'), 100),
  ['aaaaaaaaaa', 'aaaaaaaaaa']);
check('CJK wraps without spaces',
  TL.wrapTokens(ctx, TL.tokenize('あいうえおかきくけこ'), 50),
  ['あいうえお', 'かきくけこ']);

print('--- fitText ---');
var fit = TL.fitText(ctx, { text: 'hello world', boxW: 200, boxH: 60, padding: 4 });
checkTruthy('produces a positive font size', fit.fontSize > 0);
checkTruthy('produces at least one line', fit.lines.length > 0);
checkTruthy('fitted lines fit the box width',
  fit.lines.every(function (l) { return l.length * 10 <= 200 - 8; }));
checkTruthy('fitted block fits the box height',
  fit.lines.length * fit.lineHeight <= 60 - 8);

print('--- fitText overflow fallback ---');
var tiny = TL.fitText(ctx, { text: 'a very long sentence indeed here', boxW: 20, boxH: 8 });
checkTruthy('falls back to the minimum size instead of dropping text',
  tiny.fontSize > 0 && tiny.lines.length > 0);
check('flags the overflow', tiny.overflow, true);

print('--- painter.luminance ---');
// Tolerance, not equality: 0.2126 + 0.7152 + 0.0722 sums to 0.9999999999999999
// in binary floating point, which is not a defect in the code under test.
check('white is 1', Math.abs(P.luminance(255, 255, 255) - 1) < 1e-9, true);
check('black is 0', P.luminance(0, 0, 0), 0);
checkTruthy('mid grey is between',
  P.luminance(128, 128, 128) > 0.4 && P.luminance(128, 128, 128) < 0.6);

print('--- painter.dominantColor ---');
var white = [255, 255, 255, 255, 255, 255, 255, 255, 250, 250, 250, 255];
check('dominant of near-white is white-ish',
  P.dominantColor(white).r > 200 && P.dominantColor(white).g > 200, true);
var mixed = [];
for (var i = 0; i < 40; i++) mixed.push(0, 0, 0, 255);        // black majority
for (var j = 0; j < 5; j++) mixed.push(255, 255, 255, 255);
check('dominant picks the majority bucket', P.dominantColor(mixed).r < 60, true);
check('fully transparent input falls back to white', P.dominantColor([0, 0, 0, 0]).r, 255);

print('--- painter.expandBox ---');
check('grows in every direction',
  P.expandBox({ x: 10, y: 10, w: 20, h: 20 }, 4, 100, 100),
  { x: 6, y: 6, w: 28, h: 28 });
check('clamps at the top-left edge',
  P.expandBox({ x: 0, y: 0, w: 20, h: 20 }, 5, 100, 100),
  { x: 0, y: 0, w: 25, h: 25 });
check('clamps at the bottom-right edge',
  P.expandBox({ x: 80, y: 80, w: 20, h: 20 }, 5, 100, 100),
  { x: 75, y: 75, w: 25, h: 25 });

print('');
print('functional: PASSED ' + pass + ', FAILED ' + fail);
if (fail > 0) throw new Error('functional tests failed');
