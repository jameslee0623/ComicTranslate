/**
 * i18n.js - lightweight UI localization for the popup and options page.
 *
 * The extension's _locales files are also used by the browser for its manifest
 * name and description. This loader gives the two HTML controls the same five
 * catalogs without requiring a framework or a new build step.
 */
'use strict';

if (typeof globalThis.CTI18n === 'undefined') {
  const SUPPORTED = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko'];
  const cache = Object.create(null);
  let language = 'en';

  function normalise(code) {
    const value = String(code || '').replace(/_/g, '-');
    const lower = value.toLowerCase();
    if (lower === 'zh' || lower.startsWith('zh-')) {
      if (/hant|tw|hk|mo/i.test(value)) return 'zh-TW';
      return 'zh-CN';
    }
    if (lower === 'ja' || lower.startsWith('ja-')) return 'ja';
    if (lower === 'ko' || lower.startsWith('ko-')) return 'ko';
    if (lower === 'en' || lower.startsWith('en-')) return 'en';
    return 'en';
  }

  function browserLanguage() {
    try {
      if (globalThis.browser && browser.i18n && browser.i18n.getUILanguage) {
        return normalise(browser.i18n.getUILanguage());
      }
    } catch (e) { /* browser namespace is optional in the test harness */ }
    try {
      return normalise(navigator.language);
    } catch (e) {
      return 'en';
    }
  }

  async function load(code) {
    if (!cache[code]) {
      const url = '../../_locales/' + code.replace('-', '_') + '/messages.json';
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error('locale ' + code + ' returned HTTP ' + response.status);
      const body = await response.json();
      cache[code] = Object.create(null);
      for (const [key, value] of Object.entries(body)) {
        cache[code][key] = value.message;
      }
    }
    return cache[code];
  }

  function t(key) {
    return (cache[language] && cache[language][key]) || key;
  }

  function interpolate(message, values) {
    return String(message).replace(/\{(\w+)\}/g, (match, key) =>
      values && values[key] !== undefined ? String(values[key]) : match
    );
  }

  async function init(requested) {
    const fallback = requested === 'auto' ? browserLanguage() : normalise(requested);
    const code = SUPPORTED.includes(fallback) ? fallback : 'en';
    if (!cache[code]) await load(code);
    language = code;
    return code;
  }

  function apply(root) {
    if (!root || !root.querySelectorAll) return;
    for (const node of root.querySelectorAll('[data-i18n]')) {
      node.textContent = t(node.getAttribute('data-i18n'));
    }
    for (const node of root.querySelectorAll('[data-i18n-title]')) {
      node.title = t(node.getAttribute('data-i18n-title'));
    }
    for (const node of root.querySelectorAll('[data-i18n-placeholder]')) {
      node.placeholder = t(node.getAttribute('data-i18n-placeholder'));
    }
    for (const node of root.querySelectorAll('[data-i18n-html]')) {
      node.innerHTML = t(node.getAttribute('data-i18n-html'));
    }
    if (root.documentElement) root.documentElement.lang = language;
    if (root.body) {
      root.body.dataset.i18nReady = 'true';
      root.body.dataset.i18nLanguage = language;
    }
  }

  globalThis.CTI18n = { SUPPORTED, normalise, browserLanguage, init, t, interpolate, apply };
}
