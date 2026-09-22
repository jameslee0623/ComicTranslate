/**
 * popup.js - toolbar UI.
 *
 * Talks to the background for settings/engines and to the active tab's content
 * script for per-page actions. Every tab message is wrapped because the content
 * script is legitimately absent on privileged pages (about:, AMO, PDF viewer).
 */
'use strict';

const els = {
  enabled: document.getElementById('enabled'),
  targetLang: document.getElementById('targetLang'),
  engineId: document.getElementById('engineId'),
  engineNote: document.getElementById('engine-note'),
  sitesSection: document.getElementById('sites-section'),
  siteLabel: document.getElementById('site-label'),
  siteToggle: document.getElementById('site-toggle'),
  scanNow: document.getElementById('scan-now'),
  restore: document.getElementById('restore'),
  status: document.getElementById('status'),
  pageState: document.getElementById('page-state'),
  openOptions: document.getElementById('open-options'),
  clearCache: document.getElementById('clear-cache')
};

let settings = null;
let engines = [];
let activeTab = null;
let currentHost = null;

async function bg(type, payload) {
  const reply = await browser.runtime.sendMessage(Object.assign({ type }, payload));
  if (!reply) throw new Error('no reply from background');
  if (!reply.ok) throw new Error(reply.error || 'background error');
  return reply.data;
}

async function toTab(type, payload) {
  if (!activeTab || typeof activeTab.id !== 'number') throw new Error('no active tab');
  try {
    return await browser.tabs.sendMessage(activeTab.id, Object.assign({ type }, payload));
  } catch (e) {
    // "Receiving end does not exist" has two very different causes:
    //   1. the page was open before the extension loaded or reloaded, so no
    //      content script is attached yet -> inject it on demand now;
    //   2. a content-script file failed to load on EVERY page (a syntax error,
    //      or a throw at load time) - onMessage never registers at all, and
    //      injection would throw the same error again; the page console names
    //      the offending file.
    // Cause 1 is common and purely mechanical (Chrome does not inject into
    // tabs that predate the extension load), so heal it automatically instead
    // of asking for F5.
    if (!/Receiving end does not exist/i.test(e.message || '')) throw e;
    if (!/^https?:/i.test(activeTab.url || '')) {
      throw new Error('No content script on this page (not a web page). (' + e.message + ')');
    }
    await healTab(activeTab.id);
    return await browser.tabs.sendMessage(activeTab.id, Object.assign({ type }, payload));
  }
}

/**
 * One-shot on-demand injection, matching manifest.json's content_scripts
 * exactly (same files, same order - the load order is a hard dependency:
 * compat/codec first, then the DOM modules, orchestrator last).
 */
let healInjected = false;
async function healTab(tabId) {
  const files = [
    'src/shared/compat.js',
    'src/shared/codec.js',
    'src/content/textLayout.js',
    'src/content/painter.js',
    'src/content/imageScanner.js',
    'src/content/replaceImage.js',
    'src/content/content.js'
  ];
  await browser.scripting.executeScript({ target: { tabId }, files });
  // content.js guards against double-injection (window.__comicTranslateLoaded),
  // so a stray second heal is harmless - but skip repeat work in one popup life.
  healInjected = true;
}

function setStatus(text) {
  els.status.textContent = text;
}

/**
 * One-line page summary. Includes the most recent failure reason, because a
 * bare count never says WHY an engine produced nothing - and "0 translated,
 * 1 failed" reads much the same whether the API rejected the request, the
 * quota ran out, or the OCR simply found no text.
 */
function pageSummary(status) {
  return `On this page: ${status.translated} translated, ` +
         `${status.stats.failed} failed, ${status.stats.skipped} skipped.` +
         (status.quotaStopped ? ' Stopped: Lara quota exhausted.' : '') +
         (status.lastError ? ' Last error: ' + status.lastError : '');
}

function fillLanguages(selected) {
  els.targetLang.textContent = '';
  for (const lang of globalThis.CT_LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = lang.code;
    opt.textContent = lang.label;
    if (lang.code === selected) opt.selected = true;
    els.targetLang.appendChild(opt);
  }
}

function fillEngines(selected) {
  els.engineId.textContent = '';
  for (const engine of engines) {
    const opt = document.createElement('option');
    opt.value = engine.id;
    opt.textContent = engine.label;
    if (engine.id === selected) opt.selected = true;
    els.engineId.appendChild(opt);
  }
  const current = engines.find((e) => e.id === els.engineId.value);
  // State the billing rule at SELECTION time. "10,000 characters per image" is
  // knowable up front, and it is exactly what silently empties a monthly quota:
  // 40 pages is ~400,000 characters, which is most of a Pro month.
  const NOTES = {
    lara: 'Official API. Each image bills a flat 10,000 characters, so 40 pages ' +
          'is ~400,000 - most of a Pro month. Needs credentials in Settings.',
    'lens-lara': 'Official API, text only, billed per character sent (a page is ' +
                 'usually 500-1,500). Needs credentials in Settings.',
    lens: 'No API key required. Undocumented Google endpoint that can change ' +
          'without notice.'
  };
  els.engineNote.textContent = current
    ? (NOTES[current.id] || (current.needsKey
        ? 'Requires an API key (see Settings).'
        : 'No API key required.'))
    : '';
}

async function save(patch) {
  const data = await bg('CT_SET_SETTINGS', { patch });
  settings = data.settings;
  return settings;
}

async function pushToTab() {
  try {
    return await toTab('CT_APPLY_STATE', { settings });
  } catch (e) {
    return { error: e.message };
  }
}

async function refreshPageState() {
  const data = await bg('CT_GET_SETTINGS');
  settings = data.settings;
  engines = data.engines;

  fillLanguages(settings.targetLang);
  fillEngines(settings.engineId);
  els.enabled.checked = !!settings.enabled;

  // Sites section: mirrors CTSettings.isAllowedOn so the popup always agrees
  // with what the content script actually decided.
  currentHost = null;
  try { currentHost = new URL(activeTab.url).hostname; } catch (e) { /* privileged page */ }
  const listed = !!currentHost && (settings.domains || []).some(
    (d) => currentHost === d || currentHost.endsWith('.' + d)
  );
  const mode = settings.domainMode;
  els.sitesSection.hidden = !currentHost || mode === 'all';
  // The promoted button: hidden on privileged pages, inert when the list
  // isn't what gates translation (mode 'all' means nothing to add/remove).
  els.siteToggle.hidden = !currentHost || mode === 'all';
  if (currentHost) {
    if (mode === 'blocklist') {
      els.siteLabel.textContent = listed
        ? currentHost + ' is on the block list (never translated).'
        : currentHost + ' is translated (not on the block list).';
      els.siteToggle.textContent = listed ? 'Remove from block list' : 'Block this site';
    } else {
      els.siteLabel.textContent = listed
        ? currentHost + ' is on the list (translated).'
        : currentHost + ' is NOT on the list, so it is not translated.';
      els.siteToggle.textContent = listed
        ? 'Remove ' + currentHost + ' from the translating list'
        : 'Add this site to the translating list';
    }
  }

  // Lara-billed engines get a month-to-date usage line against the cap.
  const usageEl = document.getElementById('lara-usage');
  if (settings.engineId === 'lara' || settings.engineId === 'lens-lara') {
    try {
      const u = await bg('CT_GET_USAGE');
      const cap = settings.laraMonthlyCap || 10000;
      usageEl.hidden = false;
      usageEl.textContent = 'Lara this month: ' + u.totalChars.toLocaleString() +
        ' / ' + cap.toLocaleString() + ' chars (' + u.textChars.toLocaleString() +
        ' text + ' + u.imageCount + ' image ×10k).';
    } catch {
      usageEl.hidden = true;
    }
  } else {
    usageEl.hidden = true;
  }

  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  activeTab = tabs[0];

  if (!activeTab || !activeTab.url) {
    els.pageState.textContent = 'No page available.';
    return;
  }
  let host = '';
  try { host = new URL(activeTab.url).hostname; } catch { /* privileged page */ }

  const check = await bg('CT_CHECK_PAGE', { url: activeTab.url });
  const isHttp = /^https?:/i.test(activeTab.url);
  if (!isHttp) {
    els.pageState.textContent = 'Not a web page — nothing to translate here.';
    els.pageState.className = 'muted warn';
  } else if (check.allowed) {
    els.pageState.textContent = 'Active on ' + host;
    els.pageState.className = 'muted';
  } else {
    els.pageState.textContent = settings.enabled
      ? 'Excluded on ' + host + ' (see Settings).'
      : 'Paused — turn on Enabled to start.';
    els.pageState.className = 'muted';
  }

  try {
    const status = await toTab('CT_GET_STATUS');
    if (status && status.stats) {
      setStatus(pageSummary(status));
    }
  } catch {
    setStatus('Reload the page to activate on it.');
  }
}

els.enabled.addEventListener('change', async () => {
  await save({ enabled: els.enabled.checked });
  const result = await pushToTab();
  if (result && result.error) setStatus(result.error);
  else setStatus(els.enabled.checked ? 'Translating this page…' : 'Restored and paused.');
});

els.targetLang.addEventListener('change', async () => {
  await save({ targetLang: els.targetLang.value });
  await pushToTab();
});

els.engineId.addEventListener('change', async () => {
  await save({ engineId: els.engineId.value });
  fillEngines(els.engineId.value);
});

els.siteToggle.addEventListener('click', async () => {
  if (!currentHost) return;
  const list = (settings.domains || []).slice();
  const i = list.indexOf(currentHost);
  if (i >= 0) list.splice(i, 1); else list.push(currentHost);
  await save({ domains: list });
  await refreshPageState();
  // Re-evaluate live: adding the site starts translation here, removing it
  // restores any translated images and stops.
  const result = await pushToTab();
  if (result && result.error) setStatus(result.error);
  else setStatus('Site list updated.');
});

els.scanNow.addEventListener('click', async () => {
  setStatus('Scanning…');
  try {
    await toTab('CT_SCAN_NOW');
    const status = await toTab('CT_GET_STATUS');
    setStatus(pageSummary(status));
  } catch (e) {
    setStatus(e.message);
  }
});

els.restore.addEventListener('click', async () => {
  try {
    const result = await toTab('CT_RESTORE');
    setStatus('Restored ' + (result ? result.restored : 0) + ' image(s).');
  } catch (e) {
    setStatus(e.message);
  }
});

els.openOptions.addEventListener('click', () => browser.runtime.openOptionsPage());

els.clearCache.addEventListener('click', async () => {
  await bg('CT_CACHE_CLEAR');
  setStatus('Cache cleared.');
});

refreshPageState().catch((e) => {
  els.pageState.textContent = 'Error: ' + e.message;
  els.pageState.className = 'muted warn';
});
