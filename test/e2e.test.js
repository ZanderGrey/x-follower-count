// End-to-end tests: load the unpacked extension into Chromium, serve a mock
// x.com page (fixtures/timeline.html) and mock API responses, and check what
// the extension draws and reports.
const { describe, before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const API_RESPONSES = require('./fixtures/api-responses');

const ROOT = path.resolve(__dirname, '..');
const PAGE_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'timeline.html'), 'utf8');
const TIMEOUT = 10_000;
const CACHE_SAVE_WAIT_MS = 2500; // content.js debounces cache writes by 2s

/** Chrome derives an unpacked extension's ID from its directory path. */
function extensionId(dir) {
  const hex = crypto.createHash('sha256').update(fs.realpathSync(dir)).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/** Serves the mock page; API calls get `responses[operationName]`, or `{}`. */
function serveMockX(context, responses) {
  return context.route('https://x.com/**', (route) => {
    const url = route.request().url();
    if (!url.includes('/i/api/')) return route.fulfill({ contentType: 'text/html', body: PAGE_HTML });
    const operation = Object.keys(responses).find((name) => url.includes(`/${name}`));
    return route.fulfill({ contentType: 'application/json', body: responses[operation] ?? '{}' });
  });
}

describe('X Follower Count', () => {
  let context;
  let page;
  let popup;
  const badge = (selector) => page.locator(`${selector} .xfc-badge`);

  async function textOf(selector) {
    const locator = badge(selector);
    await locator.waitFor({ timeout: TIMEOUT });
    return locator.textContent();
  }

  async function sendDiagnose() {
    return popup.evaluate(async () => {
      for (const tab of await chrome.tabs.query({})) {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'xfc:diag' }).catch(() => null);
        if (response) return response;
      }
      return null;
    });
  }

  before(async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfc-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
    });
    await serveMockX(context, API_RESPONSES);
    page = await context.newPage();
    await page.goto('https://x.com/home');
    popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId(ROOT)}/popup/popup.html`);
    await page.bringToFront();
  });

  after(async () => {
    await context?.close();
  });

  test('hangs a compact, colour-tiered badge under a tweet author avatar', async () => {
    assert.equal(await textOf('#t1 [data-testid="UserAvatar-Container-Alice"]'), '1.2M');
    const classes = await badge('#t1 [data-testid="UserAvatar-Container-Alice"]').getAttribute('class');
    assert.match(classes, /\bxfc-avatar\b/);
    assert.match(classes, /\bxfc-t4\b/);
  });

  test('puts the badge after the @handle for small quoted-tweet avatars', async () => {
    assert.equal(await textOf('#quote [data-testid="User-Name"]'), '54.3K');
    // Not after the @bob mention in the tweet text.
    assert.equal(await badge('[data-testid="tweetText"]').count(), 0);
  });

  test('badges user cells', async () => {
    assert.equal(await textOf('#cell'), '999');
  });

  test('falls back to the Tweet-User-Avatar wrapper', async () => {
    assert.equal(await textOf('#t3 [data-testid="Tweet-User-Avatar"]'), '20K');
  });

  test('skips unknown users and avatars outside tweets and user cells', async () => {
    assert.equal(await badge('#t2').count(), 0);
    assert.equal(await badge('#outside').count(), 0);
    assert.equal(await page.locator('.xfc-badge').count(), 4);
  });

  test('reports diagnostics for every intercepted response', async () => {
    const diag = await sendDiagnose();
    assert.deepEqual(
      {
        hook: diag.hook,
        apiResponses: diag.apiResponses,
        known: diag.known,
        tweets: diag.tweets,
        cells: diag.cells,
        avatars: diag.avatars,
        badges: diag.badges,
        missing: diag.missing,
      },
      {
        hook: true,
        apiResponses: 4,
        known: 6,
        tweets: 3,
        cells: 1,
        avatars: 5,
        badges: 4,
        missing: ['nobody'],
      }
    );

    const byName = Object.fromEntries(diag.page.endpoints.map((e) => [e.name, e]));
    const summary = (e) => `${e.via}/${e.kinds}: ${e.n} response(s), ${e.users} user(s)`;
    assert.equal(summary(byName.HomeTimeline), 'fetch/application/json: 1 response(s), 1 user(s)');
    assert.equal(summary(byName.UserTweets), 'xhr/text: 1 response(s), 3 user(s)');
    assert.equal(summary(byName.TweetDetail), 'xhr/arraybuffer: 1 response(s), 1 user(s)');
    assert.equal(summary(byName.SearchTimeline), 'xhr/blob: 1 response(s), 1 user(s)');
    assert.equal(diag.page.unreadUserShape, null);
    assert.ok(Object.keys(diag.page.performance).some((k) => k.startsWith('HomeTimeline')));
  });

  test('popup says so when the active tab is not x.com', async () => {
    await popup.bringToFront();
    await popup.reload();
    assert.match(await popup.locator('#verdict').textContent(), /不是 x\.com/);
    await page.bringToFront();
  });

  test('moves badges after the @handle when the position setting changes', async () => {
    await popup.evaluate(() =>
      chrome.storage.local.set({ xfcSettings: { enabled: true, position: 'name' } })
    );
    assert.equal(await textOf('#t1 [data-testid="User-Name"]:not(#quote *)'), '1.2M');
    assert.equal(await badge('#t1 [data-testid="UserAvatar-Container-Alice"]').count(), 0);

    await popup.evaluate(() =>
      chrome.storage.local.set({ xfcSettings: { enabled: true, position: 'avatar' } })
    );
    assert.equal(await textOf('#t1 [data-testid="UserAvatar-Container-Alice"]'), '1.2M');
  });

  test('shows cached counts after a reload with no API data', async () => {
    await page.waitForTimeout(CACHE_SAVE_WAIT_MS);
    await context.unroute('https://x.com/**');
    await serveMockX(context, {});
    await page.reload();
    assert.equal(await textOf('#t1 [data-testid="UserAvatar-Container-Alice"]'), '1.2M');
  });
});
