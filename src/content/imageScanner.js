/**
 * imageScanner.js - find the images worth translating on a page.
 *
 * Deliberately conservative. Translating every <img> on a news site would burn
 * the user's quota and patience on logos, avatars and analytics beacons, so
 * candidates are filtered by rendered size and by scheme.
 */
'use strict';

if (typeof globalThis.CTImageScanner === 'undefined') {
  /** Schemes we cannot re-fetch usefully, or must not touch. */
  const SKIP_SCHEME = /^(blob:|filesystem:|moz-extension:|chrome-extension:)/i;
  const DATA_SCHEME = /^data:image\//i;

  /**
   * Vector files are always logos, icons or UI chrome, never comic lettering, so
   * they are never worth OCR. Observed in practice: the diagnostics picked
   * EXAMPLE-MANGA-SITE's 300x141 logo.svg as the first candidate on a manga page.
   */
  const VECTOR = /\.svgz?($|[?#])/i;

  /** Marks an element so a re-scan does not queue the same work twice. */
  let seen = new WeakSet();

  /**
   * Forget every element previously processed. Needed when the target language
   * or engine changes, because the existing translation is now stale and the
   * scan must be allowed to pick the same images up again.
   */
  function reset() {
    seen = new WeakSet();
  }

  function isEligibleUrl(url) {
    if (!url) return false;
    if (DATA_SCHEME.test(url)) return !VECTOR.test(url);
    if (SKIP_SCHEME.test(url)) return false;
    if (VECTOR.test(url)) return false;
    return /^https?:/i.test(url);
  }

  function markSeen(el) {
    seen.add(el);
  }

  function hasSeen(el) {
    return seen.has(el);
  }

  /**
   * Decide whether an <img> is a real target.
   * `naturalWidth` is the source resolution, which is what matters for OCR: a
   * 1200px-wide panel scaled down to 100px on screen is still worth translating,
   * and a 40px logo scaled up is not.
   */
  function imgCandidate(el, minSize) {
    if (!el || el.tagName !== 'IMG') return null;
    if (el.currentSrc === '' && !el.src) return null;
    const url = el.currentSrc || el.src;
    if (!isEligibleUrl(url)) return null;

    const w = el.naturalWidth || 0;
    const h = el.naturalHeight || 0;
    if (!w || !h) return null;                       // not decoded yet
    if (w < minSize || h < minSize) return null;

    const rect = el.getBoundingClientRect();
    if (rect.width < minSize * 0.25 || rect.height < minSize * 0.25) return null;

    return { el, type: 'img', url, width: w, height: h, rect };
  }

  /**
   * Background images. Full-document getComputedStyle is expensive, so callers
   * only invoke this when the user has opted in, and only for elements that have
   * a non-trivial box.
   */
  function backgroundCandidate(el, minSize) {
    if (!el || el.tagName === 'IMG' || !el.getBoundingClientRect) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width < minSize || rect.height < minSize) return null;

    let style;
    try { style = getComputedStyle(el); } catch { return null; }
    const bg = style.backgroundImage;
    if (!bg || bg === 'none') return null;

    // Only single-layer backgrounds; multi-layer compositing is out of scope.
    const match = /^url\(["']?([^"')]+)["']?\)$/.exec(bg.trim());
    if (!match) return null;
    const url = match[1];
    if (!isEligibleUrl(url)) return null;

    return {
      el,
      type: 'background',
      url,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      rect
    };
  }

  /**
   * @param {Object} options
   * @param {number} options.minSize
   * @param {boolean} options.includeBackgrounds
   * @param {number} options.limit  hard cap per scan, bounds cost
   * @returns {Array} largest first
   */
  function scan(options) {
    const opts = options || {};
    const minSize = opts.minSize || 120;
    const limit = opts.limit || 40;
    const results = [];

    for (const el of document.images) {
      const cand = imgCandidate(el, minSize);
      if (cand) results.push(cand);
    }

    if (opts.includeBackgrounds) {
      // Scope to likely containers instead of every element in the document.
      const nodes = document.querySelectorAll('div, section, article, figure, a, span, td, header, li');
      for (const el of nodes) {
        const cand = backgroundCandidate(el, minSize);
        if (cand) results.push(cand);
      }
    }

    // Largest first, because on a reader page the content is almost always the
    // biggest image. Sorting before the cap means the per-page quota is spent on
    // real panels rather than logos and thumbnails, and it makes index 0 of the
    // diagnostics the image the user actually cares about.
    results.sort((a, b) => (b.width * b.height) - (a.width * a.height));
    return results.slice(0, limit);
  }

  globalThis.CTImageScanner = {
    scan, isEligibleUrl, markSeen, hasSeen, reset, imgCandidate, backgroundCandidate
  };
}
