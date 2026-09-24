/**
 * engines.js - OCR + translation engine registry.
 *
 * THE CONTRACT
 * ------------
 * Every engine is an object with exactly this shape:
 *
 *   {
 *     id:               string,   // stable id stored in settings
 *     label:            string,   // shown in the options UI
 *     needsKey:         boolean,  // options UI shows an API-key field
 *     doesTranslation:  boolean,  // true  -> regions come back already translated
 *                                 // false -> regions are OCR only and the shared
 *                                 //          CTTranslator must be called after
 *     async imageToRegions({ bytes, mime, width, height, sourceLang, targetLang,
 *                            settings, tabId, frameId })
 *        -> { regions: [{ text, translated, bbox:{x,y,w,h}, confidence }],
 *             sourceLang, targetLang, diagnostics }
 *   }
 *
 * Full-image engines (Lara) return an extra `image: {bytes, mime}` with no
 * useful regions: a server-rendered translation. translateImage() routes that
 * to CTReplace.applyImageBytes instead of the painter and caches it keyed on
 * the engine's variantKey() (for Lara: the text-removal model).
 *
 * Swapping engines therefore touches this file plus one new provider file.
 * No other module imports a provider directly.
 */
'use strict';

if (typeof globalThis.CTEngines === 'undefined') {
  const registry = new Map();

  function register(engine) {
    if (!engine || !engine.id || typeof engine.imageToRegions !== 'function') {
      throw new Error('invalid engine registration');
    }
    registry.set(engine.id, engine);
  }

  function get(id) {
    const engine = registry.get(id);
    if (!engine) throw new Error('unknown engine: ' + id);
    return engine;
  }

  function list() {
    return Array.from(registry.values()).map((e) => ({
      id: e.id,
      label: e.label,
      needsKey: !!e.needsKey,
      doesTranslation: e.doesTranslation !== false
    }));
  }

  /**
   * Normalise a bbox into integer pixel coordinates inside the ORIGINAL image.
   * Engines hand back whatever they have (Lens gives CSS pixels relative to a
   * scaled preview, Cloud Vision gives polygon vertices), so we clamp and round
   * here, in one place, instead of in every painter call site.
   */
  function normaliseRegion(region, width, height) {
    const b = region.bbox || {};
    let x = Math.round(Number(b.x) || 0);
    let y = Math.round(Number(b.y) || 0);
    let w = Math.round(Number(b.w) || 0);
    let h = Math.round(Number(b.h) || 0);

    x = Math.max(0, Math.min(x, width - 1));
    y = Math.max(0, Math.min(y, height - 1));
    w = Math.max(1, Math.min(w, width - x));
    h = Math.max(1, Math.min(h, height - y));

    return {
      text: String(region.text || ''),
      translated: String(region.translated || ''),
      bbox: { x, y, w, h },
      confidence: typeof region.confidence === 'number' ? region.confidence : null,
      direction: region.direction || 'auto'
    };
  }

  /**
   * Run the pipeline for one image: fetch bytes, consult the cache, call the
   * engine, normalise, cache. Kept here rather than in background.js so that the
   * message layer stays a thin transport.
   */
  async function translateImage(req) {
    const settings = req.settings;
    const engine = get(settings.engineId);

    const fetched = await CTImageFetch.fetchImageBytes(req.url, {
      tabId: req.tabId,
      frameId: req.frameId
    });

    const cacheKey = await CTCache.makeKey({
      bytes: fetched.bytes,
      engineId: engine.id,
      // Engine-specific dimension of the request (Lara's text-removal model):
      // switching it must not serve entries produced with another one.
      variant: engine.variantKey ? engine.variantKey(settings) : '',
      sourceLang: req.sourceLang,
      targetLang: req.targetLang
    });

    const cached = settings.cacheTtlDays > 0 && !req.noCache
      ? await CTCache.get(cacheKey, settings.cacheTtlDays)
      : null;
    if (cached) {
      const hit = Object.assign({}, cached, { cached: true, via: fetched.via });
      if (req.needBytes && !hit.image) {
        hit.bytes = fetched.bytes;
        hit.mime = fetched.mime;
      }
      // Cache hits are free, so the meter the UI shows stays as-is.
      if (globalThis.CTUsage) hit.usage = await CTUsage.snapshot();
      return hit;
    }

    const result = await engine.imageToRegions({
      bytes: fetched.bytes,
      mime: fetched.mime,
      width: req.width,
      height: req.height,
      sourceLang: req.sourceLang,
      targetLang: req.targetLang,
      settings,
      tabId: req.tabId,
      frameId: req.frameId
    });

    const payload = {
      regions: (result.regions || []).map((r) => normaliseRegion(r, req.width, req.height)),
      sourceLang: result.sourceLang || req.sourceLang,
      targetLang: result.targetLang || req.targetLang,
      engineId: engine.id
    };

    // Full-image engines (Lara) return a server-rendered bitmap instead of
    // regions; it is cached like any other result, so repeat views stay free.
    if (result.image && result.image.bytes) {
      payload.image = { bytes: result.image.bytes, mime: result.image.mime || 'image/png' };
      // The Lara image engine bills a flat 10,000 characters per successful
      // call. Local/self-hosted engines bill nothing, so engines opt out
      // with `free: true`.
      if (globalThis.CTUsage && !engine.free) await CTUsage.addImage();
    }

    if ((payload.image || payload.regions.length) && settings.cacheTtlDays > 0) {
      await CTCache.put(cacheKey, payload);
    }

    const response = Object.assign({}, payload, {
      cached: false,
      via: fetched.via,
      mime: fetched.mime,
      diagnostics: result.diagnostics || null
    });
    // Only shipped when the page's canvas would be tainted and the content
    // script therefore cannot read pixels from its own <img> element. A
    // full-image result already carries everything the page needs, so the
    // original bytes would just double the message size.
    if (!payload.image && req.needBytes) response.bytes = fetched.bytes;
    if (globalThis.CTUsage) response.usage = await CTUsage.snapshot();
    return response;
  }

  register(CTLensEngine);
  register(CTLaraEngine);
  register(CTLensLaraEngine);
  register(CTLensLocalEngine);

  globalThis.CTEngines = { register, get, list, translateImage, normaliseRegion };
}
