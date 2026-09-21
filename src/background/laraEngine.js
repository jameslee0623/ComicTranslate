/**
 * laraEngine.js - the 'lara' engine: Lara Translate's image API.
 *
 * One OFFICIAL, documented call replaces the whole undocumented Lens chain:
 *
 *   POST https://api.laratranslate.com/v2/images/translate
 *     multipart fields: image, source, target, model
 *     -> binary translated image (server does OCR + text removal + typesetting)
 *
 * Auth (mirrors the official browser SDK, src/crypto/browser-crypto.ts +
 * src/net/lara/client.ts in translated/lara-node):
 *   1. POST /v2/auth  body {id}
 *        Content-MD5:  base64(SHA-256(body) truncated to 16 bytes)
 *        X-Lara-Date:  UTC date string
 *        Authorization: Lara:<base64(HMAC-SHA256(challenge, secret))>
 *        challenge = `${method}\n${path}\n${contentMD5}\n${contentType}\n${date}`
 *      `path` is the FULL request path ('/v2/auth') - the server rebuilds the
 *      challenge from the URI it receives, so a relative path fails with
 *      "Invalid challenge signature".
 *      (the field name lies - the browser SDK digests with SHA-256, not MD5.
 *       The server verifies the digest only inside the HMAC, so any consistent
 *       digest works; the browser variant is what we mirror.)
 *   2. every later call: Authorization: Bearer <token from /v2/auth>
 *      the token is a JWT; on expiry or 401, POST /v2/auth/refresh once, then
 *      fall back to a full access-key re-authentication.
 *
 * Cost warning surfaced in the options UI: Lara meters everything in characters
 * and image translation bills 10,000 characters per image, so each page costs
 * real money on the paid tiers. The engine therefore caches every response,
 * keyed by pixels+engine+model+target, so repeat views are always free.
 */
'use strict';

if (typeof globalThis.CTLaraEngine === 'undefined') {
  const API_ROOT = 'https://api.laratranslate.com';
  const API_BASE = API_ROOT + '/v2';

  function log(settings, ...args) {
    if (settings && settings.debug) console.log('[CT/lara]', ...args);
  }

  // ── auth primitives ────────────────────────────────────────────────────────

  /** btoa(String.fromCharCode(...)) chokes on large arrays; chunk it. */
  function bytesToBase64(bytes) {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  /**
   * The browser SDK's digestBase64: SHA-256 truncated to 16 bytes, base64.
   * Despite the name (and the Node SDK's true MD5), this is what the browser
   * SDK sends in the Content-MD5 header - and it passes the server's HMAC
   * check, so the digest is opaque to the server beyond being consistent.
   */
  async function digestBase64(text) {
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    );
    return bytesToBase64(digest.slice(0, 16));
  }

  /** base64(HMAC-SHA256(key, data)) - WebCrypto needs the key imported first. */
  async function hmac(key, data) {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(key),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign(
      'HMAC',
      cryptoKey,
      new TextEncoder().encode(data)
    );
    return bytesToBase64(new Uint8Array(signature));
  }

  /**
   * Exactly the SDK's challenge string. Exported for tests: getting this wrong
   * is the difference between a working engine and a 401 on every request.
   */
  function authChallenge(method, path, contentMd5, contentType, date) {
    return [method, path, contentMd5 || '', contentType || '', date]
      .map((s) => String(s).trim())
      .join('\n');
  }

  // ── token lifecycle ────────────────────────────────────────────────────────

  let token = null;          // current JWT
  let refreshToken = null;   // single-use, rotated by the server on refresh

  /** Decode a JWT payload without verifying it - we only need `exp`. */
  function tokenExpiry(jwt) {
    try {
      const part = String(jwt).split('.')[1]
        .replace(/-/g, '+').replace(/_/g, '/');
      const padded = part + '='.repeat((4 - (part.length % 4)) % 4);
      const payload = JSON.parse(atob(padded));
      return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
    } catch {
      return 0;
    }
  }

  function tokenIsExpired(jwt, bufferMs) {
    if (!jwt) return true;
    const buffer = bufferMs == null ? 5000 : bufferMs;
    const exp = tokenExpiry(jwt);
    return exp === 0 || exp <= Date.now() + buffer;
  }

  /** Fail fast, with a message that names the settings page, not a 401. */
  function requireCredentials(settings) {
    const id = settings && settings.laraAccessKeyId;
    const secret = settings && settings.laraAccessKeySecret;
    if (!id || !secret) {
      throw new Error(
        'Lara Translate needs credentials. Add your Access Key ID and Secret ' +
        '(app.laratranslate.com/account/credentials) in Settings, or switch ' +
        'back to the Google Lens engine.'
      );
    }
    return { id, secret };
  }

  /** Signed POST with a JSON body; returns the parsed reply.
   *  `path` is the FULL request path (e.g. '/v2/auth'): the server rebuilds
   *  the challenge from the URI it receives, so the signed string and the
   *  fetched URL must show the exact same path. Signing '/auth' while sending
   *  '/v2/auth' produced "Invalid challenge signature" from the live API. */
  async function signedJsonFetch(settings, path, body) {
    const { secret } = requireCredentials(settings);
    const date = new Date().toUTCString();
    const jsonBody = JSON.stringify(body);
    const contentMd5 = await digestBase64(jsonBody);

    const headers = {
      'Content-Type': 'application/json',
      'X-Lara-Date': date,
      'Content-MD5': contentMd5,
      'X-Lara-SDK-Name': 'comictranslate-extension',
      'X-Lara-SDK-Version': '0.1.0'
    };
    headers.Authorization = 'Lara:' +
      (await hmac(secret, authChallenge('POST', path, contentMd5,
                                        headers['Content-Type'], date)));
    log(settings, 'auth request:', path);

    const res = await fetch(API_ROOT + path, {
      method: 'POST', headers, body: jsonBody
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error body */ }
    return { ok: res.ok, status: res.status, data, headers: res.headers };
  }

  /** Fresh access-key authentication; sets token + refreshToken. */
  async function authenticate(settings) {
    const { id } = requireCredentials(settings);
    const reply = await signedJsonFetch(settings, '/v2/auth', { id });
    if (!reply.ok || !reply.data || !reply.data.token) {
      const detail = reply.data && reply.data.message
        ? reply.data.message
        : 'HTTP ' + reply.status;
      throw new Error('Lara authentication failed: ' + detail);
    }
    token = reply.data.token;
    refreshToken = reply.headers.get('x-lara-refresh-token') || null;
    log(settings, 'authenticated');
  }

  /** Single-use refresh-token rotation; false means "re-authenticate". */
  async function refresh() {
    if (!refreshToken) return false;
    try {
      const res = await fetch(API_BASE + '/auth/refresh', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + refreshToken,
          'X-Lara-Date': new Date().toUTCString()
        }
      });
      if (!res.ok) { refreshToken = null; return false; }
      const data = await res.json();
      if (!data || !data.token) { refreshToken = null; return false; }
      token = data.token;
      const rotated = res.headers.get('x-lara-refresh-token');
      if (rotated) refreshToken = rotated;
      return true;
    } catch (e) {
      refreshToken = null;
      return false;
    }
  }

  /** Ensure a usable Bearer token, re-authenticating from the access key. */
  async function ensureToken(settings) {
    if (token && !tokenIsExpired(token)) return token;
    token = null;
    if (await refresh()) return token;
    await authenticate(settings);
    return token;
  }

  /** Testing hook: forget cached tokens. */
  function resetAuth() {
    token = null;
    refreshToken = null;
  }

  // ── image translation ──────────────────────────────────────────────────────

  const MODEL_PATTERN = /^(overlay|inpainting|generative|generative_fast)$/;

  /** Multipart request fields, in the SDK's field spelling. */
  function imageFormFields(settings, sourceLang, targetLang) {
    const model = MODEL_PATTERN.test(settings && settings.laraModel)
      ? settings.laraModel
      : 'inpainting';
    return {
      source: sourceLang && sourceLang !== 'auto' ? sourceLang : '',
      target: targetLang,
      model
    };
  }

  /** File extension for a mime type - Lara keys the multipart filename. */
  function extFromMime(mime) {
    const map = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/bmp': 'bmp',
      'image/avif': 'avif',
      'image/tiff': 'tiff'
    };
    return map[mime] || 'png';
  }

  /**
   * Multipart body builder. Hand-rolled rather than FormData because the
   * background page must send bytes AND read the binary reply: the boundary is
   * assembled explicitly, so the Content-Type header we send matches what the
   * server parses, byte for byte.
   */
  function buildMultipart(fields, filename, mime, bytes) {
    const boundary = '----CT' + Math.random().toString(36).slice(2);
    const headLines = [];
    for (const [name, value] of Object.entries(fields)) {
      if (value === '' || value == null) continue;
      headLines.push(
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="' + name + '"\r\n\r\n' +
        String(value) + '\r\n'
      );
    }
    headLines.push(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="image"; filename="' +
        filename + '"\r\n' +
      'Content-Type: ' + mime + '\r\n\r\n'
    );
    const head = new TextEncoder().encode(headLines.join(''));
    const tail = new TextEncoder().encode('\r\n--' + boundary + '--\r\n');
    const body = new Uint8Array(head.length + bytes.byteLength + tail.length);
    body.set(head, 0);
    body.set(new Uint8Array(bytes), head.length);
    body.set(tail, head.length + bytes.byteLength);
    return { body, contentType: 'multipart/form-data; boundary=' + boundary };
  }

  /**
   * Engine entry point. Matches the contract documented in engines.js, with one
   * extension: instead of regions, it returns { image: {bytes, mime} } - a
   * fully rendered translation done server-side. engines.js routes that to
   * CTReplace.applyImageBytes on the content side.
   */
  async function imageToRegions(req) {
    const settings = req.settings || {};
    requireCredentials(settings);
    if (tokenIsExpired(token)) await ensureToken(settings);

    const fields = imageFormFields(settings, req.sourceLang, req.targetLang);
    const mime = req.mime && req.mime !== 'application/octet-stream'
      ? req.mime
      : 'image/png';
    const { body, contentType } = buildMultipart(
      fields, 'image.' + extFromMime(mime), mime, req.bytes
    );

    const callImage = (bearer) => fetch(API_BASE + '/images/translate', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + bearer,
        'X-Lara-Date': new Date().toUTCString(),
        // Incognito mode: per Lara's docs the content is never stored or
        // trained on - important, these are users' comics.
        'X-No-Trace': 'true',
        'X-Lara-SDK-Name': 'comictranslate-extension',
        'X-Lara-SDK-Version': '0.1.0',
        'Content-Type': contentType
      },
      body
    });

    let res = await callImage(token);
    if (res.status === 401) {
      log(settings, 'token rejected; re-authenticating');
      token = null;
      await ensureToken(settings);
      res = await callImage(token);
    }

    if (!res.ok) {
      let detail = 'HTTP ' + res.status;
      try {
        const data = await res.json();
        if (data && data.message) detail += ': ' + data.message;
      } catch { /* binary or empty error body */ }
      throw new Error('Lara image translation failed (' + detail + '). ' +
        'Each image bills ~10,000 characters against your plan.');
    }

    const outBytes = await res.arrayBuffer();
    if (!outBytes.byteLength) throw new Error('Lara returned an empty image');

    const headerMime = (res.headers.get('content-type') || '').split(';')[0].trim();
    const outMime = /^image\//.test(headerMime) ? headerMime : mime;
    log(settings, 'translated image:', outBytes.byteLength, 'bytes', outMime);

    return {
      regions: [],
      image: { bytes: outBytes, mime: outMime },
      sourceLang: req.sourceLang || 'auto',
      targetLang: req.targetLang,
      diagnostics: {
        model: fields.model,
        bytesIn: req.bytes.byteLength,
        bytesOut: outBytes.byteLength,
        contentTypeOut: headerMime || '(none)'
      }
    };
  }

  // ── text translation (the cheap route: pairs with any OCR that gives boxes) ─

  /**
   * Translate an array of strings in ONE /v2/translate call.
   *
   * Lara bills the image API a flat 10,000 characters per picture, but TEXT
   * translation is billed by the actual characters sent - a manga page of
   * speech bubbles is usually 500-1,500 characters. This is what makes the
   * free tier (10k chars/month) genuinely usable, via the 'lens-lara' engine.
   *
   * The endpoint is a NDJSON stream of partial TextResults; the official SDK
   * keeps the last chunk and so do we. `translation` mirrors the input type,
   * so an array input comes back as an array.
   */
  async function translateTexts(texts, sourceLang, targetLang, settings) {
    if (!Array.isArray(texts) || !texts.length) return [];
    requireCredentials(settings);
    if (tokenIsExpired(token)) await ensureToken(settings);

    const body = { q: texts, target: String(targetLang || 'en') };
    if (sourceLang && sourceLang !== 'auto') body.source = sourceLang;

    const call = (bearer) => fetch(API_BASE + '/translate', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + bearer,
        'X-Lara-Date': new Date().toUTCString(),
        'X-No-Trace': 'true',
        'X-Lara-SDK-Name': 'comictranslate-extension',
        'X-Lara-SDK-Version': '0.1.0',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    let res = await call(token);
    if (res.status === 401) {
      log(settings, 'token rejected; re-authenticating');
      token = null;
      await ensureToken(settings);
      res = await call(token);
    }

    if (!res.ok) {
      let detail = 'HTTP ' + res.status;
      try {
        const data = await res.json();
        if (data && data.message) detail += ': ' + data.message;
      } catch { /* empty error body */ }
      const quota = res.status === 402 || res.status === 429;
      throw new Error('Lara text translation failed (' + detail + ')' +
        (quota ? '. On the free tier the API cap is 10,000 characters per month.' : ''));
    }

    const raw = await res.text();
    let last = null;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const chunk = JSON.parse(trimmed);
        if (chunk && 'translation' in chunk) last = chunk;
      } catch { /* a partial line is not a complete JSON object yet */ }
    }
    if (!last) {
      // Small replies may arrive as one plain JSON object, not a stream.
      try {
        const one = JSON.parse(raw);
        if (one && 'translation' in one) last = one;
      } catch { /* fall through to the error below */ }
    }
    if (!last) throw new Error('Lara text translation returned an unparseable response');

    // Bill the characters actually sent - this is what the free tier caps.
    if (globalThis.CTUsage) {
      await CTUsage.addTextChars(texts.join('').length);
    }

    log(settings, 'text batch:', texts.length, 'lines,',
        texts.join('').length, 'chars billed');
    const tr = last.translation;
    if (Array.isArray(tr)) return texts.map((_, i) => String(tr[i] || ''));
    // Scalar reply for a batch should not happen (T mirrors the input type);
    // if it ever does, align to index 0 and leave the rest untranslated.
    if (texts.length === 1) return [String(tr || '')];
    log(settings, 'unexpected scalar translation for a batch');
    return texts.map((_, i) => (i === 0 ? String(tr || '') : ''));
  }

  // The secret never appears in logs or diagnostics; the key id alone is safe.
  globalThis.CTLaraEngine = {
    id: 'lara',
    label: 'Lara Translate (API key, paid)',
    needsKey: true,
    /** The engine returns a finished image; engines.js must not paint locally. */
    doesTranslation: true,
    /** Cache dimension: entries differ per text-removal model. */
    variantKey: (settings) => 'model:' + ((settings && settings.laraModel) || 'inpainting'),
    authChallenge,
    tokenExpiry,
    tokenIsExpired,
    requireCredentials,
    ensureToken,
    imageFormFields,
    extFromMime,
    translateTexts,
    resetAuth,
    log,
    imageToRegions
  };
}