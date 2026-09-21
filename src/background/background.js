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
    importScripts('settings.js', 'usage.js', 'cache.js', 'imageFetch.js',
                  'translator.js', 'protobuf.js', 'lensProto.js', 'lensEngine.js',
                  'laraEngine.js', 'lensLaraEngine.js', 'engines.js');
  } catch (e) {
    console.error('[CT] importScripts failed', e);
  }
}

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

function cap(value, max) {
  if (typeof value !== 'string') return value;
  return value.length > max ? value.slice(0, max) + '\n...[truncated]' : value;
}

/**
 * Find the web tab the user actually means.
 *
 * This cannot be "the active tab". The options page is configured with
 * open_in_tab, so when the user is looking at it, THE OPTIONS TAB IS THE ACTIVE
 * TAB - and it is a moz-extension:// page where content scripts never run.
 * Messaging it fails with "Receiving end does not exist", which is exactly the
 * confusing error that made the diagnostics look broken.
 *
 * Restricting the query to http/https excludes every extension page, browser
 * page and about: page, and lastAccessed then picks the most recently used one.
 */
async function resolveTargetTab(explicitTabId) {
  if (typeof explicitTabId === 'number') {
    try {
      const tab = await browser.tabs.get(explicitTabId);
      if (tab && /^https?:/i.test(tab.url || '')) return tab;
    } catch {
      // fall through to the search below
    }
  }

  const webUrls = ['http://*/*', 'https://*/*'];
  let tabs = await browser.tabs.query({ currentWindow: true, url: webUrls });
  if (!tabs.length) tabs = await browser.tabs.query({ url: webUrls });
  if (!tabs.length) return null;

  const active = tabs.find((t) => t.active);
  if (active) return active;

  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return tabs[0];
}

/**
 * Message a tab's content script, translating the opaque browser error into
 * something that tells the user what to actually do.
 */
async function askTab(tab, message) {
  try {
    return await browser.tabs.sendMessage(tab.id, message);
  } catch (e) {
    const where = tab.title ? '"' + tab.title.slice(0, 60) + '"' : (tab.url || 'the tab');
    throw new Error(
      'Could not reach the ComicTranslate content script in ' + where + '. ' +
      'Content scripts are only injected when a page loads, so after loading or ' +
      'reloading the extension you must reload the page (F5). Then retry.'
    );
  }
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

      if (result.diagnostics && result.diagnostics.dump) {
        result.diagnostics.dump = cap(result.diagnostics.dump, 20000);
      }
      return result;
    }

    case 'CT_LIST_CANDIDATES': {
      const tab = await resolveTargetTab(msg.tabId);
      if (!tab) throw new Error('No ordinary web page is open to inspect.');
      const listed = await askTab(tab, {
        type: 'CT_GET_CANDIDATES',
        limit: msg.limit || 20
      });
      return {
        tabId: tab.id,
        tabTitle: tab.title || '',
        tabUrl: tab.url || '',
        candidates: (listed && listed.candidates) || []
      };
    }

    case 'CT_LENS_DIAGNOSE': {
      // Deliberately ignores the `enabled` flag: diagnosing a broken parser is
      // most often needed on a page the user has not switched on yet.
      const tab = await resolveTargetTab(msg.tabId);
      if (!tab) throw new Error('No ordinary web page is open to diagnose.');

      const listed = await askTab(tab, {
        type: 'CT_GET_CANDIDATES',
        limit: msg.limit || 10
      });
      const candidates = (listed && listed.candidates) || [];
      if (!candidates.length) {
        return {
          error: 'No candidate images found on this tab. Scroll the page so the ' +
                 'images actually load, then retry.',
          tabUrl: tab.url,
          candidates: []
        };
      }

      const index = Number.isInteger(msg.index) ? msg.index : 0;
      const target = candidates[Math.min(index, candidates.length - 1)];

      startSpin();
      let result;
      try {
        result = await serialize(() =>
          CTEngines.translateImage({
            url: target.url,
            width: target.width,
            height: target.height,
            needBytes: false,
            noCache: true,
            sourceLang: msg.sourceLang || settings.sourceLang,
            targetLang: msg.targetLang || settings.targetLang,
            settings,
            tabId: tab.id,
            frameId: 0
          })
        );
      } finally {
        stopSpin();
      }

      // The options page never needs megabytes of image data: report size+mime.
      if (result.image && result.image.bytes) {
        result.image = { mime: result.image.mime, bytesLen: result.image.bytes.byteLength };
      }
      if (result.diagnostics && result.diagnostics.dump) {
        result.diagnostics.dump = cap(result.diagnostics.dump, 20000);
      }
      return { target, candidates, result, tabUrl: tab.url };
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

    default:
      throw new Error('unknown message type: ' + msg.type);
  }
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('CT_')) return undefined;
  return handle(msg, sender).then(
    (data) => ({ ok: true, data }),
    (err) => {
      console.error('[CT] handler failed for', msg.type, err);
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  );
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

