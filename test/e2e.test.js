// End-to-end test: loads the unpacked extension into Chromium, serves a mock
// x.com page plus mock API responses, and checks the badges that appear.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'timeline.html'), 'utf8');

const HOME_TIMELINE = {
  data: { home: { home_timeline_urt: { instructions: [{ entries: [{ content: { itemContent: {
    tweet_results: { result: { __typename: 'Tweet', core: { user_results: { result: {
      __typename: 'User',
      rest_id: '1',
      core: { name: 'Alice', screen_name: 'Alice' },
      legacy: { followers_count: 1234567 },
    } } } } },
  } } }] }] } } },
};

const USER_TWEETS = {
  data: { users: [
    { __typename: 'User', legacy: { screen_name: 'bob', followers_count: 54321 } },
    { __typename: 'User', legacy: { screen_name: 'carol', followers_count: 999 } },
    { __typename: 'User', core: { screen_name: 'dave' }, legacy: { followers_count: 20000 } },
  ] },
};

// Chrome derives an unpacked extension's ID from its directory path.
function extensionId(dir) {
  const hex = crypto.createHash('sha256').update(fs.realpathSync(dir)).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

async function launch() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfc-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  await context.route('https://x.com/**', (route) => {
    const url = route.request().url();
    if (url.includes('/HomeTimeline')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(HOME_TIMELINE) });
    }
    if (url.includes('/UserTweets')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(USER_TWEETS) });
    }
    return route.fulfill({ contentType: 'text/html', body: FIXTURE });
  });
  return context;
}

test('shows follower badges next to avatars', async () => {
  const context = await launch();
  try {
    const page = await context.newPage();
    await page.goto('https://x.com/home');

    const alice = page.locator('#t1 [data-testid="UserAvatar-Container-Alice"] .xfc-badge');
    await alice.waitFor({ timeout: 10000 });
    assert.equal(await alice.textContent(), '1.2M');
    assert.match(await alice.getAttribute('class'), /xfc-avatar/);
    assert.match(await alice.getAttribute('class'), /xfc-t4/);

    // Quoted tweet avatar is small, so the badge goes after its @handle -
    // not after the @bob mention in the tweet text.
    const bob = page.locator('#quote [data-testid="User-Name"] .xfc-badge');
    await bob.waitFor({ timeout: 10000 });
    assert.equal(await bob.textContent(), '54.3K');
    assert.equal(await page.locator('[data-testid="tweetText"] .xfc-badge').count(), 0);

    const carol = page.locator('#cell .xfc-badge');
    await carol.waitFor({ timeout: 10000 });
    assert.equal(await carol.textContent(), '999');

    // Fallback: a tweet avatar without the per-user container testid.
    const dave = page.locator('#t3 [data-testid="Tweet-User-Avatar"] .xfc-badge');
    await dave.waitFor({ timeout: 10000 });
    assert.equal(await dave.textContent(), '20K');

    // Unknown users and avatars outside tweets/user cells get nothing.
    assert.equal(await page.locator('#t2 .xfc-badge').count(), 0);
    assert.equal(await page.locator('#outside .xfc-badge').count(), 0);
    assert.equal(await page.locator('.xfc-badge').count(), 4);

    // Diagnostics the popup shows.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId(ROOT)}/popup/popup.html`);
    const diag = await popup.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        const resp = await chrome.tabs.sendMessage(tab.id, { type: 'xfc:diag' }).catch(() => null);
        if (resp) return resp;
      }
      return null;
    });
    assert.equal(diag.hook, true);
    assert.equal(diag.apiResponses, 2);
    assert.equal(diag.known, 4);
    assert.equal(diag.tweets, 3);
    assert.equal(diag.cells, 1);
    assert.equal(diag.avatars, 5);
    assert.equal(diag.badges, 4);
    assert.deepEqual(diag.missing, ['nobody']);
    // The popup itself is the active tab here, so it reports "not x.com".
    assert.match(await popup.locator('#verdict').textContent(), /不是 x\.com/);
    await popup.close();

    // Counts are cached: a reload with no API data still shows them.
    await context.unroute('https://x.com/**');
    await page.waitForTimeout(2500); // let the debounced cache write land
    await context.route('https://x.com/**', (route) =>
      route.request().url().includes('/i/api/')
        ? route.fulfill({ contentType: 'application/json', body: '{}' })
        : route.fulfill({ contentType: 'text/html', body: FIXTURE })
    );
    await page.reload();
    await alice.waitFor({ timeout: 10000 });
    assert.equal(await alice.textContent(), '1.2M');
  } finally {
    await context.close();
  }
});
