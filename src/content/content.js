/**
 * content.js - page orchestrator.
 *
 * Owns discovery, sequencing and the drawing surface. All network work and all
 * engine logic live in the background; this file decides what to process,
 * composites the result, and hands it to replaceImage.js.
 */
'use strict';

(function () {
  if (window.__comicTranslateLoaded) return;
  window.__comicTranslateLoaded = true;

  const MAX_CANVAS_PIXELS = 4096 * 4096; // guard against absurd source images
  let settings = null;
  let running = false;
  let queued = false;
  const stats = { translated: 0, failed: 0, skipped: 0 };
  /** Most recent failure reason - surfaced in the chip and the popup, because a
   *  silent failure looks identical to a successful translation that drew
   *  nothing, which is exactly how a dead engine can seem healthy. */
  let lastError = null;

  function log(...args) {
    if (settings && settings.debug) console.log('[CT/content]', ...args);
  }

  async function send(type, payload) {
    const reply = await browser.runtime.sendMessage(Object.assign({ type }, payload));
    if (!reply) throw new Error('no reply from background for ' + type);
    if (!reply.ok) throw new Error(reply.error || 'background error');
    return reply.data;
  }

  function bytesToDataUrl(bytes, mime) {
    const u8 = new Uint8Array(bytes);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return 'data:' + mime + ';base64,' + btoa(binary);
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = src;
    });
  }

  /**
   * Drawing a cross-origin <img> taints the canvas, which makes getImageData
   * throw - and the painter needs getImageData to sample bubble colours. So we
   * probe the canvas once, up front, and only pay for a byte round-trip when the
   * page actually forces us to.
   */
  function isTainted(el) {
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 2;
    const ctx = c.getContext('2d');
    try {
      ctx.drawImage(el, 0, 0, 2, 2);
      ctx.getImageData(0, 0, 1, 1);
      return false;
    } catch {
      return true;
    }
  }

  function makeCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  /** Fit oversized sources inside MAX_CANVAS_PIXELS, preserving aspect ratio. */
  function fitDimensions(width, height) {
    const pixels = width * height;
    if (pixels <= MAX_CANVAS_PIXELS) return { width, height, scale: 1 };
    const scale = Math.sqrt(MAX_CANVAS_PIXELS / pixels);
    return {
      width: Math.max(1, Math.floor(width * scale)),
      height: Math.max(1, Math.floor(height * scale)),
      scale
    };
  }

  // ── in-page progress chip ──────────────────────────────────────────────────
  // "Is it still translating?" answered without opening the popup: a small
  // fixed chip with a spinner, per-image progress and the month's Lara usage.
  // The spinner animates via the Web Animations API rather than a <style>
  // block, because page CSP can forbid inline stylesheets but not el.animate.
  let chip = null;
  let chipLabel = null;
  let chipHideTimer = null;
  let lastUsage = null;

  function fmtChars(n) {
    return Number(n || 0).toLocaleString();
  }

  function usageSuffix() {
    if (!lastUsage || !(lastUsage.totalChars > 0)) return '';
    const cap = (settings && settings.laraMonthlyCap) || 10000;
    return ' · ' + fmtChars(lastUsage.totalChars) + ' / ' + fmtChars(cap) + ' chars';
  }

  function ensureChip() {
    if (chip && chip.isConnected) return;
    chip = document.createElement('div');
    chip.style.cssText = [
      'position:fixed', 'right:16px', 'top:16px', 'z-index:2147483647',
      'display:flex', 'align-items:center', 'gap:8px', 'padding:8px 14px',
      'background:rgba(24,24,38,.88)', 'color:#fff',
      'font:13px/1.4 system-ui,-apple-system,sans-serif',
      'border-radius:999px', 'box-shadow:0 2px 10px rgba(0,0,0,.35)',
      'cursor:pointer', 'margin:0'
    ].join(';');
    chip.title = 'ComicTranslate is working on this page. Click to hide.';

    const spinner = document.createElement('span');
    spinner.style.cssText = [
      'width:14px', 'height:14px', 'flex:none',
      'border:2px solid rgba(255,255,255,.35)', 'border-top-color:#fff',
      'border-radius:50%', 'display:inline-block'
    ].join(';');
    spinner.animate(
      [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
      { duration: 800, iterations: Infinity }
    );
    chip.appendChild(spinner);

    chipLabel = document.createElement('span');
    chip.appendChild(chipLabel);
    chip.addEventListener('click', hideChip);
    document.documentElement.appendChild(chip);
    chip.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
  }

  function chipText(text) {
    ensureChip();
    if (chipHideTimer) { clearTimeout(chipHideTimer); chipHideTimer = null; }
    if (chipLabel) chipLabel.textContent = text;
  }

  /** Chip-sized version of an error message. */
  function shorten(text, max) {
    const limit = max || 110;
    const s = String(text || '');
    return s.length > limit ? s.slice(0, limit - 1) + '\u2026' : s;
  }

  function hideChip() {
    if (chipHideTimer) { clearTimeout(chipHideTimer); chipHideTimer = null; }
    if (chip) {
      const gone = chip;
      chip = null;
      chipLabel = null;
      gone.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180 });
      setTimeout(() => gone.remove(), 200);
    }
  }

  async function translateOne(candidate) {
    const el = candidate.el;
    const tainted = candidate.type === 'img' && isTainted(el);
    log('processing', candidate.url.slice(0, 120), { tainted });

    const result = await send('CT_TRANSLATE_IMAGE', {
      url: candidate.url,
      width: candidate.width,
      height: candidate.height,
      needBytes: tainted
    });
    if (result.usage) lastUsage = result.usage;

    // Full-image engines (Lara) return a server-rendered translation: no
    // local painting at all, just put the bitmap into the page.
    if (result.image && result.image.bytes) {
      const applied = await CTReplace.applyImageBytes(
        el, result.image.bytes, result.image.mime,
        settings.renderMode === 'overlay' ? 'overlay' : 'replace'
      );
      log('applied image', applied);
      if (!applied.ok) throw new Error(applied.reason || 'apply failed');
      stats.translated++;
      return { ok: true, mode: applied.mode };
    }

    if (!result.regions || !result.regions.length) {
      stats.skipped++;
      log('no regions for', candidate.url.slice(0, 120), result.diagnostics);
      return { ok: false, reason: 'no regions' };
    }

    const dims = fitDimensions(candidate.width, candidate.height);
    const canvas = makeCanvas(dims.width, dims.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // Prefer the page's own decoded bitmap: no transfer, no re-decode.
    if (!tainted && candidate.type === 'img') {
      ctx.drawImage(el, 0, 0, dims.width, dims.height);
    } else {
      if (!result.bytes) throw new Error('needed pixel bytes but background sent none');
      const dataUrl = bytesToDataUrl(result.bytes, result.mime || 'image/png');
      const source = await loadImage(dataUrl);
      ctx.drawImage(source, 0, 0, dims.width, dims.height);
    }

    const scaled = dims.scale === 1 ? result.regions : result.regions.map((r) => ({
      text: r.text,
      translated: r.translated,
      bbox: {
        x: Math.round(r.bbox.x * dims.scale),
        y: Math.round(r.bbox.y * dims.scale),
        w: Math.round(r.bbox.w * dims.scale),
        h: Math.round(r.bbox.h * dims.scale)
      }
    }));

    const painted = CTPainter.renderRegions(ctx, scaled, {
      fontFamily: settings.fontFamily,
      stroke: settings.textStroke
    });
    if (!painted.drawn) {
      stats.skipped++;
      return { ok: false, reason: 'nothing drawn' };
    }

    const applied = await CTReplace.apply(el, canvas, settings.renderMode);
    log('applied', applied);
    if (!applied.ok) throw new Error(applied.reason || 'apply failed');

    stats.translated++;
    return { ok: true, mode: applied.mode, drawn: painted.drawn };
  }

  /**
   * Retry bookkeeping. A transport failure (rate limit, slow Lens boot, a flaky
   * CDN) must not permanently skip a panel, but a clean "OCR found no text"
   * result is final - retrying it would waste a request and re-upload the image.
   */
  const MAX_ATTEMPTS = 2;
  const attempts = new WeakMap();

  function attemptCount(el) {
    return attempts.get(el) || 0;
  }

  function recordTransportFailure(el) {
    const n = attemptCount(el) + 1;
    attempts.set(el, n);
    if (n >= MAX_ATTEMPTS) CTImageScanner.markSeen(el);
  }

  async function runQueue() {
    if (running) { queued = true; return; }
    running = true;
    try {
      do {
        queued = false;
        if (!settings || !settings.enabled) break;

        const candidates = CTImageScanner.scan({
          minSize: settings.minImageSize,
          includeBackgrounds: settings.scanBackgrounds,
          limit: settings.maxImagesPerPage
        }).filter((c) => !CTImageScanner.hasSeen(c.el) && attemptCount(c.el) < MAX_ATTEMPTS);

        if (candidates.length) {
          chipText('Translating… 0/' + candidates.length + usageSuffix());
        }

        let runIndex = 0;
        let firstFailure = null;
        for (const candidate of candidates) {
          if (!settings.enabled) break;
          runIndex++;
          chipText('Translating… ' + runIndex + '/' + candidates.length + usageSuffix());

          try {
            const outcome = await translateOne(candidate);
            // Either it worked, or OCR found nothing worth drawing. Both are
            // settled results, so the element is done either way.
            CTImageScanner.markSeen(candidate.el);
            if (outcome && outcome.ok) log('done', outcome);
          } catch (e) {
            stats.failed++;
            if (!firstFailure) firstFailure = e.message;
            lastError = e.message;
            recordTransportFailure(candidate.el);
            log('failed', candidate.url.slice(0, 120), e.message);
          }

          // Pace ourselves: the Lens engine drives a shared tab, and hammering
          // Google is the fastest way to get a session rate-limited.
          await new Promise((r) => setTimeout(r, settings.requestDelayMs || 1500));
        }

        if (candidates.length) {
          // Never report a bare "Done" over a silent failure: that is what makes
          // a completely dead engine look like a working one.
          chipText((firstFailure
            ? 'Failed: ' + shorten(firstFailure)
            : (settings.enabled ? 'Done' : 'Paused') + ' · ' +
              runIndex + '/' + candidates.length + ' images') + usageSuffix());
          chipHideTimer = setTimeout(hideChip, firstFailure ? 20000 : 3200);
        }
      } while (queued);
    } finally {
      running = false;
    }
  }

  let observer = null;
  let debounce = null;

  function scheduleRun() {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      runQueue();
    }, 800);
  }

  /**
   * A newly decoded image does NOT fire a DOM mutation once it is already in the
   * tree, so lazy-loading readers would be skipped entirely without this. The
   * listener is capture-phase because load events do not bubble.
   */
  function onResourceLoad(event) {
    const target = event.target;
    if (target && target.tagName === 'IMG') scheduleRun();
  }

  /**
   * Comic readers lazy-load and infinite-scroll, so new <img> elements appear
   * long after load. Debounced because one scroll can append dozens at once.
   */
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(scheduleRun);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('load', onResourceLoad, true);
  }

  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
    if (debounce) { clearTimeout(debounce); debounce = null; }
    document.removeEventListener('load', onResourceLoad, true);
  }

  /**
   * Content-script fetch, used as the fallback when the background request is
   * refused. Running here means the browser attaches the page's cookies and
   * Referer, which is what hotlink-protected image hosts check.
   */
  async function fetchInPage(url) {
    try {
      const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
      const bytes = await res.arrayBuffer();
      return { ok: true, bytes, mime: res.headers.get('content-type') || '' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function applyState(next) {
    const previous = settings;
    const wasEnabled = !!(previous && previous.enabled);
    settings = next;

    // A different language, engine or placement makes every existing
    // translation stale, so the page is restored and the images become eligible
    // for scanning again.
    const stale = !!previous && (
      previous.targetLang !== next.targetLang ||
      previous.sourceLang !== next.sourceLang ||
      previous.engineId !== next.engineId ||
      previous.laraModel !== next.laraModel ||
      previous.renderMode !== next.renderMode
    );
    if (stale) {
      CTReplace.restoreAll();
      CTImageScanner.reset();
    }

    const allowed = await send('CT_CHECK_PAGE', { url: location.href });

    if (allowed.allowed) {
      startObserver();
      runQueue();
    } else {
      stopObserver();
      if (wasEnabled) CTReplace.restoreAll();
    }
    return { allowed: allowed.allowed, stats, redone: stale };
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== 'string') return undefined;

    switch (msg.type) {
      case 'CT_FETCH_IMAGE_IN_PAGE':
        return fetchInPage(msg.url);

      case 'CT_APPLY_STATE':
        return applyState(msg.settings);

      case 'CT_RESTORE':
        stopObserver();
        if (settings) settings.enabled = false;
        hideChip();
        return Promise.resolve({ restored: CTReplace.restoreAll() });

      case 'CT_GET_STATUS':
        return Promise.resolve({
          stats,
          translated: CTReplace.count(),
          running,
          lastError,
          hasObserver: !!observer
        });

      case 'CT_SCAN_NOW':
        runQueue();
        return Promise.resolve({ started: true });

      default:
        return undefined;
    }
  });

  // Boot: pull settings and act, but never before the page has images to find.
  send('CT_GET_SETTINGS')
    .then((data) => applyState(data.settings))
    .then((result) => log('booted', result))
    .catch((e) => console.warn('[CT] boot failed', e.message));
})();
