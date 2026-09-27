/**
 * lensAzureEngine.js - the 'lens-azure' engine: Google Lens OCR + Microsoft
 * Translator (Azure AI Translator).
 *
 * WHY THIS ENGINE EXISTS
 * ----------------------
 * The free 'lens' engine translates through an undocumented Google endpoint
 * that can change or start blocking without notice, and the Lara engines bill
 * the user's own characters. Microsoft Translator has the most generous
 * standing free allowance of the three big clouds and is a DOCUMENTED,
 * versioned API, so it is the one engine that is both free at comic volumes
 * and contractually stable:
 *
 *   Free (F0) tier: 2,000,000 characters per month, renewing every month.
 *   A manga page of speech bubbles is ~1,500 characters, so that is roughly
 *   1,300 pages a month - and Google Lens still does the OCR for free, so only
 *   the detected strings travel to Microsoft.
 *
 * When the allowance is spent the service stops until the next subscription
 * month (Microsoft's own wording), which is why exhaustion is treated as
 * TERMINAL for a whole run rather than as a transient failure: a 40-image queue
 * would otherwise make 40 doomed requests.
 *
 * REQUEST SHAPE (verified against the v3.0 reference)
 * ---------------------------------------------------
 *   POST https://api.cognitive.microsofttranslator.com/translate?api-version=3.0
 *        &to=<target>[&from=<source>]
 *     Ocp-Apim-Subscription-Key:    <key 1 or key 2>
 *     Ocp-Apim-Subscription-Region: <resource region, or 'global'>
 *     Content-Type: application/json; charset=UTF-8
 *     body: [{"Text":"..."}, ...]         <= 1,000 items, <= 50,000 chars
 *     ->   [{"translations":[{"text":"...","to":"..."}],
 *            "detectedLanguage":{"language":"ja","score":1.0}}]
 *
 * One request carries a whole page. `from` is omitted when the source is
 * 'auto' so the service detects it - though in practice the source comes from
 * Lens, which is a better detector for lettering than plain text would be.
 *
 * Like 'lens-lara', this is an OCR + text-translation engine: the boxes come
 * from the shared Lens protobuf scan (reused, not copied, so the engines
 * cannot drift apart) and the painter redraws locally.
 */
'use strict';

if (typeof globalThis.CTLensAzureEngine === 'undefined') {
  const ENDPOINT = 'https://api.cognitive.microsofttranslator.com/translate';
  const API_VERSION = '3.0';

  /**
   * Azure's documented per-request ceilings. A page is ~1,500 characters, so
   * both sit far above what a comic needs - they bound a pathological page (a
   * text-heavy webtoon strip) rather than shape normal traffic.
   */
  const MAX_ITEMS = 1000;
  const MAX_CHARS = 50000;

  /**
   * Thousands separators, deterministically. toLocaleString() would vary with
   * the browser's locale while the tests pin this exact text, and the message is
   * user-facing ("over the 50,000-character ceiling").
   */
  function fmtCount(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /**
   * Quota exhaustion is TERMINAL, not transient: every later request would be
   * refused too, so the caller has to be able to stop the whole run rather than
   * fail one image and retry the next 39. The text names the allowance, the
   * consequence and the exit route, because the F0 tier stops silently.
   */
  const QUOTA_HINT = ' Your Microsoft Translator allowance is spent: the free'
    + ' (F0) tier is 2,000,000 characters per month, and the service stops'
    + ' until the next subscription month once it is used up. Switch to the'
    + ' Google Lens engine in Settings, or raise the tier of the Translator'
    + ' resource in the Azure portal.';

  function log(settings, ...args) {
    if (settings && settings.debug) console.log('[CT/lens-azure]', ...args);
  }

  /**
   * The UI (and Lens) use Google's codes; Azure names the two Chinese scripts
   * instead: zh-Hans and zh-Hant. Everything else in languages.js is already a
   * code Azure accepts (lowercase ISO 639-1), so it passes through unchanged -
   * the map only has to cover the pair that genuinely differs.
   */
  const TO_AZURE = { 'zh-cn': 'zh-Hans', 'zh-tw': 'zh-Hant' };
  const FROM_AZURE = { 'zh-hans': 'zh-CN', 'zh-hant': 'zh-TW' };

  function toAzureCode(code) {
    const value = String(code == null ? '' : code).trim();
    if (!value) return '';
    return TO_AZURE[value.toLowerCase()] || value;
  }

  /** Azure's detected language back into the UI's table, or null. */
  function fromAzureCode(code) {
    const value = String(code == null ? '' : code).trim();
    if (!value) return null;
    return FROM_AZURE[value.toLowerCase()] || value;
  }

  /**
   * Both halves of the credential, with an error that says where to put them.
   * Exported because a missing region is the single most common setup mistake
   * (the key alone is not enough), and the probe reports it verbatim.
   */
  function requireCredentials(settings) {
    const s = settings || {};
    const key = String(s.azureKey || '').trim();
    const region = String(s.azureRegion || '').trim();
    if (!key || !region) {
      throw new Error('Microsoft Translator needs both a key and the resource'
        + ' region (' + (key ? 'region is missing' : 'key is missing') + ').'
        + ' Open Settings \u2192 Engine \u2192 Microsoft Translator and fill both'
        + ' in from the resource\u2019s Keys and Endpoint page.');
    }
    return { key: key, region: region };
  }

  /**
   * 403 is what the service answers once a subscription's characters are gone;
   * a body that names the quota confirms it and is honoured whatever the status
   * (Azure has used more than one code for this over the years). 429 is a RATE
   * limit - transient by definition - so it must NOT stop the run.
   */
  function isQuotaError(status, detail) {
    if (/quota/i.test(String(detail || ''))) return true;
    return status === 403;
  }

  /**
   * Group pending indices into requests that respect both ceilings. Pure, so
   * the boundaries can be tested without touching the network.
   *
   * A single string longer than the per-request ceiling cannot be sent at all -
   * that is a real failure rather than something to batch around, and splitting
   * a speech bubble would put the translation in the wrong place, so it throws.
   *
   * @param {string[]} strings
   * @param {number[]} pending indices worth translating
   * @returns {number[][]} batches of indices
   */
  function planBatches(strings, pending) {
    const batches = [];
    let cur = [];
    let chars = 0;
    for (const idx of pending) {
      const text = String(strings[idx] == null ? '' : strings[idx]);
      if (text.length > MAX_CHARS) {
        throw new Error('lens-azure: one line is ' + fmtCount(text.length) + ' characters,'
          + ' over the ' + fmtCount(MAX_CHARS) + '-character ceiling for a single request');
      }
      if (cur.length && (cur.length >= MAX_ITEMS || chars + text.length > MAX_CHARS)) {
        batches.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(idx);
      chars += text.length;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  /**
   * Parse a reply into index-aligned strings plus the detected source.
   *
   * The reply is an array in request order - one entry per submitted Text -
   * each carrying translations[0].text. An entry that is missing or empty
   * yields '' rather than throwing: a page with one untranslatable line should
   * still paint the other nineteen. Exported for tests, because a reply-shape
   * change is otherwise only visible as blank bubbles on a live page.
   *
   * @returns {{texts: string[], detectedLang: string|null}}
   */
  function parseReply(body) {
    let data;
    try {
      data = typeof body === 'string' ? JSON.parse(body) : body;
    } catch (e) {
      throw new Error('lens-azure: unparseable response (blocked or throttled?)');
    }
    if (!Array.isArray(data)) {
      throw new Error('lens-azure: unexpected response shape (expected an array)');
    }
    let detected = null;
    const texts = data.map((item) => {
      if (!item || typeof item !== 'object') return '';
      if (!detected) {
        const d = item.detectedLanguage;
        if (d && d.language) detected = fromAzureCode(d.language);
      }
      const list = item.translations;
      if (!Array.isArray(list) || !list.length) return '';
      const first = list[0];
      if (!first || typeof first.text !== 'string') return '';
      return first.text;
    });
    return { texts: texts, detectedLang: detected };
  }

  /**
   * Translate strings, returning translations aligned by index ('' where the
   * input was empty or the reply was missing an entry). Empty inputs never hit
   * the network, so an empty page never costs a request.
   *
   * @param {string[]} strings
   * @param {string} sourceLang 'auto' omits `from`
   * @param {string} targetLang
   * @param {Object} settings
   * @returns {Promise<string[]>}
   */
  async function translateTexts(strings, sourceLang, targetLang, settings) {
    if (!targetLang) throw new Error('lens-azure: no target language');
    const creds = requireCredentials(settings);
    const out = new Array(strings.length).fill('');

    const pending = [];
    for (let i = 0; i < strings.length; i++) {
      if (strings[i] && String(strings[i]).trim()) pending.push(i);
    }
    if (!pending.length) return out;

    const source = String(sourceLang || 'auto').trim();
    const batches = planBatches(strings, pending);
    for (let b = 0; b < batches.length; b++) {
      const idxs = batches[b];
      let url = ENDPOINT + '?api-version=' + API_VERSION
        + '&to=' + encodeURIComponent(toAzureCode(targetLang));
      if (source && source !== 'auto') {
        url += '&from=' + encodeURIComponent(toAzureCode(source));
      }

      const res = await fetch(url, {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'Ocp-Apim-Subscription-Key': creds.key,
          'Ocp-Apim-Subscription-Region': creds.region
        },
        body: JSON.stringify(idxs.map((i) => ({ Text: String(strings[i]) })))
      });

      if (!res.ok) {
        let detail = '';
        try { detail = await res.text(); } catch (e) { /* body is optional */ }
        if (isQuotaError(res.status, detail)) {
          throw new Error('lens-azure: HTTP ' + res.status + ' - '
            + (detail || 'quota rejected') + QUOTA_HINT);
        }
        if (res.status === 401) {
          throw new Error('lens-azure: HTTP 401 - the key or the region was'
            + ' rejected. Both must come from the same Translator resource;'
            + ' check them in Settings \u2192 Engine.');
        }
        throw new Error('lens-azure: HTTP ' + res.status
          + (detail ? ' - ' + detail : ''));
      }

      const parsed = parseReply(await res.text());
      log(settings, 'batch', b + 1, '/', batches.length, '-', idxs.length,
          'strings', parsed.detectedLang ? '(detected ' + parsed.detectedLang + ')' : '');
      // Index alignment is the contract: reply entry k belongs to request k.
      idxs.forEach((idx, k) => {
        if (k < parsed.texts.length) out[idx] = parsed.texts[k] || '';
      });
    }
    return out;
  }

  /**
   * Engine entry point (engines.js contract). Regions are OCR'd and translated;
   * the caller paints locally, exactly like the 'lens' and 'lens-lara' engines.
   */
  async function imageToRegions(req) {
    const settings = req.settings || {};

    // 1-2. OCR: identical halves to the free engine (downscale, then crupload),
    // reused rather than copied so the engines cannot drift apart.
    const up = await CTLensEngine.toUploadable(req.bytes, req.mime, req.width, req.height);
    const scanned = await CTLensProto.scan(up.bytes, up.width, up.height, settings, {
      targetLang: req.targetLang
    });
    const regions = CTLensProto.rescaleRegions(
      scanned.regions, up.width, up.height, req.width, req.height
    );

    // 3. Translate with Microsoft Translator instead of the anonymous endpoint.
    const texts = await translateTexts(
      regions.map((r) => r.text),
      scanned.sourceLang || req.sourceLang,
      req.targetLang,
      settings
    );
    const finalRegions = regions.map((r, i) =>
      Object.assign({}, r, { translated: texts[i] || '' })
    );

    log(settings, 'engine done', {
      language: scanned.sourceLang,
      regions: finalRegions.length,
      translated: finalRegions.filter((r) => r.translated).length
    });

    return {
      regions: finalRegions,
      sourceLang: scanned.sourceLang || req.sourceLang || 'auto',
      targetLang: req.targetLang,
      diagnostics: Object.assign(
        {
          sentSize: up.width + 'x' + up.height,
          originalSize: req.width + 'x' + req.height,
          backend: 'azure-translator'
        },
        scanned.diagnostics
      )
    };
  }

  /**
   * Cache dimension: results belong to the resource they came from, so moving
   * to another region (a different account, a different model set) must not
   * serve entries produced by the previous one.
   */
  function variantKey(settings) {
    return String((settings && settings.azureRegion) || '').trim();
  }

  globalThis.CTLensAzureEngine = {
    id: 'lens-azure',
    label: 'Google Lens OCR (free) + Microsoft Translator',
    needsKey: true,
    doesTranslation: true,
    ENDPOINT,
    API_VERSION,
    MAX_ITEMS,
    MAX_CHARS,
    QUOTA_HINT,
    toAzureCode,
    fromAzureCode,
    requireCredentials,
    isQuotaError,
    planBatches,
    parseReply,
    translateTexts,
    variantKey,
    imageToRegions,
    log
  };
}
