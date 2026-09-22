/**
 * localImageEngine.js - the 'local-image' engine: a user-run local server
 * that behaves like Lara's image API (full-image: POST image, get back a
 * translated bitmap; the server does detection + cleanup + typesetting).
 *
 *   POST {localImageUrl} (default path /translate-image for a bare host:port)
 *     multipart: image, source, target; optional Bearer {localImageApiKey}
 *     -> 200 binary image (content-type image/*), OR
 *     -> 200 JSON { "image": "<base64>" } (data: URIs unwrapped too)
 *
 * Privacy: nothing leaves the machine except to the URL the user typed.
 * No auth dance, no quota, no usage billing.
 */
'use strict';

if (typeof globalThis.CTLocalImageEngine === 'undefined') {

  function log(settings, ...args) {
    if (settings && settings.debug) console.log('[CT/local-image]', ...args);
  }

  /** Only http(s). A bare host:port gets the default path. No URL dependency. */
  function requireEndpoint(settings) {
    const raw = (settings && settings.localImageUrl) || '';
    const url = String(raw).trim();
    if (!url) {
      throw new Error(
        'Local image engine has no server URL. Open Settings \u2192 Engine \u2192 ' +
        'Local image model and enter the URL of your local server.');
    }
    const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
    if (!schemeMatch) {
      throw new Error('Local server URL is not a valid URL: ' + url);
    }
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      throw new Error('Local server URL must be http(s), got "' + scheme + ':".');
    }
    const rest = url.slice(schemeMatch[0].length);
    if (!rest || /\s/.test(rest)) {
      throw new Error('Local server URL is not a valid URL: ' + url);
    }
    const slash = rest.indexOf('/');
    const host = slash < 0 ? rest : rest.slice(0, slash);
    let path = slash < 0 ? '/' : rest.slice(slash);
    if (!host) {
      throw new Error('Local server URL is not a valid URL: ' + url);
    }
    if (path === '' || path === '/') {
      path = '/translate-image';
    }
    return scheme + '://' + host + path;
  }

  function extFromMime(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
    if (m.includes('webp')) return 'webp';
    if (m.includes('gif')) return 'gif';
    if (m.includes('bmp')) return 'bmp';
    return 'png';
  }

  /** Unwrap a translated bitmap from either response shape. For tests. */
  async function parseImageResponse(res) {
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (ctype.includes('image/')) {
      const buf = await res.arrayBuffer();
      const mime = ctype.split(';')[0].trim() || 'image/png';
      return { bytes: new Uint8Array(buf), mime };
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      throw new Error('Local server returned HTTP ' + res.status +
        ' with content-type "' + (ctype || 'unknown') +
        '": expected a translated image or JSON.');
    }
    let b64 = data && (data.image || data.image_base64 || data.data);
    if (!b64 || typeof b64 !== 'string') {
      const detail = data && data.message ? ': ' + data.message : '';
      throw new Error('Local server error (HTTP ' + res.status + ')' + detail);
    }
    let mime = (data && data.mime) || 'image/png';
    const uri = /^data:([^;,]+)?;base64,(.*)$/s.exec(b64);
    if (uri) {
      if (uri[1]) mime = uri[1];
      b64 = uri[2];
    }
    const bin = atob(b64.replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mime };
  }

  /** Engine entry point (engines.js contract). Full-image: bitmap, no regions. */
  async function imageToRegions(req) {
    const settings = req.settings || {};
    const endpoint = requireEndpoint(settings);
    const form = new FormData();
    form.append('image',
      new Blob([req.bytes], { type: req.mime || 'image/png' }),
      'page.' + extFromMime(req.mime));
    if (req.sourceLang && req.sourceLang !== 'auto') {
      form.append('source', req.sourceLang);
    }
    form.append('target', String(req.targetLang || 'en'));
    const headers = {};
    const apiKey = settings.localImageApiKey &&
      String(settings.localImageApiKey).trim();
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    let res;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120000);
      try {
        res = await fetch(endpoint,
          { method: 'POST', headers, body: form, signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      const why = e && e.name === 'AbortError' ? 'timed out after 120s'
        : 'is it running?';
      throw new Error('Cannot reach the local server at ' + endpoint +
        ' (' + why + ').');
    }
    if (!res.ok) {
      let detail = 'HTTP ' + res.status;
      try {
        const data = await res.json();
        if (data && data.message) detail += ': ' + data.message;
      } catch { /* binary error body */ }
      throw new Error('Local image translation failed (' + detail + ').');
    }
    const image = await parseImageResponse(res);
    log(settings, 'engine done',
      { bytes: image.bytes.length, mime: image.mime });
    return {
      regions: [],
      image,
      sourceLang: req.sourceLang || 'auto',
      targetLang: req.targetLang,
      diagnostics: { backend: 'local-image', endpoint }
    };
  }

  globalThis.CTLocalImageEngine = {
    id: 'local-image',
    label: 'Local image model (your own server, free)',
    needsKey: false,
    /** Self-hosted images cost nothing: engines.js skips the usage meter. */
    free: true,
    doesTranslation: true,
    requireEndpoint,
    extFromMime,
    parseImageResponse,
    log,
    imageToRegions
  };
}
