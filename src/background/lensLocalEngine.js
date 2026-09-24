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
 * Server contract. TWO shapes are supported, because the local-AI servers people
 * actually run split into two families, and one extension should speak to both:
 *
 *   (A) A CHAT endpoint - LM Studio, Ollama, llama.cpp's server, vLLM, OpenRouter.
 *       Detected by a path containing "chat". The instruction is the FIRST LINE
 *       of the user message, outside any JSON envelope, followed by the array:
 *
 *         POST {localTextUrl}      e.g. http://lmserver.local:1234/v1/chat/completions
 *         Content-Type: application/json
 *         Authorization: Bearer {localTextApiKey}          (only if set)
 *         { "model": "google/gemma-4-12b",                 (only if set)
 *           "messages": [ { "role": "user",
 *                            "content": "Translate ... no code fences.\n[\"...\"]" } ],
 *           "temperature": 0 }
 *         -> 200 { "choices": [ { "message": { "content": "[\"...\"]" } } ] }
 *
 *   (B) A COMPLETION endpoint - llama.cpp's text-completions route and hand-rolled
 *       shims. Detected by a path containing "completions" (and not "chat"). The
 *       body IS the prompt:
 *
 *         POST {localTextUrl}      e.g. http://127.0.0.1:8080/completion
 *         Content-Type: text/plain;charset=utf-8
 *         body: "Translate ... no code fences.\n[\"...\"]"
 *         -> 200 { "content": "[\"...\"]" }   or a bare array, or plain text
 *
 *   (C) A DEDICATED translation endpoint - anything answering
 *       { "translations": [...] } to any of the above. No model name needed.
 *
 *   The reply is read as text and parsed by hand, so all of these land in the
 *   same place: a chat envelope, a completion envelope, {"translations":[...]},
 *   a bare array, or an array wrapped in prose or a ```json fence - which is what
 *   a general LLM actually emits. Reasoning models' answer half is used and
 *   their reasoning half is discarded (see unwrapAssistantText).
 *
 *   The "model" field is only sent for chat endpoints when the user names one;
 *   LM Studio accepts a model id, Ollama does not want one, and llama.cpp's
 *   server ignores it, so guessing would be wrong somewhere.
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
   * Only http(s). A bare host:port gets the default path below.
   *
   * Parsed by hand rather than with `new URL()`: the browser always has URL, but
   * the jsc harness that runs tools/test_lara.js does not, and a URL check that
   * no test can exercise is a URL check nobody notices breaking.
   *
   * The default path is the OpenAI-compatible chat route, because that is what
   * the servers people actually run expose by default: LM Studio, Ollama's
   * OpenAI-compatible listener, vLLM and llama.cpp's server all serve
   * /v1/chat/completions. A dedicated hand-written shim keeps working - just
   * give its path explicitly (e.g. http://localhost:8000/translate).
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
      path = '/v1/chat/completions';
    }
    return scheme + '://' + host + path;
  }

  /**
   * The URL to ask for the model list, derived from the chat endpoint.
   *
   * Only used by the "Test local server" button, to fill in a model id so the
   * user does not have to copy it out of the server's own UI. OpenAI-compatible
   * servers put the list at <prefix>/models, so /v1/chat/completions pairs with
   * /v1/models; Ollama's native route is /api/chat and pairs with /api/tags.
   * Returns null for a non-chat endpoint, which has no model to name.
   */
  function modelsEndpoint(endpoint) {
    const ep = String(endpoint || '');
    if (!isChatEndpoint(ep)) return null;
    if (/\/api\/chat\/?$/.test(ep)) return ep.replace(/\/api\/chat\/?$/, '/api/tags');
    return ep.replace(/\/chat\/completions\/?$/, '/models')
             .replace(/\/chat\/?$/, '/models');
  }

  /**
   * Model ids the server offers, newest-list first, with embedding models
   * filtered out. A text-completion endpoint has no models: null.
   *
   * Handles the two list shapes in the wild: OpenAI-compatible {data:[{id}]}
   * (LM Studio, vLLM, llama.cpp's server) and Ollama's {models:[{key|name}]}.
   * Embedding models are excluded because posting a chat request to one fails
   * with a route-level error that looks nothing like "wrong model".
   */
  function parseModelList(data) {
    let list = null;
    if (data && Array.isArray(data.data)) list = data.data;
    else if (data && Array.isArray(data.models)) list = data.models;
    if (!list) return [];
    const out = [];
    for (const m of list) {
      if (!m) continue;
      const id = String(m.id || m.key || m.name || m.model || '').trim();
      if (!id) continue;
      if (/embed|embedding|bge-|e5-|minilm/i.test(id)) continue;
      if (out.indexOf(id) < 0) out.push(id);
    }
    return out;
  }

  /**
   * Is this a CHAT endpoint (LM Studio, Ollama, vLLM, llama.cpp's chat route)?
   *
   * A live probe of LM Studio's own API showed the trap this avoids: it serves
   * /v1/chat/completions and /v1/completions, but its NATIVE REST API has NO
   * text-completion route at all (/api/v1/completions and /api/v1/generate are
   * 404). So a "just POST the raw prompt" client cannot talk to LM Studio at all -
   * the request has to be a JSON messages envelope. Detection is by path, not
   * by a setting: a path containing "chat" is one on every server in this family
   * (they all use the OpenAI /api/chat / /v1/chat/completions convention), and
   * "completions" without "chat" means llama.cpp's /completion or a custom
   * text-completions shim, which does consume the raw prompt.
   */
  function isChatEndpoint(endpoint) {
    return /chat/i.test(String(endpoint || ''));
  }

  /**
   * The HTTP request for one page's strings.
   *
   * The prompt is always built by buildPrompt - instruction first, outside any
   * JSON - and is then wrapped for the detected endpoint family. `texts`,
   * `source` and `target` are still sent for chat endpoints because a chat
   * server that is actually a dedicated translator can read them; a general LLM
   * ignores them and obeys the prompt. temperature 0: a comic page should get
   * the same translation on a re-read, and a reasoning model's "creative" pass
   * is exactly the wrong behaviour for fixed dialogue.
   */
  function buildRequest(endpoint, prompt, texts, target, source, settings) {
    const headers = {};
    const apiKey = settings.localTextApiKey && String(settings.localTextApiKey).trim();
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;

    if (isChatEndpoint(endpoint)) {
      headers['Content-Type'] = 'application/json';
      const body = {
        messages: [{ role: 'user', content: prompt }],
        temperature: 0
      };
      const model = String((settings.localTextModel || '')).trim();
      // Only sent when the user named one: LM Studio wants an id, Ollama
      // rejects an unknown one, llama.cpp ignores it.
      if (model) body.model = model;
      body.texts = texts;
      body.target = target;
      if (source && source !== 'auto') body.source = source;
      return { headers: headers, body: JSON.stringify(body), chat: true };
    }

    headers['Content-Type'] = 'text/plain;charset=utf-8';
    return { headers: headers, body: prompt, chat: false };
  }

  /**
   * Pull a generated string out of a *completion* envelope, or null. The answer
   * lives in a different field per server: llama.cpp's server uses `content`,
   * some shims use `response` or `text`. Reasoning models put their scratch work
   * in `reasoning_content`, which is deliberately never read.
   */
  function unwrapCompletionText(data) {
    if (!data || typeof data !== 'object') return null;
    for (const key of ['content', 'response', 'text', 'completion']) {
      if (typeof data[key] === 'string' && data[key].trim()) return data[key];
    }
    return null;
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
   * The prompt sent to the local model.
   *
   * A general LLM is a chat/completion endpoint, not a translation API: drop a
   * bare {"texts":[...]} at it and it will answer the question you did not ask.
   * So the request is plain text - the instruction is the FIRST LINE, outside any
   * JSON envelope, because that is what a completion endpoint consumes as its
   * prompt, and a model reads an opening instruction far more reliably than one
   * buried in a JSON field.
   *
   * Line 2 is a JSON array of the source strings. JSON - rather than one string
   * per line - because OCR text can contain newlines, quotes and brackets, and
   * line-based framing would split a single bubble into two entries and shift
   * every translation after it. The count is stated twice (prose and shape)
   * because an off-by-one there silently mis-pairs the whole page.
   */
  function buildInstruction(texts, target, source) {
    const n = texts.length;
    const from = languageLabel(source);
    const to = languageLabel(target);
    const instruction = 'Translate the following ' + n + ' text(s) from ' + from +
      ' to ' + to + '. Reply with ONLY a JSON array of ' + n +
      ' translated strings, in the same order, no explanations, no code fences.';
    return instruction + '\n' + JSON.stringify(texts);
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
   * Pull the assistant's ANSWER out of a chat envelope, or return the value
   * unchanged when it is not one.
   *
   * This exists because of reasoning models (Qwen3, Gemma 4, DeepSeek-R1, ...).
   * Their reply carries two different pieces of text and they are NOT
   * interchangeable:
   *
   *   LM Studio  /api/v1/chat  -> { output: [ {type:"reasoning", content:...},
   *                                           {type:"message",   content:...} ] }
   *   OpenAI     /v1/chat/...  -> { choices:[{ message:{ content:...,
   *                                            reasoning_content:... }} ] }
   *   Ollama     /api/chat     -> { message:{ content:... } }
   *
   * The reasoning half quotes the input back while working - including the
   * ORIGINAL JSON array of Japanese - so scanning the whole body for an array
   * finds the source text first and would paint the untranslated original over
   * every bubble, silently. Only the answer half is ever a candidate.
   *
   * Returns the answer as a string, or null when this is not a chat envelope
   * (a dedicated translation server answering {"translations":[...]} passes
   * through untouched).
   */
  function unwrapAssistantText(data) {
    if (!data || typeof data !== 'object') return null;

    // LM Studio native: keep only the answer items, never the reasoning ones.
    if (Array.isArray(data.output)) {
      const parts = data.output
        .filter((o) => o && (o.type === 'message' || o.type === 'text'))
        .map((o) => String(o.content === undefined ? '' : o.content));
      return parts.length ? parts.join('\n') : null;
    }

    // OpenAI-compatible.
    if (Array.isArray(data.choices) && data.choices.length) {
      const msg = data.choices[0] && data.choices[0].message;
      if (msg && typeof msg.content === 'string' && msg.content.trim()) {
        return msg.content;
      }
      return null;
    }

    // Ollama.
    if (data.message && typeof data.message.content === 'string' &&
        data.message.content.trim()) {
      return data.message.content;
    }

    return null;
  }

  /**
   * JSON.parse that returns undefined instead of throwing, for the error-path
   * call sites where a non-JSON body is expected and not interesting.
   */
  function safeJson(text) {
    try {
      return JSON.parse(String(text));
    } catch (e) {
      return undefined;
    }
  }

  /**
   * The server's own error text, when it reported one in a body.
   *
   * LM Studio, Ollama and llama.cpp's server answer an UNKNOWN ROUTE with HTTP
   * 200 and a body like {"error":"Unexpected endpoint or method. (POST /translate)"}.
   * Treating that as "no translations array" sends the user hunting for a parsing
   * bug that does not exist, so the server's message is surfaced verbatim.
   */
  function serverErrorMessage(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (data.translations || data.result) return null; // a real payload
    for (const key of ['error', 'detail', 'message', 'msg']) {
      const v = data[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (v && typeof v === 'object' && typeof v.message === 'string' &&
          v.message.trim()) {
        return v.message.trim();
      }
    }
    return null;
  }

  /**
   * Coerce one server reply into exactly `expected` strings.
   *
   * Index alignment is the whole contract: entry i translates region i. A length
   * mismatch is an error rather than a zip, because silently pairing the wrong
   * strings paints plausible nonsense into speech bubbles - much worse than a
   * visible failure. Accepted shapes: {"translations":[...]} (the dedicated shim
   * contract), {"result":[...]}, and a bare array.
   */
  function normalizeTranslations(data, expected) {
    let list = null;
    if (Array.isArray(data)) {
      list = data;
    } else if (data && Array.isArray(data.translations)) {
      list = data.translations;
    } else if (data && Array.isArray(data.result)) {
      list = data.result;
    }
    if (list === null) {
      throw new Error(
        'Local server reply has no translations array. Expected ' +
        '{"translations":["..."]} with ' + expected + ' entries.');
    }
    if (typeof expected === 'number' && list.length !== expected) {
      throw new Error(
        'Local server returned ' + list.length + ' translation(s) for ' + expected +
        ' source line(s) - refusing to pair them, because shifted entries would ' +
        'paint the wrong text into the wrong speech bubble.');
    }
    return list.map((v) => (v === null || v === undefined ? '' : String(v)));
  }

  /**
   * Already-parsed JSON to translations. Exported for the "Test local server"
   * probe, which posts the same envelope and must interpret the answer with the
   * identical rules the engine uses.
   */
  function parseReply(data, expected) {
    return normalizeTranslations(data, expected);
  }

  /**
   * Coerce a response BODY (the string from res.text()) into exactly `expected`
   * translations. Shared by the engine and the "Test local server" probe so both
   * read a reply with identical rules.
   *
   * The body is read as text and parsed by hand, because a general LLM's answer
   * is not reliably JSON. res.json() consumes the response stream even when the
   * parse then throws, so a json()-then-text() fallback rejects with "body
   * stream already read" on exactly the case it exists for. Accepted: a chat
   * envelope, a completion envelope, {"translations":[...]}, a bare array, and an
   * array wrapped in prose or a ```json fence.
   */
  function parseBody(bodyText, expected) {
    const text = (bodyText === null || bodyText === undefined) ? '' : String(bodyText);
    if (!text.trim()) {
      throw new Error('Local server reply was empty. Expected ' +
        '{"translations":["..."]}.');
    }

    let parsedBody;
    try {
      parsedBody = JSON.parse(text);
    } catch (e) {
      parsedBody = undefined;
    }

    let data = null;
    if (parsedBody !== undefined) {
      const answer = unwrapAssistantText(parsedBody);
      if (answer !== null) {
        // A chat or completion envelope. The answer is a STRING that may itself
        // be JSON, may be code-fenced, may carry a sentence of prose - so parse
        // that string. Never scan the whole body for an array: a reasoning
        // model's scratch half quotes the source text back and would win,
        // painting the untranslated original into every bubble with no error.
        try {
          data = JSON.parse(answer);
        } catch (e2) {
          const found = extractJsonArray(answer);
          data = found ? found.parsed : null;
        }
      } else {
        // Not an envelope: a dedicated translation server answering
        // {"translations":[...]} or a bare array. Use it as-is - but surface its
        // own error text first, because LM Studio answers an UNKNOWN ROUTE with
        // HTTP 200 and {"error":"Unexpected endpoint or method."}, which would
        // otherwise be reported as a missing translations array and send the
        // user hunting for a parsing bug that does not exist.
        const reported = serverErrorMessage(parsedBody);
        if (reported) {
          throw new Error('Local server reported: ' + reported);
        }
        data = parsedBody;
      }
    } else {
      // Not JSON at all: a raw completion that wrapped the array in prose or a
      // code fence.
      const found = extractJsonArray(text);
      data = found ? found.parsed : null;
    }

    if (data === null || data === undefined) {
      // Genuine prose still fails here: guessing which sentence is translation
      // 3 of 7 would paint plausible nonsense into speech bubbles.
      throw new Error('Local server reply was not valid JSON. Expected ' +
        '{"translations":["..."]}.');
    }
    return normalizeTranslations(data, expected);
  }

  /**
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

    // text/plain, not application/json: the body IS the prompt. A completion
    // endpoint (llama.cpp, Ollama /api/generate, LM Studio's text completions)
    // consumes the raw text; a JSON envelope would arrive as a JSON object
    // printed into the model's context, and the instruction would stop being
    // the first thing it reads. A CHAT endpoint (LM Studio, Ollama, vLLM) has no
    // text route at all - it needs the JSON messages envelope - so buildRequest
    // picks the right one from the URL.
    const request = buildRequest(endpoint, buildInstruction(texts, target, sourceLang),
      texts, target, sourceLang, settings);

    log(settings, 'POSTing', texts.length, 'strings to', endpoint);
    let res;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120000);
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
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

    // Read the body ONCE, as text, whatever the status: an error status from a
    // local server carries the real reason in its body too, and res.json() would
    // consume the stream that parseBody needs.
    let bodyText = null;
    try {
      bodyText = await res.text();
    } catch (e) {
      bodyText = null;
    }

    if (!res.ok) {
      let detail = 'HTTP ' + res.status;
      const reported = bodyText ? serverErrorMessage(safeJson(bodyText)) : null;
      if (reported) detail += ': ' + reported;
      throw new Error('Local server error (' + detail + ').');
    }

    const translations = parseBody(bodyText, texts.length);

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
    modelsEndpoint,
    parseModelList,
    isChatEndpoint,
    buildRequest,
    safeJson,
    serverErrorMessage,
    parseReply,
    parseBody,
    languageLabel,
    buildInstruction,
    unwrapCompletionText,
    unwrapAssistantText,
    extractJsonArray,
    normalizeTranslations,
    log,
    imageToRegions
  };
}
