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
  const API_RE = /\/(?:graphql|i\/api)\//;
  const MAX_NODES = 500000;

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
    }
    if (typeof name === 'string' && name) found.set(name.toLowerCase(), count);
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

  // Every intercepted API response is reported, even with no users in it,
  // so the popup's diagnostics can tell "not intercepting" from "no data".
  function publish(data, api) {
    const users = data && typeof data === 'object' ? collectUsers(data) : new Map();
    if (users.size || api) {
      window.postMessage({ type: MSG_TYPE, users: [...users], api: Boolean(api) }, location.origin);
    }
  }

  function handleText(text) {
    let data = null;
    if (text && (text[0] === '{' || text[0] === '[')) {
      try {
        data = JSON.parse(text);
      } catch {
        // Not JSON.
      }
    }
    publish(data, true);
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      const promise = origFetch.apply(this, args);
      promise.then(
        (res) => {
          try {
            if (!API_RE.test(res.url)) return;
            res.clone().text().then(handleText, () => {});
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
    if (API_RE.test(xhrUrls.get(this) || '')) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') handleText(this.responseText);
          else if (this.responseType === 'json') publish(this.response, true);
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
      if (users) publish(users);
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
