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

  const MSG_TYPE = 'xfc:users';
  const STATS_REQ = 'xfc:stats-req';
  const STATS_TYPE = 'xfc:stats';
  const API_RE = /\/(?:graphql|i\/api)\//;
  const MAX_NODES = 500000;
  const FOLLOWERS_KEY_RE = /^(?:followers_?count|followers)$/i;

  // ---------- diagnostics ----------

  /** endpoint -> { n, users, nonJson, via: Set, kinds: Set, sample } */
  const endpoints = new Map();
  /** Key layout of the first User object we could not read, for bug reports. */
  let unreadUserShape = null;

  function endpointName(url) {
    try {
      const path = new URL(url, location.href).pathname;
      const gql = path.match(/\/graphql\/[^/]+\/([^/]+)/);
      return gql ? gql[1] : path.split('/').filter(Boolean).slice(-2).join('/');
    } catch {
      return String(url).slice(0, 60);
    }
  }

  function record(url, via, kind, usersFound, isJson, text) {
    const key = endpointName(url);
    let e = endpoints.get(key);
    if (!e) {
      e = { n: 0, users: 0, nonJson: 0, via: new Set(), kinds: new Set(), sample: '' };
      endpoints.set(key, e);
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
      if (v && typeof v === 'object' && !Array.isArray(v) && depth > 0) out[k] = shapeOf(v, depth - 1);
      else out[k] = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
    }
    return out;
  }

  function performanceSummary() {
    const out = {};
    for (const e of performance.getEntriesByType('resource')) {
      if (!API_RE.test(e.name)) continue;
      const key = `${endpointName(e.name)} (${e.initiatorType})`;
      out[key] = (out[key] || 0) + 1;
    }
    return out;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.type !== STATS_REQ) return;
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
      { type: STATS_TYPE, endpoints: list, unreadUserShape, performance: performanceSummary() },
      location.origin
    );
  });
  try {
    performance.setResourceTimingBufferSize(5000);
  } catch {
    // Ignore.
  }

  // ---------- parsing ----------

  // Looks a couple of levels into a User object for a follower count stored
  // somewhere other than legacy.followers_count.
  function findFollowers(o, depth) {
    for (const k in o) {
      const v = o[k];
      if (typeof v === 'number' && FOLLOWERS_KEY_RE.test(k)) return v;
    }
    if (depth <= 0) return undefined;
    for (const k in o) {
      const v = o[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && v.__typename !== 'User' && v.__typename !== 'Tweet') {
        const found = findFollowers(v, depth - 1);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  }

  function readUser(o, found) {
    let name;
    let count;
    if (o.legacy && typeof o.legacy.followers_count === 'number') {
      // GraphQL "User" result. screen_name moved from legacy to core in 2025;
      // accept either.
      name = (o.core && o.core.screen_name) || o.legacy.screen_name;
      count = o.legacy.followers_count;
    } else if (typeof o.followers_count === 'number' && typeof o.screen_name === 'string') {
      // REST v1.1 style user, also used by window.__INITIAL_STATE__.
      name = o.screen_name;
      count = o.followers_count;
    } else if (o.__typename === 'User') {
      name = o.core?.screen_name || o.legacy?.screen_name || o.screen_name;
      count = findFollowers(o, 2);
      if (count === undefined && !unreadUserShape) unreadUserShape = shapeOf(o, 2);
    }
    if (typeof name === 'string' && name && typeof count === 'number') found.set(name.toLowerCase(), count);
  }

  function collectUsers(root) {
    const found = new Map();
    const stack = [root];
    let budget = MAX_NODES;
    while (stack.length && budget-- > 0) {
      const node = stack.pop();
      if (Array.isArray(node)) {
        for (const v of node) if (v && typeof v === 'object') stack.push(v);
        continue;
      }
      readUser(node, found);
      for (const k in node) {
        const v = node[k];
        if (v && typeof v === 'object') stack.push(v);
      }
    }
    return found;
  }

  function parseJson(text) {
    if (typeof text !== 'string') return null;
    // Tolerate anti-JSON-hijacking prefixes such as ")]}'" or "for(;;);".
    const start = text.search(/[[{]/);
    if (start < 0 || start > 20) return null;
    try {
      return JSON.parse(start ? text.slice(start) : text);
    } catch {
      return null;
    }
  }

  // Every intercepted API response is reported, even with no users in it,
  // so the popup's diagnostics can tell "not intercepting" from "no data".
  function handleData(url, via, kind, data, text) {
    const users = data && typeof data === 'object' ? collectUsers(data) : new Map();
    record(url, via, kind, users.size, Boolean(data), text);
    window.postMessage({ type: MSG_TYPE, users: [...users], api: true }, location.origin);
  }

  function handleText(url, via, kind, text) {
    handleData(url, via, kind, parseJson(text), text);
  }

  function publishInitial(data) {
    const users = collectUsers(data);
    if (users.size) window.postMessage({ type: MSG_TYPE, users: [...users], api: false }, location.origin);
  }

  // ---------- hooks ----------

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
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
              .then((t) => handleText(res.url, 'fetch', kind, t), () => {});
          } catch {
            // Never break the page's own request.
          }
        },
        () => {}
      );
      return promise;
    };
  }

  const xhrUrls = new WeakMap();
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    xhrUrls.set(this, String(url));
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const url = xhrUrls.get(this) || '';
    if (API_RE.test(url)) {
      this.addEventListener('load', () => {
        const kind = this.responseType || 'text';
        try {
          if (kind === 'text') {
            handleText(url, 'xhr', kind, this.responseText);
          } else if (kind === 'json') {
            handleData(url, 'xhr', kind, this.response, '');
          } else if (kind === 'arraybuffer' && this.response) {
            handleText(url, 'xhr', kind, new TextDecoder().decode(this.response));
          } else if (kind === 'blob' && this.response) {
            this.response.text().then((t) => handleText(url, 'xhr', kind, t), () => {});
          } else {
            record(url, 'xhr', kind, 0, false, '');
          }
        } catch {
          // Ignore.
        }
      });
    }
    return origSend.apply(this, args);
  };

  // Lets the content script's diagnostics see that this script was injected.
  document.documentElement.setAttribute('data-xfc-hook', '1');

  // The first page load may embed users in the server-rendered state.
  function readInitialState() {
    try {
      const users = window.__INITIAL_STATE__?.entities?.users?.entities;
      if (users) publishInitial(users);
    } catch {
      // Ignore.
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', readInitialState, { once: true });
  } else {
    readInitialState();
  }
})();
