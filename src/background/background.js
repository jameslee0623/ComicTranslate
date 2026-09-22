/**
 * background.js - message router for the background event page.
 *
 * Firefox MV3 runs this as a non-persistent EVENT PAGE (it ignores
 * service_worker); Chrome runs it as a service worker and ignores scripts.
 * Every listener is therefore registered synchronously at the top level, so the
 * background context is revived correctly after Firefox unloads it while idle.
 */
'use strict';

// Chrome reaches the other modules through importScripts because it ignores the
// manifest's background.scripts array. The modules guard themselves against
// double evaluation, so this is a no-op under Firefox.
if (typeof importScripts === 'function') {
  try {
    // Paths are relative to this file (src/background/), so the shared modules
    // are one level up. compat.js must come first: everything below assumes
    // `browser` exists, and on Chrome it does not until compat.js aliases it.
    importScripts('../shared/compat.js', '../shared/codec.js',
                  'settings.js', 'usage.js', 'cache.js', 'imageFetch.js',
                  'translator.js', 'protobuf.js', 'lensProto.js', 'lensEngine.js',
                  'laraEngine.js', 'lensLaraEngine.js', 'localImageEngine.js', 'engines.js');
  } catch (e) {
    console.error('[CT] importScripts failed', e);
  }
}

// One line per context, always: this is how we tell "the background never
// started" from "it started but the work failed" in bug reports. In Chrome the
// line appears in the service worker console (chrome://extensions -> Inspect
// views: service worker); in Firefox in the Browser Console.
console.log('[CT] background up:',
  typeof importScripts === 'function' ? 'Chrome service worker' : 'Firefox event page');

/**
 * Every translation is funneled through a single promise chain. That serialises
 * outbound work so we stay polite with Google — the engine makes several network
 * calls per image — without needing explicit locks.
 */
let queue = Promise.resolve();
function serialize(task) {
  const run = queue.then(task, task);
  // Keep the chain alive even when a task throws.
  queue = run.then(() => undefined, () => undefined);
  return run;
}

// ── toolbar "translating" animation ──────────────────────────────────────────
// While any translation is in flight the toolbar icon becomes a rotating arc.
// setIcon accepts ImageData records, so frames are drawn once on a canvas and
// swapped on a timer; the static manifest PNG is restored when the queue idles.
const SPIN_PATHS = {
  32: 'assets/icons/icon-32.png',
  48: 'assets/icons/icon-48.png',
  96: 'assets/icons/icon-96.png'
};
let spinFrames = null;   // [{32: ImageData, 64: ImageData}, ...]
let spinTimer = null;
let spinIndex = 0;
let spinBusy = 0;

function makeCanvas(size) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(size, size);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    return c;
  }
  return null;
}

function renderSpinnerFrames() {
  const FRAMES = 12;
  const frames = [];
  for (let f = 0; f < FRAMES; f++) {
    const angle = (f / FRAMES) * Math.PI * 2;
    const set = {};
    for (const s of [32, 64]) {
      const canvas = makeCanvas(s);
      if (!canvas) return null;
      const ctx = canvas.getContext('2d');
      const c = s / 2;
      ctx.clearRect(0, 0, s, s);
      ctx.lineCap = 'round';
      ctx.lineWidth = s * 0.13;
      // faint full ring...
      ctx.strokeStyle = 'rgba(99, 102, 241, 0.30)';
      ctx.beginPath();
      ctx.arc(c, c, s * 0.30, 0, Math.PI * 2);
      ctx.stroke();
      // ...with a bright rotating arc on top
      ctx.strokeStyle = '#6366F1';
      ctx.beginPath();
      ctx.arc(c, c, s * 0.30, angle, angle + Math.PI * 1.25);
      ctx.stroke();
      set[s] = ctx.getImageData(0, 0, s, s);
    }
    frames.push(set);
  }
  return frames;
}

function startSpin() {
  spinBusy++;
  if (!browser.action || !browser.action.setIcon || spinTimer) return;
  if (!spinFrames) spinFrames = renderSpinnerFrames();
  if (!spinFrames) return; // no canvas in this context; nothing to animate
  spinIndex = 0;
  spinTimer = setInterval(() => {
    try {
      spinIndex = (spinIndex + 1) % spinFrames.length;
      browser.action.setIcon({ imageData: spinFrames[spinIndex] })
        .catch(() => {});
    } catch {
      // a failed frame swap must never take the queue down
    }
  }, 110);
}

function stopSpin() {
  spinBusy = Math.max(0, spinBusy - 1);
  if (spinBusy > 0 || !spinTimer) return;
  clearInterval(spinTimer);
  spinTimer = null;
  try { browser.action.setIcon({ path: SPIN_PATHS }); } catch { /* noop */ }
}


async function handle(msg, sender) {
  const settings = await CTSettings.get();

  switch (msg.type) {
    case 'CT_GET_SETTINGS':
      return {
        settings,
        engines: CTEngines.list(),
        version: browser.runtime.getManifest().version
      };

    case 'CT_SET_SETTINGS':
      return { settings: await CTSettings.set(msg.patch || {}) };

    case 'CT_CHECK_PAGE':
      return { allowed: CTSettings.isAllowedOn(settings, msg.url) };

    case 'CT_CACHE_CLEAR':
      await CTCache.clear();
      return { cleared: true };

    case 'CT_TRANSLATE_IMAGE': {
      if (!CTSettings.isAllowedOn(settings, sender.url || msg.url || '')) {
        return { skipped: true, reason: 'disabled for this page' };
      }
      // Trust the sender, not the payload, for tab identity.
      const tabId = sender.tab ? sender.tab.id : msg.tabId;
      const frameId = typeof sender.frameId === 'number' ? sender.frameId : msg.frameId;

      startSpin();
      let result;
      try {
        result = await serialize(() =>
          CTEngines.translateImage({
            url: msg.url,
            width: msg.width || 0,
            height: msg.height || 0,
            needBytes: !!msg.needBytes,
            sourceLang: msg.sourceLang || settings.sourceLang,
            targetLang: msg.targetLang || settings.targetLang,
            settings,
            tabId,
            frameId
          })
        );
      } finally {
        stopSpin();
      }
      return result;
    }

    case 'CT_GET_USAGE':
      return CTUsage.snapshot();

    case 'CT_RESET_USAGE':
      return CTUsage.reset();

    case 'CT_LARA_PROBE': {
      // Free credential check: /v2/auth only, never an image (an image bills
      // ~10,000 characters). Reports the fresh token's actual expiry.
      CTLaraEngine.resetAuth();
      const bearer = await CTLaraEngine.ensureToken(settings);
      return { ok: true, expiresAt: CTLaraEngine.tokenExpiry(bearer) || 0 };
    }

    case 'CT_LOCAL_IMAGE_PROBE': {
      // Free connectivity check against the user's own server: validates the
      // URL shape without sending any image. The server answers GET with any
      // 2xx/4xx to prove it is alive (a 404 on /translate-image still means a
      // live server that only accepts POST).
      const endpoint = CTLocalImageEngine.requireEndpoint(settings);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      try {
        const res = await fetch(endpoint,
          { method: 'GET', signal: ctrl.signal });
        return { ok: true, status: res.status };
      } catch (e) {
        throw new Error('Cannot reach the local server at ' + endpoint +
          ' (' + (e && e.name === 'AbortError' ? 'timed out' : 'is it running?') + ').');
      } finally {
        clearTimeout(timer);
      }
    }

    default:
      throw new Error('unknown message type: ' + msg.type);
  }
}

/**
 * Reply with sendResponse() and `return true` - never by returning a Promise.
 * Firefox accepts both styles; Chrome accepts only this one, because a returned
 * Promise causes Chrome to close the message port before the reply exists and
 * the sender sees "The message port closed before a response was received".
 *
 * Returning true has a second benefit on Chrome: it keeps the service worker
 * alive while the work is pending, which matters because one Lens scan is
 * several network round-trips and Chrome terminates an idle worker after ~30s.
 *
 * CTCodec.packReply is what makes the payload survive Chrome at all - Chrome
 * serialises messages as JSON, so raw image bytes would arrive as {}.
 */
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('CT_')) return false;

  handle(msg, sender).then(
    (data) => sendResponse({ ok: true, data: CTCodec.packReply(data) }),
    (err) => {
      console.error('[CT] handler failed for', msg.type, err);
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  );
  return true;
});

browser.runtime.onInstalled.addListener((details) => {
  CTSettings.get()
    .then((s) => CTCache.prune(s.cacheTtlDays))
    .then((n) => {
      if (n) console.log('[CT] pruned', n, 'stale cache entries');
    })
    .catch((e) => console.error('[CT] startup maintenance failed', e));
  console.log('[CT] installed/updated', details.reason);
});

