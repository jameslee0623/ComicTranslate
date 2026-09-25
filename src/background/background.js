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
                  '../shared/languages.js',
                  'settings.js', 'usage.js', 'cache.js', 'imageFetch.js',
                  'translator.js', 'protobuf.js', 'lensProto.js', 'lensEngine.js',
                  'laraEngine.js', 'lensLaraEngine.js', 'lensLocalEngine.js', 'engines.js');
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

// ── page-change cancellation ─────────────────────────────────────────────────
/**
 * A job whose page is gone is not worth finishing. Two things have to be stopped,
 * and they need different mechanisms:
 *
 *   QUEUED jobs  - the content script posts one request per image, so a page of
 *                  40 panels leaves a chain of them behind it. They are dropped
 *                  by generation, not by abort: each request records the counters
 *                  of the document that posted it, and a job that reaches the
 *                  front of the queue after those moved returns "skipped" without
 *                  a single byte going to the server.
 *   RUNNING job  - the one in flight is aborted at the engine (see
 *                  CTLensLocalEngine.cancelActive). On a local model that is the
 *                  difference between stopping now and finishing a generation
 *                  nobody will ever see, at the user's own expense - the reason
 *                  this exists at all.
 *
 * Identity is the TAB plus the FRAME, in two counters, because the extension runs
 * in every frame (all_frames: true):
 *
 *   tabGeneration    bumped when a new document loads in the tab. Invalidates
 *                    every frame at once, which is what a real navigation means.
 *   frameGeneration  bumped when ONE frame reports itself leaving (its own
 *                    CT_CANCEL_TRANSLATE on pagehide). This is the precision that
 *                    matters on ad-heavy readers: an advertising iframe reloading
 *                    must not throw away the translations the main frame is in the
 *                    middle of, which a tab-wide counter alone would do.
 *
 * A real page load is the only thing tabs.onUpdated reports as "loading", and it
 * is never reported for a hash or history.pushState move - both keep the document,
 * and therefore keep the content script that is still waiting for its reply.
 */
const tabGeneration = new Map();   // tabId -> counter
const frameGeneration = new Map(); // 'tabId:frameId' -> counter
let currentJob = null;             // {tabId, frameId} of the translation running now

function frameKey(tabId, frameId) {
  return tabId + ':' + (typeof frameId === 'number' ? frameId : 0);
}

/** Both halves of a document's identity, as one comparable token. */
function generationFor(tabId, frameId) {
  if (typeof tabId !== 'number') return '0:0';
  return (tabGeneration.get(tabId) || 0) + ':' + (frameGeneration.get(frameKey(tabId, frameId)) || 0);
}

function bumpGeneration(tabId, frameId) {
  if (typeof frameId === 'number') {
    const key = frameKey(tabId, frameId);
    frameGeneration.set(key, (frameGeneration.get(key) || 0) + 1);
  } else {
    tabGeneration.set(tabId, (tabGeneration.get(tabId) || 0) + 1);
  }
}

/**
 * Stop caring about a frame's (or a whole tab's) work: drop everything it queued
 * and abort whatever it has in flight. Returns whether a live request was cut
 * short.
 *
 * `frameId` omitted means the whole tab - that is what a navigation is. When it is
 * given, only that frame's jobs are dropped and only its request is aborted.
 *
 * cancelActive() is a no-op for every other engine, so this can never cut a
 * Google or Lara request short by mistake - and it does not need to. A Lens scan
 * costs a few hundred milliseconds; a local generation costs real CPU for as long
 * as it runs, which is what makes the asymmetry worth having.
 */
function cancelJobForTab(tabId, frameId) {
  if (typeof tabId !== 'number') return false;
  bumpGeneration(tabId, frameId);
  if (!currentJob || currentJob.tabId !== tabId) return false;
  if (typeof frameId === 'number' && currentJob.frameId !== frameId) return false;
  if (typeof CTLensLocalEngine === 'undefined') return false;
  const stopped = CTLensLocalEngine.cancelActive();
  if (stopped) {
    console.log('[CT] page changed in tab', tabId, 'frame', currentJob.frameId,
                '- local request cancelled');
  }
  return stopped;
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

    case 'CT_CANCEL_TRANSLATE': {
      // The page is going away and said so itself. This is the earliest signal
      // there can be - a bfcache navigation in particular may reach the listener
      // below late, or not at all - so it is acted on directly. The frame id is
      // passed so an iframe that is leaving drops only its own work.
      return {
        cancelled: cancelJobForTab(sender.tab ? sender.tab.id : msg.tabId,
                                   typeof sender.frameId === 'number'
                                     ? sender.frameId : msg.frameId)
      };
    }

    case 'CT_TRANSLATE_IMAGE': {
      if (!CTSettings.isAllowedOn(settings, sender.url || msg.url || '')) {
        return { skipped: true, reason: 'disabled for this page' };
      }
      // Trust the sender, not the payload, for tab identity.
      const tabId = sender.tab ? sender.tab.id : msg.tabId;
      const frameId = typeof sender.frameId === 'number' ? sender.frameId : msg.frameId;

      // The page this request belongs to, as of the moment it was posted.
      const generation = generationFor(tabId, frameId);

      startSpin();
      let result;
      try {
        result = await serialize(async () => {
          // The reader turned the page while this job waited its turn. Every
          // remaining job in the chain is for a document that no longer exists,
          // so returning early here is what drains the queue "immediately"
          // instead of paying for 39 more OCR scans and 39 more generations.
          if (generationFor(tabId, frameId) !== generation) {
            return { skipped: true, reason: 'page changed' };
          }
          if (typeof tabId === 'number') {
            currentJob = { tabId: tabId, frameId: frameId };
          }
          try {
            return await CTEngines.translateImage({
              url: msg.url,
              width: msg.width || 0,
              height: msg.height || 0,
              needBytes: !!msg.needBytes,
              sourceLang: msg.sourceLang || settings.sourceLang,
              targetLang: msg.targetLang || settings.targetLang,
              settings,
              tabId,
              frameId
            });
          } finally {
            currentJob = null;
          }
        });
      } catch (err) {
        // An abort WE asked for is not a failure and must not be reported as one:
        // the page that would have shown it is already gone, and the model was
        // stopped on purpose. Anything else keeps its own error path.
        if (err && err.cancelled) {
          return { skipped: true, reason: 'page changed' };
        }
        throw err;
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

    case 'CT_LOCAL_TEXT_PROBE': {
      // Free connectivity check against the user's own server. It validates the
      // URL shape and proves the server is alive WITHOUT sending an image or any
      // OCR text: an empty `texts` array is the one request every implementation
      // of the documented contract must answer, and any reply - 200, or an error
      // status for the empty body - proves the server is up and listening.
      const endpoint = CTLensLocalEngine.requireEndpoint(settings);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ texts: [], target: 'en' }),
          signal: ctrl.signal
        });
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

/**
 * The reader turned the page: stop paying for the page they left.
 *
 * "loading" is the whole filter, and it is deliberate. tabs.onUpdated reports it
 * when a NEW document starts in the tab, so it fires once per real navigation and
 * never for a hash change or a pushState move - both of which keep the document,
 * and therefore keep the content script that is still waiting for its reply. Those
 * must not be cancelled. A frame loading on its own does not touch the tab's
 * status, so an embedded reader that swaps its own frames is not caught here; it
 * is caught by that frame's own CT_CANCEL_TRANSLATE instead, which is also why the
 * frame id is carried through every job.
 */
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo || changeInfo.status !== 'loading') return;
  cancelJobForTab(tabId);   // no frame id: a tab document load invalidates them all
});

/**
 * Closing a tab is the same event with no page left to read the reply, plus one
 * loose end: the counters would otherwise sit in the maps for a tab id that no
 * longer exists. Chrome reuses ids, and a reused id must start clean - otherwise a
 * fresh tab could inherit a stale counter and have its first translation dropped
 * as "page changed".
 */
browser.tabs.onRemoved.addListener((tabId) => {
  if (currentJob && currentJob.tabId === tabId &&
      typeof CTLensLocalEngine !== 'undefined') {
    CTLensLocalEngine.cancelActive();
  }
  tabGeneration.delete(tabId);
  for (const key of Array.from(frameGeneration.keys())) {
    if (key.indexOf(tabId + ':') === 0) frameGeneration.delete(key);
  }
});

