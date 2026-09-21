/**
 * lensLaraEngine.js - the 'lens-lara' engine: Google Lens OCR + Lara text API.
 *
 * The cheap route through Lara. The image API bills a flat 10,000 characters
 * per picture (one page a month on the free tier), but TEXT translation is
 * billed by the actual characters sent - a manga page of speech bubbles is
 * usually 500-1,500 characters, so the free tier's 10k/month covers roughly
 * 10-20 pages. So: the same anonymous Lens crupload as the free engine finds
 * the boxes and detects the language, then ONE batched /v2/translate call
 * carries all lines to Lara.
 */
'use strict';

if (typeof globalThis.CTLensLaraEngine === 'undefined') {

  function log(settings, ...args) {
    if (settings && settings.debug) console.log('[CT/lens-lara]', ...args);
  }

  /**
   * Engine entry point (engines.js contract). Regions are OCR'd and translated;
   * the caller paints locally, exactly like the 'lens' engine.
   */
  async function imageToRegions(req) {
    const settings = req.settings || {};

    // 1-2. OCR: identical halves to the free engine (downscale, then crupload),
    // reused rather than copied so the two engines cannot drift apart.
    const up = await CTLensEngine.toUploadable(req.bytes, req.mime, req.width, req.height);
    const scanned = await CTLensProto.scan(up.bytes, up.width, up.height, settings, {
      targetLang: req.targetLang
    });
    const regions = CTLensProto.rescaleRegions(
      scanned.regions, up.width, up.height, req.width, req.height
    );

    // 3. Translate with Lara instead of the anonymous Google endpoint.
    const texts = await CTLaraEngine.translateTexts(
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
          backend: 'lara-text'
        },
        scanned.diagnostics
      )
    };
  }

  globalThis.CTLensLaraEngine = {
    id: 'lens-lara',
    label: 'Google Lens OCR (free) + Lara text API',
    needsKey: true,
    doesTranslation: true,
    log,
    imageToRegions
  };
}