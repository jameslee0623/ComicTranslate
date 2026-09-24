/**
 * lensLocalEngine.js - the 'lens-local' engine: Google Lens does the detection
 * and the OCR, then a USER-RUN LOCAL SERVER translates the original text.
 *
 * The extension keeps doing what it has always done: Lens finds the boxes and
 * the original strings, the translation is written back into the same regions,
 * and the local painter redraws them onto the page - the same visuals as the
 * free 'lens' engine. The ONLY thing that differs is who translates the text:
 * instead of Google's anonymous endpoint (or Lara's billed API), the strings go
 * to a server the user runs themselves.
 *
 * Because this engine returns REGIONS rather than a bitmap, engines.js caches
 * the result and the content script's existing redraw/replace path renders it -
 * no full-image route, no server-side typesetting, no font assumptions.
 *
 * Server contract (HTTP stays tiny; the LLM needs words, not just fields):
 *
 *   POST {localTextUrl}  (default path /translate for a bare host:port)
 *     headers: Content-Type: application/json
 *              Authorization: Bearer {localTextApiKey}   (only if set)
 *     body:    { "texts": ["...", "..."], "target": "en", "source": "ja",
 *                "instruction": "Translate the following 2 text(s) from Japanese
 *                 to English. Reply with ONLY a JSON array of 2 translated
 *                 strings, in the same order, no explanations, no code fences." }
 *              ("source" is omitted when the OCR language is auto/unknown;
 *               the instruction then says "from the original language")
 *     -> 200  { "translations": ["...", "..."] }   // index-aligned, same length
 *              (a bare JSON array works too; prose/code fences around it are
 *               tolerated, because that is what a general LLM actually emits)
 *
 * Index alignment is the whole contract: line i of `translations` translates
 * line i of `texts`. A length mismatch is an error, not a zip - silently pairing
 * the wrong strings would paint plausible nonsense into speech bubbles, which is
 * worse than failing loudly.
 *
 * Privacy: the OCR'd strings (and only those) travel to the URL the user typed -
 * localhost by default. No image ever reaches the local server, there is no
 * account, no quota and no billing (usage.js is never touched: the meter is the
 * Lara engines' meter).
 */
'use strict';

if (typeof globalThis.CTLensLocalEngine === 'undefined') {

  function log(settings, ...args) {
    if (settings && settings.debug) console.log('[CT/lens-local]', ...args);
  }

  /**
   * Only http(s). A bare host:port gets the documented default path.
   *
   * Parsed by hand rather than with `new URL()`: the browser always has URL, but
   * the jsc harness that runs tools/test_lara.js does not, and a URL check that
   * no test can exercise is a URL check nobody notices breaking.
   */
  function requireEndpoint(settings) {
    const raw = (settings && settings.localTextUrl) || '';
    const url = String(raw).trim();
    if (!url) {
      throw new Error(
        'Local AI engine has no server URL. Open Settings \u2192 Engine \u2192 ' +
        'Lens OCR + local AI and enter the URL of your local server.');
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
      path = '/translate';
    }
    return scheme + '://' + host + path;
  }

  /**
   * Extract the index-aligned translation list from a reply. Accepts the
   * documented { translations: [...] } shape or a bare JSON array. Anything else
   * - or a length mismatch - throws with a message naming what was expected, so
   * a misconfigured server is diagnosable from the error text alone.
   */
  function parseReply(data, expected) {
    let list = null;
    if (Array.isArray(data)) {
      list = data;
    } else if (data && Array.isArray(data.translations)) {
      list = data.translations;
    } else {
      throw new Error(
        'Local server reply has no "translations" array (got ' +
        (data === null ? 'null' : typeof data) + ').');
    }
    if (list.length !== expected) {
      throw new Error('Local server replied with ' + list.length +
        ' translations for ' + expected + ' lines - refusing to pair ' +
        'mismatched strings.');
    }
    return list.map((t) => (t == null ? '' : String(t)));
  }

  /**
   * Cache dimension: entries belong to the server they came from, so switching
   * the URL must not serve results produced by another one. Read directly rather
   * than through requireEndpoint() because engines.js builds the cache key
   * before the engine runs - an unset URL must still produce a key, and the
   * helpful "no server URL" error belongs to the translation attempt itself.
   */
  function variantKey(settings) {
    return String((settings && settings.localTextUrl) || '').trim();
  }
  /**
   * Human name for a language code, e.g. 'ja' -> 'Japanese'.
   *
   * The shared CT_LANGUAGES table is bundled with the popup/options pages; the
   * background loads it too (a script tag in the importScripts list). A test
   * that loads only this one file sees no table, so fall back to the code
   * itself - and tag CJK codes with their region, because 'zh' alone tells a
   * model nothing about simplified vs traditional.
   */
  const CJK_FALLBACK = { 'zh-CN': 'Chinese (Simplified)', 'zh-TW': 'Chinese (Traditional)' };

  function languageLabel(code) {
    const c = String(code || '').trim() || 'auto';
    if (c === 'auto') return 'the original language';
    if (typeof globalThis.CT_LANGUAGES !== 'undefined') {
      try {
        for (const lang of globalThis.CT_LANGUAGES) {
          if (lang && lang.code === c) return lang.label;
        }
      } catch (e) { /* fall through to the code itself */ }
    }
    if (CJK_FALLBACK[c]) return CJK_FALLBACK[c];
    return c;
  }

  /**
   * The instruction string that rides alongside the machine-readable fields.
   * A general LLM is a chat endpoint, not a translation API: without being
   * told the job, the language pair and the reply shape, it will chat about
   * the input instead of translating it. This names all three explicitly,
   * states the entry count twice (prose + the shape line), and pins the
   * output to bare JSON with no explanations or code fences - because prose
   * around the array is exactly what breaks index alignment downstream.
   */
  function buildInstruction(texts, target, source) {
    const n = texts.length;
    const from = languageLabel(source);
    const to = languageLabel(target);
    return 'Translate the following ' + n + ' text(s) from ' + from +
      ' to ' + to + '. Reply with ONLY a JSON array of ' + n +
      ' translated strings, in the same order, no explanations, no code fences.';
  }

  /**
   * Brace-balance scan for a [...] window that JSON.parses. A regex cannot do
   * this: quoted strings are skipped (brackets inside text must not throw the
   * depth count) and escapes inside strings are honoured. Of several parsing
   * windows, the longest wins - a correct array beats a quoted fragment.
   */
  function extractJsonArray(raw) {
    let best = null;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] !== '[') continue;
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let j = i; j < raw.length; j++) {
        const c = raw[j];
        if (inString) {
          if (escaped) { escaped = false; continue; }
          if (c === '\\') { escaped = true; continue; }
          if (c === '"') inString = false;
          continue;
        }
        if (c === '"') { inString = true; continue; }
        if (c === '[') depth++;
        else if (c === ']') {
          depth--;
          if (depth === 0) {
            const candidate = raw.slice(i, j + 1);
            try {
              const parsed = JSON.parse(candidate);
              if (!best || candidate.length > best.candidate.length) {
                best = { candidate: candidate, parsed: parsed };
              }
            } catch (e) { /* this window is prose, keep scanning */ }
            break;
          }
        }
      }
    }
    return best;
  }

  /**
   * The mismatch rule lives in exactly one place: a length mismatch is an
   * error, never a zip. Shared by parseReply and the raw-text fallback.
   */
  function normalizeTranslations(data, expected) {
    let list = null;
    if (Array.isArray(data)) list = data;
    else if (data && Array.isArray(data.translations)) list = data.translations;
    if (!list) {
      throw new Error(
        'Local server reply has no translations array. Expected ' +
        '{"translations":["..."]} with ' + expected + ' entries.');
    }
    if (list.length !== expected) {
      throw new Error(
        'Local server returned ' + list.length + ' translations for ' + expected +
        ' texts - refusing to pair by position.');
    }
    return list.map((t) => (t === null || t === undefined) ? '' : String(t));
  }

  /**
   * A *string* response (res.text()) that is not valid JSON is rejected - an
   * LLM chat reply is prose, and guessing which sentence is translation 3 of
   * 7 would paint plausible nonsense into speech bubbles. But a general LLM
   * often wraps a correct array in prose or a code fence, so before giving
   * up, hunt for a [...] that parses and use it. A JSON-shape that parses but
   * has no translations list is rejected by parseReply as before.
   *
   * Engine entry point (engines.js contract). Sends the image to Google Lens
   * exactly like the free engine does, then hands ONLY the OCR'd strings to the
   * user's own server. It returns regions, so the content script redraws and
   * replaces the text in place, the old way.
   */
  async function imageToRegions(req) {
    const settings = req.settings || {};

    // 1-2. Detect + OCR: identical halves to the free engine (downscale, then
    // crupload), reused rather than copied so the two engines cannot drift.
    const up = await CTLensEngine.toUploadable(req.bytes, req.mime, req.width, req.height);
    const scanned = await CTLensProto.scan(up.bytes, up.width, up.height, settings, {
      targetLang: req.targetLang
    });
    const regions = CTLensProto.rescaleRegions(
      scanned.regions, up.width, up.height, req.width, req.height
    );

    const sourceLang = scanned.sourceLang || req.sourceLang;
    const texts = regions.map((r) => r.text);
    const diagnostics = Object.assign(
      {
        sentSize: up.width + 'x' + up.height,
        originalSize: req.width + 'x' + req.height,
        backend: 'lens-local'
      },
      scanned.diagnostics
    );

    // Nothing found: there is no translation to ask for, and POSTing an empty
    // array would only invite a length-mismatch error from the server.
    if (!texts.length) {
      log(settings, 'no text found - skipping the local server call');
      return {
        regions: [],
        sourceLang: sourceLang || 'auto',
        targetLang: req.targetLang,
        diagnostics: diagnostics
      };
    }

    // 3. Translate the strings with the user's own server.
    const endpoint = requireEndpoint(settings);
    diagnostics.endpoint = endpoint;
    const target = String(req.targetLang || 'en');
    const body = { texts: texts, target: target,
      instruction: buildInstruction(texts, target, sourceLang) };
    if (sourceLang && sourceLang !== 'auto') body.source = sourceLang;

    const headers = { 'Content-Type': 'application/json' };
    const apiKey = settings.localTextApiKey && String(settings.localTextApiKey).trim();
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;

    log(settings, 'POSTing', texts.length, 'strings to', endpoint);
    let res;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120000);
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(body),
          signal: ctrl.signal
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      throw new Error('Cannot reach the local server at ' + endpoint +
        ' (' + (e && e.name === 'AbortError' ? 'timed out after 120s'
          : 'is it running?') + ').');
    }

    if (!res.ok) {
      let detail = 'HTTP ' + res.status;
      try {
        const data = await res.json();
        if (data && data.message) detail += ': ' + data.message;
      } catch { /* non-JSON error body - the status line is all we have */ }
      throw new Error('Local server error (' + detail + ').');
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }

    if (data === null || data === undefined) {
      // A general LLM is a chat endpoint: it may answer with text/plain, or
      // wrap the array in prose or a code fence. res.json() then throws (or
      // the content-type was never JSON), so fall back to the raw text and
      // hunt for a [...] window that parses. Genuine prose still fails here -
      // guessing translations from chat would paint nonsense into bubbles.
      let rawText = null;
      try {
        rawText = await res.text();
      } catch (e2) {
        rawText = null;
      }
      if (rawText !== null && rawText !== undefined && String(rawText)) {
        const s = String(rawText);
        let parsed = null;
        try {
          parsed = JSON.parse(s);
        } catch (e3) {
          const found = extractJsonArray(s);
          if (found) parsed = found.parsed;
        }
        if (parsed !== null && parsed !== undefined) {
          data = parsed;
        } else {
          throw new Error('Local server reply was not valid JSON. Expected ' +
            '{"translations":["...","..."]}.');
        }
      }
    }

    if (data === null || data === undefined) {
      throw new Error('Local server reply was empty. Expected ' +
        '{"translations":["...","..."]}.');
    }

    const translations = normalizeTranslations(data, texts.length);
    const finalRegions = regions.map((r, i) =>
      Object.assign({}, r, { translated: translations[i] || '' })
    );

    log(settings, 'engine done', {
      language: sourceLang,
      regions: finalRegions.length,
      translated: finalRegions.filter((r) => r.translated).length,
      endpoint: endpoint
    });

    return {
      regions: finalRegions,
      sourceLang: sourceLang || 'auto',
      targetLang: req.targetLang,
      diagnostics: diagnostics
    };
  }

  globalThis.CTLensLocalEngine = {
    id: 'lens-local',
    label: 'Google Lens OCR (free) + your own local AI server',
    needsKey: false,
    /** Self-hosted text translation costs nothing to meter. */
    free: true,
    /** Regions arrive already translated: engines.js must not run CTTranslator. */
    doesTranslation: true,
    variantKey,
    requireEndpoint,
    parseReply,
    languageLabel,
    buildInstruction,
    extractJsonArray,
    normalizeTranslations,
    log,
    imageToRegions
  };
}
