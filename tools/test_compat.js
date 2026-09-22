/**
 * test_compat.js - the browser namespace shim, exercised as both browsers.
 *
 * compat.js exists because Firefox provides `browser` and Chrome does not, so
 * every call site would otherwise need a fallback - and the one that gets missed
 * fails on whichever browser the developer is not using. Simulate both here.
 *
 * Runs under jsc. Run via tools/verify.sh from the repository root.
 */

var failures = 0;
function check(name, ok) { print((ok ? '  ok   ' : '  FAIL ') + name); if (!ok) failures++; }

var src = readFile('src/shared/compat.js');

/** Load compat.js into a clean global namespace containing exactly `globals`. */
function loadAs(globals) {
  delete globalThis.browser;
  delete globalThis.chrome;
  delete globalThis.CTCompat;
  Object.keys(globals).forEach(function (key) { globalThis[key] = globals[key]; });
  (0, eval)(src);
  return { browser: globalThis.browser, compat: globalThis.CTCompat };
}

// --- Chrome: only `chrome` exists ------------------------------------------
var chromeApi = { runtime: { onMessage: {} }, storage: { local: {} } };
var c = loadAs({ chrome: chromeApi });
check('chrome: a `browser` namespace is created', c.browser === chromeApi);
check('chrome: isFirefox is false', c.compat.isFirefox === false);
check('chrome: available is true', c.compat.available === true);
check('chrome: api points at the chrome object', c.compat.api === chromeApi);

// --- Firefox: `browser` exists (and so does a legacy `chrome`) --------------
var browserApi = { runtime: { onMessage: {} }, storage: { local: {} } };
var f = loadAs({ browser: browserApi, chrome: { legacyOnly: true } });
check('firefox: `browser` is left untouched', f.browser === browserApi);
check('firefox: isFirefox is true', f.compat.isFirefox === true);
check('firefox: api points at browser, not chrome', f.compat.api === browserApi);

// --- neither: a plain page or a bare test harness --------------------------
var n = loadAs({});
check('neither: available is false', n.compat.available === false);
check('neither: no `browser` is invented', n.browser === undefined);

print('');
if (failures) {
  print('compat: ' + failures + ' FAILURE(S)');
  throw new Error('compat tests failed');
}
print('compat: PASSED');
