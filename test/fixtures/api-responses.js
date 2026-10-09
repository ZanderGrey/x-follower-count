// Mock X API responses served to test/fixtures/timeline.html, keyed by the
// GraphQL operation name in the request URL. Each exercises one parsing path.
//
// Expected results:
//   users   Alice 1.2M (you follow), bob 54.3K (mutual), carol 999, dave 20K,
//           eve 77, frank 5, gina 171 (quotes herself in #t5)
//   tweets  111 Alice 200K likes -> 16% of followers, hot
//           222 bob (quoted inside 111) 10K likes -> hot, but not 111's marker
//           333 dave 30K likes -> 1.5x followers, hot
//           555 frank 50 likes -> 10x followers but under 100 likes, not hot

const user = (screenName, followers, extra = {}) => ({
  __typename: 'User',
  core: { screen_name: screenName },
  legacy: { followers_count: followers },
  ...extra,
});

const tweet = (id, likes, author) => ({
  __typename: 'Tweet',
  rest_id: id,
  core: { user_results: { result: author } },
  legacy: { favorite_count: likes },
});

module.exports = {
  // Current GraphQL layout, nested the way a timeline nests tweets.
  // Relationship in relationship_perspectives. Fetched with fetch().
  HomeTimeline: JSON.stringify({
    data: {
      home: {
        home_timeline_urt: {
          instructions: [
            {
              entries: [
                {
                  content: {
                    itemContent: {
                      tweet_results: {
                        result: tweet(
                          '111',
                          200000,
                          user('Alice', 1234567, {
                            relationship_perspectives: { following: true, followed_by: false },
                          })
                        ),
                      },
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    },
  }),

  // Older layout: screen_name and relationship under legacy.
  // Fetched with XHR, default responseType.
  UserTweets: JSON.stringify({
    data: {
      users: [
        { __typename: 'User', legacy: { screen_name: 'carol', followers_count: 999 } },
        user('dave', 20000, { relationship_perspectives: { following: false } }),
        user('gina', 171),
      ],
      tweets: [
        tweet('222', 10000, {
          __typename: 'User',
          legacy: { screen_name: 'bob', followers_count: 54321, following: true, followed_by: true },
        }),
        tweet('333', 30000, user('dave', 20000)),
      ],
    },
  }),

  // Anti-hijacking prefix, and the count outside `legacy`.
  // Fetched with XHR, responseType "arraybuffer".
  TweetDetail: `)]}'\n${JSON.stringify({
    data: { u: { __typename: 'User', core: { screen_name: 'eve' }, relationship_counts: { followers: 77 } } },
  })}`,

  // Fetched with XHR, responseType "blob". Alice appears again without any
  // relationship info, which must not erase what HomeTimeline said.
  SearchTimeline: JSON.stringify({
    data: { tweets: [tweet('555', 50, user('frank', 5))], u: user('Alice', 1234567) },
  }),
};
