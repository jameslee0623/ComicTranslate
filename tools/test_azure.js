/**
 * Microsoft Translator (Azure) engine unit tests.
 *
 * The engine's make-or-break details are the request envelope, the batching
 * ceilings, the language-code translation and the error taxonomy - none of
 * which a live page shows you when they are wrong: a bad code is a 400, a bad
 * batch is a 413, and a quota rejection treated as transient burns 39 more
 * doomed requests. jsc has no fetch, so it is stubbed with a queue and every
 * call is recorded.
 *
 * Runs under jsc via tools/verify.sh from the repository root.
 */

var passed = 0;
var failed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; print('  ok   ' + name); }
  else { failed++; print('  FAIL ' + name + (extra !== undefined ? ' - ' + extra : '')); }
}
function eq(name, actual, expected) {
  var a = String(actual);
  var e = String(expected);
  check(name, a === e, 'got "' + a + '", want "' + e + '"');
}
/** Repeat a character without String.prototype.repeat (jsc is fine with it, but
 *  the engine's inputs are ASCII either way). */
function rep(ch, n) {
  var out = '';
  while (out.length < n) out += ch;
  return out.slice(0, n);
}

// ── fetch stub: queued responders, every call recorded ──────────────────────
var fetchQueue = [];
var fetchCalls = [];
globalThis.fetch = function (url, opts) {
  fetchCalls.push({ url: url, opts: opts });
  var responder = fetchQueue.shift();
  if (!responder) throw new Error('unexpected fetch to ' + url);
  return Promise.resolve(responder(url, opts));
};

function jsonReply(status, body) {
  var serialised;
  try { serialised = JSON.stringify(body); } catch (e) { serialised = ''; }
  return {
    ok: status >= 200 && status < 300,
    status: status,
    headers: { get: function () { return null; } },
    json: function () { return Promise.resolve(body); },
    text: function () { return Promise.resolve(serialised); }
  };
}

/** One reply item, in the shape the v3.0 reference documents. */
function item(text, detected) {
  var out = { translations: [{ text: text, to: 'es' }] };
  if (detected) out.detectedLanguage = { language: detected, score: 1.0 };
  return out;
}

// ── load the module ────────────────────────────────────────────────────────
var src = readFile('src/background/lensAzureEngine.js');
(0, eval)(src);
if (typeof CTLensAzureEngine === 'undefined') throw new Error('CTLensAzureEngine did not load');

var settings = { azureKey: 'key1', azureRegion: 'global', debug: false };

async function main() {
  // ── language mapping ─────────────────────────────────────────────────────
  eq('code: zh-CN becomes zh-Hans', CTLensAzureEngine.toAzureCode('zh-CN'), 'zh-Hans');
  eq('code: zh-TW becomes zh-Hant', CTLensAzureEngine.toAzureCode('zh-TW'), 'zh-Hant');
  eq('code: the mapping is case-insensitive',
     CTLensAzureEngine.toAzureCode('ZH-tw'), 'zh-Hant');
  eq('code: ja passes through unchanged', CTLensAzureEngine.toAzureCode('ja'), 'ja');
  eq('code: an empty code stays empty', CTLensAzureEngine.toAzureCode(''), '');
  eq('code back: zh-Hant becomes zh-TW',
     CTLensAzureEngine.fromAzureCode('zh-Hant'), 'zh-TW');
  eq('code back: zh-Hans becomes zh-CN',
     CTLensAzureEngine.fromAzureCode('zh-Hans'), 'zh-CN');
  eq('code back: an unknown code passes through',
     CTLensAzureEngine.fromAzureCode('ja'), 'ja');
  check('code back: nothing detected -> null',
        CTLensAzureEngine.fromAzureCode('') === null);

  // ── credentials ──────────────────────────────────────────────────────────
  var threw = null;
  try { CTLensAzureEngine.requireCredentials({}); } catch (e) { threw = e; }
  check('requireCredentials: empty settings throws with guidance',
        !!threw && /region/i.test(threw.message) && /Settings/i.test(threw.message));
  threw = null;
  try { CTLensAzureEngine.requireCredentials({ azureKey: 'k' }); } catch (e) { threw = e; }
  check('requireCredentials: a key alone is not enough (region is named)',
        !!threw && /region is missing/.test(threw.message));
  threw = null;
  try { CTLensAzureEngine.requireCredentials({ azureRegion: 'global' }); } catch (e) { threw = e; }
  check('requireCredentials: a region alone names the missing key',
        !!threw && /key is missing/.test(threw.message));
  var creds = CTLensAzureEngine.requireCredentials({ azureKey: ' k ', azureRegion: ' w ' });
  eq('requireCredentials: trims both halves', creds.key + '/' + creds.region, 'k/w');

  // ── batching ceilings ────────────────────────────────────────────────────
  eq('batch: a whole page is one request',
     CTLensAzureEngine.planBatches(['a', 'b', 'c'], [0, 1, 2]).length, 1);
  eq('batch: an empty pending list is no request',
     CTLensAzureEngine.planBatches(['a'], []).length, 0);
  // MAX_ITEMS = 1000: the 1001st string must start a second request.
  var many = [];
  var idx = [];
  for (var i = 0; i < 1001; i++) { many.push('x'); idx.push(i); }
  var batches = CTLensAzureEngine.planBatches(many, idx);
  eq('batch: 1001 items split into 2 requests', batches.length, 2);
  eq('batch: the first request takes exactly MAX_ITEMS',
     batches[0].length, CTLensAzureEngine.MAX_ITEMS);
  eq('batch: the second request takes the remainder', batches[1].length, 1);
  // MAX_CHARS = 50000: 2 x 30,000 cannot share a request.
  var big = [rep('y', 30000), rep('z', 30000)];
  eq('batch: 2 x 30,000 chars split into 2 requests',
     CTLensAzureEngine.planBatches(big, [0, 1]).length, 2);
  eq('batch: exactly 50,000 chars still fits alone',
     CTLensAzureEngine.planBatches([rep('q', 50000)], [0]).length, 1);
  eq('batch: 50,000 chars + one more line needs a second request',
     CTLensAzureEngine.planBatches([rep('q', 50000), 'r'], [0, 1]).length, 2);
  // A single string over the ceiling cannot be sent at all.
  threw = null;
  try { CTLensAzureEngine.planBatches([rep('x', 50001)], [0]); } catch (e) { threw = e; }
  check('batch: one over-long line throws instead of splitting',
        !!threw && /50,000/.test(threw.message));

  // ── reply parsing ────────────────────────────────────────────────────────
  var parsed = CTLensAzureEngine.parseReply(JSON.stringify([item('hola', 'ja'), item('mundo')]));
  eq('parseReply: texts align with the request', parsed.texts.join('|'), 'hola|mundo');
  eq('parseReply: the detected source is mapped back to a UI code',
     parsed.detectedLang, 'ja');
  var partial = CTLensAzureEngine.parseReply([
    item('uno'), {}, { translations: [] }, null, item('cinco')
  ]);
  eq('parseReply: unusable entries become empty strings',
     partial.texts.join('|'), 'uno||||cinco');
  var t1 = null;
  try { CTLensAzureEngine.parseReply('{"error":"nope"}'); } catch (e) { t1 = e; }
  check('parseReply: a non-array throws', !!t1 && /shape/.test(t1.message));
  var t2 = null;
  try { CTLensAzureEngine.parseReply('<html>blocked</html>'); } catch (e) { t2 = e; }
  check('parseReply: an unparseable body throws', !!t2 && /unparseable/.test(t2.message));

  // ── quota vs transient ───────────────────────────────────────────────────
  check('isQuotaError: 403 is quota', CTLensAzureEngine.isQuotaError(403, '') === true);
  check('isQuotaError: a body naming the quota counts whatever the status',
        CTLensAzureEngine.isQuotaError(400, 'quota exceeded') === true);
  check('isQuotaError: 429 is a RATE limit, not quota',
        CTLensAzureEngine.isQuotaError(429, 'Too many requests') === false);
  check('isQuotaError: 400 is not quota',
        CTLensAzureEngine.isQuotaError(400, 'bad request') === false);
  check('quota hint states the allowance and an exit route',
        /2,000,000/.test(CTLensAzureEngine.QUOTA_HINT) &&
        /Google Lens/.test(CTLensAzureEngine.QUOTA_HINT));

  // ── the request itself ───────────────────────────────────────────────────
  fetchCalls.length = 0;
  fetchQueue = [function () { return jsonReply(200, [item('uno'), item('dos')]); }];
  var out = await CTLensAzureEngine.translateTexts(['hello', 'world'], 'auto', 'es', settings);
  eq('translateTexts: index-aligned output', out.join('|'), 'uno|dos');
  eq('translateTexts: one request for the page', fetchCalls.length, 1);
  var url = fetchCalls[0].url;
  eq('translateTexts: endpoint + api-version',
     url.indexOf('https://api.cognitive.microsofttranslator.com/translate?api-version=3.0'), 0);
  check('translateTexts: the target is a query parameter', /&to=es/.test(url));
  check('translateTexts: auto source omits from', !/&from=/.test(url));
  var opts = fetchCalls[0].opts;
  eq('translateTexts: POST', opts.method, 'POST');
  eq('translateTexts: the subscription key header',
     opts.headers['Ocp-Apim-Subscription-Key'], 'key1');
  eq('translateTexts: the region header',
     opts.headers['Ocp-Apim-Subscription-Region'], 'global');
  eq('translateTexts: JSON content type',
     opts.headers['Content-Type'], 'application/json; charset=UTF-8');
  var body = JSON.parse(opts.body);
  check('translateTexts: one {Text} object per string',
        body.length === 2 && body[0].Text === 'hello' && body[1].Text === 'world');

  // A concrete source is sent, and the Chinese pair goes through the map.
  fetchCalls.length = 0;
  fetchQueue = [function () { return jsonReply(200, [item('hola')]); }];
  await CTLensAzureEngine.translateTexts(['hello'], 'ja', 'zh-TW', settings);
  url = fetchCalls[0].url;
  check('translateTexts: concrete source is sent as from', /&from=ja/.test(url));
  check('translateTexts: a zh-TW target becomes zh-Hant', /&to=zh-Hant/.test(url));

  // Empty input never reaches the network.
  fetchCalls.length = 0;
  var emptyOut = await CTLensAzureEngine.translateTexts(['', '   '], 'ja', 'es', settings);
  eq('translateTexts: blank lines -> no request, empty output',
     emptyOut.length + '/' + fetchCalls.length, '2/0');

  // Multi-batch alignment. The plan for [40k, 40k, 4] is two requests - [0] and
  // [1,2], because the two oversized lines cannot share one request and the short
  // line then rides along with the second - so the replies must land per index.
  fetchCalls.length = 0;
  fetchQueue = [
    function () { return jsonReply(200, [item('A')]); },
    function () { return jsonReply(200, [item('B'), item('C')]); }
  ];
  var split = await CTLensAzureEngine.translateTexts(
    [rep('x', 40000), rep('y', 40000), 'zord'], 'ja', 'es', settings);
  eq('translateTexts: two requests for two oversized lines', fetchCalls.length, 2);
  eq('translateTexts: alignment survives the split', split.join('|'), 'A|B|C');
  eq('translateTexts: the first request carries only the first line',
     JSON.parse(fetchCalls[0].opts.body).length, 1);
  eq('translateTexts: the short line rides the second request',
     JSON.parse(fetchCalls[1].opts.body).length, 2);
  check('translateTexts: and it is the short line that rode along',
        /zord/.test(fetchCalls[1].opts.body) && !/zord/.test(fetchCalls[0].opts.body));

  // A short reply leaves the remaining indices empty rather than shifting them:
  // a mistranslated bubble is worse than an empty one.
  fetchCalls.length = 0;
  fetchQueue = [function () { return jsonReply(200, [item('solo')]); }];
  var short = await CTLensAzureEngine.translateTexts(['uno', 'dos', 'tres'], 'ja', 'es', settings);
  eq('translateTexts: a truncated reply leaves the tail empty',
     short.join('|'), 'solo||');

  // ── failures ─────────────────────────────────────────────────────────────
  fetchCalls.length = 0;
  fetchQueue = [function () { return jsonReply(403, { error: { message: 'quota exceeded' } }); }];
  var t3 = null;
  try { await CTLensAzureEngine.translateTexts(['hi'], 'ja', 'es', settings); } catch (e) { t3 = e; }
  check('translateTexts: a quota rejection carries the allowance hint',
        !!t3 && /quota/.test(t3.message) && /2,000,000/.test(t3.message));

  fetchQueue = [function () { return jsonReply(401, { error: { message: 'unauthorized' } }); }];
  var t4 = null;
  try { await CTLensAzureEngine.translateTexts(['hi'], 'ja', 'es', settings); } catch (e) { t4 = e; }
  check('translateTexts: 401 blames the key/region pairing',
        !!t4 && /401/.test(t4.message) && /region/.test(t4.message));

  fetchQueue = [function () { return jsonReply(429, 'Too many requests'); }];
  var t5 = null;
  try { await CTLensAzureEngine.translateTexts(['hi'], 'ja', 'es', settings); } catch (e) { t5 = e; }
  check('translateTexts: 429 stays a plain failure (retryable, not terminal)',
        !!t5 && /429/.test(t5.message) && !/allowance is spent/.test(t5.message));

  fetchCalls.length = 0;
  fetchQueue = [];
  var t6 = null;
  try { await CTLensAzureEngine.translateTexts(['hi'], 'ja', 'es', { azureRegion: 'global' }); }
  catch (e) { t6 = e; }
  check('translateTexts: missing credentials fail before any request',
        !!t6 && /key is missing/.test(t6.message) && fetchCalls.length === 0);

  var t7 = null;
  try { await CTLensAzureEngine.translateTexts(['hi'], 'ja', '', settings); }
  catch (e) { t7 = e; }
  check('translateTexts: no target language throws',
        !!t7 && /no target language/.test(t7.message));

  // ── cache dimension ──────────────────────────────────────────────────────
  eq('variantKey: the region is the cache dimension',
     CTLensAzureEngine.variantKey({ azureRegion: ' westus2 ' }), 'westus2');
  eq('variantKey: an unset region is empty', CTLensAzureEngine.variantKey({}), '');

  // ── registration surface (the engines.js contract) ───────────────────────
  eq('engine id', CTLensAzureEngine.id, 'lens-azure');
  check('engine needs a key (so the options UI shows the fields)',
        CTLensAzureEngine.needsKey === true);
  check('engine translates (regions arrive already translated)',
        CTLensAzureEngine.doesTranslation === true);
  check('engine exposes imageToRegions',
        typeof CTLensAzureEngine.imageToRegions === 'function');
  eq('engine declares the documented endpoint',
     CTLensAzureEngine.ENDPOINT,
     'https://api.cognitive.microsofttranslator.com/translate');

  print('');
  if (failed) throw new Error('azure: ' + failed + ' failure(s)');
  print('azure: PASSED ' + passed + ', FAILED ' + failed);
}

/**
 * Report a driver failure AND make it visible to the shell.
 *
 * jsc exits 0 for a rejection that escapes an async driver - it only prints
 * "Unhandled promise rejection" - so a failing assertion would scroll past and
 * tools/verify.sh would still report the stage as passed. quit(1) puts the
 * verdict in the exit code, which is what the stage actually checks; the
 * rethrow keeps the same behaviour under node.
 */
function failDriver(e) {
  print('azure: test driver failed: ' + (e && e.message));
  if (typeof quit === 'function') quit(1);
  throw e;
}

main().catch(failDriver);
