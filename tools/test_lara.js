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
// Stubs for what jsc lacks. laraEngine.js builds its multipart body by hand, so
// FormData/Blob only have to exist; lensLocalEngine.js aborts a hung local
// request after 120s and aborts it on demand when the page changes, and jsc has
// setTimeout but neither AbortController nor clearTimeout.
globalThis.FormData = function () {
  this.fields = {};
  this.append = function (k, v, f) { this.fields[k] = { value: v, file: f }; };
};
globalThis.Blob = function (parts, opts) {
  this.parts = parts; this.type = (opts && opts.type) || '';
};
// Fires onabort/abort listeners like the real thing, because that notification is
// the entire mechanism a cancelled fetch is rejected by - a stub that only flips
// `aborted` would let a broken cancel pass every test.
globalThis.AbortController = function () {
  var self = this;
  this.signal = {
    aborted: false,
    onabort: null,
    addEventListener: function (name, fn) {
      if (name === 'abort') self.signal.onabort = fn;
    }
  };
  this.abort = function () {
    if (self.signal.aborted) return;
    self.signal.aborted = true;
    if (typeof self.signal.onabort === 'function') self.signal.onabort();
  };
};
globalThis.clearTimeout = function () {};

// Model a real Response, which has exactly ONE consumable body. The engine
// reads text() first and parses by hand, so the body must serialise to the same
// JSON that json() would have produced - a stub with only json() made every
// successful local-server reply look empty.
function jsonReply(status, body, headers) {
  var serialised;
  try { serialised = JSON.stringify(body); } catch (e) { serialised = ''; }
  return {
    ok: status >= 200 && status < 300,
    status: status,
    headers: {
      get: function (n) { return (headers || {})[String(n).toLowerCase()] || null; }
    },
    json: function () { return Promise.resolve(body); },
    text: function () { return Promise.resolve(serialised); }
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
src = readFile('src/background/lensLocalEngine.js');
// languages.js first, exactly as manifest.json and importScripts order it: the
// engine reads CT_LANGUAGES to name the language pair in its instruction, and
// without the table it silently degrades to raw codes ("ja" -> "ja").
(0, eval)(readFile('src/shared/languages.js'));
(0, eval)(src);
if (typeof CTLensLocalEngine === 'undefined') throw new Error('CTLensLocalEngine did not load');
if (typeof CT_LANGUAGES === 'undefined') throw new Error('CT_LANGUAGES did not load');

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

  // ── lens-local engine: Lens OCR + the user's own translation server ───
  // Translating is this engine's only change: Lens finds the text exactly as it
  // does for the free engine, and the strings - never the image - go to the
  // user's URL. The regions it returns are painted by the normal path.
  var threwLocal = null;
  try { CTLensLocalEngine.requireEndpoint({}); } catch (e) { threwLocal = e; }
  check('lens-local: empty URL throws with guidance',
        !!threwLocal && /server URL/i.test(threwLocal.message));
  threwLocal = null;
  try { CTLensLocalEngine.requireEndpoint({ localTextUrl: 'ftp://x/y' }); }
  catch (e) { threwLocal = e; }
  check('lens-local: non-http(s) rejected', !!threwLocal && /http/i.test(threwLocal.message));
  threwLocal = null;
  try { CTLensLocalEngine.requireEndpoint({ localTextUrl: 'localhost:8000' }); }
  catch (e) { threwLocal = e; }
  check('lens-local: scheme-less string rejected',
        !!threwLocal && /valid URL/i.test(threwLocal.message));
  // LM Studio, Ollama's OpenAI listener, vLLM and llama.cpp's server all expose
  // the OpenAI-compatible chat route by default, so a bare host is assumed to be
  // one of those. A hand-written shim keeps working by giving its path explicitly.
  eq('lens-local: bare host defaults to the OpenAI-compatible chat route',
      CTLensLocalEngine.requireEndpoint({ localTextUrl: 'http://localhost:8000' }),
      'http://localhost:8000/v1/chat/completions');
  eq('lens-local: a lone slash is normalised too',
      CTLensLocalEngine.requireEndpoint({ localTextUrl: 'http://127.0.0.1:5000/' }),
      'http://127.0.0.1:5000/v1/chat/completions');
  eq('lens-local: an explicit shim path is kept, not rewritten',
      CTLensLocalEngine.requireEndpoint({ localTextUrl: 'http://localhost:8000/translate' }),
      'http://localhost:8000/translate');
  // A chat route is wrapped in the JSON messages envelope; a text route is posted
  // raw, because the body IS the prompt. The URL is the only thing that decides.
  check('lens-local: a chat URL is detected as chat',
      CTLensLocalEngine.isChatEndpoint('http://lmserver.local:1234/v1/chat/completions') &&
      CTLensLocalEngine.isChatEndpoint('http://lmserver.local:11434/api/chat') &&
      !CTLensLocalEngine.isChatEndpoint('http://lmserver.local:8000/translate'));
  eq('lens-local: the model list is derived from the chat route',
      CTLensLocalEngine.modelsEndpoint('http://lmserver.local:1234/v1/chat/completions'),
      'http://lmserver.local:1234/v1/models');
  eq('lens-local: Ollama native pairs with /api/tags',
      CTLensLocalEngine.modelsEndpoint('http://lmserver.local:11434/api/chat'),
      'http://lmserver.local:11434/api/tags');
  eq('lens-local: a text route has no model list',
      CTLensLocalEngine.modelsEndpoint('http://lmserver.local:8000/translate'), null);
  var chatReq = CTLensLocalEngine.buildRequest(
    'http://lmserver.local:1234/v1/chat/completions', 'PROMPT', ['a'], 'en', 'ja',
    { localTextModel: 'google/gemma-4-12b' });
  check('lens-local: a chat route sends the OpenAI messages envelope',
        chatReq.chat === true &&
        JSON.parse(chatReq.body).messages[0].content === 'PROMPT' &&
        JSON.parse(chatReq.body).model === 'google/gemma-4-12b' &&
        JSON.parse(chatReq.body).temperature === 0);
  var textReq = CTLensLocalEngine.buildRequest(
    'http://x:8000/translate', 'PROMPT', ['a'], 'en', 'ja', {});
  check('lens-local: a text route posts the prompt raw, not as JSON',
        textReq.chat === false && textReq.body === 'PROMPT' &&
        /text\/plain/.test(textReq.headers['Content-Type']));

  // ── live LM Studio replies (captured from google/gemma-4-12b) ───────────
  // LM Studio is an OpenAI-compatible server, so it answers with a
  // chat.completion envelope. Gemma also emits a `reasoning_content` field that
  // quotes the SOURCE text back while it thinks. Scanning the whole body for an
  // array would find that reasoning half first and paint the untranslated
  // original into every speech bubble with no error anywhere - so the parser
  // must read message.content and nothing else. This is the real captured body.
  var lmReply = JSON.stringify({
    id: 'chatcmpl-8c2jzbc', object: 'chat.completion', model: 'google/gemma-4-12b',
    choices: [{ index: 0, message: {
      role: 'assistant',
      content: '["Hello", "See you later", "Where are you going?"]',
      reasoning_content: '\n* Input: Three Japanese phrases.\n* Source Texts: "こんにちは", "またね", "どこへ行くの？"\n* 1. Hello'
    }, finish_reason: 'stop' }]
  });
  var lmOut = CTLensLocalEngine.parseBody(lmReply, 3);
  check('lens-local: a real LM Studio chat envelope parses',
        lmOut.length === 3 && lmOut[0] === 'Hello' &&
        lmOut[2] === 'Where are you going?');
  check('lens-local: reasoning_content quoting the source never wins',
        lmOut.indexOf('こんにちは') < 0 && lmOut.indexOf('またね') < 0);

  // LM Studio answers an UNKNOWN ROUTE with HTTP 200 and an error body. Reading
  // it as a reply would report "no translations array" and hide the real reason.
  var lmErr = CTLensLocalEngine.serverErrorMessage(
    { error: 'Unexpected endpoint or method. (POST /translate)' });
  check('lens-local: a route error is surfaced, not swallowed',
        /Unexpected endpoint/.test(lmErr || ''));
  // A genuine mismatch must still throw rather than zip - mis-pairing would put
  // plausible wrong text in the wrong bubble, which is worse than a visible error.
  var mismatch = null;
  try { CTLensLocalEngine.parseBody(lmReply, 7); } catch (e) { mismatch = e; }
  check('lens-local: a length mismatch throws instead of zipping',
        !!mismatch && /7/.test(mismatch.message));

  // ── picking the answer out of a reply that also quotes its work ──────────
  // An array with the RIGHT number of entries beats a longer one. This is what
  // lets the parser read a reply whose thinking half is still attached - LM Studio
  // keeps <think> inside content when its reasoning splitter is off - because
  // while thinking the model quotes the source array back and restates its own
  // draft. Longest-wins would pick the scratch work; count-wins picks the answer.
  var counted = CTLensLocalEngine.extractJsonArray(
    'Draft: ["あ","い","う","え","お"]\nFinal: ["Hello", "World"]', 2);
  check('lens-local: the array with the requested count beats a longer one',
        counted.parsed.length === 2 && counted.parsed[0] === 'Hello');
  var restated = CTLensLocalEngine.extractJsonArray(
    'Try: ["one","two"]\nBetter: ["three","four"]', 2);
  check('lens-local: of two arrays of the right size, the last one wins',
        restated.parsed[0] === 'three');
  eq('lens-local: without a count the longest window still wins',
     CTLensLocalEngine.extractJsonArray('["a","b","c"]').parsed.length, 3);

  // The captured live failure, reproduced: HTTP 200, finish_reason "stop", an
  // EMPTY message.content, and every translated line left in reasoning_content
  // (LM Studio bug #1602, google/gemma-4-12b). The model did the work, so an
  // exact-count array in the thinking half is accepted - and only an exact-count
  // array, which is what keeps the quoted source from being painted in.
  var thinkOnly = JSON.stringify({
    id: 'chatcmpl-qtzc3ea', object: 'chat.completion', model: 'google/gemma-4-12b',
    choices: [{ index: 0, message: {
      role: 'assistant',
      content: '',
      reasoning_content: 'Plan: 2 lines. Draft: ["あいさつ", "またね"] ' +
        'Refined final answer: ["Hello", "See you later"]'
    }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 136, completion_tokens: 1530 }
  });
  var recovered = CTLensLocalEngine.parseBody(thinkOnly, 2);
  check('lens-local: a reasoning-only reply is recovered, not thrown away',
        recovered[0] === 'Hello' && recovered[1] === 'See you later');
  check('lens-local: recovery takes the final draft, never the quoted source',
        recovered.indexOf('あいさつ') < 0 && recovered.indexOf('またね') < 0);
  check('lens-local: the thinking half is found in every envelope spelling',
        CTLensLocalEngine.reasoningText({ message: { content: '', thinking: 'x' } }) === 'x' &&
        CTLensLocalEngine.reasoningText(
          { output: [{ type: 'reasoning', content: 'y' }] }) === 'y' &&
        CTLensLocalEngine.reasoningText({ choices: [{ message: { content: 'ok' } }] }) === null);

  // Reasoning with no array in it at all - the shape the captured reply actually
  // had, a numbered list of translations. There is nothing to recover, so the
  // error has to name the real cause instead of reporting a JSON parse failure on
  // our side and sending the user hunting for a bug that does not exist.
  var thinkProse = JSON.stringify({
    choices: [{ index: 0, message: { role: 'assistant', content: '',
      reasoning_content: '1. 恥ずかしい -> 好害羞\n2. ば -> 啊' },
      finish_reason: 'stop' }]
  });
  var threwThink = null;
  try { CTLensLocalEngine.parseBody(thinkProse, 2); } catch (e) { threwThink = e; }
  check('lens-local: unrecoverable reasoning names the real cause, not a parse bug',
        !!threwThink && !/not valid JSON/i.test(threwThink.message) &&
        /nothing was translated/i.test(threwThink.message) &&
        /reasoning_content/i.test(threwThink.message));

  eq('lens-local: free engine bills nothing', CTLensLocalEngine.free, true);
  eq('lens-local: needs no key', CTLensLocalEngine.needsKey, false);
  // Regions come back already translated, so engines.js must not run the shared
  // translator on them a second time - that is what doesTranslation records.
  eq('lens-local: translating is the engine\'s own job',
      CTLensLocalEngine.doesTranslation, true);
  eq('lens-local: stable engine id', CTLensLocalEngine.id, 'lens-local');
  // Cache dimension: two servers must never share cache entries, and an unset
  // URL must still produce a key - the helpful error belongs to the attempt,
  // because engines.js builds the key before the engine ever runs.
  eq('lens-local: variantKey is the trimmed URL',
      CTLensLocalEngine.variantKey({ localTextUrl: ' http://box:9000 ' }), 'http://box:9000');
  eq('lens-local: variantKey of an unset URL', CTLensLocalEngine.variantKey({}), '');

  // ── reply parsing: index alignment is the whole contract ──────────────
  var tr = CTLensLocalEngine.parseReply({ translations: ['a', 'b'] }, 2);
  check('lens-local: documented {translations} shape',
        tr.length === 2 && tr[0] === 'a' && tr[1] === 'b');
  tr = CTLensLocalEngine.parseReply(['x', null], 2);
  check('lens-local: a bare array works, null becomes empty',
        tr[0] === 'x' && tr[1] === '');
  var threwParse = null;
  try { CTLensLocalEngine.parseReply({ nope: 1 }, 2); } catch (e) { threwParse = e; }
  check('lens-local: a reply with no translations array is rejected',
        !!threwParse && /translations/.test(threwParse.message));
  threwParse = null;
  try { CTLensLocalEngine.parseReply({ translations: ['only one'] }, 2); }
  catch (e) { threwParse = e; }
  check('lens-local: length mismatch is an error, not a silent zip',
        !!threwParse && /refusing to pair/.test(threwParse.message));

  // ── end to end: Lens OCR -> strings to the local server -> regions ────
  // The two Lens halves have their own suite, so they are stubbed here and the
  // engine is driven once. That pins the entire contract: where the request
  // goes, what rides in it (the strings, never the image), and the translations
  // landing back on the boxes Lens found.
  globalThis.CTLensEngine = {
    toUploadable: function () {
      return Promise.resolve({
        bytes: new Uint8Array([1, 2, 3]), width: 100, height: 50, mime: 'image/jpeg'
      });
    }
  };
  globalThis.CTLensProto = {
    scan: function () {
      return Promise.resolve({
        sourceLang: 'ja',
        regions: [{ text: 'A' }, { text: 'B' }],
        diagnostics: { lensCalls: 2 }
      });
    },
    rescaleRegions: function (regions) { return regions; }
  };

  var sawRequest = null;
  fetchQueue.push(function (url, opts) {
    sawRequest = { url: url, opts: opts, body: JSON.parse(opts.body) };
    return jsonReply(200, { translations: ['Hello', 'Goodbye'] });
  });

  var out = await CTLensLocalEngine.imageToRegions({
    bytes: new Uint8Array([9]), mime: 'image/png', width: 100, height: 50,
    sourceLang: 'auto', targetLang: 'en',
    settings: { localTextUrl: 'http://localhost:8000', localTextApiKey: 'k' }
  });

  eq('lens-local: a bare host is POSTed as a chat request',
     sawRequest.url, 'http://localhost:8000/v1/chat/completions');
  check('lens-local: the strings are POSTed', sawRequest.opts.method === 'POST');
  eq('lens-local: JSON content type',
     sawRequest.opts.headers['Content-Type'], 'application/json');
  eq('lens-local: the API key rides as a bearer token',
     sawRequest.opts.headers.Authorization, 'Bearer k');
  eq('lens-local: every OCR line is sent, in order',
     sawRequest.body.texts.join(','), 'A,B');
  eq('lens-local: the detected language is stated', sawRequest.body.source, 'ja');
  eq('lens-local: the target language is stated', sawRequest.body.target, 'en');
  // A general LLM is a chat endpoint, not a translation API: the instruction must
  // be the FIRST LINE of the message, outside any JSON field, or it answers the
  // question nobody asked. The strings ride as the JSON array on line 2.
  var prompt = sawRequest.body.messages[0].content;
  var promptLines = prompt.split('\n');
  check('lens-local: the instruction is the first line, outside the JSON',
        /Translate the following 2/i.test(promptLines[0]) &&
        promptLines[0].indexOf('[') < 0 &&
        promptLines[1] === '["A","B"]');
  check('lens-local: the instruction names the job and the language pair',
        /Translate/i.test(promptLines[0]) &&
        /Japanese/i.test(promptLines[0]) &&
        /English/i.test(promptLines[0]));
  check('lens-local: the instruction pins the output shape and count',
        /ONLY a JSON array of 2/i.test(promptLines[0]) &&
        /no code fences/i.test(promptLines[0]));
  check('lens-local: not one image byte reaches the local server',
        sawRequest.opts.body.indexOf('image') < 0);
  // The engine's job ends at translated regions: the page redraws and replaces
  // them the same way it does for the free engine.
  eq('lens-local: two regions come back', out.regions.length, 2);
  eq('lens-local: the first box is translated', out.regions[0].translated, 'Hello');
  eq('lens-local: the second box is translated', out.regions[1].translated, 'Goodbye');
  eq('lens-local: the original text is preserved', out.regions[0].text, 'A');
  check('lens-local: no bitmap, so the usual painter path runs', !out.image);
  eq('lens-local: diagnostics name the backend', out.diagnostics.backend, 'lens-local');
  eq('lens-local: diagnostics name the server', out.diagnostics.endpoint,
     'http://localhost:8000/v1/chat/completions');
  check('lens-local: Lens diagnostics survive', out.diagnostics.lensCalls === 2);
  // A model that answers the first time costs exactly one request: dividing a
  // batch is a recovery path, never the normal path.
  eq('lens-local: a clean page costs one request', out.diagnostics.batches, 1);
  eq('lens-local: and reports nothing unpaired', out.diagnostics.untranslated, 0);

  // An unknown source language must be omitted, not sent as the literal "auto":
  // no model wants to be told the input is in a language called auto.
  sawRequest = null;
  fetchQueue.push(function (url, opts) {
    sawRequest = { body: JSON.parse(opts.body) };
    return jsonReply(200, ['Hi']);
  });
  globalThis.CTLensProto.scan = function () {
    return Promise.resolve({ sourceLang: 'auto', regions: [{ text: 'x' }], diagnostics: {} });
  };
  out = await CTLensLocalEngine.imageToRegions({
    bytes: new Uint8Array([9]), mime: 'image/png', width: 10, height: 10,
    sourceLang: 'auto', targetLang: 'en', settings: { localTextUrl: 'http://l:1' }
  });
  check('lens-local: an unknown source language is omitted from the body',
        !('source' in sawRequest.body));
  check('lens-local: the instruction still names the target when source is unknown',
        /original language/i.test(sawRequest.body.messages[0].content) &&
        /English/i.test(sawRequest.body.messages[0].content));
  check('lens-local: a bare JSON array reply is accepted',
        out.regions[0].translated === 'Hi');

  // A model that answers with the wrong number of lines must still fail loudly:
  // pairing them up anyway would paint the wrong words into speech bubbles. What
  // changed is how hard we try first - the batch is re-asked in halves, so the
  // error has to survive that and not be papered over by a lucky small batch.
  // The scan stub above reports a single box, so widen it first - one line in,
  // one line out is a match, and a match is not what is under test here.
  globalThis.CTLensProto.scan = function () {
    return Promise.resolve({
      sourceLang: 'ja', regions: [{ text: 'x' }, { text: 'y' }], diagnostics: {}
    });
  };
  // Short by one at EVERY size, so this is the model that cannot pair a line even
  // alone: 2 lines -> 1, then each single line -> none at all.
  var unpairable = function (url, opts) {
    var sent = JSON.parse(opts.body).texts;
    return jsonReply(200, { translations: sent.slice(0, sent.length - 1) });
  };
  fetchQueue.push(unpairable, unpairable, unpairable);
  var callsBeforeUnpaired = fetchCalls.length;
  var threwPair = null;
  try {
    await CTLensLocalEngine.imageToRegions({
      bytes: new Uint8Array([9]), mime: 'image/png', width: 10, height: 10,
      sourceLang: 'ja', targetLang: 'en', settings: { localTextUrl: 'http://l:1' }
    });
  } catch (e) { threwPair = e; }
  check('lens-local: an unpaired reply fails loudly',
        !!threwPair && /refusing to pair/.test(threwPair.message));
  eq('lens-local: but only after re-asking in halves',
     fetchCalls.length - callsBeforeUnpaired, 3);

  // ...and an unreachable server reports the URL the user typed, because that
  // is the one thing they can act on. The bare host is reported fully resolved,
  // since a path-less URL is what they need checking against the server's routes.
  fetchQueue.push(function () { throw new Error('connect ECONNREFUSED'); });
  var threwDown = null;
  try {
    await CTLensLocalEngine.imageToRegions({
      bytes: new Uint8Array([9]), mime: 'image/png', width: 10, height: 10,
      sourceLang: 'ja', targetLang: 'en', settings: { localTextUrl: 'http://l:1' }
    });
  } catch (e) { threwDown = e; }
  check('lens-local: an unreachable server names the URL',
        !!threwDown && /http:\/\/l:1\/v1\/chat\/completions/.test(threwDown.message));

  // ── batch halving: count mismatches re-asked in smaller pieces ───────
  // A model that drops the last line on batches larger than 2, but behaves on
  // 2 or fewer (the real LM Studio behavior on 17 strings dropping 2).
  var dropsOver2 = function (url, opts) {
    var sent = JSON.parse(opts.body).messages[0].content;
    var match = sent.match(/\[.*\]/);
    var texts = match ? JSON.parse(match[0]) : [];
    var out = texts.map(function (t) { return 'T(' + t + ')'; });
    if (texts.length > 2) out = out.slice(0, texts.length - 1);
    return jsonReply(200, { translations: out });
  };

  globalThis.CTLensProto.scan = function () {
    return Promise.resolve({
      sourceLang: 'ja',
      regions: [{ text: 'A' }, { text: 'B' }, { text: 'C' }, { text: 'D' }],
      diagnostics: {}
    });
  };
  fetchQueue.push(dropsOver2, dropsOver2, dropsOver2);
  var callsBeforeSplit = fetchCalls.length;
  var splitOut = await CTLensLocalEngine.imageToRegions({
    bytes: new Uint8Array([9]), mime: 'image/png', width: 10, height: 10,
    sourceLang: 'ja', targetLang: 'en', settings: { localTextUrl: 'http://l:1' }
  });
  eq('lens-local: split batch takes 3 requests (top + 2 halves)',
     fetchCalls.length - callsBeforeSplit, 3);
  eq('lens-local: all 4 lines translated after splitting',
     splitOut.regions.map(function (r) { return r.translated; }).join(','),
     'T(A),T(B),T(C),T(D)');
  eq('lens-local: exact order and text alignment preserved',
     splitOut.regions[2].translated, 'T(C)');
  eq('lens-local: diagnostics track split batches', splitOut.diagnostics.batches, 3);
  eq('lens-local: diagnostics report 0 untranslated', splitOut.diagnostics.untranslated, 0);

  // Line that fails down to leaf level leaves region untranslated ('' fallback)
  var failsSingleB = function (url, opts) {
    var sent = JSON.parse(opts.body).messages[0].content;
    var match = sent.match(/\[.*\]/);
    var texts = match ? JSON.parse(match[0]) : [];
    if (texts.length > 1) {
      // Drop last line for batch > 1
      return jsonReply(200, { translations: texts.slice(0, texts.length - 1) });
    }
    // At leaf: 'A' succeeds, 'B' returns empty array (unpairable)
    if (texts[0] === 'B') {
      return jsonReply(200, { translations: [] });
    }
    return jsonReply(200, { translations: ['T(' + texts[0] + ')'] });
  };
  globalThis.CTLensProto.scan = function () {
    return Promise.resolve({
      sourceLang: 'ja',
      regions: [{ text: 'A' }, { text: 'B' }],
      diagnostics: {}
    });
  };
  fetchQueue.push(failsSingleB, failsSingleB, failsSingleB);
  var leafOut = await CTLensLocalEngine.imageToRegions({
    bytes: new Uint8Array([9]), mime: 'image/png', width: 10, height: 10,
    sourceLang: 'ja', targetLang: 'en', settings: { localTextUrl: 'http://l:1' }
  });
  eq('lens-local: unresolvable line leaves translated string empty',
     leafOut.regions[1].translated, '');
  eq('lens-local: resolved line gets translated string',
     leafOut.regions[0].translated, 'T(A)');
  eq('lens-local: painter original text retained', leafOut.regions[1].text, 'B');
  eq('lens-local: diagnostics report 1 untranslated line', leafOut.diagnostics.untranslated, 1);


  // ── a general LLM talks back: instruction + tolerant parsing ─────────
  eq('lens-local: languageLabel resolves a shared-table code',
      CTLensLocalEngine.languageLabel('ja'), 'Japanese');
  eq('lens-local: languageLabel tags CJK regions without the table',
      CTLensLocalEngine.languageLabel('zh-TW'), 'Chinese (Traditional)');
  eq('lens-local: unknown codes pass through untouched',
      CTLensLocalEngine.languageLabel('xx'), 'xx');
  var instr = CTLensLocalEngine.buildInstruction(['a', 'b', 'c'], 'zh-TW', 'ja');
  check('lens-local: instruction states job, pair and count',
        /Translate the following 3/i.test(instr) &&
        /Japanese/i.test(instr) && /Chinese \(Traditional\)/i.test(instr) &&
        /ONLY a JSON array of 3/i.test(instr) && /no code fences/i.test(instr));
  instr = CTLensLocalEngine.buildInstruction(['a'], 'en', 'auto');
  check('lens-local: instruction never names a language called auto',
        instr.indexOf('auto') < 0 && /original language/i.test(instr));
  var found = CTLensLocalEngine.extractJsonArray(
    'Sure! ```json\n["Hi there", "Bye"]\n``` Hope that helps.');
  check('lens-local: an array inside prose/fences is recovered',
        !!found && found.parsed.length === 2 && found.parsed[0] === 'Hi there');
  check('lens-local: brackets inside quoted text do not break the scan',
        CTLensLocalEngine.extractJsonArray('He said "[hi]" then ["a", "b"]').parsed[1] === 'b');
  check('lens-local: pure prose yields nothing',
        CTLensLocalEngine.extractJsonArray('hello there, no array here') === null);

  // The raw-text fallback runs inside imageToRegions. jsonReply has no text(),
  // so wrap it: a text/plain LLM answer carrying a fenced array must land.
  globalThis.CTLensProto.scan = function () {
    return Promise.resolve({
      sourceLang: 'ja', regions: [{ text: 'x' }, { text: 'y' }], diagnostics: {}
    });
  };
  fetchQueue.push(function () {
    return {
      ok: true, status: 200,
      headers: { get: function () { return 'text/plain'; } },
      json: function () { return Promise.reject(new Error('not json')); },
      text: function () {
        return Promise.resolve('Here you go:\n```json\n["one", "two"]\n```');
      }
    };
  });
  out = await CTLensLocalEngine.imageToRegions({
    bytes: new Uint8Array([9]), mime: 'image/png', width: 10, height: 10,
    sourceLang: 'ja', targetLang: 'en', settings: { localTextUrl: 'http://l:1' }
  });
  check('lens-local: a fenced text/plain answer is translated, not rejected',
        out.regions[0].translated === 'one' && out.regions[1].translated === 'two');

  // ...but genuine chat prose still fails loudly instead of being guessed at.
  var proseResponder = function () {
    return {
      ok: true, status: 200,
      headers: { get: function () { return 'text/plain'; } },
      json: function () { return Promise.reject(new Error('not json')); },
      text: function () { return Promise.resolve('I cannot translate that, sorry.'); }
    };
  };
  fetchQueue.push(proseResponder, proseResponder, proseResponder);
  var threwChat = null;
  try {
    await CTLensLocalEngine.imageToRegions({
      bytes: new Uint8Array([9]), mime: 'image/png', width: 10, height: 10,
      sourceLang: 'ja', targetLang: 'en', settings: { localTextUrl: 'http://l:1' }
    });
  } catch (e) { threwChat = e; }
  check('lens-local: prose with no array fails loudly',
        !!threwChat && /not valid JSON/i.test(threwChat.message));

  // Regression: a real Response consumes its body once. json() reads the stream
  // and then fails to parse, so the later text() rejects with "body already
  // read" - which is the ONLY way a text/plain LLM reply can arrive. The stub
  // above gave json() and text() independent bodies, so it passed while the real
  // request could never work. Model the consumed stream exactly.
  fetchQueue.push(function () {
    var consumed = false;
    return {
      ok: true, status: 200,
      headers: { get: function () { return 'text/plain'; } },
      json: function () {
        consumed = true;
        return Promise.reject(new SyntaxError('Unexpected token in JSON'));
      },
      text: function () {
        if (consumed) {
          return Promise.reject(new TypeError('body stream already read'));
        }
        return Promise.resolve('```json\n["one", "two"]\n```');
      }
    };
  });
  var outConsumed = null;
  try {
    outConsumed = await CTLensLocalEngine.imageToRegions({
      bytes: new Uint8Array([9]), mime: 'image/png', width: 10, height: 10,
      sourceLang: 'ja', targetLang: 'en', settings: { localTextUrl: 'http://l:1' }
    });
  } catch (e) { outConsumed = e; }
  check('lens-local: a real consumed-body Response still yields translations',
        !!(outConsumed && outConsumed.regions) &&
        outConsumed.regions[0].translated === 'one' &&
        outConsumed.regions[1].translated === 'two');

  // ── cancelling: turning the page stops the model, it does not wait ───────
  // A local model burns the user's own CPU for every token it emits, and the page
  // that asked for this translation can be gone long before the model finishes.
  // So the request stays registered while it is in flight, cancelActive() cuts it,
  // and the failure is flagged `cancelled` - which is what lets background.js treat
  // a deliberate stop as an expected event instead of a server error.
  var inFlight = null;
  fetchQueue.push(function (url, opts) {
    return new Promise(function (resolve, reject) {
      inFlight = { url: url, opts: opts, settle: resolve };
      // Modelled exactly: an aborted fetch rejects with a DOMException named
      // AbortError, which is indistinguishable from the 120s timeout by type -
      // only the engine's own `cancelled`/`timedOut` flags tell them apart.
      opts.signal.onabort = function () {
        var e = new Error('The operation was aborted.');
        e.name = 'AbortError';
        reject(e);
      };
    });
  });

  var pending = CTLensLocalEngine.imageToRegions({
    bytes: new Uint8Array([9]), mime: 'image/png', width: 100, height: 50,
    sourceLang: 'ja', targetLang: 'en', settings: { localTextUrl: 'http://l:1' }
  });
  // Bounded microtask drain - no timers, so this cannot hang: the Lens stubs all
  // resolve immediately, so the fetch is issued after a fixed handful of ticks.
  for (var spin = 0; spin < 50 && !inFlight; spin++) await Promise.resolve();
  check('lens-local: the request is issued and waiting', !!inFlight);
  eq('lens-local: a live request can be cancelled',
     CTLensLocalEngine.cancelActive(), true);

  var stopped = null;
  try { await pending; } catch (e) { stopped = e; }
  check('lens-local: a cancelled request ends as cancelled, not as a translation',
        !!stopped && stopped.cancelled === true);
  check('lens-local: the cancel says the page changed, not that the server failed',
        !!stopped && /page changed/i.test(stopped.message) &&
        !/Cannot reach/i.test(stopped.message));
  check('lens-local: the abort actually reached the fetch signal',
        !!inFlight && inFlight.opts.signal.aborted === true);
  // Nothing may stay registered once the request settles, or a later page change
  // would abort whatever happened to be running then.
  eq('lens-local: nothing stays registered after the request settles',
     CTLensLocalEngine.cancelActive(), false);
  // A second cancel with nothing in flight is a no-op, which is what makes it safe
  // for background.js to call on every navigation regardless of the engine in use.
  eq('lens-local: cancelling an idle engine reports nothing to do',
     CTLensLocalEngine.cancelActive(), false);

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
