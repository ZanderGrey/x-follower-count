// Runs in the extension's isolated world. Receives follower counts from
// page-hook.js, caches them, and draws a badge next to each author's avatar
// (or @handle) in tweets and user lists.
(() => {
  const { STORAGE_KEYS, DEFAULT_SETTINGS, CACHE_TTL_MS, CACHE_MAX_ENTRIES, MESSAGE } = globalThis.XFC;

  const SAVE_DELAY_MS = 2000;
  const PAGE_STATS_TIMEOUT_MS = 500;
  const SMALL_AVATAR_PX = 28;

  const BADGE_CLASS = 'xfc-badge';
  const HOOK_ATTR = 'data-xfc-hook';
  const AVATAR_PREFIX = 'UserAvatar-Container-';
  const USER_AVATAR_SEL = `[data-testid^="${AVATAR_PREFIX}"]`;
  // Fallback in case the per-user container testid changes; skipped when it
  // wraps a per-user container.
  const TWEET_AVATAR_SEL = '[data-testid="Tweet-User-Avatar"]';
  const AVATAR_SEL = `${USER_AVATAR_SEL}, ${TWEET_AVATAR_SEL}`;
  const TWEET_SEL = 'article[data-testid="tweet"]';
  const USER_CELL_SEL = '[data-testid="UserCell"]';
  const SCOPE_SEL = `${TWEET_SEL}, ${USER_CELL_SEL}`;
  const USER_NAME_SEL = '[data-testid="User-Name"]';

  /** screen_name (lowercase) -> { c: followers, t: last seen ms } */
  const counts = new Map();
  let settings = { ...DEFAULT_SETTINGS };
  /** avatar element -> { badge, count } */
  let placed = new WeakMap();
  const stats = { apiResponses: 0, usersFromApi: 0 };

  // ---------- storage ----------

  /** Returns null once the extension is reloaded and this script is orphaned. */
  function storage() {
    try {
      return chrome.runtime?.id ? chrome.storage.local : null;
    } catch {
      return null;
    }
  }

  function isFresh(entry, now) {
    return typeof entry?.c === 'number' && now - entry.t < CACHE_TTL_MS;
  }

  function loadState() {
    storage()?.get([STORAGE_KEYS.cache, STORAGE_KEYS.settings], (r) => {
      settings = { ...DEFAULT_SETTINGS, ...r[STORAGE_KEYS.settings] };
      const now = Date.now();
      for (const [name, entry] of Object.entries(r[STORAGE_KEYS.cache] || {})) {
        if (isFresh(entry, now) && !counts.has(name)) counts.set(name, entry);
      }
      scheduleRender();
    });
  }

  function newestFirst(entries, now) {
    return entries
      .filter(([, entry]) => isFresh(entry, now))
      .sort((a, b) => b[1].t - a[1].t)
      .slice(0, CACHE_MAX_ENTRIES);
  }

  let saveTimer = 0;
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      const store = storage();
      if (!store) return;
      const now = Date.now();
      // Merge with what other tabs saved so tabs don't overwrite each other.
      store.get(STORAGE_KEYS.cache, (r) => {
        const merged = { ...r?.[STORAGE_KEYS.cache] };
        for (const [name, entry] of newestFirst([...counts], now)) {
          if (!merged[name] || merged[name].t <= entry.t) merged[name] = entry;
        }
        store.set({
          [STORAGE_KEYS.cache]: Object.fromEntries(newestFirst(Object.entries(merged), now)),
        });
      });
    }, SAVE_DELAY_MS);
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    if (changes[STORAGE_KEYS.settings]) {
      settings = { ...DEFAULT_SETTINGS, ...changes[STORAGE_KEYS.settings].newValue };
      resetBadges();
    }
    if (changes[STORAGE_KEYS.cache] && !changes[STORAGE_KEYS.cache].newValue) {
      // Cache cleared from the popup.
      counts.clear();
      resetBadges();
    }
  }

  // ---------- data from page-hook.js ----------

  function onPageMessage(e) {
    const data = e.data;
    if (e.source !== window || data?.type !== MESSAGE.users || !Array.isArray(data.users)) return;
    if (data.api) stats.apiResponses++;
    stats.usersFromApi += data.users.length;

    const now = Date.now();
    let changed = false;
    for (const pair of data.users) {
      if (!Array.isArray(pair)) continue;
      const [name, count] = pair;
      if (typeof name !== 'string' || !Number.isFinite(count)) continue;
      if (counts.get(name)?.c !== count) changed = true;
      counts.set(name, { c: count, t: now });
    }
    scheduleSave();
    if (changed) scheduleRender();
  }

  // ---------- badges ----------

  let numberFormat = null;
  function formatCount(n) {
    if (!numberFormat) {
      const options = { notation: 'compact', maximumFractionDigits: 1 };
      const lang = document.documentElement.lang || navigator.language || 'en';
      try {
        numberFormat = new Intl.NumberFormat(lang, options);
      } catch {
        numberFormat = new Intl.NumberFormat('en', options);
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
    badge.className = `${BADGE_CLASS} xfc-${mode} ${tierClass(count)}`;
    badge.textContent = formatCount(count);
    badge.title = `粉丝：${count.toLocaleString()}`;
    return badge;
  }

  function screenNameOf(avatar) {
    const testId = avatar.getAttribute('data-testid') || '';
    if (testId.startsWith(AVATAR_PREFIX) && testId.length > AVATAR_PREFIX.length) {
      return testId.slice(AVATAR_PREFIX.length).toLowerCase();
    }
    const href = avatar.querySelector('a[href^="/"]')?.getAttribute('href') || '';
    const match = href.match(/^\/([A-Za-z0-9_]{1,15})(?:$|[/?#])/);
    return match ? match[1].toLowerCase() : '';
  }

  /** Finds the "@handle" text of this author inside a tweet or user cell. */
  function findHandle(scope, name) {
    const target = `@${name}`;
    const nameAreas = scope.querySelectorAll(USER_NAME_SEL);
    for (const root of nameAreas.length ? nameAreas : [scope]) {
      for (const span of root.querySelectorAll('span')) {
        if (span.childElementCount > 0) continue;
        if (span.textContent.trim().toLowerCase() !== target) continue;
        if (!span.nextElementSibling?.classList.contains(BADGE_CLASS)) return span;
      }
    }
    return null;
  }

  function placeBadge(avatar, scope, name, count) {
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

  /** Yields [avatar, scope, screenName] for each author avatar in a tweet or user cell. */
  function* authorAvatars() {
    for (const avatar of document.querySelectorAll(AVATAR_SEL)) {
      if (avatar.closest(`.${BADGE_CLASS}`)) continue;
      if (avatar.matches(TWEET_AVATAR_SEL) && avatar.querySelector(USER_AVATAR_SEL)) continue;
      const scope = avatar.closest(SCOPE_SEL);
      if (!scope) continue;
      const name = screenNameOf(avatar);
      if (name) yield [avatar, scope, name];
    }
  }

  function render() {
    if (!settings.enabled) return;
    for (const [avatar, scope, name] of authorAvatars()) {
      const entry = counts.get(name);
      if (!entry) continue;
      const prev = placed.get(avatar);
      if (prev?.badge.isConnected) {
        if (prev.count === entry.c) continue;
        prev.badge.remove();
      }
      const badge = placeBadge(avatar, scope, name, entry.c);
      if (badge) placed.set(avatar, { badge, count: entry.c });
    }
  }

  function resetBadges() {
    for (const badge of document.querySelectorAll(`.${BADGE_CLASS}`)) badge.remove();
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

  // ---------- diagnostics (shown in the popup) ----------

  /** Asks page-hook.js for its per-endpoint stats; resolves null on timeout. */
  function pageStats() {
    return new Promise((resolve) => {
      const finish = (result) => {
        clearTimeout(timer);
        window.removeEventListener('message', onReply);
        resolve(result);
      };
      const onReply = (e) => {
        if (e.source === window && e.data?.type === MESSAGE.stats) finish(e.data);
      };
      const timer = setTimeout(() => finish(null), PAGE_STATS_TIMEOUT_MS);
      window.addEventListener('message', onReply);
      window.postMessage({ type: MESSAGE.statsRequest }, location.origin);
    });
  }

  async function diagnose() {
    const avatarNames = new Set();
    for (const [, , name] of authorAvatars()) avatarNames.add(name);
    return {
      hook: document.documentElement.hasAttribute(HOOK_ATTR),
      enabled: settings.enabled,
      apiResponses: stats.apiResponses,
      usersFromApi: stats.usersFromApi,
      known: counts.size,
      tweets: document.querySelectorAll(TWEET_SEL).length,
      cells: document.querySelectorAll(USER_CELL_SEL).length,
      avatars: avatarNames.size,
      badges: document.querySelectorAll(`.${BADGE_CLASS}`).length,
      missing: [...avatarNames].filter((name) => !counts.has(name)).slice(0, 5),
      sampleKnown: [...counts.keys()].slice(-5),
      page: await pageStats(),
    };
  }

  function onExtensionMessage(msg, _sender, sendResponse) {
    if (msg?.type !== MESSAGE.diagnose) return false;
    diagnose().then(sendResponse);
    return true; // Responds asynchronously.
  }

  // ---------- start ----------

  window.addEventListener('message', onPageMessage);
  try {
    chrome.storage.onChanged.addListener(onStorageChanged);
    chrome.runtime.onMessage.addListener(onExtensionMessage);
  } catch {
    // Orphaned after an extension reload; badges already drawn stay as they are.
  }
  loadState();
  new MutationObserver(scheduleRender).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
