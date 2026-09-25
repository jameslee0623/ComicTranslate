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
 *   a general LLM actually emits. A reasoning model's answer half is preferred
 *   and its thinking half is ignored (see unwrapAssistantText); the one exception
 *   is a reply whose answer half is EMPTY while the thinking half holds the work,
 *   which LM Studio does by design when the two are split (see reasoningText).
 *
 * Page changes cancel the request. A local model is the only engine here that
 * spends the user's own CPU/GPU per token, so when the reader turns the page the
 * in-flight generation is aborted rather than left to finish into a document
 * nobody is looking at (see cancelActive).
 *
 *   The "model" field is only sent for chat endpoints when the user names one;
 *   LM Studio accepts a model id, Ollama does not want one, and llama.cpp's
 *   server ignores it, so guessing would be wrong somewhere.
 *
 * Index alignment is the whole contract: line i of `translations` translates
 * line i of `texts`. A length mismatch is an error, not a zip - silently pairing
 * the wrong strings would paint plausible nonsense into speech bubbles, which is
 * worse than failing loudly. It is not the END of the run either: a batch whose
 * answer does not line up is re-asked in halves, because a model that returns 15
 * lines for 17 has merged or dropped something in the middle of a long list and
 * has no trouble at all with nine (see translateTexts).
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
   * The local request currently in flight, if any, so a page that navigates away
   * can stop it. A local model is the one engine here that spends the user's OWN
   * CPU/GPU on every token, and a comic page is read for seconds at a time: when
   * the reader turns the page, a generation that is still running is worthless the
   * moment it lands - it belongs to a document that no longer exists.
   *
   * There is no cancel route in the OpenAI-compatible API - LM Studio, Ollama,
   * llama.cpp's server and vLLM all answer a chat request with one ordinary
   * response - so the ONE mechanism all of them honour is closing the request.
   * Every one of those servers stops generating when the socket drops, which is
   * exactly what AbortController.abort() does. That is the difference between
   * "stops now" and "keeps burning the GPU for another 1,500 tokens" on a
   * reasoning model, which is what made this worth building.
   *
   * A single slot is enough: background.js funnels every translation through one
   * promise chain, so at most one request exists at a time and a cancel can never
   * hit the wrong page's work.
   */
  let activeRequest = null;

  /**
   * Stop the in-flight local request, if there is one. Returns whether anything
   * was actually cancelled - false means there was nothing to stop, which is the
   * normal answer when another engine is selected, because only this engine ever
   * registers a request here.
   */
  function cancelActive() {
    if (!activeRequest) return false;
    activeRequest.cancelled = true;
    try { activeRequest.ctrl.abort(); } catch (e) { /* already settled */ }
    return true;
  }

  /**
   * The error a cancelled job fails with. Distinguished by its `cancelled` flag,
   * never by its message: background.js swallows these quietly, and the content
   * script must not mark the image as seen - a reader who goes BACK to a page
   * still wants it translated.
   */
  function cancelledError() {
    const stopped = new Error('Cancelled: the page changed.');
    stopped.cancelled = true;
    return stopped;
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
   * The prompt is always built by buildInstruction - instruction first, outside
   * any JSON - and is then wrapped for the detected endpoint family. `texts`,
   * `source` and `target` are still sent for chat endpoints because a chat
   * server that is actually a dedicated translator can read them; a general LLM
   * ignores them and obeys the prompt. temperature 0: a comic page should get
   * the same translation on a re-read, and a reasoning model's "creative" pass
   * is exactly the wrong behaviour for fixed dialogue.
   *
   * A completion endpoint gets the prompt as the raw body (text/plain), not as
   * JSON: the body IS the prompt there, and a JSON envelope would arrive as a JSON
   * object printed into the model's context, pushing the instruction out of the
   * first thing it reads. A chat endpoint has no text route at all - it needs the
   * messages envelope - so the path decides, never a setting.
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
      ' translated strings, in the same order, no explanations, no code fences.' +
      // The anti-thinking clause is a mitigation, not a guarantee: a reasoning
      // model obeys its own template first, and LM Studio can still route the
      // whole reply into reasoning_content (bug #1602, handled by parseBody).
      // What it does do is cut the reasoning short on models that read the
      // instruction - which is the difference between a fast translation and
      // 1,500 tokens of analysis for a page of dialogue.
      ' Do not analyse the text and do not think step by step: output the array' +
      ' itself as your very first characters, then stop.';
    return instruction + '\n' + JSON.stringify(texts);
  }

  /**
   * Brace-balance scan for a [...] window that JSON.parses. A regex cannot do
   * this: quoted strings are skipped (brackets inside text must not throw the
   * depth count) and escapes inside strings are honoured. Of several parsing
   * windows, the longest wins - a correct array beats a quoted fragment.
   *
   * `expected`, when given, is the entry count the caller needs, and it makes the
   * scan far more decisive than length ever could: an array with EXACTLY that many
   * strings is the answer, and the LAST one is taken, because a reasoning model
   * repeats its draft and then restates the final version. That is what makes it
   * safe to look inside a `<think>` block or a separated reasoning_content field,
   * where the same array appears several times and an earlier draft is not the
   * reply. Without a count the old rule still applies, and the caller's length
   * check rejects a wrong guess - loudly, never by mis-pairing.
   */
  function extractJsonArray(raw, expected) {
    let best = null;      // longest parseable window, whatever its length
    let exact = null;     // the LAST window with exactly `expected` entries
    const counted = typeof expected === 'number' && expected >= 0;
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
              if (counted && Array.isArray(parsed) && parsed.length === expected) {
                exact = { candidate: candidate, parsed: parsed };
              } else if (!best || candidate.length > best.candidate.length) {
                best = { candidate: candidate, parsed: parsed };
              }
            } catch (e) { /* this window is prose, keep scanning */ }
            break;
          }
        }
      }
    }
    return exact || best;
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
   *
   * A null return therefore means two different things - "not an envelope" and
   * "an envelope whose answer half is EMPTY" - and the two are told apart by
   * reasoningText(), which parseBody calls on the second. See its comment: an
   * empty answer is not the same as no answer.
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
   * The model's SCRATCH text, when the server split it out of the answer, or null.
   *
   * This exists because of a live failure, not a theory. A captured LM Studio reply
   * (google/gemma-4-12b, LM Studio 0.4.6) came back as HTTP 200 with
   * finish_reason "stop", an EMPTY message.content, and 1,526 reasoning tokens -
   * every translated line sitting in reasoning_content. `enable_thinking: false`
   * and a /no_think instruction do NOT prevent it; LM Studio's own bug tracker
   * tracks it as "reasoning_content populated but content empty - server reports
   * success on empty response" (#1602) and explains the cause: when the whole
   * response falls inside the thinking half with nothing after it, the split
   * leaves the answer field empty and calls it a success.
   *
   * The model did the work in that case, so throwing it away is the wrong answer -
   * but it is only safe to accept because the caller knows how many entries it
   * asked for and extractJsonArray can demand exactly that count. Reading this
   * field WITHOUT a count would be the disaster the answer-only rule prevents:
   * the reasoning quotes the source back, so an arbitrarily-chosen array from it
   * could paint Japanese over every bubble and call it a translation.
   *
   * Covers every spelling of the field seen in the wild plus LM Studio's native
   * { output: [ {type:"reasoning", content:...} ] } shape.
   */
  function reasoningText(data) {
    if (!data || typeof data !== 'object') return null;

    const boxes = [];
    if (Array.isArray(data.choices) && data.choices.length) {
      boxes.push(data.choices[0] && data.choices[0].message);
    }
    boxes.push(data.message, data);
    for (const box of boxes) {
      if (!box || typeof box !== 'object') continue;
      for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
        if (typeof box[key] === 'string' && box[key].trim()) return box[key];
      }
    }

    if (Array.isArray(data.output)) {
      const parts = data.output
        .filter((o) => o && o.type === 'reasoning')
        .map((o) => String(o.content === undefined ? '' : o.content));
      if (parts.length && parts.join('').trim()) return parts.join('\n');
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
        // that string. `expected` is passed so a reply that also quotes the
        // source back (inside a <think> block, say, which LM Studio keeps in
        // content when its reasoning splitter is off) resolves to the array with
        // the right number of entries instead of the longest one.
        try {
          data = JSON.parse(answer);
        } catch (e2) {
          const found = extractJsonArray(answer, expected);
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
        // An envelope whose ANSWER is empty: a reasoning model that put the whole
        // reply in its thinking half (LM Studio bug #1602). Recovering it needs
        // the exact entry count, so a reply that produced no array of exactly
        // `expected` strings is reported as the server misconfiguration it is,
        // rather than as a parsing failure on our side. Testing reasoning here
        // and not scanning the body blindly is what keeps the source text out.
        const think = reasoningText(parsedBody);
        if (think !== null) {
          const found = typeof expected === 'number'
            ? extractJsonArray(think, expected) : null;
          if (found && Array.isArray(found.parsed) &&
              found.parsed.length === expected) {
            return normalizeTranslations(found.parsed, expected);
          }
          throw new Error(
            'The local model spent its whole reply thinking (' + think.length +
            ' characters) and left the answer empty - nothing was translated. ' +
            'LM Studio does this while "Separate reasoning_content and content in ' +
            'API responses" is on; switch that off in Developer Settings, or pick ' +
            'a model that does not reason.');
        }
        data = parsedBody;
      }
    } else {
      // Not JSON at all: a raw completion that wrapped the array in prose or a
      // code fence.
      const found = extractJsonArray(text, expected);
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
   * How deep a batch may be divided when the model's answer does not line up.
   * 2^5 = 32 pieces, so even a 40-line webtoon page reaches single-line batches.
   * The cap is what keeps a model that fails at EVERY size from turning one page
   * into an unbounded number of requests.
   */
  const MAX_SPLIT_DEPTH = 5;

  /**
   * Consecutive unparseable replies tolerated before the run stops asking.
   *
   * A local model spends the user's own CPU/GPU on every token, and a server or
   * model that cannot answer a 3-line request is not going to answer the other 40
   * either - walking the whole tree would multiply the wait by the length of the
   * page. Any success resets the count, so an awkward page still finishes: only
   * three failures WITH NOTHING IN BETWEEN give up. The lines given up on are left
   * untranslated and reported, never guessed at.
   */
  const MAX_FAILED_STREAK = 3;

  /**
   * Send one request and return the reply body as TEXT, whatever the status.
   *
   * Read as text and parsed by hand rather than with res.json(), because a general
   * LLM's answer is not reliably JSON and because an error status from a local
   * server carries the real reason in its body too - and res.json() consumes the
   * response stream even when its parse then throws.
   *
   * Every failure that is NOT about the reply's shape is marked `serverSide`, and
   * that mark is what stops the batch splitter: re-asking a question that a dead
   * or unreachable server could not answer would queue up more of the same wait,
   * which on a local model is minutes per request.
   */
  async function postPrompt(job, endpoint, request) {
    let res;
    const timer = setTimeout(() => {
      job.timedOut = true;
      job.ctrl.abort();
    }, 120000);
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: job.ctrl.signal
      });
    } catch (e) {
      // A page change is not a failure, so it must not be reported as one: the
      // reader moved on and the content script that asked for this reply is gone.
      if (job.cancelled) throw cancelledError();
      const err = new Error('Cannot reach the local server at ' + endpoint +
        ' (' + (e && e.name === 'AbortError' && job.timedOut ? 'timed out after 120s'
          : 'is it running?') + ').');
      err.serverSide = true;
      throw err;
    } finally {
      clearTimeout(timer);
    }

    // The body can still be streaming when the reader leaves, and an abort that
    // lands between the fetch resolving and the parse would otherwise be handed
    // back as a finished translation for a page nobody is looking at.
    if (job.cancelled) throw cancelledError();

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
      // A 404 from an unknown route, a 400 naming a model the server does not
      // have, a 500 from an overloaded box: all "ask a different question", not
      // "ask it in smaller pieces".
      const err = new Error('Local server error (' + detail + ').');
      err.serverSide = true;
      throw err;
    }
    return bodyText;
  }

  /**
   * Translate one batch of strings, dividing it when the model's answer does not
   * line up.
   *
   * A 17-line page is the failure this exists for. A general LLM asked for 17
   * translated strings sometimes returns 15: it merges a whispered aside into the
   * line above it, or drops the narration box it decided was not dialogue. Both
   * obvious responses to that are wrong. Pairing 15 with the first 15 source lines
   * shifts every bubble after the merge and paints the wrong dialogue into it -
   * and failing the whole page throws away 15 perfectly good translations over one
   * formatting slip, which is what the reader experiences as "the extension is
   * broken".
   *
   * So the batch is divided and each half asked for on its own: 17 lines become
   * 9 + 8, and a model that drops a line out of 17 usually has no trouble with
   * nine. Every request is still checked against its OWN exact count, so this
   * cannot mis-pair anything - the guarantee is unchanged, it is just applied per
   * batch - and the pieces are concatenated in order, which is what keeps line i
   * translating region i.
   *
   * A line that will not pair even on its own is left UNTRANSLATED rather than
   * guessed at: the painter falls back to the region's original text, so that
   * bubble keeps the source the reader can already read, and a wrong dialogue or a
   * blank bubble are both worse. imageToRegions reports the lines that were given
   * up on, and still throws when NOTHING could be paired, so a broken setup cannot
   * pass for a working one.
   */
  async function translateTexts(job, endpoint, texts, target, source, settings, tally, depth) {
    // Checked before the request, not only after it: a cancel that lands between
    // two requests of a split batch must stop the next one from being sent at all.
    if (job.cancelled) throw cancelledError();

    const request = buildRequest(endpoint, buildInstruction(texts, target, source),
      texts, target, source, settings);

    try {
      tally.requests++;
      const bodyText = await postPrompt(job, endpoint, request);
      const translations = parseBody(bodyText, texts.length);
      tally.failedStreak = 0;
      return translations;
    } catch (err) {
      // Not the reply's shape: the page changed, or the server itself failed.
      if (err && (err.cancelled || err.serverSide)) throw err;

      tally.failedStreak++;
      if (!tally.firstError) tally.firstError = err;

      // Nothing smaller to ask for (a single line), the depth cap is reached, or
      // the model has failed everything in a row: give up on this batch. Its
      // lines stay untranslated rather than paired with a guess - and when that
      // turns out to be the whole page, imageToRegions throws the first error, so
      // the failure is as loud as it was before, just later.
      if (texts.length <= 1 || depth >= MAX_SPLIT_DEPTH ||
          tally.failedStreak >= MAX_FAILED_STREAK) {
        tally.dropped += texts.length;
        return texts.map(() => '');
      }

      const mid = Math.ceil(texts.length / 2);
      tally.splits++;
      const head = await translateTexts(job, endpoint, texts.slice(0, mid),
        target, source, settings, tally, depth + 1);
      const tail = await translateTexts(job, endpoint, texts.slice(mid),
        target, source, settings, tally, depth + 1);
      return head.concat(tail);
    }
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

    // One request per batch, and each batch's answer is checked against its own
    // count, so a model that returns 15 lines for 17 is re-asked in smaller pieces
    // rather than either failing the page or being quietly mis-paired (see
    // translateTexts).
    log(settings, 'POSTing', texts.length, 'strings to', endpoint);
    // Registered for the WHOLE sequence rather than for one fetch: a divided batch
    // makes several requests, and a cancel landing in the gap between two of them
    // must still stop the next one. Cleared the moment the last one is done, so the
    // window a page change can cancel in is exactly the window work is happening.
    const job = { ctrl: new AbortController(), cancelled: false, timedOut: false };
    activeRequest = job;
    const tally = { requests: 0, splits: 0, dropped: 0, failedStreak: 0, firstError: null };
    let translations;
    try {
      translations = await translateTexts(job, endpoint, texts, target, sourceLang,
        settings, tally, 0);
    } finally {
      if (activeRequest === job) activeRequest = null;
    }

    // A line we could not pair is left untranslated on purpose - the painter then
    // falls back to the region's original text, which is the honest outcome - but
    // the page it leaves behind must not look like a clean success, so it gets one
    // visible line. Not debug-gated: "why is this bubble still in Japanese?" should
    // not require turning on debug logging to answer. A TOTAL failure needs no
    // warning here: the throw below reports it in full.
    if (tally.dropped && tally.dropped < texts.length) {
      const warnMsg = '[CT/lens-local] ' + tally.dropped + ' of ' + texts.length +
        ' line(s) came back unpaired and were left untranslated (' + tally.requests +
        ' request(s), ' + tally.splits + ' re-asked in smaller batches). First ' +
        'problem: ' + (tally.firstError ? tally.firstError.message : 'unknown');
      if (typeof console !== 'undefined' && console.warn) console.warn(warnMsg);
    }

    // Every line failed: that is the whole page, so report the first real problem
    // instead of handing back a page of untranslated bubbles, which looks exactly
    // like a working engine that found nothing to translate.
    if (tally.dropped >= texts.length && tally.firstError) throw tally.firstError;

    const finalRegions = regions.map((r, i) =>
      Object.assign({}, r, { translated: translations[i] || '' })
    );

    log(settings, 'engine done', {
      language: sourceLang,
      regions: finalRegions.length,
      translated: finalRegions.filter((r) => r.translated).length,
      batches: tally.requests,
      untranslated: tally.dropped,
      endpoint: endpoint
    });

    // How many requests the page actually cost (a clean page is one, a page whose
    // model dropped a line is two or three) and how many lines were given up on -
    // both visible in the popup's diagnostics, because "the model needs two tries
    // on a long page" is worth knowing without reading the console.
    diagnostics.batches = tally.requests;
    diagnostics.untranslated = tally.dropped;

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
    reasoningText,
    extractJsonArray,
    normalizeTranslations,
    log,
    cancelActive,
    translateTexts,
    imageToRegions
  };
}
