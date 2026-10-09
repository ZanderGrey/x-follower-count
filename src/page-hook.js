// Runs in the page's own JavaScript world (manifest "world": "MAIN").
//
// X's web client already downloads full user objects - including
// followers_count - for every author shown in a timeline. Instead of making
// extra requests, we listen to the API responses the page receives anyway,
// pull out {screen_name -> followers_count}, and hand the result to the
// extension's content script via window.postMessage.
(() => {
  if (window.__xfcHooked) return;
  window.__xfcHooked = true;

  // Mirrors XFC.MESSAGE in shared.js, which is not loaded in the page world.
  const MESSAGE = {
    users: 'xfc:users',
    statsRequest: 'xfc:stats-req',
    stats: 'xfc:stats',
  };
  const HOOK_ATTR = 'data-xfc-hook';
  const API_RE = /\/(?:graphql|i\/api)\//;
  const MAX_NODES = 500_000;
  const MAX_JSON_PREFIX = 20;
  const FOLLOWERS_KEY_RE = /^(?:followers_?count|followers)$/i;

  // ---------- parsing ----------

  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  /** Looks a couple of levels into a User object for a follower count stored outside `legacy`. */
  function findFollowers(o, depth) {
    for (const k in o) {
      if (typeof o[k] === 'number' && FOLLOWERS_KEY_RE.test(k)) return o[k];
    }
    if (depth <= 0) return undefined;
    for (const k in o) {
      const v = o[k];
      if (!isPlainObject(v) || v.__typename === 'User' || v.__typename === 'Tweet') continue;
      const found = findFollowers(v, depth - 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** Returns [screenName, followers] if `o` is a user object we can read. */
  function readUser(o) {
    if (typeof o.legacy?.followers_count === 'number') {
      // GraphQL User. screen_name moved from legacy to core in 2025; accept either.
      return [o.core?.screen_name || o.legacy.screen_name, o.legacy.followers_count];
    }
    if (typeof o.followers_count === 'number' && typeof o.screen_name === 'string') {
      // REST v1.1 user, also used by window.__INITIAL_STATE__.
      return [o.screen_name, o.followers_count];
    }
    if (o.__typename === 'User') {
      const count = findFollowers(o, 2);
      if (count === undefined) noteUnreadUser(o);
      return [o.core?.screen_name || o.legacy?.screen_name || o.screen_name, count];
    }
    return null;
  }

  /** Walks a JSON value and returns Map(lowercase screen name -> followers). */
  function collectUsers(root) {
    const found = new Map();
    const stack = [root];
    let budget = MAX_NODES;
    while (stack.length && budget-- > 0) {
      const node = stack.pop();
      if (!Array.isArray(node)) {
        const user = readUser(node);
        if (user && typeof user[0] === 'string' && user[0] && typeof user[1] === 'number') {
          found.set(user[0].toLowerCase(), user[1]);
        }
      }
      for (const v of Array.isArray(node) ? node : Object.values(node)) {
        if (v && typeof v === 'object') stack.push(v);
      }
    }
    return found;
  }

  /** Parses JSON, tolerating anti-hijacking prefixes such as ")]}'" or "for(;;);". */
  function parseJson(text) {
    if (typeof text !== 'string') return null;
    const start = text.search(/[[{]/);
    if (start < 0 || start > MAX_JSON_PREFIX) return null;
    try {
      return JSON.parse(text.slice(start));
    } catch {
      return null;
    }
  }

  // ---------- reporting to the content script ----------

  function postUsers(users, fromApi) {
    window.postMessage({ type: MESSAGE.users, users: [...users], api: fromApi }, location.origin);
  }

  /**
   * Handles one intercepted API response. Every response is reported, even
   * with no users in it, so diagnostics can tell "not intercepting" from "no data".
   */
  function handleResponse(url, via, kind, data, text = '') {
    const users = data && typeof data === 'object' ? collectUsers(data) : new Map();
    recordEndpoint(url, via, kind, users.size, Boolean(data), text);
    postUsers(users, true);
  }

  function handleText(url, via, kind, text) {
    handleResponse(url, via, kind, parseJson(text), text);
  }

  // ---------- diagnostics ----------

  /** endpoint -> { n, users, nonJson, via: Set, kinds: Set, sample } */
  const endpoints = new Map();
  /** Key layout (no values) of the first User object we could not read. */
  let unreadUserShape = null;

  function endpointName(url) {
    try {
      const path = new URL(url, location.href).pathname;
      const graphql = path.match(/\/graphql\/[^/]+\/([^/]+)/);
      return graphql ? graphql[1] : path.split('/').filter(Boolean).slice(-2).join('/');
    } catch {
      return String(url).slice(0, 60);
    }
  }

  function recordEndpoint(url, via, kind, usersFound, isJson, text) {
    const name = endpointName(url);
    let e = endpoints.get(name);
    if (!e) {
      e = { n: 0, users: 0, nonJson: 0, via: new Set(), kinds: new Set(), sample: '' };
      endpoints.set(name, e);
    }
    e.n++;
    e.users += usersFound;
    e.via.add(via);
    e.kinds.add(kind);
    if (!isJson) {
      e.nonJson++;
      if (!e.sample && typeof text === 'string') e.sample = text.slice(0, 40);
    }
  }

  function shapeOf(o, depth) {
    const out = {};
    for (const k of Object.keys(o).slice(0, 40)) {
      const v = o[k];
      if (isPlainObject(v) && depth > 0) out[k] = shapeOf(v, depth - 1);
      else out[k] = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
    }
    return out;
  }

  function noteUnreadUser(o) {
    if (!unreadUserShape) unreadUserShape = shapeOf(o, 2);
  }

  /** API requests the browser itself logged, to spot ones our hooks missed. */
  function performanceSummary() {
    const out = {};
    for (const entry of performance.getEntriesByType('resource')) {
      if (!API_RE.test(entry.name)) continue;
      const key = `${endpointName(entry.name)} (${entry.initiatorType})`;
      out[key] = (out[key] || 0) + 1;
    }
    return out;
  }

  function onStatsRequest(e) {
    if (e.source !== window || e.data?.type !== MESSAGE.statsRequest) return;
    const list = [...endpoints]
      .map(([name, v]) => ({
        name,
        n: v.n,
        users: v.users,
        nonJson: v.nonJson,
        via: [...v.via].join('+'),
        kinds: [...v.kinds].join('+'),
        sample: v.sample,
      }))
      .sort((a, b) => b.n - a.n);
    window.postMessage(
      { type: MESSAGE.stats, endpoints: list, unreadUserShape, performance: performanceSummary() },
      location.origin
    );
  }

  // ---------- network hooks ----------

  function hookFetch() {
    const origFetch = window.fetch;
    if (typeof origFetch !== 'function') return;
    window.fetch = function (...args) {
      const promise = origFetch.apply(this, args);
      promise.then(
        (res) => {
          try {
            if (!API_RE.test(res.url)) return;
            const kind = (res.headers.get('content-type') || '?').split(';')[0];
            res
              .clone()
              .text()
              .then(
                (text) => handleText(res.url, 'fetch', kind, text),
                () => {}
              );
          } catch {
            // Never break the page's own request.
          }
        },
        () => {}
      );
      return promise;
    };
  }

  function readXhrResponse(xhr, url) {
    const kind = xhr.responseType || 'text';
    if (kind === 'text') {
      handleText(url, 'xhr', kind, xhr.responseText);
    } else if (kind === 'json') {
      handleResponse(url, 'xhr', kind, xhr.response);
    } else if (kind === 'arraybuffer' && xhr.response) {
      handleText(url, 'xhr', kind, new TextDecoder().decode(xhr.response));
    } else if (kind === 'blob' && xhr.response) {
      xhr.response.text().then(
        (text) => handleText(url, 'xhr', kind, text),
        () => {}
      );
    } else {
      recordEndpoint(url, 'xhr', kind, 0, false, '');
    }
  }

  function hookXhr() {
    const urls = new WeakMap();
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      urls.set(this, String(url));
      return origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      const url = urls.get(this) || '';
      if (API_RE.test(url)) {
        this.addEventListener('load', () => {
          try {
            readXhrResponse(this, url);
          } catch {
            // Never break the page's own request.
          }
        });
      }
      return origSend.apply(this, args);
    };
  }

  /** The first page load may embed users in the server-rendered state. */
  function readInitialState() {
    try {
      const users = window.__INITIAL_STATE__?.entities?.users?.entities;
      if (!users) return;
      const found = collectUsers(users);
      if (found.size) postUsers(found, false);
    } catch {
      // Ignore malformed state.
    }
  }

  // ---------- start ----------

  hookFetch();
  hookXhr();
  window.addEventListener('message', onStatsRequest);
  try {
    performance.setResourceTimingBufferSize(5000);
  } catch {
    // Not critical: only affects diagnostics.
  }
  document.documentElement.setAttribute(HOOK_ATTR, '1');
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', readInitialState, { once: true });
  } else {
    readInitialState();
  }
})();
