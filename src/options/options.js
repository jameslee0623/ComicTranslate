/**
 * options.js - settings page.
 *
 * Every control writes through to the background as it changes, and any tab
 * that is already open is told to re-apply state. There is no explicit save
 * button because there is nothing here that benefits from a draft state.
 */
'use strict';

const FIELDS = [
  'sourceLang', 'targetLang', 'engineId', 'fontFamily',
  'minImageSize', 'maxImagesPerPage', 'requestDelayMs',
  'cacheTtlDays', 'domainMode',
  'laraAccessKeyId', 'laraAccessKeySecret', 'laraModel', 'laraMonthlyCap',
  'localTextUrl', 'localTextApiKey'
];
const CHECKBOXES = ['textStroke', 'scanBackgrounds', 'debug'];

let optionEngines = [];
let uiLanguage = 'en';

const saveState = document.getElementById('save-state');

function el(id) { return document.getElementById(id); }

function t(key) {
  return CTI18n.t(key);
}

function tr(key, fallback) {
  const value = t(key);
  return value === key ? fallback : value;
}

function msg(key, values) {
  return CTI18n.interpolate(t(key), values);
}

async function bg(type, payload) {
  const reply = await browser.runtime.sendMessage(Object.assign({ type }, payload));
  if (!reply) throw new Error('no reply from background');
  if (!reply.ok) throw new Error(reply.error || 'background error');
  return reply.data;
}

function fillLanguageSelects(sourceLang, targetLang) {
  const addOptions = (select, includeAuto) => {
    select.textContent = '';
    if (includeAuto) {
      const auto = document.createElement('option');
      auto.value = 'auto';
      auto.textContent = t('options_detect_auto');
      select.appendChild(auto);
    }
    for (const lang of globalThis.CT_LANGUAGES) {
      const opt = document.createElement('option');
      opt.value = lang.code;
      opt.textContent = lang.label;
      select.appendChild(opt);
    }
  };
  addOptions(el('sourceLang'), true);
  el('sourceLang').value = sourceLang;
  addOptions(el('targetLang'), false);
  el('targetLang').value = targetLang;
}

function fillEngines(engines, selected) {
  optionEngines = engines;
  const sel = el('engineId');
  sel.textContent = '';
  for (const engine of engines) {
    const opt = document.createElement('option');
    opt.value = engine.id;
    const key = 'engine_' + engine.id.replace(/-/g, '_');
    opt.textContent = tr(key, engine.label || engine.id);
    sel.appendChild(opt);
  }
  sel.value = selected;
  const current = engines.find((e) => e.id === selected);
  const noteKey = current && (
    current.id === 'lara' ? 'engine_note_lara' :
    current.id === 'lens-lara' ? 'engine_note_lens_lara' :
    current.id === 'lens-local' ? 'engine_note_lens_local' :
    current.needsKey ? 'engine_note_needs_key' : 'engine_note_none_needed'
  );
  el('engine-note').textContent = noteKey ? t(noteKey) : '';
  el('lara-fields').hidden = !(current &&
    (current.id === 'lara' || current.id === 'lens-lara'));
  el('lens-local-fields').hidden = !(current && current.id === 'lens-local');
}

/** Push new settings to every open tab so behaviour updates immediately. */
async function broadcast(settings) {
  const tabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(tabs.map((tab) =>
    browser.tabs.sendMessage(tab.id, { type: 'CT_APPLY_STATE', settings }).catch(() => {})
  ));
}

function flash(text) {
  saveState.textContent = text;
  setTimeout(() => { saveState.textContent = t('options_save_notice'); }, 1500);
}

async function applyLanguage(requested) {
  try {
    uiLanguage = await CTI18n.init(requested || 'auto');
  } catch (e) {
    uiLanguage = 'en';
  }
  CTI18n.apply(document);
}

async function save(patch) {
  const data = await bg('CT_SET_SETTINGS', { patch });
  flash(t('options_saved'));
  broadcast(data.settings);
  return data.settings;
}

async function load() {
  const data = await bg('CT_GET_SETTINGS');
  const s = data.settings;

  el('uiLanguage').value = s.uiLanguage || 'auto';
  await applyLanguage(s.uiLanguage || 'auto');
  fillLanguageSelects(s.sourceLang, s.targetLang);
  fillEngines(data.engines, s.engineId);
  el('fontFamily').value = s.fontFamily || '';
  el('minImageSize').value = s.minImageSize;
  el('maxImagesPerPage').value = s.maxImagesPerPage;
  el('requestDelayMs').value = s.requestDelayMs;
  el('cacheTtlDays').value = s.cacheTtlDays;
  el('domainMode').value = s.domainMode;
  el('domains').value = (s.domains || []).join('\n');
  el('laraAccessKeyId').value = s.laraAccessKeyId || '';
  el('laraAccessKeySecret').value = s.laraAccessKeySecret || '';
  el('laraModel').value = s.laraModel || 'inpainting';
  el('laraMonthlyCap').value = s.laraMonthlyCap || 10000;
  el('localTextUrl').value = s.localTextUrl || '';
  el('localTextApiKey').value = s.localTextApiKey || '';
  for (const key of CHECKBOXES) el(key).checked = !!s[key];
  renderUsage();
}

/** Month-to-date Lara usage against the reference cap. */
async function renderUsage() {
  const text = el('ct-usage-text');
  const fill = el('ct-usage-fill');
  try {
    const u = await bg('CT_GET_USAGE');
    const cap = Number(el('laraMonthlyCap').value) || 10000;
    fill.style.width = Math.min(100, (u.totalChars / cap) * 100).toFixed(1) + '%';
    fill.classList.toggle('over', u.totalChars > cap);
    text.textContent = msg('options_usage_details', {
      text: u.textChars.toLocaleString(),
      images: u.imageCount,
      total: u.totalChars.toLocaleString(),
      cap: cap.toLocaleString()
    });
  } catch (e) {
    text.textContent = t('options_usage_error') + e.message;
  }
}

for (const id of FIELDS) {
  el(id).addEventListener('change', () => {
    const node = el(id);
    const patch = {};
    patch[id] = node.type === 'number' ? Number(node.value) : node.value;
    save(patch);
  });
}

for (const id of CHECKBOXES) {
  el(id).addEventListener('change', () => save({ [id]: el(id).checked }));
}

el('uiLanguage').addEventListener('change', async () => {
  const saved = await save({ uiLanguage: el('uiLanguage').value });
  await applyLanguage(saved.uiLanguage);
  fillLanguageSelects(el('sourceLang').value, el('targetLang').value);
  fillEngines(optionEngines, el('engineId').value);
  await renderUsage();
});

el('domains').addEventListener('change', () => {
  const domains = el('domains').value
    .split('\n')
    .map((line) => line.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean);
  el('domains').value = domains.join('\n');
  save({ domains });
});

el('clear-cache').addEventListener('click', async () => {
  await bg('CT_CACHE_CLEAR');
  saveState.textContent = t('options_cache_cleared_msg');
});

// Changing the cap reference re-renders the usage bar immediately.
el('laraMonthlyCap').addEventListener('change', () => renderUsage());

el('reset-usage').addEventListener('click', async () => {
  await bg('CT_RESET_USAGE');
  await renderUsage();
  flash(t('options_counter_reset'));
});

el('lara-probe').addEventListener('click', async () => {
  const note = el('lara-probe-result');
  note.textContent = t('options_testing_creds');
  try {
    // Save first: the probe authenticates with whatever is in the fields now.
    await save({
      laraAccessKeyId: el('laraAccessKeyId').value.trim(),
      laraAccessKeySecret: el('laraAccessKeySecret').value.trim()
    });
    const data = await bg('CT_LARA_PROBE');
    const when = data.expiresAt ? new Date(data.expiresAt).toLocaleString() : t('options_unknown');
    note.textContent = t('options_creds_valid') + when + '.';
  } catch (e) {
    note.textContent = t('options_creds_invalid') + e.message;
  }
});

el('engineId').addEventListener('change', () => {
  // Re-render the engine note + field visibility without waiting for a reload:
  // the select already holds the new id, so rebuild from the last-known list.
  save({ engineId: el('engineId').value }).then((s) => {
    bg('CT_GET_SETTINGS').then((data) => fillEngines(data.engines, s.engineId))
      .catch(() => {});
  });
});

el('lens-local-probe').addEventListener('click', async () => {
  const note = el('lens-local-probe-result');
  note.textContent = t('options_testing');
  try {
    // Save first: the probe talks to whatever URL is in the field now. It sends
    // no page text - only an empty request that proves the server is listening.
    await save({ localTextUrl: el('localTextUrl').value.trim() });
    const data = await bg('CT_LOCAL_TEXT_PROBE');
    if (data.status === 404 || data.status === 405) {
      note.textContent = msg('options_server_bad_method', { status: data.status });
    } else {
      note.textContent = msg('options_server_reachable_detail', { status: data.status });
    }
  } catch (e) {
    note.textContent = t('options_server_failed') + e.message;
  }
});

load().catch((e) => { saveState.textContent = t('options_load_error') + e.message; });
