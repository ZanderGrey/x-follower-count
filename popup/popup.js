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

// ---------- diagnostics ----------

const diagBox = document.getElementById('diag-box');
const diagEl = document.getElementById('diag');
const verdictEl = document.getElementById('verdict');
const copyEl = document.getElementById('copy');
let diagText = '';

function verdictFor(d) {
  if (!d) return '当前标签页不是 x.com，或者装好插件后还没刷新页面。请打开 x.com 并刷新后再看。';
  if (!d.hook) return '页面脚本没有注入。请确认 Chrome 版本 ≥ 111，并刷新 x.com。';
  if (!d.enabled) return '插件已被关闭，勾选上方"启用"即可。';
  if (d.apiResponses === 0) return '没有拦截到 X 的接口数据。刷新页面并往下滚动几屏后再看。';
  if (d.usersFromApi === 0) return '拦截到了接口数据，但没有解析出粉丝数（X 可能改了数据格式）。';
  if (d.tweets + d.cells === 0) return '有粉丝数据，但页面上找不到推文元素（X 可能改了页面结构）。';
  if (d.avatars === 0) return '找到了推文，但找不到头像元素（X 可能改了页面结构）。';
  if (d.badges === 0) return '头像和数据都有，但没能显示出来。';
  return '工作正常。';
}

function showDiag(d) {
  verdictEl.textContent = verdictFor(d);
  const rows = d
    ? [
        ['页面脚本已注入', d.hook ? '是' : '否'],
        ['拦截到的接口响应', d.apiResponses],
        ['解析出的用户条目', d.usersFromApi],
        ['已知粉丝数的用户', d.known],
        ['页面上的推文 / 用户卡片', `${d.tweets} / ${d.cells}`],
        ['识别到的头像', d.avatars],
        ['已显示的徽标', d.badges],
        ['没有数据的头像', d.missing.join(', ') || '-'],
        ['已知用户示例', d.sampleKnown.join(', ') || '-'],
      ]
    : [];
  diagEl.replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = k;
      dd.textContent = String(v);
      return [dt, dd];
    })
  );
  diagText = `${verdictEl.textContent}\n${JSON.stringify(d)}\nChrome ${navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || '?'}`;
  if (d && (!d.hook || d.badges === 0)) diagBox.open = true;
  if (!d) diagBox.open = true;
}

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab) return showDiag(null);
  chrome.tabs.sendMessage(tab.id, { type: 'xfc:diag' }, (resp) => {
    void chrome.runtime.lastError; // No content script in this tab.
    showDiag(resp || null);
  });
});

copyEl.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(diagText);
    copyEl.textContent = '已复制';
  } catch {
    copyEl.textContent = '复制失败';
  }
});
