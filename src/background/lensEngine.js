/**
 * lensEngine.js - the 'lens' engine: Chrome Lens OCR + Google text translate.
 *
 * Two anonymous HTTP calls, in this order (see README "Live-probed endpoints"):
 *   1. lensfrontend-pa.googleapis.com/v1/crupload  (lensProto.js)
 *      -> text, per-line normalised boxes, detected source language
 *   2. clients5.google.com/translate_a/t           (translator.js)
 *      -> translation per line
 *
 * An earlier prototype instead drove a hidden Lens tab and scraped the rendered
 * results DOM. Live testing showed that page exposes no per-line geometry, so
 * that path — and the shared worker tab it needed — is gone entirely.
 */
'use strict';

if (typeof globalThis.CTLensEngine === 'undefined') {
  /**
   * Longest edge sent to the API. The protobuf request carries the image bytes
   * inline, so a 1412px manga page would otherwise approach the size limit.
   * Downscaling via canvas keeps typical pages comfortably small while losing
   * little: OCR boxes are normalised, so accuracy depends on legibility more
   * than on resolution.
   */
  const MAX_DIMENSION = 1600;

  function log(settings, ...args) {
    if (settings && settings.debug) console.log('[CT/lens]', ...args);
  }

  /**
   * Downscale large images before upload. Returns the bytes to send together
   * with the dimensions they correspond to, so regions can be mapped back to
   * the original grid with rescaleRegions().
   *
   * When no scaling is needed the input passes through unchanged; when the
   * canvas APIs are unavailable (some background contexts) it also passes
   * through and lensProto.scan() enforces its own size ceiling.
   *
   * @param {ArrayBuffer|Uint8Array} bytes
   * @param {string} mime
   * @param {number} width
   * @param {number} height
   * @returns {Promise<{bytes: Uint8Array, width: number, height: number, mime: string}>}
   */
  async function toUploadable(bytes, mime, width, height) {
    const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
    if (scale >= 1) return { bytes: bytes, width: width, height: height, mime: mime };
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
      return { bytes: bytes, width: width, height: height, mime: mime };
    }
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    // JPEG keeps request size predictable; the painter redraws from the
    // original fetch, so upload-side artefacts never reach the page.
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    const out = new Uint8Array(await blob.arrayBuffer());
    log(null, 'downscaled', width + 'x' + height, '->', w + 'x' + h,
        '(' + out.byteLength + ' bytes)');
    return { bytes: out, width: w, height: h, mime: 'image/jpeg' };
  }

  /**
   * Engine entry point. Matches the contract documented in engines.js.
   * @param {{bytes: ArrayBuffer, mime: string, width: number, height: number,
   *           sourceLang: string, targetLang: string, settings: Object}} req
   * @returns {Promise<{regions: Array, sourceLang: string, targetLang: string,
   *                    diagnostics: Object}>}
   */
  async function imageToRegions(req) {
    const settings = req.settings || {};
    const up = await toUploadable(req.bytes, req.mime, req.width, req.height);

    // 1. OCR: text + normalised boxes + detected language.
    const scanned = await CTLensProto.scan(up.bytes, up.width, up.height, settings, {
      targetLang: req.targetLang
    });

    // 2. Map boxes from the (possibly downscaled) upload grid back to the
    //    original pixel grid the content script will paint on.
    const regions = CTLensProto.rescaleRegions(
      scanned.regions, up.width, up.height, req.width, req.height
    );

    // 3. Translate. The protobuf API positions text but does not translate it,
    //    so this is the second half of the engine (engines.js: an OCR-only
    //    engine runs the shared translator itself, which is what happens here).
    const texts = await CTTranslator.translateStrings(
      regions.map((r) => r.text),
      { sourceLang: scanned.sourceLang || req.sourceLang, targetLang: req.targetLang, settings }
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
        { sentSize: up.width + 'x' + up.height, originalSize: req.width + 'x' + req.height },
        scanned.diagnostics
      )
    };
  }

  globalThis.CTLensEngine = {
    id: 'lens',
    label: 'Google Lens (free OCR) + Google Translate',
    needsKey: false,
    /** Regions arrive already translated: this engine runs the shared
     *  translator itself, so engines.js must not run it a second time. */
    doesTranslation: true,
    imageToRegions,
    toUploadable,
    log
  };
}