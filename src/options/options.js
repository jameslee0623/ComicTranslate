/**
 * options.js - settings page.
 *
 * Every control writes through to the background as it changes, and any tab
 * that is already open is told to re-apply state. There is no explicit save
 * button because there is nothing here that benefits from a draft state.
 */
'use strict';

const FIELDS = [
  'sourceLang', 'targetLang', 'engineId', 'renderMode', 'fontFamily',
  'minImageSize', 'maxImagesPerPage', 'requestDelayMs',
  'cacheTtlDays', 'domainMode',
  'laraAccessKeyId', 'laraAccessKeySecret', 'laraModel'
];
const CHECKBOXES = ['textStroke', 'scanBackgrounds', 'debug'];

const out = document.getElementById('diag-output');
const saveState = document.getElementById('save-state');

function el(id) { return document.getElementById(id); }

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
      auto.textContent = 'Detect automatically';
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
  const sel = el('engineId');
  sel.textContent = '';
  for (const engine of engines) {
    const opt = document.createElement('option');
    opt.value = engine.id;
    opt.textContent = engine.label;
    sel.appendChild(opt);
  }
  sel.value = selected;
  const current = engines.find((e) => e.id === selected);
  el('engine-note').textContent = current
    ? (current.id === 'lara'
        ? 'Paid API. Enter your credentials below, then use "Test Lara credentials".'
        : current.needsKey
          ? 'This engine needs an API key before it will work.'
          : 'No API key needed. Uses an undocumented Google endpoint that can change ' +
            'without notice.')
    : '';
  el('lara-fields').hidden = !(current && current.id === 'lara');
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
  setTimeout(() => { saveState.textContent = 'Changes save as you edit.'; }, 1500);
}

async function save(patch) {
  const data = await bg('CT_SET_SETTINGS', { patch });
  flash('Saved.');
  broadcast(data.settings);
  return data.settings;
}

async function load() {
  const data = await bg('CT_GET_SETTINGS');
  const s = data.settings;

  fillLanguageSelects(s.sourceLang, s.targetLang);
  fillEngines(data.engines, s.engineId);
  el('renderMode').value = s.renderMode;
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
  for (const key of CHECKBOXES) el(key).checked = !!s[key];
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
  out.textContent = 'Cache cleared.';
});

el('lara-probe').addEventListener('click', async () => {
  const note = el('lara-probe-result');
  note.textContent = 'Checking…';
  try {
    // Save first: the probe authenticates with whatever is in the fields now.
    await save({
      laraAccessKeyId: el('laraAccessKeyId').value.trim(),
      laraAccessKeySecret: el('laraAccessKeySecret').value.trim()
    });
    const data = await bg('CT_LARA_PROBE');
    const when = data.expiresAt ? new Date(data.expiresAt).toLocaleString() : 'unknown';
    note.textContent = 'Credentials accepted. Token expires ' + when + '.';
  } catch (e) {
    note.textContent = 'Failed: ' + e.message;
  }
});

el('list-candidates').addEventListener('click', async () => {
  out.textContent = 'Looking for images on your most recently used web page...';
  try {
    // Resolved in the background, NOT with tabs.query({active:true}) here: this
    // options page is itself a tab, so "active tab" would be this page, and
    // content scripts do not exist on moz-extension:// URLs.
    const data = await bg('CT_LIST_CANDIDATES', { limit: 20 });
    const header = 'tab: ' + (data.tabTitle || '(untitled)') + '\n     ' +
                   (data.tabUrl || '(unknown)') + '\n\n';
    const candidates = data.candidates || [];
    out.textContent = header + (candidates.length
      ? candidates.map((c, i) =>
          `[${i}] ${c.width}x${c.height} ${c.type} seen=${c.seen}\n     ${c.url}`).join('\n')
      : 'No candidate images found. Scroll the page so the images load, then retry.');
  } catch (e) {
    out.textContent = 'Failed: ' + e.message;
  }
});

el('run-diagnostic').addEventListener('click', async () => {
  out.textContent = 'Running the full engine on one image… this uploads the ' +
    'image to the configured engine (Google Lens, or Lara — a paid API).';
  const started = Date.now();
  try {
    const data = await bg('CT_LENS_DIAGNOSE', { index: Number(el('diagIndex').value) || 0 });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    if (data.error) {
      out.textContent = data.error + '\n\ntab: ' + (data.tabUrl || '(unknown)') +
        '\n\nCandidates:\n' +
        (data.candidates || []).map((c, i) => `[${i}] ${c.width}x${c.height} ${c.url}`).join('\n');
      return;
    }

    const result = data.result || {};
    const summary = [
      `took ${seconds}s`,
      `tab: ${data.tabUrl}`,
      `target: ${data.target.width}x${data.target.height} ${data.target.url}`,
      `engineId: ${result.engineId}`,
      `via: ${result.via}`,
      `cached: ${result.cached}`,
      result.image
        ? `image: ${result.image.bytesLen} bytes, ${result.image.mime}`
        : `regions: ${(result.regions || []).length}`,
      'diagnostics:',
      JSON.stringify(result.diagnostics || null, null, 2)
    ].join('\n');

    const regions = (result.regions || []).map((r, i) =>
      `[${i}] bbox=${r.bbox.x},${r.bbox.y},${r.bbox.w}x${r.bbox.h} ` +
      `text=${JSON.stringify(r.text)} translated=${JSON.stringify(r.translated)}`
    ).join('\n');

    out.textContent = summary +
      (result.image ? '' : '\n\n--- regions ---\n' + (regions || '(none)'));
  } catch (e) {
    out.textContent = 'Diagnostic failed: ' + e.message;
  }
});

load().catch((e) => { out.textContent = 'Could not load settings: ' + e.message; });
