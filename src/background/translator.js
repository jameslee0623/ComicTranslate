/**
 * translator.js - text translation via Google's public word-translation API.
 *
 * WHY THIS ENDPOINT
 * -----------------
 * Live probes from this machine (2026-09):
 *
 *   translate.googleapis.com/translate_a/single?client=gtx   -> IP-blocked
 *   translate.googleapis.com/translate_a/t?client=gtx        -> IP-blocked
 *   clients5.google.com/translate_a/t?client=dict-chrome-ex  -> WORKS, batches
 *
 * The last one is what Chrome's built-in page translation uses. It accepts
 * repeated `q` parameters and answers with one entry per `q`, in order:
 *
 *   GET .../translate_a/t?client=dict-chrome-ex&sl=auto&tl=zh-TW&q=A&q=B
 *   -> [["你好","ja"],["世界","zh-CN"]]
 *
 * The Lens protobuf API (lensProto.js) detects and positions text but does NOT
 * translate, so this module is the second half of the 'lens' engine. It is also
 * the shared translator for any future engine that declares
 * `doesTranslation: false` in its registration (see engines.js).
 */
'use strict';

if (typeof globalThis.CTTranslator === 'undefined') {
  const ENDPOINT = 'https://clients5.google.com/translate_a/t';
  /** One request carries at most this many `q` parameters. */
  const MAX_BATCH = 32;
  /** Hard URL-length budget per request, keeping us clear of 4xx refusals. */
  const MAX_URL_CHARS = 1800;
  /** Polite gap between consecutive batch requests. */
  const BATCH_PAUSE_MS = 300;

  function log(settings, ...args) {
    if (settings && settings.debug) console.log('[CT/translator]', ...args);
  }

  /**
   * Parse a reply into one string per request, tolerating both observed item
   * shapes: ["text"] and ["text", "sourceLang"].
   */
  function parseReply(json) {
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      throw new Error('translator: unparseable response (blocked or rate-limited?)');
    }
    if (!Array.isArray(data)) {
      throw new Error('translator: unexpected response shape');
    }
    return data.map((item) => {
      if (typeof item === 'string') return item;
      if (Array.isArray(item) && item.length) return String(item[0] == null ? '' : item[0]);
      return '';
    });
  }

  /**
   * Group pending indices into batches that respect the per-request count cap
   * and a URL-length budget. Pure so it can be tested without the network.
   *
   * @param {string[]} strings
   * @param {number[]} pending indices worth translating
   * @param {number} baseChars fixed per-request URL overhead
   * @returns {number[][]} batches of indices
   */
  function planBatches(strings, pending, baseChars) {
    const batches = [];
    let cur = [];
    let size = 0;
    for (const idx of pending) {
      const cost = encodeURIComponent(strings[idx]).length + 3;
      if (cur.length && (cur.length >= MAX_BATCH || baseChars + size + cost > MAX_URL_CHARS)) {
        batches.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(idx);
      size += cost;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  /**
   * Translate strings, returning translations aligned by index ('' where the
   * input was empty or the reply was missing an entry). Empty inputs never hit
   * the network.
   *
   * @param {string[]} strings
   * @param {{sourceLang?: string, targetLang: string, settings?: Object}} opts
   * @returns {Promise<string[]>}
   */
  async function translateStrings(strings, opts) {
    if (!opts || !opts.targetLang) throw new Error('translator: no target language');
    const settings = opts.settings || {};
    const out = new Array(strings.length).fill('');

    const pending = [];
    for (let i = 0; i < strings.length; i++) {
      if (strings[i] && strings[i].trim()) pending.push(i);
    }
    if (!pending.length) return out;

    const batches = planBatches(strings, pending, ENDPOINT.length + 60);
    for (let b = 0; b < batches.length; b++) {
      if (b) await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
      const idxs = batches[b];
      const url = new URL(ENDPOINT);
      url.searchParams.set('client', 'dict-chrome-ex');
      url.searchParams.set(
        'sl',
        opts.sourceLang && opts.sourceLang !== 'auto' ? opts.sourceLang : 'auto'
      );
      url.searchParams.set('tl', opts.targetLang);
      for (const idx of idxs) url.searchParams.append('q', strings[idx]);

      const res = await fetch(url.toString(), {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store'
      });
      if (!res.ok) throw new Error('translator: HTTP ' + res.status);
      const parts = parseReply(await res.text());
      log(settings, 'batch', b + 1, '/', batches.length, '-', idxs.length, 'strings');
      // Index alignment is the contract: reply entry k belongs to request q k.
      idxs.forEach((idx, k) => {
        if (k < parts.length) out[idx] = parts[k] || '';
      });
    }
    return out;
  }

  /**
   * Fill `translated` on engine regions in place; convenience wrapper for the
   * flow documented in engines.js (OCR-only engines call this afterwards).
   *
   * @returns {Promise<Array>} the same region objects, mutated
   */
  async function translateRegions(regions, opts) {
    const texts = await translateStrings(regions.map((r) => r.text), opts);
    regions.forEach((r, i) => {
      r.translated = texts[i] || '';
    });
    return regions;
  }

  globalThis.CTTranslator = {
    ENDPOINT,
    MAX_BATCH,
    MAX_URL_CHARS,
    BATCH_PAUSE_MS,
    parseReply,
    planBatches,
    translateStrings,
    translateRegions,
    log
  };
}