const CACHE_KEY = 'xfcCache';
const SETTINGS_KEY = 'xfcSettings';
const DEFAULT_SETTINGS = { enabled: true, position: 'avatar' };

const enabledEl = document.getElementById('enabled');
const statsEl = document.getElementById('stats');
const clearEl = document.getElementById('clear');
const positionEls = [...document.querySelectorAll('input[name="position"]')];

let settings = { ...DEFAULT_SETTINGS };

function showStats(cache) {
  statsEl.textContent = `已缓存 ${Object.keys(cache || {}).length} 位用户`;
}

function save() {
  chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

chrome.storage.local.get([CACHE_KEY, SETTINGS_KEY], (r) => {
  settings = { ...DEFAULT_SETTINGS, ...(r[SETTINGS_KEY] || {}) };
  enabledEl.checked = settings.enabled;
  for (const el of positionEls) el.checked = el.value === settings.position;
  showStats(r[CACHE_KEY]);
});

enabledEl.addEventListener('change', () => {
  settings.enabled = enabledEl.checked;
  save();
});

for (const el of positionEls) {
  el.addEventListener('change', () => {
    if (!el.checked) return;
    settings.position = el.value;
    save();
  });
}

clearEl.addEventListener('click', () => {
  chrome.storage.local.remove(CACHE_KEY, () => showStats({}));
});
