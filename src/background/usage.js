/**
 * usage.js - persistent counter of what the Lara engines bill.
 *
 * Lara meters everything in characters and the free tier caps API usage at
 * 10,000 characters per month, so the user needs to see where they stand:
 *
 *   - text translation (lens-lara) bills the characters actually sent;
 *   - the full-image engine bills a FLAT 10,000 characters per image.
 *
 * So one image costs what a whole page of text costs, and the meter reflects
 * both. The counter follows the CALENDAR month as an approximation of Lara's
 * own billing window (their reset day is account-specific and unknowable to
 * us), and the options page exposes a manual reset for that reason.
 *
 * Cache hits are never counted: only calls that actually reach Lara bill.
 */
'use strict';

if (typeof globalThis.CTUsage === 'undefined') {
  const KEY = 'ct_usage';
  const IMAGE_CHARS = 10000; // Lara's flat per-image billing unit

  let cache = null;

  /** 'YYYY-MM' in local time. Exported for tests. */
  function monthKey(d) {
    const date = d || new Date();
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
  }

  async function load() {
    const stored = await browser.storage.local.get(KEY);
    let u = stored[KEY];
    if (!u || u.monthKey !== monthKey()) {
      // New month (or first run): the window starts empty.
      u = { monthKey: monthKey(), textChars: 0, imageCount: 0 };
      await browser.storage.local.set({ [KEY]: u });
    }
    cache = u;
    return u;
  }

  async function save() {
    await browser.storage.local.set({ [KEY]: cache });
  }

  async function addTextChars(n) {
    if (!(n > 0)) return;
    const u = await load();
    u.textChars += n;
    await save();
  }

  async function addImage() {
    const u = await load();
    u.imageCount += 1;
    await save();
  }

  /** What the UI needs, including the image engine's flat billing folded in. */
  async function snapshot() {
    const u = await load();
    return {
      monthKey: u.monthKey,
      textChars: u.textChars,
      imageCount: u.imageCount,
      imageCharsPerImage: IMAGE_CHARS,
      totalChars: u.textChars + u.imageCount * IMAGE_CHARS
    };
  }

  /** Manual reset (options page) - for when Lara's own window rolls over. */
  async function reset() {
    cache = { monthKey: monthKey(), textChars: 0, imageCount: 0 };
    await save();
    return snapshot();
  }

  globalThis.CTUsage = { monthKey, addTextChars, addImage, snapshot, reset };
}