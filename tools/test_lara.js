/**
 * Lara engine unit tests.
 *
 * The engine's make-or-break details are all string plumbing: the HMAC
 * challenge line, the truncated digest, the multipart field assembly and the
 * token lifecycle. jsc has no WebCrypto, so crypto.subtle, TextEncoder,
 * btoa/atob and fetch are stubbed - these tests pin OUR logic while trusting
 * the platform for SHA-256/HMAC themselves. The real credentials path is
 * exercised by "Test Lara credentials" in the options page (a free /v2/auth
 * call; a test image would bill ~10,000 characters).
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

// ── browser-global stubs (ASCII only - every string in the engine is) ───────
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

globalThis.TextEncoder = function () {
  this.encode = function (str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c > 127) throw new Error('test TextEncoder is ASCII-only');
      out[i] = c;
    }
    return out;
  };
};
globalThis.btoa = function (s) {
  var out = '';
  for (var i = 0; i < s.length; i += 3) {
    var b0 = s.charCodeAt(i);
    var has1 = i + 1 < s.length;
    var has2 = i + 2 < s.length;
    var b1 = has1 ? s.charCodeAt(i + 1) : 0;
    var b2 = has2 ? s.charCodeAt(i + 2) : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += has1 ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += has2 ? B64[b2 & 63] : '=';
  }
  return out;
};
globalThis.atob = function (s) {
  s = String(s).replace(/=+$/, '');
  var out = '';
  var bits = 0;
  var acc = 0;
  for (var i = 0; i < s.length; i++) {
    var v = B64.indexOf(s[i]);
    if (v < 0) throw new Error('bad base64 character: ' + s[i]);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out += String.fromCharCode((acc >> bits) & 0xff); }
  }
  return out;
};

// Deterministic fake WebCrypto: digest -> bytes 0..31, HMAC -> bytes 1,2,3.
// lastSignData captures the challenge so tests can pin the signed path.
var lastSignData = null;
globalThis.crypto = {
  subtle: {
    digest: function () {
      var out = new Uint8Array(32);
      for (var i = 0; i < 32; i++) out[i] = i;
      return Promise.resolve(out.buffer);
    },
    importKey: function (type, raw, algo) {
      return Promise.resolve({ type: type, raw: raw, algo: algo });
    },
    sign: function (algo, key, data) {
      lastSignData = data;
      return Promise.resolve(new Uint8Array([1, 2, 3]).buffer);
    }
  }
};

// Fetch stub: queued responders, every call recorded.
var fetchQueue = [];
var fetchCalls = [];
globalThis.fetch = function (url, opts) {
  fetchCalls.push({ url: url, opts: opts });
  var responder = fetchQueue.shift();
  if (!responder) throw new Error('unexpected fetch to ' + url);
  return Promise.resolve(responder(url, opts));
};

// usage.js needs storage: a tiny in-memory fake.
var storageMap = {};
globalThis.browser = {
  storage: {
    local: {
      get: function (key) {
        var out = {};
        if (key in storageMap) out[key] = storageMap[key];
        return Promise.resolve(out);
      },
      set: function (obj) {
        for (var k in obj) storageMap[k] = obj[k];
        return Promise.resolve();
      }
    },
    onChanged: { addListener: function () {} }
  }
};

function jsonReply(status, body, headers) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    headers: {
      get: function (n) { return (headers || {})[String(n).toLowerCase()] || null; }
    },
    json: function () { return Promise.resolve(body); }
  };
}
function imageReply(status, bytes, mime) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    headers: {
      get: function (n) {
        return String(n).toLowerCase() === 'content-type' ? mime : null;
      }
    },
    arrayBuffer: function () { return Promise.resolve(bytes); }
  };
}
function bytesToString(u8) {
  var s = '';
  for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
}
function b64urlFromString(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeJwt(expSeconds) {
  return 'h.' + b64urlFromString('{"exp":' + expSeconds + '}') + '.s';
}

// ── load the modules ─────────────────────────────────────────────────────────
// usage.js first: translateTexts bills through it when it is defined.
var src = readFile('src/background/usage.js');
(0, eval)(src);
src = readFile('src/background/laraEngine.js');
(0, eval)(src);
if (typeof CTLaraEngine === 'undefined') throw new Error('CTLaraEngine did not load');
if (typeof CTUsage === 'undefined') throw new Error('CTUsage did not load');

var settings = {
  laraAccessKeyId: 'id',
  laraAccessKeySecret: 'sec',
  laraModel: 'inpainting',
  debug: false
};

async function main() {
  // ── challenge string ──────────────────────────────────────────────────────
  eq('challenge: exact SDK vector',
     CTLaraEngine.authChallenge('POST', '/v2/auth', 'DIG', 'application/json',
                                'Mon, 01 Jan 2024 00:00:00 GMT'),
     'POST\n/v2/auth\nDIG\napplication/json\nMon, 01 Jan 2024 00:00:00 GMT');
  eq('challenge: trims each part, empty digest allowed',
     CTLaraEngine.authChallenge(' POST ', ' /auth ', '  x  ', '', ' d '),
     'POST\n/auth\nx\n\nd');

  // ── token lifecycle ───────────────────────────────────────────────────────
  eq('tokenExpiry: reads exp from a JWT', CTLaraEngine.tokenExpiry(makeJwt(1700000000)), 1700000000000);
  eq('tokenExpiry: malformed token -> 0', CTLaraEngine.tokenExpiry('garbage'), 0);
  check('tokenIsExpired: null token', CTLaraEngine.tokenIsExpired(null) === true);
  check('tokenIsExpired: future exp', CTLaraEngine.tokenIsExpired(makeJwt(Math.floor(Date.now() / 1000) + 3600)) === false);
  check('tokenIsExpired: past exp', CTLaraEngine.tokenIsExpired(makeJwt(1000)) === true);
  check('tokenIsExpired: honours the 5s buffer',
        CTLaraEngine.tokenIsExpired(makeJwt(Math.floor((Date.now() + 2000) / 1000)), 5000) === true);
  check('tokenIsExpired: zero buffer lets it through',
        CTLaraEngine.tokenIsExpired(makeJwt(Math.floor((Date.now() + 2000) / 1000)), 0) === false);

  var threw = null;
  try { CTLaraEngine.requireCredentials({}); } catch (e) { threw = e; }
  check('requireCredentials: empty settings throws with guidance',
        !!threw && /credentials/i.test(threw.message));
  var creds = CTLaraEngine.requireCredentials({ laraAccessKeyId: 'id', laraAccessKeySecret: 'sec' });
  check('requireCredentials: returns both halves', creds.id === 'id' && creds.secret === 'sec');

  // ── request assembly ──────────────────────────────────────────────────────
  var f = CTLaraEngine.imageFormFields({ laraModel: 'overlay' }, 'ja', 'zh-TW');
  eq('fields: model honoured', f.model, 'overlay');
  eq('fields: concrete source kept', f.source, 'ja');
  eq('fields: target passed through', f.target, 'zh-TW');
  var f2 = CTLaraEngine.imageFormFields({}, 'auto', 'en');
  eq('fields: default model', f2.model, 'inpainting');
  check('fields: auto source omitted', f2.source === '');
  var f3 = CTLaraEngine.imageFormFields({ laraModel: 'bogus' }, 'auto', 'en');
  eq('fields: invalid model falls back to inpainting', f3.model, 'inpainting');

  eq('ext: png', CTLaraEngine.extFromMime('image/png'), 'png');
  eq('ext: jpeg -> jpg', CTLaraEngine.extFromMime('image/jpeg'), 'jpg');
  eq('ext: webp', CTLaraEngine.extFromMime('image/webp'), 'webp');
  eq('ext: unknown falls back to png', CTLaraEngine.extFromMime('image/x-weird'), 'png');

  // ── signed auth request (digest + hmac + challenge via captured fetch) ────
  CTLaraEngine.resetAuth();
  fetchCalls.length = 0;
  fetchQueue = [function () {
    return jsonReply(200, { token: makeJwt(4102444800) }, { 'x-lara-refresh-token': 'r1' });
  }];
  var t = await CTLaraEngine.ensureToken(settings);
  check('ensureToken: returns the fresh token', t === makeJwt(4102444800));
  eq('ensureToken: exactly one fetch', fetchCalls.length, 1);
  eq('ensureToken: POST /v2/auth', fetchCalls[0].url, 'https://api.laratranslate.com/v2/auth');
  eq('ensureToken: body is the access key id', fetchCalls[0].opts.body, '{"id":"id"}');
  // fake digest -> bytes 0..31, truncated to 0..15: the truncation, pinned.
  eq('ensureToken: Content-MD5 = base64(SHA-256)[0:16]',
     fetchCalls[0].opts.headers['Content-MD5'], 'AAECAwQFBgcICQoLDA0ODw==');
  // fake hmac -> bytes 1,2,3 -> 'AQID'; proves Authorization = 'Lara:'+sig.
  eq('ensureToken: Authorization = Lara:<HMAC(challenge)>',
     fetchCalls[0].opts.headers.Authorization, 'Lara:AQID');
  check('ensureToken: date header present',
        fetchCalls[0].opts.headers['X-Lara-Date'].indexOf('GMT') > 0);
  // The live API rejected a challenge signed over '/auth': the server
  // rebuilds the challenge from the request URI, so the FULL path must be
  // signed. This is the regression test for "Invalid challenge signature".
  eq('challenge: signs the full /v2/auth path',
     bytesToString(new Uint8Array(lastSignData)).split('\n')[1], '/v2/auth');
  var t2 = await CTLaraEngine.ensureToken(settings);
  check('ensureToken: cached token reused without a second fetch',
        t2 === t && fetchCalls.length === 1);

  // ── image call: multipart assembly + 401 recovery ─────────────────────────
  CTLaraEngine.resetAuth();
  fetchCalls.length = 0;
  // A fresh context must authenticate BEFORE the first image call, so the
  // 401-recovery scenario is: auth, image(401), re-auth, image(200).
  fetchQueue = [
    function () { return jsonReply(200, { token: makeJwt(4102444800) }, {}); },
    function () { return imageReply(401, new ArrayBuffer(0), 'image/png'); },
    function () { return jsonReply(200, { token: makeJwt(4102444800) }, {}); },
    function () { return imageReply(200, new Uint8Array([9, 9, 9, 9]).buffer, 'image/png'); }
  ];
  var req = {
    bytes: new Uint8Array([1, 2, 3, 4]).buffer,
    mime: 'image/webp',
    sourceLang: 'auto',
    targetLang: 'zh-TW',
    settings: settings
  };
  var res = await CTLaraEngine.imageToRegions(req);
  check('imageToRegions: recovers from 401 and returns bytes',
        !!res.image && res.image.bytes.byteLength === 4);
  eq('imageToRegions: mime from response header', res.image.mime, 'image/png');
  eq('imageToRegions: no regions for a full-image engine', res.regions.length, 0);
  eq('imageToRegions: auth + 401 + re-auth + retry = four calls', fetchCalls.length, 4);
  check('imageToRegions: hits /images/translate',
        fetchCalls[1].url.indexOf('/images/translate') > 0);
  check('imageToRegions: X-No-Trace always set',
        fetchCalls[1].opts.headers['X-No-Trace'] === 'true');
  var bodyStr = bytesToString(new Uint8Array(fetchCalls[1].opts.body));
  check('multipart: target field',
        bodyStr.indexOf('name="target"') > 0 && bodyStr.indexOf('zh-TW') > 0);
  check('multipart: model field',
        bodyStr.indexOf('name="model"') > 0 && bodyStr.indexOf('inpainting') > 0);
  check('multipart: empty auto-source omitted', bodyStr.indexOf('name="source"') < 0);
  check('multipart: filename keyed by mime', bodyStr.indexOf('filename="image.webp"') > 0);

  // ── token reuse across calls ──────────────────────────────────────────────
  fetchCalls.length = 0;
  fetchQueue = [function () { return imageReply(200, new Uint8Array([1]).buffer, 'image/png'); }];
  await CTLaraEngine.imageToRegions(req);
  eq('imageToRegions: valid token reused (no re-auth)', fetchCalls.length, 1);

  // ── error surfacing ───────────────────────────────────────────────────────
  CTLaraEngine.resetAuth();
  fetchCalls.length = 0;
  // Non-401 errors are not retried: auth once, then the failing image reply.
  fetchQueue = [
    function () { return jsonReply(200, { token: makeJwt(4102444800) }, {}); },
    function () {
      return {
        ok: false, status: 402,
        headers: { get: function () { return 'application/json'; } },
        json: function () { return Promise.resolve({ message: 'quota exceeded' }); }
      };
    }
  ];
  var threw2 = null;
  try { await CTLaraEngine.imageToRegions(req); } catch (e) { threw2 = e; }
  check('imageToRegions: surfaces the server message and the cost warning',
        !!threw2 && /quota exceeded/.test(threw2.message) && /10,000/.test(threw2.message));

  // ── text translation (the free-tier route) ────────────────────────────────
  CTLaraEngine.resetAuth();
  fetchCalls.length = 0;
  // NDJSON stream: two chunks, the last one is the final result (SDK parity).
  fetchQueue = [
    function () { return jsonReply(200, { token: makeJwt(4102444800) }, {}); },
    function () {
      return {
        ok: true, status: 200,
        headers: { get: function () { return 'application/json'; } },
        text: function () {
          return Promise.resolve(
            '{"translation":["hola","mundo"],"sourceLanguage":"en"}\n' +
            '{"translation":["hola","mundo"],"sourceLanguage":"en"}\n');
        }
      };
    }
  ];
  var out2 = await CTLaraEngine.translateTexts(['hello', 'world'], 'auto', 'es', settings);
  eq('translateTexts: aligns the batch reply', out2.join('|'), 'hola|mundo');
  eq('translateTexts: two calls (auth + translate)', fetchCalls.length, 2);
  eq('translateTexts: hits /v2/translate',
     fetchCalls[1].url, 'https://api.laratranslate.com/v2/translate');
  var tb = JSON.parse(fetchCalls[1].opts.body);
  check('translateTexts: batch rides under q',
        Array.isArray(tb.q) && tb.q[0] === 'hello' && tb.q[1] === 'world');
  eq('translateTexts: target field', tb.target, 'es');
  check('translateTexts: auto source omitted', !('source' in tb));
  check('translateTexts: no-trace header', fetchCalls[1].opts.headers['X-No-Trace'] === 'true');

  // Concrete source passes through; a scalar reply wraps for single input.
  fetchCalls.length = 0;
  fetchQueue = [
    function () {
      return {
        ok: true, status: 200,
        headers: { get: function () { return 'application/json'; } },
        text: function () { return Promise.resolve('{"translation":"hola"}\n'); }
      };
    }
  ];
  var out3 = await CTLaraEngine.translateTexts(['hello'], 'en', 'es', settings);
  eq('translateTexts: scalar reply wraps for single input', out3.join('|'), 'hola');
  tb = JSON.parse(fetchCalls[0].opts.body);
  eq('translateTexts: concrete source kept', tb.source, 'en');

  // Empty input never reaches the network.
  fetchCalls.length = 0;
  var out4 = await CTLaraEngine.translateTexts([], 'auto', 'es', settings);
  eq('translateTexts: empty input -> empty output, zero fetches',
     out4.length + '/' + fetchCalls.length, '0/0');

  // Quota errors carry the free-tier hint.
  CTLaraEngine.resetAuth();
  fetchCalls.length = 0;
  fetchQueue = [
    function () { return jsonReply(200, { token: makeJwt(4102444800) }, {}); },
    function () {
      return {
        ok: false, status: 402,
        headers: { get: function () { return 'application/json'; } },
        json: function () { return Promise.resolve({ message: 'quota exceeded' }); }
      };
    }
  ];
  var threw3 = null;
  try { await CTLaraEngine.translateTexts(['hi'], 'en', 'es', settings); } catch (e) { threw3 = e; }
  check('translateTexts: quota error carries the free-tier hint',
        !!threw3 && /quota exceeded/.test(threw3.message) && /10,000/.test(threw3.message));

  // Quota classification. The caller has to be able to tell a TERMINAL quota
  // rejection (stop the whole run) from a transient failure (retry the image),
  // otherwise it fires a doomed request for every remaining image.
  check('isQuotaError: 402 is quota', CTLaraEngine.isQuotaError(402, '') === true);
  check('isQuotaError: 429 is quota', CTLaraEngine.isQuotaError(429, '') === true);
  check('isQuotaError: 400 is NOT quota',
        CTLaraEngine.isQuotaError(400, 'bad request') === false);
  check('isQuotaError: a body naming the quota counts',
        CTLaraEngine.isQuotaError(200, 'api_translation_chars quota exceeded') === true);
  check('quota hint states the real billing rule and an exit route',
        /10,000/.test(CTLaraEngine.QUOTA_HINT) &&
        /Google Lens/.test(CTLaraEngine.QUOTA_HINT));

  // ── usage meter (free tier: 10,000 chars/month) ───────────────────────────
  eq('usage: monthKey format', CTUsage.monthKey(new Date(2026, 0, 5)), '2026-01');
  // start from a clean slate: earlier tests in this file billed chars.
  delete storageMap['ct_usage'];
  var snap = await CTUsage.snapshot();
  check('usage: starts empty', snap.textChars === 0 && snap.imageCount === 0 &&
        snap.totalChars === 0);
  // data stored under a previous month is discarded, not carried over
  storageMap['ct_usage'] = { monthKey: '2020-01', textChars: 999, imageCount: 7 };
  snap = await CTUsage.snapshot();
  check('usage: old-month data rolls off',
        snap.textChars === 0 && snap.imageCount === 0 && snap.totalChars === 0);
  // text translation bills the characters actually sent
  CTLaraEngine.resetAuth();
  fetchCalls.length = 0;
  fetchQueue = [
    function () { return jsonReply(200, { token: makeJwt(4102444800) }, {}); },
    function () {
      return {
        ok: true, status: 200,
        headers: { get: function () { return 'application/json'; } },
        text: function () { return Promise.resolve('{"translation":["a","b"]}'); }
      };
    }
  ];
  await CTLaraEngine.translateTexts(['hello', 'world'], 'auto', 'es', settings);
  snap = await CTUsage.snapshot();
  eq('usage: translateTexts bills 10 chars', snap.textChars, 10);
  // the image engine bills a flat 10,000 per call
  await CTUsage.addImage();
  snap = await CTUsage.snapshot();
  eq('usage: image bills flat 10k', snap.totalChars, 10010);
  check('usage: image count tracked', snap.imageCount === 1);
  // manual reset (options page) clears everything
  snap = await CTUsage.reset();
  check('usage: reset clears everything',
        snap.textChars === 0 && snap.imageCount === 0 && snap.totalChars === 0);

  print('');
  if (failed) {
    print('lara: ' + failed + ' FAILURE(S) (' + passed + ' passed)');
    throw new Error('lara tests failed');
  }
  print('lara: PASSED ' + passed + ', FAILED 0');
}

main().catch(function (e) {
  print('lara: test driver failed: ' + (e && e.message));
  throw e;
});
