const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatSongsReply,
  parseSongsFromReplyText,
  resolveChordsUrlsForSongs,
  searchForChordsUrlWithDebug,
  explainChordsMatch
} = require('../src/chords');

function responseFromJson(json, options = {}) {
  const status = options.status ?? 200;
  const ok = options.ok ?? (status >= 200 && status < 300);
  return {
    ok,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json)
  };
}

test('formatting keeps the header and shows a plain chords URL line', () => {
  const song = {
    song_title: 'Sultans of Swing',
    artist: 'Dire Straits',
    chords_url: 'https://tab4u.com/tabs/songs/123'
  };

  assert.equal(
    formatSongsReply([song], { includeChords: true }),
    '\u200F🤖 הבאתי:\n\u200FSultans of Swing - Dire Straits\n\u200F   אקורדים: https://tab4u.com/tabs/songs/123'
  );
});

test('parseSongsFromReplyText extracts song lines in order', () => {
  const parsed = parseSongsFromReplyText(
    '\u200F🤖 הבאתי:\n\u200F1. Sultans of Swing - Dire Straits\n\u200F   אקורדים: https://tab4u.com/tabs/songs/123\n\u200F2. White Room - Cream'
  );

  assert.deepEqual(parsed, [
    { song_title: 'Sultans of Swing', artist: 'Dire Straits' },
    { song_title: 'White Room', artist: 'Cream' }
  ]);
});

test('SearXNG request includes one site query per allowed host in Hebrew order', async () => {
  const requests = [];

  await searchForChordsUrlWithDebug(
    {
      song_title: 'ארץ חדשה',
      artist: 'שלמה ארצי',
      language: 'he'
    },
    async (url, init) => {
      requests.push({ url, init });
      return responseFromJson({ results: [] });
    },
    {
      searxngBaseUrl: 'http://127.0.0.1:8080',
      searxngMaxResults: 5
    }
  );

  assert.ok(requests.length > 0);
  const first = new URL(requests[0].url);
  assert.equal(first.origin, 'http://127.0.0.1:8080');
  assert.equal(first.pathname, '/search');
  assert.equal(first.searchParams.get('format'), 'json');
  assert.equal(first.searchParams.get('pageno'), '1');
  assert.deepEqual(
    requests.map((entry) => new URL(entry.url).searchParams.get('q')),
    [
      'site:tab4u.com/tabs/songs/ "ארץ חדשה" "שלמה ארצי" אקורדים',
      'site:nagnu.co.il "ארץ חדשה" "שלמה ארצי" אקורדים',
      'site:ultimate-guitar.com/tab/ "ארץ חדשה" "שלמה ארצי" אקורדים',
      'site:tab4u.com/tabs/songs/ "ארץ חדשה" "שלמה ארצי" chords',
      'site:nagnu.co.il "ארץ חדשה" "שלמה ארצי" chords',
      'site:ultimate-guitar.com/tab/ "ארץ חדשה" "שלמה ארצי" chords'
    ]
  );
});

test('SearXNG request includes one site query per allowed host in English order', async () => {
  const requests = [];

  await searchForChordsUrlWithDebug(
    {
      song_title: 'please dont let me be misunderstood',
      artist: 'The Animals',
      language: 'en'
    },
    async (url) => {
      requests.push(url);
      return responseFromJson({ results: [] });
    },
    {
      searxngBaseUrl: 'http://127.0.0.1:8080'
    }
  );

  assert.deepEqual(
    requests.map((url) => new URL(url).searchParams.get('q')),
    [
      'site:ultimate-guitar.com/tab/ "please dont let me be misunderstood" "The Animals" chords',
      'site:songsterr.com/a/wsa/ "please dont let me be misunderstood" "The Animals" chords',
      'site:tabs.ultimate-guitar.com/tab/ "please dont let me be misunderstood" "The Animals" chords',
      'site:tab4u.com/tabs/songs/ "please dont let me be misunderstood" "The Animals" chords',
      'site:guitarsongs.club "please dont let me be misunderstood" "The Animals" chords'
    ]
  );
});

test('search stops after the first valid chords page across site queries', async () => {
  const requests = [];

  const debug = await searchForChordsUrlWithDebug(
    {
      song_title: 'ארץ חדשה',
      artist: 'שלמה ארצי',
      language: 'he'
    },
    async (url) => {
      requests.push(url);
      const searchUrl = new URL(url);
      if (searchUrl.searchParams.get('q')?.includes('site:tab4u.com')) {
        return responseFromJson({ results: [] });
      }

      return responseFromJson({
        results: [
          {
            title: 'ארץ חדשה - שלמה ארצי אקורדים',
            content: 'אקורדים',
            url: 'https://www.tab4u.com/tabs/songs/2794_%D7%A9%D7%9C%D7%9E%D7%94_%D7%90%D7%A8%D7%A6%D7%99_-%D7%90%D7%A8%D7%A5_%D7%97%D7%93%D7%A9%D7%94.html'
          }
        ]
      });
    },
    {
      searxngBaseUrl: 'http://127.0.0.1:8080'
    }
  );

  assert.equal(debug.chords_url, 'https://www.tab4u.com/tabs/songs/2794_%D7%A9%D7%9C%D7%9E%D7%94_%D7%90%D7%A8%D7%A6%D7%99_-%D7%90%D7%A8%D7%A5_%D7%97%D7%93%D7%A9%D7%94.html');
  assert.equal(requests.length, 2);
});

test('SearXNG request can include optional engines', async () => {
  const requests = [];

  await searchForChordsUrlWithDebug(
    {
      song_title: 'Sultans of Swing',
      artist: 'Dire Straits',
      language: 'en'
    },
    async (url) => {
      requests.push(url);
      return responseFromJson({ results: [] });
    },
    {
      searxngBaseUrl: 'http://127.0.0.1:8080',
      searxngEngines: 'google,bing'
    }
  );

  const first = new URL(requests[0]);
  assert.equal(first.searchParams.get('engines'), 'google,bing');
});

test('search maps SearXNG content into snippet and keeps engine metadata', async () => {
  const debug = await searchForChordsUrlWithDebug(
    {
      song_title: 'ארץ חדשה',
      artist: 'שלמה ארצי',
      language: 'he'
    },
    async () =>
      responseFromJson({
        results: [
          {
            title: 'ארץ חדשה - שלמה ארצי אקורדים',
            content: 'טאב4יו מציג אקורדים',
            url: 'https://www.tab4u.com/tabs/songs/2794_%D7%A9%D7%9C%D7%9E%D7%94_%D7%90%D7%A8%D7%A6%D7%99_-%D7%90%D7%A8%D7%A5_%D7%97%D7%93%D7%A9%D7%94.html',
            engine: 'google',
            engines: ['google', 'bing']
          }
        ]
      }),
    {
      searxngBaseUrl: 'http://127.0.0.1:8080'
    }
  );

  assert.equal(debug.chords_url, 'https://www.tab4u.com/tabs/songs/2794_%D7%A9%D7%9C%D7%9E%D7%94_%D7%90%D7%A8%D7%A6%D7%99_-%D7%90%D7%A8%D7%A5_%D7%97%D7%93%D7%A9%D7%94.html');
  assert.equal(debug.best_candidate.snippet, 'טאב4יו מציג אקורדים');
  assert.equal(debug.best_candidate.engine, 'google');
  assert.deepEqual(debug.best_candidate.engines, ['google', 'bing']);
});

test('search ignores invalid URLs and reports no candidate', async () => {
  const debug = await searchForChordsUrlWithDebug(
    {
      song_title: 'Sultans of Swing',
      artist: 'Dire Straits',
      language: 'en'
    },
    async () =>
      responseFromJson({
        results: [
          { title: 'bad', content: 'bad', url: 'javascript:void(0)' },
          { title: 'bad2', content: 'bad2', url: '' }
        ]
      }),
    {
      searxngBaseUrl: 'http://127.0.0.1:8080'
    }
  );

  assert.equal(debug.chords_url, null);
  assert.equal(debug.reason, 'no candidate found');
  assert.equal(debug.search_results_received, 0);
});

test('search deduplicates identical result URLs', async () => {
  let callCount = 0;
  const debug = await searchForChordsUrlWithDebug(
    {
      song_title: 'Different Song',
      artist: 'Other Artist',
      language: 'en'
    },
    async () => {
      callCount += 1;
      if (callCount === 1) {
        return responseFromJson({
          results: [
            {
              title: 'Result 1',
              content: 'chords',
              url: 'https://tabs.ultimate-guitar.com/tab/dire-straits/sultans-of-swing-chords-80492'
            },
            {
              title: 'Result 2',
              content: 'duplicate',
              url: 'https://tabs.ultimate-guitar.com/tab/dire-straits/sultans-of-swing-chords-80492'
            }
          ]
        });
      }

      return responseFromJson({ results: [] });
    },
    {
      searxngBaseUrl: 'http://127.0.0.1:8080'
    }
  );

  assert.equal(debug.chords_url, null);
  assert.equal(debug.duplicate_urls_skipped, 1);
});

test('search stops inspecting allowed candidates after the configured limit', async () => {
  const debug = await searchForChordsUrlWithDebug(
    {
      song_title: 'Different Song',
      artist: 'Other Artist',
      language: 'en'
    },
    async () =>
      responseFromJson({
        results: Array.from({ length: 12 }, (_, index) => ({
          title: `Result ${index + 1}`,
          content: 'chords',
          url: `https://tabs.ultimate-guitar.com/tab/dire-straits/sultans-of-swing-chords-${index + 1}`
        }))
      }),
    {
      searxngBaseUrl: 'http://127.0.0.1:8080',
      searxngMaxResults: 12
    }
  );

  assert.equal(debug.allowed_candidates_inspected, 10);
});

test('search handles timeouts without throwing', async () => {
  const debug = await searchForChordsUrlWithDebug(
    {
      song_title: 'Sultans of Swing',
      artist: 'Dire Straits',
      language: 'en'
    },
    async (url, init) =>
      new Promise((resolve, reject) => {
        const keepAlive = setInterval(() => {}, 1000);
        init.signal.addEventListener('abort', () => {
          clearInterval(keepAlive);
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
    {
      searxngBaseUrl: 'http://127.0.0.1:8080',
      searxngTimeoutMs: 1
    }
  );

  assert.equal(debug.chords_url, null);
  assert.match(debug.search_error, /timeout/i);
});

test('search surfaces a 403 JSON-format hint', async () => {
  const debug = await searchForChordsUrlWithDebug(
    {
      song_title: 'Sultans of Swing',
      artist: 'Dire Straits',
      language: 'en'
    },
    async () =>
      ({
        ok: false,
        status: 403,
        json: async () => ({})
      }),
    {
      searxngBaseUrl: 'http://127.0.0.1:8080'
    }
  );

  assert.equal(debug.chords_url, null);
  assert.equal(debug.search_error, 'SearXNG rejected JSON output. Enable json under search.formats in settings.yml.');
});

test('search surfaces invalid JSON responses', async () => {
  const debug = await searchForChordsUrlWithDebug(
    {
      song_title: 'Sultans of Swing',
      artist: 'Dire Straits',
      language: 'en'
    },
    async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('unexpected token');
      }
    }),
    {
      searxngBaseUrl: 'http://127.0.0.1:8080'
    }
  );

  assert.equal(debug.chords_url, null);
  assert.match(debug.search_error, /invalid JSON/i);
});

test('search surfaces missing results arrays', async () => {
  const debug = await searchForChordsUrlWithDebug(
    {
      song_title: 'Sultans of Swing',
      artist: 'Dire Straits',
      language: 'en'
    },
    async () => responseFromJson({}),
    {
      searxngBaseUrl: 'http://127.0.0.1:8080'
    }
  );

  assert.equal(debug.chords_url, null);
  assert.match(debug.search_error, /missing results array/i);
});

test('resolver fails open when search errors out', async () => {
  const songs = [
    {
      message_id: '1',
      song_title: 'Sultans of Swing',
      artist: 'Dire Straits',
      chords_url: null
    }
  ];

  const result = await resolveChordsUrlsForSongs(songs, {
    fetchImpl: async () => {
      throw new Error('network failed');
    },
    searxngBaseUrl: 'http://127.0.0.1:8080'
  });

  assert.equal(result[0].song_title, 'Sultans of Swing');
  assert.equal(result[0].chords_url, null);
});

test('Tab4U generic song pages under /tabs/songs/ are accepted', async () => {
  const debug = await searchForChordsUrlWithDebug(
    {
      song_title: 'ארץ חדשה',
      artist: 'שלמה ארצי',
      language: 'he'
    },
    async () =>
      responseFromJson({
        results: [
          {
            title: 'ארץ חדשה - שלמה ארצי אקורדים',
            content: 'אקורדים',
            url: 'https://www.tab4u.com/tabs/songs/2794_%D7%A9%D7%9C%D7%9E%D7%94_%D7%90%D7%A8%D7%A6%D7%99_-%D7%90%D7%A8%D7%A5_%D7%97%D7%93%D7%A9%D7%94.html'
          }
        ]
      }),
    {
      searxngBaseUrl: 'http://127.0.0.1:8080'
    }
  );

  assert.equal(debug.chords_url, 'https://www.tab4u.com/tabs/songs/2794_%D7%A9%D7%9C%D7%9E%D7%94_%D7%90%D7%A8%D7%A6%D7%99_-%D7%90%D7%A8%D7%A5_%D7%97%D7%93%D7%A9%D7%94.html');
  assert.equal(debug.reason, 'matched');
});

test('search rejects guitar-tab pages for the correct song', async () => {
  const debug = await searchForChordsUrlWithDebug(
    {
      song_title: 'Sultans of Swing',
      artist: 'Dire Straits',
      language: 'en'
    },
    async () =>
      responseFromJson({
        results: [
          {
            title: 'Sultans of Swing guitar tab',
            content: 'Sultans of Swing guitar tab',
            url: 'https://www.ultimate-guitar.com/tab/dire-straits/sultans-of-swing'
          }
        ]
      }),
    {
      searxngBaseUrl: 'http://127.0.0.1:8080'
    }
  );

  assert.equal(debug.chords_url, null);
  assert.equal(debug.reason, 'tablature page, not chords');
  assert.equal(debug.page_type, 'tabs');
});

test('search accepts a chords page even when the host path contains tabs', async () => {
  const debug = await searchForChordsUrlWithDebug(
    {
      song_title: 'Into the Great Wide Open',
      artist: 'Tom Petty and the Heartbreakers',
      language: 'en'
    },
    async () =>
      responseFromJson({
        results: [
          {
            title: 'Into the Great Wide Open Chords - Ultimate Guitar',
            content: 'chords',
            url: 'https://tabs.ultimate-guitar.com/tab/tom-petty-and-the-heartbreakers/into-the-great-wide-open-chords-80492'
          }
        ]
      }),
    {
      searxngBaseUrl: 'http://127.0.0.1:8080'
    }
  );

  assert.equal(debug.chords_url, 'https://tabs.ultimate-guitar.com/tab/tom-petty-and-the-heartbreakers/into-the-great-wide-open-chords-80492');
  assert.equal(debug.reason, 'matched');
});

test('search rejects unknown pages without chord evidence', async () => {
  const debug = await searchForChordsUrlWithDebug(
    {
      song_title: 'Sultans of Swing',
      artist: 'Dire Straits',
      language: 'en'
    },
    async () =>
      responseFromJson({
        results: [
          {
            title: 'Sultans of Swing',
            content: 'lyrics',
            url: 'https://www.songsterr.com/?pattern=sultans+of+swing'
          }
        ]
      }),
    {
      searxngBaseUrl: 'http://127.0.0.1:8080'
    }
  );

  assert.equal(debug.chords_url, null);
  assert.equal(debug.reason, 'unsupported host');
});

test('search accepts Songsterr song pages under /a/wsa/', async () => {
  const debug = await searchForChordsUrlWithDebug(
    {
      song_title: 'Little wing',
      artist: 'The Jimi Hendrix Experience',
      language: 'en'
    },
    async () =>
      responseFromJson({
        results: [
          {
            title: 'The Jimi Hendrix Experience Bass Tabs | Songsterr Tabs with Rhythm',
            content: 'Songsterr tabs',
            url: 'https://www.songsterr.com/a/wsa/the-jimi-hendrix-experience-tabs-a99690?inst=bass'
          }
        ]
      }),
    {
      searxngBaseUrl: 'http://127.0.0.1:8080'
    }
  );

  assert.equal(debug.chords_url, 'https://www.songsterr.com/a/wsa/the-jimi-hendrix-experience-tabs-a99690?inst=bass');
  assert.equal(debug.reason, 'matched');
});

test('host normalization keeps www and bare hosts equivalent for supported sites', () => {
  const tab4uMatch = explainChordsMatch(
    {
      song_title: 'ארץ חדשה',
      artist: 'שלמה ארצי'
    },
    'https://www.tab4u.com/tabs/songs/2794_%D7%A9%D7%9C%D7%9E%D7%94_%D7%90%D7%A8%D7%A6%D7%99_-%D7%90%D7%A8%D7%A5_%D7%97%D7%93%D7%A9%D7%94.html',
    'ארץ חדשה אקורדים'
  );
  const ugMatch = explainChordsMatch(
    {
      song_title: 'Sultans of Swing',
      artist: 'Dire Straits'
    },
    'https://www.ultimate-guitar.com/tab/dire-straits/sultans-of-swing-chords-80492',
    'Sultans of Swing chords'
  );
  const songsterrMatch = explainChordsMatch(
    {
      song_title: 'Sultans of Swing',
      artist: 'Dire Straits'
    },
    'https://www.songsterr.com/a/wsa/dire-straits-sultans-of-swing',
    'Sultans of Swing chords'
  );
  const tab4uSubdomainMatch = explainChordsMatch(
    {
      song_title: 'ארץ חדשה',
      artist: 'שלמה ארצי'
    },
    'https://en.tab4u.com/tabs/songs/2794_%D7%A9%D7%9C%D7%9E%D7%94_%D7%90%D7%A8%D7%A6%D7%99_-%D7%90%D7%A8%D7%A5_%D7%97%D7%93%D7%A9%D7%94.html',
    'ארץ חדשה אקורדים'
  );
  const guitarSongsMatch = explainChordsMatch(
    {
      song_title: 'Living on the Edge',
      artist: 'Aerosmith'
    },
    'https://www.guitarsongs.club/living-on-the-edge-aerosmith',
    'Living on the Edge chords'
  );

  assert.equal(tab4uMatch.ok, true);
  assert.equal(ugMatch.ok, true);
  assert.equal(songsterrMatch.ok, true);
  assert.equal(tab4uSubdomainMatch.ok, true);
  assert.equal(guitarSongsMatch.ok, true);
});

test('search accepts Songsterr artist names with leading articles', async () => {
  const debug = await searchForChordsUrlWithDebug(
    {
      song_title: 'Little wing',
      artist: 'The Jimi Hendrix Experience',
      language: 'en'
    },
    async () =>
      responseFromJson({
        results: [
          {
            title: 'Little wing chords',
            content: 'chords',
            url: 'https://www.songsterr.com/a/wsa/jimi-hendrix-experience-little-wing-chords-s321'
          }
        ]
      }),
    {
      searxngBaseUrl: 'http://127.0.0.1:8080'
    }
  );

  assert.equal(debug.chords_url, 'https://www.songsterr.com/a/wsa/jimi-hendrix-experience-little-wing-chords-s321');
  assert.equal(debug.reason, 'matched');
});
