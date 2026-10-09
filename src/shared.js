// Constants shared by the content script and the popup.
//
// page-hook.js runs in the page's own world, where this file is not loaded,
// so it keeps its own copy of the MESSAGE values. Keep the two in sync.
globalThis.XFC = Object.freeze({
  STORAGE_KEYS: Object.freeze({
    cache: 'xfcCache',
    settings: 'xfcSettings',
  }),

  DEFAULT_SETTINGS: Object.freeze({
    enabled: true,
    /** 'avatar': under the avatar; 'name': after the @handle. */
    position: 'avatar',
    /** Mark people you follow (✓) and mutual follows (⇄) on the badge. */
    showFollowing: true,
    /** Mark tweets whose likes are high relative to the author's followers. */
    hotTweets: true,
    /** A tweet is "hot" when likes >= followers * hotRatio ... */
    hotRatio: 0.1,
    /** ... and likes >= hotMinLikes. */
    hotMinLikes: 100,
  }),

  /** Bit flags for the viewer's relationship with a user. Mirrored in page-hook.js. */
  RELATION: Object.freeze({
    following: 1,
    followedBy: 2,
  }),

  CACHE_TTL_MS: 3 * 24 * 60 * 60 * 1000,
  CACHE_MAX_ENTRIES: 5000,
  /** Tweets are kept in memory only, for the current tab. */
  TWEETS_MAX_ENTRIES: 5000,

  MESSAGE: Object.freeze({
    /** page-hook -> content: users and tweets parsed from an API response. */
    users: 'xfc:users',
    /** content -> page-hook: request per-endpoint stats. */
    statsRequest: 'xfc:stats-req',
    /** page-hook -> content: per-endpoint stats. */
    stats: 'xfc:stats',
    /** popup -> content (chrome.tabs.sendMessage): request diagnostics. */
    diagnose: 'xfc:diag',
  }),
});
