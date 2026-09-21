/**
 * replaceImage.js - put the translated bitmap into the page, reversibly.
 *
 * Two strategies, because the page's Content-Security-Policy decides which works:
 *
 *   'replace' - swap img.src for a blob URL. Cleanest and preserves page layout,
 *               but a strict `img-src` policy can block blob: and data:.
 *   'overlay' - insert the rendered <canvas> on top of the original. Involves no
 *               URL whatsoever, so no CSP directive can block it. Used as the
 *               automatic fallback when the blob URL fails to decode.
 *
 * Everything is recorded so the popup's off switch restores the page exactly.
 */
'use strict';

if (typeof globalThis.CTReplace === 'undefined') {
  /** el -> { kind, originalSrc, originalSrcset, originalSizes, overlay, blobUrl } */
  const records = new Map();

  function remember(el, record) {
    const existing = records.get(el);
    records.set(el, Object.assign({}, existing, record));
  }

  function canvasToBlobUrl(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) return reject(new Error('canvas.toBlob returned null'));
        resolve(URL.createObjectURL(blob));
      }, 'image/png');
    });
  }

  /** Decode an image URL and draw it onto a canvas (used for overlay fallbacks). */
  async function urlToCanvas(url) {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('translated image failed to decode'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return canvas;
  }

  /**
   * Apply a fully translated bitmap (Lara engine) instead of a locally painted
   * canvas. Same two strategies and the same fallback logic as apply():
   * blob-src swap first, canvas overlay if the page's CSP refuses the blob.
   */
  async function applyImageBytes(el, bytes, mime, preferred) {
    const isImg = el.tagName === 'IMG';
    const kind = isImg ? 'img' : 'background';
    const url = URL.createObjectURL(new Blob([bytes], { type: mime || 'image/png' }));

    if (preferred === 'overlay' || !isImg) {
      try {
        const canvas = await urlToCanvas(url);
        URL.revokeObjectURL(url);
        return attachOverlay(el, canvas, kind);
      } catch (e) {
        URL.revokeObjectURL(url);
        return { mode: 'overlay', ok: false, reason: e.message };
      }
    }

    try {
      swapSrc(el, url);
      if (await waitForDecode(el, 5000)) {
        remember(el, { kind, translated: true, blobUrl: url });
        return { mode: 'replace', ok: true };
      }
      // Decoded to nothing: most likely the page's img-src policy refused the
      // blob URL. Roll back and use the CSP-immune canvas overlay instead.
      URL.revokeObjectURL(url);
      const canvas = await urlToCanvas(url);
      URL.revokeObjectURL(url);
      const result = attachOverlay(el, canvas, kind);
      return Object.assign(result, { reason: 'csp blocked blob URL' });
    } catch (e) {
      URL.revokeObjectURL(url);
      // swapSrc already recorded the original src, so restore still works.
      try {
        const canvas = await urlToCanvas(url);
        URL.revokeObjectURL(url);
        const result = attachOverlay(el, canvas, kind);
        return Object.assign(result, { reason: 'blob replace failed: ' + e.message });
      } catch (e2) {
        return { mode: 'overlay', ok: false, reason: e2.message };
      }
    }
  }

  /** Wait until the browser has actually decoded (or refused) the new source. */
  function waitForDecode(el, timeoutMs) {
    return new Promise((resolve) => {
      const done = () => {
        cleanup();
        resolve(el.naturalWidth > 0);
      };
      const cleanup = () => {
        el.removeEventListener('load', done);
        el.removeEventListener('error', done);
        clearTimeout(timer);
      };
      const timer = setTimeout(done, timeoutMs || 2500);
      el.addEventListener('load', done, { once: true });
      el.addEventListener('error', done, { once: true });
    });
  }

  function swapSrc(el, blobUrl) {
    const existing = records.get(el);
    // Translating the same image twice (e.g. after switching target language)
    // must not overwrite the recorded original with the previously translated
    // blob URL, or "Restore page" would restore a translation.
    const priorSrc = existing && existing.originalSrc !== undefined
      ? existing.originalSrc
      : el.getAttribute('src');
    const priorSrcset = existing && existing.originalSrcset !== undefined
      ? existing.originalSrcset
      : el.getAttribute('srcset');
    const priorSizes = existing && existing.originalSizes !== undefined
      ? existing.originalSizes
      : el.getAttribute('sizes');

    if (existing && existing.blobUrl && existing.blobUrl !== blobUrl) {
      URL.revokeObjectURL(existing.blobUrl);
    }

    remember(el, {
      kind: 'img',
      originalSrc: priorSrc,
      originalSrcset: priorSrcset,
      originalSizes: priorSizes
    });
    // srcset wins over src, so it must be cleared or the browser keeps using it.
    el.removeAttribute('srcset');
    el.removeAttribute('sizes');
    el.src = blobUrl;
  }

  /**
   * Place the translated canvas over the original element. Anchoring to a
   * positioned ancestor via offsetLeft/offsetTop means scrolling and page reflow
   * keep working without any scroll listeners.
   */
  function mountOverlay(el, canvas) {
    const parent = el.parentElement;
    if (!parent) return null;

    if (getComputedStyle(parent).position === 'static') {
      remember(parent, { kind: 'positioned', priorPosition: parent.style.position });
      parent.style.position = 'relative';
    }

    canvas.style.position = 'absolute';
    canvas.style.left = el.offsetLeft + 'px';
    canvas.style.top = el.offsetTop + 'px';
    canvas.style.width = el.offsetWidth + 'px';
    canvas.style.height = el.offsetHeight + 'px';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '1';
    canvas.classList.add('ct-overlay');
    parent.appendChild(canvas);

    const sync = () => {
      canvas.style.left = el.offsetLeft + 'px';
      canvas.style.top = el.offsetTop + 'px';
      canvas.style.width = el.offsetWidth + 'px';
      canvas.style.height = el.offsetHeight + 'px';
    };
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(sync)
      : null;
    if (observer) observer.observe(el);

    return { canvas, observer };
  }

  function unmountOverlay(record) {
    if (!record || !record.overlay) return;
    if (record.overlay.observer) record.overlay.observer.disconnect();
    const node = record.overlay.canvas;
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  const SIDE_BY_SIDE_ATTR = 'data-ct-original-clone';
  const SIDE_BY_SIDE_WRAP = 'data-ct-side-by-side';

  /**
   * Wrap a translated <img> in a flex row with a clone showing the original
   * source: original on the left, translation on the right, each 50% wide.
   * Called when the side-by-side toggle is turned on after images were already
   * translated, and available as an option on fresh replacements.
   *
   * Returns true when a wrap was created. Skips anything that is not a
   * translated <img> in 'replace' mode: overlays keep their own positioning,
   * and background-image elements have no <img> to pair with.
   */
  function wrapSideBySide(el) {
    const record = records.get(el);
    if (!record || !record.translated || record.sideBySide) return false;
    if (record.kind !== 'img' || el.tagName !== 'IMG') return false;
    if (record.overlay) return false;
    if (!record.originalSrc) return false;
    const parent = el.parentNode;
    if (!parent) return false;

    const wrap = document.createElement('div');
    wrap.setAttribute(SIDE_BY_SIDE_WRAP, 'true');
    wrap.style.cssText = [
      'display:flex', 'flex-direction:row', 'align-items:flex-start',
      'gap:8px', 'width:100%', 'max-width:100%', 'box-sizing:border-box'
    ].join(';');

    const clone = document.createElement('img');
    clone.setAttribute(SIDE_BY_SIDE_ATTR, 'true');
    clone.src = record.originalSrc;
    if (record.originalSrcset !== null && record.originalSrcset !== undefined) {
      clone.setAttribute('srcset', record.originalSrcset);
    }
    if (record.originalSizes !== null && record.originalSizes !== undefined) {
      clone.setAttribute('sizes', record.originalSizes);
    }
    clone.alt = el.alt || '';
    clone.style.cssText = [
      'flex:1 1 50%', 'width:50%', 'max-width:50%', 'height:auto',
      'object-fit:contain', 'box-sizing:border-box'
    ].join(';');

    parent.insertBefore(wrap, el);
    wrap.appendChild(clone);
    wrap.appendChild(el);
    el.style.flex = '1 1 50%';
    el.style.maxWidth = '50%';
    el.style.width = '50%';
    el.style.height = 'auto';
    el.style.boxSizing = 'border-box';

    remember(el, { sideBySide: true, sideBySideWrap: wrap, sideBySideClone: clone });
    return true;
  }

  /**
   * Remove the side-by-side wrapper for one element: the clone is dropped and
   * the translated <img> is moved back to its original position with its
   * inline sizing restored.
   */
  function unwrapSideBySide(el) {
    const record = records.get(el);
    if (!record || !record.sideBySide) return false;
    const wrap = record.sideBySideWrap;
    const clone = record.sideBySideClone;
    if (wrap && wrap.parentNode) {
      wrap.parentNode.insertBefore(el, wrap);
      wrap.parentNode.removeChild(wrap);
    }
    if (clone && clone.parentNode) clone.parentNode.removeChild(clone);
    el.style.flex = '';
    el.style.maxWidth = '';
    el.style.width = '';
    el.style.height = '';
    el.style.boxSizing = '';
    remember(el, { sideBySide: false, sideBySideWrap: null, sideBySideClone: null });
    return true;
  }

  /** Apply the side-by-side mode to every translated element on the page. */
  function setSideBySide(on) {
    let n = 0;
    for (const el of Array.from(records.keys())) {
      if (on ? wrapSideBySide(el) : unwrapSideBySide(el)) n++;
    }
    return n;
  }

  function restoreElement(el) {
    const record = records.get(el);
    if (!record) return false;

    unwrapSideBySide(el);
    if (record.overlay) unmountOverlay(record);
    if (record.blobUrl) URL.revokeObjectURL(record.blobUrl);

    if (record.originalSrc !== undefined) {
      if (record.originalSrcset !== null) el.setAttribute('srcset', record.originalSrcset);
      else el.removeAttribute('srcset');
      if (record.originalSizes !== null) el.setAttribute('sizes', record.originalSizes);
      else el.removeAttribute('sizes');
      el.setAttribute('src', record.originalSrc);
    }
    if (record.kind === 'positioned') {
      el.style.position = record.priorPosition || '';
    }
    records.delete(el);
    return true;
  }

  function restoreAll() {
    let n = 0;
    for (const el of Array.from(records.keys())) {
      if (restoreElement(el)) n++;
    }
    records.clear();
    return n;
  }

  function attachOverlay(el, canvas, kind) {
    const overlay = mountOverlay(el, canvas);
    if (!overlay) return { mode: 'overlay', ok: false, reason: 'no parent element' };
    remember(el, { kind, translated: true, overlay });
    return { mode: 'overlay', ok: true };
  }

  /**
   * @param {HTMLElement} el
   * @param {HTMLCanvasElement} canvas  already containing the translated bitmap
   * @param {'replace'|'overlay'} preferred
   * @returns {Promise<{mode: string, ok: boolean, reason?: string}>}
   */
  async function apply(el, canvas, preferred) {
    const isImg = el.tagName === 'IMG';
    const kind = isImg ? 'img' : 'background';

    if (preferred === 'overlay' || !isImg) {
      return attachOverlay(el, canvas, kind);
    }

    let blobUrl = null;
    try {
      blobUrl = await canvasToBlobUrl(canvas);
      swapSrc(el, blobUrl);

      if (await waitForDecode(el, 2500)) {
        remember(el, { kind, translated: true, blobUrl });
        return { mode: 'replace', ok: true };
      }

      // Decoded to nothing: most likely the page's img-src policy refused the
      // blob URL. Roll back and use the CSP-immune canvas overlay instead.
      URL.revokeObjectURL(blobUrl);
      const result = attachOverlay(el, canvas, kind);
      return Object.assign(result, { reason: 'csp blocked blob URL' });
    } catch (e) {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      const result = attachOverlay(el, canvas, kind);
      return Object.assign(result, { reason: 'blob replace failed: ' + e.message });
    }
  }

  function count() {
    return records.size;
  }

  globalThis.CTReplace = {
    apply,
    applyImageBytes,
    restoreElement,
    restoreAll,
    mountOverlay,
    unmountOverlay,
    canvasToBlobUrl,
    wrapSideBySide,
    unwrapSideBySide,
    setSideBySide,
    count
  };
}
