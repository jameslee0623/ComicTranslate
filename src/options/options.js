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
  'laraAccessKeyId', 'laraAccessKeySecret', 'laraModel', 'laraMonthlyCap'
];
const CHECKBOXES = ['textStroke', 'scanBackgrounds', 'debug'];

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
        ? 'Paid API, official and stable. Each image bills a FLAT 10,000 characters, ' +
          'so Pro (500,000/month) covers about 50 pages - watch the usage panel ' +
          'below. Enter credentials, then use "Test Lara credentials".'
        : current.id === 'lens-lara'
          ? 'Free anonymous Lens OCR finds the boxes; only the text goes to Lara, ' +
            'billed by the characters actually sent (a manga page is usually ' +
            '500-1,500) - so the 10,000 chars/month of API access on the free plan ' +
            'covers roughly 10-20 pages. Same Lara credentials below.'
          : current.needsKey
            ? 'This engine needs an API key before it will work.'
            : 'No API key needed. Uses an undocumented Google endpoint that can change ' +
              'without notice.')
    : '';
  el('lara-fields').hidden = !(current &&
    (current.id === 'lara' || current.id === 'lens-lara'));
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
    text.textContent =
      u.textChars.toLocaleString() + ' text chars + ' + u.imageCount +
      ' image(s) ×10,000 = ' + u.totalChars.toLocaleString() + ' / ' +
      cap.toLocaleString() + ' chars' +
      (u.totalChars > cap ? ' — over the reference cap' : ' this month');
  } catch (e) {
    text.textContent = 'Could not load usage: ' + e.message;
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

// Changing the cap reference re-renders the usage bar immediately.
el('laraMonthlyCap').addEventListener('change', () => renderUsage());

el('reset-usage').addEventListener('click', async () => {
  await bg('CT_RESET_USAGE');
  await renderUsage();
  flash('Usage counter reset.');
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

load().catch((e) => { saveState.textContent = 'Could not load settings: ' + e.message; });
