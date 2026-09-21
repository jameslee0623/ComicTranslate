/**
 * Syntax check for every JS file in the extension.
 *
 * Run via tools/verify.sh, which generates the file list first. Uses
 * JavaScriptCore's `new Function` to PARSE without executing, so it catches
 * syntax errors without needing Node, npm, or a browser.
 */
var listPath = '/tmp/ct-files.json';
var list = JSON.parse(readFile(listPath));
var bad = 0;

for (var i = 0; i < list.length; i++) {
  var file = list[i];
  var src;
  try {
    src = readFile(file);
  } catch (e) {
    print('READFAIL ' + file);
    bad++;
    continue;
  }
  try {
    // Wrapping in a function body parses the source without running it.
    new Function(src);
    print('ok    ' + file);
  } catch (e) {
    print('PARSE ERROR ' + file + '\n      ' + e.message);
    bad++;
  }
}

print('');
if (bad === 0) {
  print('syntax: ' + list.length + ' files parse cleanly');
} else {
  throw new Error('syntax: ' + bad + ' file(s) failed to parse');
}
