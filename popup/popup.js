const DEFAULTS = { enabled: true, showVpn: true, intervalSec: 1, ttlDays: 14 };
const $ = (id) => document.getElementById(id);
const t = (key, subs) => chrome.i18n.getMessage(key, subs);

document.documentElement.lang = chrome.i18n.getUILanguage();
document.title = t('actionTitle');
for (const el of document.querySelectorAll('[data-i18n]')) {
  el.textContent = t(el.dataset.i18n);
}

async function load() {
  const all = await chrome.storage.local.get(null);
  const s = { ...DEFAULTS, ...(all.settings || {}) };
  $('enabled').checked = s.enabled;
  $('showVpn').checked = s.showVpn;
  $('intervalSec').value = s.intervalSec;
  $('ttlDays').value = s.ttlDays;

  const count = Object.keys(all).filter((k) => k.startsWith('u:')).length;
  $('count').textContent = t('popupCached', [String(count)]);

  const st = all.status || {};
  if (st.rateLimitedUntil && st.rateLimitedUntil > Date.now()) {
    $('state').textContent = t('popupRateLimited', [new Date(st.rateLimitedUntil).toLocaleTimeString()]);
  } else if (st.lastOkAt) {
    $('state').textContent = t('popupLastFetched', [new Date(st.lastOkAt).toLocaleString()]);
  } else {
    $('state').textContent = '';
  }
  $('error').textContent = st.lastError ? t('popupLastError', [st.lastError]) : '';
}

async function save() {
  const settings = {
    enabled: $('enabled').checked,
    showVpn: $('showVpn').checked,
    intervalSec: Math.max(0.5, Number($('intervalSec').value) || DEFAULTS.intervalSec),
    ttlDays: Math.max(1, Number($('ttlDays').value) || DEFAULTS.ttlDays),
  };
  await chrome.storage.local.set({ settings });
}

for (const id of ['enabled', 'showVpn', 'intervalSec', 'ttlDays']) {
  $(id).addEventListener('change', save);
}

$('clear').addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('u:'));
  await chrome.storage.local.remove(keys);
  await chrome.storage.local.set({ cacheClearedAt: Date.now() });
  load();
});

load();
