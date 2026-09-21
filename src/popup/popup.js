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
  renderMode: document.getElementById('renderMode'),
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
    // The overwhelmingly common cause is that the page was already open when the
    // extension was loaded or reloaded; content scripts only run on page load.
    throw new Error('Reload the page (F5), then try again. (' + e.message + ')');
  }
}

function setStatus(text) {
  els.status.textContent = text;
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
  els.engineNote.textContent = current
    ? (current.needsKey ? 'Requires an API key (see Settings).'
                        : 'No API key required. Undocumented Google endpoint.')
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
  els.renderMode.value = settings.renderMode;

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
      setStatus(`On this page: ${status.translated} translated, ` +
                `${status.stats.failed} failed, ${status.stats.skipped} skipped.`);
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

els.renderMode.addEventListener('change', async () => {
  await save({ renderMode: els.renderMode.value });
});

els.scanNow.addEventListener('click', async () => {
  setStatus('Scanning…');
  try {
    await toTab('CT_SCAN_NOW');
    const status = await toTab('CT_GET_STATUS');
    setStatus(`On this page: ${status.translated} translated, ` +
              `${status.stats.failed} failed, ${status.stats.skipped} skipped.`);
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
