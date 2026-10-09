// Runs in the extension's isolated world. Receives follower counts from
// page-hook.js, caches them, and draws a badge next to each author's avatar
// (or @handle) in tweets and user lists.
(() => {
  const MSG_TYPE = 'xfc:users';
  const CACHE_KEY = 'xfcCache';
  const SETTINGS_KEY = 'xfcSettings';
  const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
  const CACHE_MAX = 5000;
  const DEFAULT_SETTINGS = { enabled: true, position: 'avatar' };

  const AVATAR_PREFIX = 'UserAvatar-Container-';
  const AVATAR_SEL = `[data-testid^="${AVATAR_PREFIX}"]`;
  const SCOPE_SEL = 'article[data-testid="tweet"], [data-testid="UserCell"]';
  const SMALL_AVATAR_PX = 28;

  /** screen_name (lowercase) -> { c: followers, t: last seen ms } */
  const counts = new Map();
  let settings = { ...DEFAULT_SETTINGS };
  /** avatar element -> { badge, count } */
  let placed = new WeakMap();

  // ---------- data ----------

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.type !== MSG_TYPE || !Array.isArray(d.users)) return;
    const now = Date.now();
    let changed = false;
    for (const pair of d.users) {
      if (!Array.isArray(pair)) continue;
      const [name, c] = pair;
      if (typeof name !== 'string' || typeof c !== 'number' || !Number.isFinite(c)) continue;
      const prev = counts.get(name);
      if (!prev || prev.c !== c) changed = true;
      counts.set(name, { c, t: now });
    }
    scheduleSave();
    if (changed) scheduleRender();
  });

  function storage() {
    try {
      return chrome.runtime?.id ? chrome.storage.local : null;
    } catch {
      return null; // Extension was reloaded; this content script is orphaned.
    }
  }

  storage()?.get([CACHE_KEY, SETTINGS_KEY], (r) => {
    settings = { ...DEFAULT_SETTINGS, ...(r[SETTINGS_KEY] || {}) };
    const now = Date.now();
    for (const [name, v] of Object.entries(r[CACHE_KEY] || {})) {
      if (v && typeof v.c === 'number' && now - v.t < CACHE_TTL_MS && !counts.has(name)) {
        counts.set(name, v);
      }
    }
    scheduleRender();
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[SETTINGS_KEY]) {
        settings = { ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) };
        resetBadges();
      }
      if (CACHE_KEY in changes && !changes[CACHE_KEY].newValue) {
        // Cache cleared from the popup.
        counts.clear();
        resetBadges();
      }
    });
  } catch {
    // Ignore.
  }

  let saveTimer = 0;
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      const store = storage();
      if (!store) return;
      const now = Date.now();
      const fresh = [...counts].filter(([, v]) => now - v.t < CACHE_TTL_MS);
      fresh.sort((a, b) => b[1].t - a[1].t);
      // Merge with what other tabs saved so tabs don't overwrite each other.
      store.get(CACHE_KEY, (r) => {
        const merged = { ...(r?.[CACHE_KEY] || {}) };
        for (const [name, v] of fresh.slice(0, CACHE_MAX)) {
          if (!merged[name] || merged[name].t <= v.t) merged[name] = v;
        }
        const entries = Object.entries(merged)
          .filter(([, v]) => now - v.t < CACHE_TTL_MS)
          .sort((a, b) => b[1].t - a[1].t)
          .slice(0, CACHE_MAX);
        store.set({ [CACHE_KEY]: Object.fromEntries(entries) });
      });
    }, 2000);
  }

  // ---------- rendering ----------

  let numberFormat = null;
  function formatCount(n) {
    if (!numberFormat) {
      const lang = document.documentElement.lang || navigator.language || 'en';
      try {
        numberFormat = new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 1 });
      } catch {
        numberFormat = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
      }
    }
    return numberFormat.format(n);
  }

  function tierClass(n) {
    if (n >= 1_000_000) return 'xfc-t4';
    if (n >= 100_000) return 'xfc-t3';
    if (n >= 10_000) return 'xfc-t2';
    return 'xfc-t1';
  }

  function makeBadge(count, mode) {
    const badge = document.createElement('span');
    badge.className = `xfc-badge xfc-${mode} ${tierClass(count)}`;
    badge.textContent = formatCount(count);
    badge.title = `粉丝：${count.toLocaleString()}`;
    return badge;
  }

  function screenNameOf(avatar) {
    const id = avatar.getAttribute('data-testid') || '';
    if (id.length > AVATAR_PREFIX.length) return id.slice(AVATAR_PREFIX.length).toLowerCase();
    const href = avatar.querySelector('a[href^="/"]')?.getAttribute('href') || '';
    const m = href.match(/^\/([A-Za-z0-9_]{1,15})(?:$|[/?#])/);
    return m ? m[1].toLowerCase() : '';
  }

  // Finds the "@handle" text belonging to this author inside the tweet/cell.
  function findHandle(scope, name) {
    const target = `@${name}`;
    const areas = scope.querySelectorAll('[data-testid="User-Name"]');
    const roots = areas.length ? areas : [scope];
    for (const root of roots) {
      for (const span of root.querySelectorAll('span')) {
        if (span.childElementCount === 0 && span.textContent.trim().toLowerCase() === target) {
          const next = span.nextElementSibling;
          if (!next || !next.classList.contains('xfc-badge')) return span;
        }
      }
    }
    return null;
  }

  function placeBadge(avatar, name, count) {
    const scope = avatar.closest(SCOPE_SEL);
    if (!scope) return null;
    let mode = settings.position === 'name' ? 'name' : 'avatar';
    if (mode === 'avatar' && avatar.offsetWidth > 0 && avatar.offsetWidth < SMALL_AVATAR_PX) {
      mode = 'name'; // e.g. quoted tweets: too small to hang a badge under.
    }
    if (mode === 'avatar') {
      if (getComputedStyle(avatar).position === 'static') avatar.style.position = 'relative';
      const badge = makeBadge(count, mode);
      avatar.appendChild(badge);
      return badge;
    }
    const handle = findHandle(scope, name);
    if (!handle) return null;
    const badge = makeBadge(count, mode);
    handle.after(badge);
    return badge;
  }

  function render() {
    if (!settings.enabled) return;
    for (const avatar of document.querySelectorAll(AVATAR_SEL)) {
      if (avatar.closest('.xfc-badge')) continue;
      const name = screenNameOf(avatar);
      const entry = name && counts.get(name);
      if (!entry) continue;
      const prev = placed.get(avatar);
      if (prev && prev.badge.isConnected) {
        if (prev.count === entry.c) continue;
        prev.badge.remove();
      }
      if (!avatar.closest(SCOPE_SEL)) continue;
      const badge = placeBadge(avatar, name, entry.c);
      if (badge) placed.set(avatar, { badge, count: entry.c });
    }
  }

  function resetBadges() {
    for (const b of document.querySelectorAll('.xfc-badge')) b.remove();
    placed = new WeakMap();
    scheduleRender();
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  new MutationObserver(scheduleRender).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
