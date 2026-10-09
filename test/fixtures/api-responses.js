// Mock X API responses served to test/fixtures/timeline.html, keyed by the
// GraphQL operation name in the request URL. Each exercises one parsing path.

const user = (screenName, followers) => ({
  __typename: 'User',
  core: { screen_name: screenName },
  legacy: { followers_count: followers },
});

module.exports = {
  // Current GraphQL layout, nested the way a timeline nests tweet authors.
  // Fetched with fetch().
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
                        result: {
                          __typename: 'Tweet',
                          core: { user_results: { result: user('Alice', 1234567) } },
                        },
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

  // Older layout with screen_name under legacy, plus the current one.
  // Fetched with XHR, default responseType.
  UserTweets: JSON.stringify({
    data: {
      users: [
        { __typename: 'User', legacy: { screen_name: 'bob', followers_count: 54321 } },
        { __typename: 'User', legacy: { screen_name: 'carol', followers_count: 999 } },
        user('dave', 20000),
      ],
    },
  }),

  // Anti-hijacking prefix, and the count outside `legacy`.
  // Fetched with XHR, responseType "arraybuffer".
  TweetDetail: `)]}'\n${JSON.stringify({
    data: { u: { __typename: 'User', core: { screen_name: 'eve' }, relationship_counts: { followers: 77 } } },
  })}`,

  // Fetched with XHR, responseType "blob".
  SearchTimeline: JSON.stringify({ data: { u: user('frank', 5) } }),
};
