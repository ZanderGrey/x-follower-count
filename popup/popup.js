// Extension popup: settings, cache size, and diagnostics for the current tab.
(() => {
  const { STORAGE_KEYS, DEFAULT_SETTINGS, MESSAGE } = globalThis.XFC;
  const MAX_ENDPOINT_ROWS = 8;

  const $ = (id) => document.getElementById(id);
  const enabledInput = $('enabled');
  const positionInputs = [...document.querySelectorAll('input[name="position"]')];
  const cacheStats = $('stats');
  const clearButton = $('clear');
  const diagBox = $('diag-box');
  const diagList = $('diag');
  const verdictText = $('verdict');
  const copyButton = $('copy');

  let settings = { ...DEFAULT_SETTINGS };
  let diagReport = '';

  // ---------- settings & cache ----------

  function showCacheSize(cache) {
    cacheStats.textContent = `已缓存 ${Object.keys(cache || {}).length} 位用户`;
  }

  function saveSettings() {
    chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  }

  function loadSettings() {
    chrome.storage.local.get([STORAGE_KEYS.cache, STORAGE_KEYS.settings], (r) => {
      settings = { ...DEFAULT_SETTINGS, ...r[STORAGE_KEYS.settings] };
      enabledInput.checked = settings.enabled;
      for (const input of positionInputs) input.checked = input.value === settings.position;
      showCacheSize(r[STORAGE_KEYS.cache]);
    });
  }

  enabledInput.addEventListener('change', () => {
    settings.enabled = enabledInput.checked;
    saveSettings();
  });

  for (const input of positionInputs) {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      settings.position = input.value;
      saveSettings();
    });
  }

  clearButton.addEventListener('click', () => {
    chrome.storage.local.remove(STORAGE_KEYS.cache, () => showCacheSize({}));
  });

  // ---------- diagnostics ----------

  function verdictFor(d) {
    if (!d) return '当前标签页不是 x.com，或者装好插件后还没刷新页面。请打开 x.com 并刷新后再看。';
    if (!d.hook) return '页面脚本没有注入。请确认 Chrome 版本 ≥ 111，并刷新 x.com。';
    if (!d.enabled) return '插件已被关闭，勾选上方"启用"即可。';
    if (d.apiResponses === 0) return '没有拦截到 X 的接口数据。刷新页面并往下滚动几屏后再看。';
    if (d.usersFromApi < 5 && d.apiResponses >= 10) {
      return '拦截到了很多接口数据，但几乎没解析出粉丝数。请点下方按钮复制诊断信息发给开发者。';
    }
    if (d.usersFromApi === 0) return '拦截到了接口数据，但没有解析出粉丝数（X 可能改了数据格式）。';
    if (d.tweets + d.cells === 0) return '有粉丝数据，但页面上找不到推文元素（X 可能改了页面结构）。';
    if (d.avatars === 0) return '找到了推文，但找不到头像元素（X 可能改了页面结构）。';
    if (d.badges === 0) return '头像和数据都有，但没能显示出来。';
    if (d.missing.length) {
      return '部分头像还没有数据，往下滚动或刷新后会补上；一直没有的话请复制诊断信息发给开发者。';
    }
    return '工作正常。';
  }

  function diagRows(d) {
    if (!d) return [];
    const endpointRows = (d.page?.endpoints || []).slice(0, MAX_ENDPOINT_ROWS).map((e) => {
      const nonJson = e.nonJson ? ` / ${e.nonJson} 非JSON` : '';
      return [`接口 ${e.name}`, `${e.n} 次 / ${e.users} 人${nonJson}`];
    });
    return [
      ['页面脚本已注入', d.hook ? '是' : '否'],
      ['拦截到的接口响应', d.apiResponses],
      ['解析出的用户条目', d.usersFromApi],
      ['已知粉丝数的用户', d.known],
      ['页面上的推文 / 用户卡片', `${d.tweets} / ${d.cells}`],
      ['识别到的头像', d.avatars],
      ['已显示的徽标', d.badges],
      ['没有数据的头像', d.missing.join(', ') || '-'],
      ['已知用户示例', d.sampleKnown.join(', ') || '-'],
      ...endpointRows,
    ];
  }

  function showDiagnostics(d) {
    verdictText.textContent = verdictFor(d);
    diagList.replaceChildren(
      ...diagRows(d).flatMap(([label, value]) => {
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = label;
        dd.textContent = String(value);
        return [dt, dd];
      })
    );

    const chromeVersion = navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || '?';
    diagReport = `${verdictText.textContent}\n${JSON.stringify(d)}\nChrome ${chromeVersion}`;

    // Expand automatically when something looks wrong.
    if (!d || !d.hook || d.badges < d.avatars / 2) diagBox.open = true;
  }

  function loadDiagnostics() {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab) return showDiagnostics(null);
      chrome.tabs.sendMessage(tab.id, { type: MESSAGE.diagnose }, (response) => {
        void chrome.runtime.lastError; // Expected when the tab has no content script.
        showDiagnostics(response || null);
      });
    });
  }

  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(diagReport);
      copyButton.textContent = '已复制';
    } catch {
      copyButton.textContent = '复制失败';
    }
  });

  loadSettings();
  loadDiagnostics();
})();
