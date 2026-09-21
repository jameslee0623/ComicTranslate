/**
 * settings.js - persisted user settings.
 *
 * Loaded as a classic script into the background context (Firefox event page).
 * Idempotent: safe to evaluate twice, which happens when Chrome loads this file
 * via importScripts() from background.js.
 */
'use strict';

if (typeof globalThis.CTSettings === 'undefined') {
  const DEFAULTS = Object.freeze({
    /** Master switch. Off by default so a fresh install never phones home. */
    enabled: false,

    /** Which OCR/translation engine to use. See engines.js for the registry. */
    engineId: 'lens',

    /** 'auto' lets the engine detect the source language. */
    sourceLang: 'auto',
    targetLang: 'en',

    /** Ignore images smaller than this on either axis (filters icons/spacers). */
    minImageSize: 120,

    /** Upper bound on images translated per page load, to bound cost/load. */
    maxImagesPerPage: 40,

    /** Minimum gap between outbound requests, to stay polite and avoid bans. */
    requestDelayMs: 1500,

    /**
     * Where the translated image is written.
     *   'replace' - swap img.src (cleanest, but page CSP can block blob:/data:)
     *   'overlay' - draw a canvas on top of the original (CSP-proof fallback)
     */
    renderMode: 'replace',

    /** Also translate CSS background-image elements. Off: expensive to scan. */
    scanBackgrounds: false,

    /** Outline text for legibility over artwork rather than flat bubbles. */
    textStroke: true,

    /** null uses textLayout.js's built-in stack with CJK/RTL coverage. */
    fontFamily: null,

    /** 'all' | 'blocklist' | 'allowlist' */
    domainMode: 'all',
    domains: [],

    /** 0 disables caching. */
    cacheTtlDays: 30,

    /**
     * Reference monthly cap for the usage meter (Lara's free tier is
     * 10,000 chars/month). Display only - the API enforces the real one.
     */
    laraMonthlyCap: 10000,

    /**
     * Lara Translate credentials (https://laratranslate.com). Stored locally in
     * browser.storage; requests are signed in the background page and sent
     * directly to api.laratranslate.com. Empty = Lara engine unavailable.
     */
    laraAccessKeyId: '',
    laraAccessKeySecret: '',
    /** Text-removal model: overlay | inpainting | generative | generative_fast. */
    laraModel: 'inpainting',

    /** Diagnostic logging in the background console. */
    debug: true
  });

  const KEY = 'ct_settings';
  let cache = null;
  const listeners = new Set();

  async function load() {
    const stored = await browser.storage.local.get(KEY);
    cache = Object.assign({}, DEFAULTS, stored[KEY] || {});
    return cache;
  }

  async function get() {
    if (!cache) await load();
    return cache;
  }

  async function set(patch) {
    const current = await get();
    const next = Object.assign({}, current, patch);
    cache = next;
    await browser.storage.local.set({ [KEY]: next });
    for (const fn of listeners) {
      try { fn(next); } catch (e) { console.error('[CT] settings listener failed', e); }
    }
    return next;
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /**
   * Should the extension act on this page at all?
   * Kept in settings.js so popup, content script and background all agree.
   */
  function isAllowedOn(settings, url) {
    if (!settings.enabled) return false;
    let host;
    try { host = new URL(url).hostname; } catch { return false; }
    if (!host) return false;

    const listed = (settings.domains || []).some(
      (d) => host === d || host.endsWith('.' + d)
    );

    if (settings.domainMode === 'allowlist') return listed;
    if (settings.domainMode === 'blocklist') return !listed;
    return true;
  }

  globalThis.CTSettings = { DEFAULTS, load, get, set, onChange, isAllowedOn };
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    cache = Object.assign({}, DEFAULTS, changes[KEY].newValue || {});
    for (const fn of listeners) {
      try { fn(cache); } catch (e) { /* ignore */ }
    }
  });
}
