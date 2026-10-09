// Runs in the extension's isolated world. Receives follower counts from
// page-hook.js, caches them, and draws a badge next to each author's avatar
// (or @handle) in tweets and user lists.
(() => {
  const {
    STORAGE_KEYS,
    DEFAULT_SETTINGS,
    RELATION,
    CACHE_TTL_MS,
    CACHE_MAX_ENTRIES,
    TWEETS_MAX_ENTRIES,
    MESSAGE,
  } = globalThis.XFC;

  const SAVE_DELAY_MS = 2000;
  const PAGE_STATS_TIMEOUT_MS = 500;
  const SMALL_AVATAR_PX = 28;

  const BADGE_CLASS = 'xfc-badge';
  const HOT_CLASS = 'xfc-hot';
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
  // The tweet's own permalink wraps its timestamp; the first one in an
  // article belongs to the tweet itself, not to a quoted tweet.
  const PERMALINK_SEL = 'a[href*="/status/"]:has(> time)';

  /** screen_name (lowercase) -> { c: followers, t: last seen ms, r?: RELATION flags } */
  const counts = new Map();
  /** tweet id -> { likes, author } (memory only) */
  const tweets = new Map();
  let settings = { ...DEFAULT_SETTINGS };
  /** avatar element -> { badge, key } */
  let placed = new WeakMap();
  /** tweet article -> { marker, key } */
  let hotPlaced = new WeakMap();
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

    const usersChanged = storeUsers(data.users);
    const tweetsChanged = Array.isArray(data.tweets) && storeTweets(data.tweets);
    scheduleSave();
    if (usersChanged || tweetsChanged) scheduleRender();
  }

  /** Stores [name, followers, relation] triples; returns whether anything changed. */
  function storeUsers(users) {
    const now = Date.now();
    let changed = false;
    for (const user of users) {
      if (!Array.isArray(user)) continue;
      const [name, count, relation] = user;
      if (typeof name !== 'string' || !Number.isFinite(count)) continue;
      const prev = counts.get(name);
      // Not every response says how you relate to a user; keep what we knew.
      const r = Number.isInteger(relation) ? relation : prev?.r;
      if (prev?.c !== count || prev?.r !== r) changed = true;
      counts.set(name, r === undefined ? { c: count, t: now } : { c: count, t: now, r });
    }
    return changed;
  }

  /** Stores [id, likes, author] triples; returns whether anything changed. */
  function storeTweets(list) {
    let changed = false;
    for (const tweet of list) {
      if (!Array.isArray(tweet)) continue;
      const [id, likes, author] = tweet;
      if (typeof id !== 'string' || !Number.isFinite(likes) || typeof author !== 'string') continue;
      if (tweets.get(id)?.likes !== likes) changed = true;
      tweets.delete(id); // Re-insert so the Map stays ordered oldest -> newest.
      tweets.set(id, { likes, author });
    }
    while (tweets.size > TWEETS_MAX_ENTRIES) tweets.delete(tweets.keys().next().value);
    return changed;
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

  /** Returns { mark, label } for how you relate to a user, or null. */
  function relationLabel(relation) {
    if (!settings.showFollowing || !(relation & RELATION.following)) return null;
    return relation & RELATION.followedBy
      ? { mark: '⇄', label: '互相关注' }
      : { mark: '✓', label: '你已关注' };
  }

  function makeBadge(entry, mode) {
    const rel = relationLabel(entry.r);
    const badge = document.createElement('span');
    badge.className = `${BADGE_CLASS} xfc-${mode} ${tierClass(entry.c)}${rel ? ' xfc-following' : ''}`;
    badge.textContent = rel ? `${rel.mark} ${formatCount(entry.c)}` : formatCount(entry.c);
    badge.title = `粉丝：${entry.c.toLocaleString()}${rel ? `\n${rel.label}` : ''}`;
    return badge;
  }

  /** Changes whenever the badge for this entry would look different. */
  function badgeKey(entry) {
    return `${entry.c}|${relationLabel(entry.r)?.mark || ''}`;
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

  /**
   * The User-Name areas closest to the avatar: walking up from it, those in the
   * first ancestor that has any. For a quoted tweet that is the quote's own
   * header, so a self-quote can't reach the outer tweet's @handle.
   */
  function nameAreasNear(avatar, scope) {
    for (let el = avatar.parentElement; el && scope.contains(el); el = el.parentElement) {
      if (el.matches(USER_NAME_SEL)) return [el];
      const areas = el.querySelectorAll(USER_NAME_SEL);
      if (areas.length) return areas;
    }
    return [scope]; // e.g. user cells, which have no User-Name area
  }

  /** Finds the "@handle" text of this avatar's author. */
  function findHandle(avatar, scope, name) {
    const target = `@${name}`;
    for (const root of nameAreasNear(avatar, scope)) {
      for (const span of root.querySelectorAll('span')) {
        if (span.childElementCount === 0 && span.textContent.trim().toLowerCase() === target) return span;
      }
    }
    return null;
  }

  function placeBadge(avatar, scope, name, entry) {
    let mode = settings.position === 'name' ? 'name' : 'avatar';
    if (mode === 'avatar' && avatar.offsetWidth > 0 && avatar.offsetWidth < SMALL_AVATAR_PX) {
      mode = 'name'; // e.g. quoted tweets: too small to hang a badge under.
    }

    if (mode === 'avatar') {
      if (getComputedStyle(avatar).position === 'static') avatar.style.position = 'relative';
      const badge = makeBadge(entry, mode);
      avatar.appendChild(badge);
      return badge;
    }

    const handle = findHandle(avatar, scope, name);
    // Already badged (e.g. by the Tweet-User-Avatar fallback): never add a second.
    if (!handle || handle.nextElementSibling?.classList.contains(BADGE_CLASS)) return null;
    const badge = makeBadge(entry, mode);
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

  function renderBadges() {
    for (const [avatar, scope, name] of authorAvatars()) {
      const entry = counts.get(name);
      if (!entry) continue;
      const key = badgeKey(entry);
      const prev = placed.get(avatar);
      if (prev?.badge.isConnected) {
        if (prev.key === key) continue;
        prev.badge.remove();
      }
      const badge = placeBadge(avatar, scope, name, entry);
      if (badge) placed.set(avatar, { badge, key });
    }
  }

  // ---------- hot tweets ----------

  function formatRatio(ratio) {
    return ratio >= 1
      ? `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}×`
      : `${Math.round(ratio * 100)}%`;
  }

  /** Returns { likes, followers, ratio } if the tweet counts as hot, else null. */
  function hotness(tweet) {
    const followers = counts.get(tweet.author)?.c;
    if (followers === undefined || tweet.likes < settings.hotMinLikes) return null;
    const ratio = tweet.likes / Math.max(followers, 1);
    return ratio >= settings.hotRatio ? { likes: tweet.likes, followers, ratio } : null;
  }

  function makeHotMarker({ likes, followers, ratio }) {
    const marker = document.createElement('span');
    marker.className = `${HOT_CLASS}${ratio >= 1 ? ' xfc-hot-max' : ''}`;
    marker.textContent = `🔥 ${formatRatio(ratio)}`;
    marker.title =
      `爆款：点赞 ${likes.toLocaleString()}，作者粉丝 ${followers.toLocaleString()}\n` +
      `点赞数是粉丝数的 ${ratio >= 1 ? `${ratio.toFixed(1)} 倍` : `${(ratio * 100).toFixed(1)}%`}`;
    return marker;
  }

  function renderHotMarkers() {
    for (const article of document.querySelectorAll(TWEET_SEL)) {
      const permalink = article.querySelector(PERMALINK_SEL);
      const id = permalink?.getAttribute('href').match(/\/status\/(\d+)/)?.[1];
      const tweet = id && tweets.get(id);
      const hot = tweet && hotness(tweet);
      const key = hot ? `${id}|${hot.likes}|${hot.followers}` : '';
      const prev = hotPlaced.get(article);
      if (prev?.marker.isConnected) {
        if (prev.key === key) continue;
        prev.marker.remove();
      }
      if (!hot) {
        hotPlaced.delete(article);
        continue;
      }
      const marker = makeHotMarker(hot);
      permalink.after(marker);
      hotPlaced.set(article, { marker, key });
    }
  }

  // ---------- render loop ----------

  function render() {
    if (!settings.enabled) return;
    renderBadges();
    if (settings.hotTweets) renderHotMarkers();
  }

  function resetBadges() {
    for (const el of document.querySelectorAll(`.${BADGE_CLASS}, .${HOT_CLASS}`)) el.remove();
    placed = new WeakMap();
    hotPlaced = new WeakMap();
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
      tweetsKnown: tweets.size,
      hotMarkers: document.querySelectorAll(`.${HOT_CLASS}`).length,
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
