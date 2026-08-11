const test = require('node:test');
const assert = require('node:assert/strict');

const { SYSTEM_PROMPT, buildAgentPrompt, interpretMessage, getAgentUsageStats } = require('../src/llm');

test('SYSTEM_PROMPT stays compact and stable', () => {
  assert.ok(SYSTEM_PROMPT.length < 5200);
  assert.doesNotMatch(SYSTEM_PROMPT, /state\.json|songs\[|migration/i);
  assert.match(SYSTEM_PROMPT, /מתאים לזמר/);
  assert.match(SYSTEM_PROMPT, /מתאים לגיטריסט/);
  assert.match(SYSTEM_PROMPT, /Prefer taking a reasonable search interpretation/);
  assert.match(SYSTEM_PROMPT, /Use clarify only when execution would be unsafe or impossible/);
  assert.match(SYSTEM_PROMPT, /supported_search_fields/);
  assert.match(SYSTEM_PROMPT, /closest supported query parameters/);
});

test('buildAgentPrompt includes reply context without full database payloads', () => {
  const prompt = buildAgentPrompt({
    messageText: '\u05ea\u05d1\u05d9\u05d0 \u05e2\u05d5\u05d3 \u05db\u05de\u05d5 3',
    recentMessages: [
      { text: '\u05de\u05e9\u05d4\u05d5 \u05e7\u05e6\u05d1\u05d9', from_me: false, sender: 'Member A' },
      { text: '\u05dc\u05d0 \u05de\u05d8\u05d0\u05dc', from_me: false, sender: 'Member B' }
    ],
    replyContext: {
      results: [{ index: 3, song_id: 'song_a', title: 'Zombie', artist: 'The Cranberries' }]
    },
    currentDate: '2026-08-08'
  });

  assert.match(prompt, /reply_context/);
  assert.match(prompt, /supported_search_fields/);
  assert.match(prompt, /bass_interest/);
  assert.match(prompt, /groove_level/);
  assert.match(prompt, /"index":3/);
  assert.match(prompt, /"song_id":"song_a"/);
  assert.match(prompt, /recent_messages/);
  assert.match(prompt, /משהו קצבי/);
  assert.match(SYSTEM_PROMPT, /get_band_failure_reasons/);
  assert.match(SYSTEM_PROMPT, /explain_song_rejection/);
  assert.match(SYSTEM_PROMPT, /update_song/);
  assert.match(SYSTEM_PROMPT, /remove_song/);
  assert.doesNotMatch(prompt, /"songs":\s*\[/);
  assert.doesNotMatch(prompt, /history/i);
});

test('interpretMessage validates the structured response from the provider', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05ea\u05df 5 \u05e9\u05d9\u05e8\u05d9 \u05e8\u05d5\u05e7',
    replyContext: null,
    recentMessages: [],
    currentDate: '2026-08-08',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'search_songs',
                  query: {
                    requirements: { genres: ['rock'] },
                    preferences: {},
                    exclusions: {},
                    limit: 5
                  }
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'search_songs');
  assert.equal(action.query.limit, 5);
});

test('interpretMessage infers requested song count from Hebrew quantity phrases', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05ea\u05d1\u05d9\u05d0 \u05e9\u05dc\u05d5\u05e9\u05d4 \u05e9\u05d9\u05e8\u05d9\u05dd \u05de\u05d2\u05e0\u05d9\u05d1\u05d9\u05dd',
    replyContext: null,
    recentMessages: [],
    currentDate: '2026-08-08',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'search_songs',
                  query: {
                    preferences: { band_energy: 'high' }
                  }
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'search_songs');
  assert.equal(action.query.limit, 3);
});

test('interpretMessage infers a single result for singular song phrasing', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05ea\u05d1\u05d9\u05d0 \u05e9\u05d9\u05e8 \u05e9\u05de\u05ea\u05d0\u05d9\u05dd \u05dc\u05d6\u05de\u05e8\u05ea',
    replyContext: null,
    recentMessages: [],
    currentDate: '2026-08-08',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'search_songs',
                  query: {
                    preferences: { singer_fit: 'great' }
                  }
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'search_songs');
  assert.equal(action.query.limit, 1);
});

test('interpretMessage accepts update_song corrections by result index for title fixes', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05ea\u05ea\u05e7\u05df \u05d0\u05ea 3 \u05dc-Sultans of Swing',
    replyContext: {
      results: [{ index: 3, song_id: 'song_a', title: 'Sultan of swing', artist: 'Dire Straits' }]
    },
    currentDate: '2026-08-08',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'update_song',
                  result_index: 3,
                  updates: {
                    song_title: 'Sultans of Swing'
                  }
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'update_song');
  assert.equal(action.result_index, 3);
  assert.equal(action.updates.song_title, 'Sultans of Swing');
});

test('interpretMessage accepts update_song corrections by result index for artist fixes', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05d4\u05d0\u05de\u05df \u05e9\u05dc 2 \u05d4\u05d5\u05d0 The Cranberries',
    replyContext: {
      results: [{ index: 2, song_id: 'song_b', title: 'Zombie', artist: 'Cranberries' }]
    },
    currentDate: '2026-08-08',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'update_song',
                  result_index: 2,
                  updates: {
                    artist: 'The Cranberries'
                  }
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'update_song');
  assert.equal(action.result_index, 2);
  assert.equal(action.updates.artist, 'The Cranberries');
});

test('interpretMessage repairs malformed update_song updates using the correction text', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: 'תקן את 4 ל רד מעל מסך הטלויזיה שלי של פורטיס',
    replyContext: {
      results: [{ index: 4, song_id: 'song_d', title: 'רד מעל הטלויזיה שלי', artist: 'פורטיסחרוף' }]
    },
    recentMessages: [],
    currentDate: '2026-08-11',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'update_song',
                  result_index: 4,
                  updates: []
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'update_song');
  assert.equal(action.result_index, 4);
  assert.equal(action.updates.song_title, 'רד מעל מסך הטלויזיה שלי');
  assert.equal(action.updates.artist, 'פורטיס');
});

test('interpretMessage uses the last "של" as the artist separator in update_song corrections', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: 'תקן את 2 ל שיר של יום חולין של מאיר אריאל',
    replyContext: {
      results: [{ index: 2, song_id: 'song_b', title: 'שיר', artist: 'אמן שגוי' }]
    },
    recentMessages: [],
    currentDate: '2026-08-11',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'update_song',
                  result_index: 2,
                  updates: []
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'update_song');
  assert.equal(action.result_index, 2);
  assert.equal(action.updates.song_title, 'שיר של יום חולין');
  assert.equal(action.updates.artist, 'מאיר אריאל');
});

test('interpretMessage flags fresh follow-up searches to avoid previous results', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05ea\u05d1\u05d9\u05d0 \u05e2\u05d5\u05d3 \u05e9\u05dc\u05d5\u05e9\u05d4 \u05e9\u05d9\u05e8\u05d9\u05dd',
    replyContext: {
      results: [{ index: 1, song_id: 'song_a', title: 'Zombie', artist: 'The Cranberries' }]
    },
    currentDate: '2026-08-08',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'search_songs',
                  query: {}
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'search_songs');
  assert.equal(action.query.limit, 3);
  assert.equal(action.query.avoid_previous_results, true);
});

test('interpretMessage infers artist constraints from "songs by" phrasing', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05ea\u05d1\u05d9\u05d0 \u05e9\u05d9\u05e8\u05d9\u05dd \u05e9\u05dc Pink Floyd',
    replyContext: null,
    currentDate: '2026-08-08',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'search_songs',
                  query: {}
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'search_songs');
  assert.equal(action.query.requirements.artist, 'Pink Floyd');
});

test('interpretMessage canonicalizes common Hebrew artist names into English artist constraints', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05ea\u05d1\u05d9\u05d0 \u05e9\u05d9\u05e8\u05d9\u05dd \u05e9\u05dc \u05e4\u05d9\u05e0\u05e7 \u05e4\u05dc\u05d5\u05d9\u05d3',
    replyContext: null,
    currentDate: '2026-08-08',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'search_songs',
                  query: {}
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'search_songs');
  assert.equal(action.query.requirements.artist, 'Pink Floyd');
});

test('interpretMessage infers artist constraints from bare "של <artist>" phrasing', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: 'של החברים של נטאשה',
    replyContext: null,
    recentMessages: [],
    currentDate: '2026-08-11',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'search_songs',
                  query: {}
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'search_songs');
  assert.equal(action.query.requirements.artist, 'החברים של נטאשה');
});

test('interpretMessage overrides transliterated artist output with Hebrew artist inferred from the message', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: 'תביא שירים של פורטיס',
    replyContext: null,
    recentMessages: [],
    currentDate: '2026-08-11',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'search_songs',
                  query: {
                    requirements: {
                      artist: 'Portis'
                    }
                  }
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'search_songs');
  assert.equal(action.query.requirements.artist, 'פורטיס');
});

test('interpretMessage overrides transliterated Hebrew artist variants with the original Hebrew phrasing', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: 'תביא שירים של נטאשה',
    replyContext: null,
    recentMessages: [],
    currentDate: '2026-08-11',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'search_songs',
                  query: {
                    requirements: {
                      artist: 'Netasha'
                    }
                  }
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'search_songs');
  assert.equal(action.query.requirements.artist, 'נטאשה');
});

test('interpretMessage preserves canonical English artist mappings for known Hebrew names', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: 'תביא שירים של פינק פלויד',
    replyContext: null,
    recentMessages: [],
    currentDate: '2026-08-11',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'search_songs',
                  query: {
                    requirements: {
                      artist: 'Pink Floyd'
                    }
                  }
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'search_songs');
  assert.equal(action.query.requirements.artist, 'Pink Floyd');
});

test('interpretMessage infers Hebrew language constraints from the message text', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05d1\u05d5\u05d8 \u05ea\u05d1\u05d9\u05d0 3 \u05e9\u05d9\u05e8\u05d9\u05dd \u05d1\u05e2\u05d1\u05e8\u05d9\u05ea',
    replyContext: null,
    currentDate: '2026-08-08',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'search_songs',
                  query: {}
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'search_songs');
  assert.equal(action.query.limit, 3);
  assert.equal(action.query.requirements.language, 'he');
});

test('interpretMessage infers genre constraints from explicit blues requests', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05d1\u05d5\u05d8 \u05ea\u05d1\u05d9\u05d0 \u05e9\u05d9\u05e8 \u05d1\u05dc\u05d5\u05d6',
    replyContext: null,
    currentDate: '2026-08-08',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'search_songs',
                  query: {}
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'search_songs');
  assert.deepEqual(action.query.requirements.genres, ['blues']);
});

test('interpretMessage infers drum difficulty preferences from hard drumming requests', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05d1\u05d5\u05d8 \u05ea\u05d1\u05d9\u05d0 \u05e9\u05d9\u05e8 \u05e2\u05dd \u05ea\u05d9\u05e4\u05d5\u05e3 \u05e7\u05e9\u05d4',
    replyContext: null,
    currentDate: '2026-08-08',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'search_songs',
                  query: {}
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'search_songs');
  assert.equal(action.query.preferences.drums_difficulty, 'high');
});

test('interpretMessage infers guitar difficulty preferences from hard guitar requests', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05d1\u05d5\u05d8 \u05ea\u05d1\u05d9\u05d0 \u05e9\u05d9\u05e8 \u05e2\u05dd \u05d2\u05d9\u05d8\u05e8\u05d4 \u05e7\u05e9\u05d4',
    replyContext: null,
    currentDate: '2026-08-08',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'search_songs',
                  query: {}
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'search_songs');
  assert.equal(action.query.preferences.guitar_difficulty, 'high');
});

test('interpretMessage infers bass difficulty preferences from hard bass requests', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05d1\u05d5\u05d8 \u05ea\u05d1\u05d9\u05d0 \u05e9\u05d9\u05e8 \u05e2\u05dd \u05d1\u05e1 \u05e7\u05e9\u05d4',
    replyContext: null,
    currentDate: '2026-08-08',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'search_songs',
                  query: {}
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'search_songs');
  assert.equal(action.query.preferences.bass_difficulty, 'high');
});

test('interpretMessage preserves agent-provided keyboard type constraints', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05d1\u05d5\u05d8 \u05ea\u05d1\u05d9\u05d0 \u05e9\u05d9\u05e8 \u05dc\u05e4\u05e1\u05e0\u05ea\u05e8 \u05e7\u05e9\u05d4',
    replyContext: null,
    currentDate: '2026-08-09',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'search_songs',
                  query: {
                    requirements: {
                      keys_type_any: ['piano']
                    },
                    preferences: {
                      keys_difficulty: 'high'
                    }
                  }
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'search_songs');
  assert.deepEqual(action.query.requirements.keys_type_any, ['piano']);
  assert.equal(action.query.preferences.keys_difficulty, 'high');
});

test('interpretMessage does not invent keyboard type constraints from the raw message when the agent does not provide them', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05d1\u05d5\u05d8 \u05ea\u05d1\u05d9\u05d0 \u05e9\u05d9\u05e8 \u05dc\u05e4\u05e1\u05e0\u05ea\u05e8',
    replyContext: null,
    currentDate: '2026-08-09',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'search_songs',
                  query: {}
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'search_songs');
  assert.equal(action.query.limit, 1);
  assert.equal(action.query.requirements?.keys_type_any, undefined);
  assert.equal(action.query.preferences?.keys_difficulty, undefined);
});

test('interpretMessage infers female vocal fit preferences from singer phrasing', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05d1\u05d5\u05d8 \u05ea\u05d1\u05d9\u05d0 \u05e9\u05d9\u05e8 \u05e9\u05de\u05ea\u05d0\u05d9\u05dd \u05dc\u05d6\u05de\u05e8\u05ea',
    replyContext: null,
    currentDate: '2026-08-08',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'search_songs',
                  query: {}
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'search_songs');
  assert.equal(action.query.preferences.original_vocal, 'female');
  assert.equal(action.query.preferences.singer_fit, 'great');
});

test('interpretMessage normalizes short feedback into update_song_feedback updates', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05e9\u05d9\u05e8 1 \u05d4\u05d5\u05d0 \u05e7\u05e9\u05d4',
    replyContext: {
      results: [{ index: 1, song_id: 'song_a', title: 'Zombie', artist: 'The Cranberries' }]
    },
    currentDate: '2026-08-08',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'update_song_feedback'
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'update_song_feedback');
  assert.equal(action.updates.length, 1);
  assert.equal(action.updates[0].result_index, 1);
  assert.deepEqual(action.updates[0].issues, ['too_hard']);
});

test('interpretMessage infers positive fit for rehearsal-success feedback', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05d4\u05d9\u05d4 \u05db\u05d9\u05e3 \u05dc\u05e0\u05d2\u05df \u05d0\u05ea \u05d4\u05e9\u05d9\u05e8 \u05e9\u05d4\u05d1\u05d0\u05ea',
    replyContext: {
      results: [{ index: 1, song_id: 'song_a', title: 'Zombie', artist: 'The Cranberries' }]
    },
    currentDate: '2026-08-08',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'update_song_feedback',
                  result_index: 1
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'update_song_feedback');
  assert.equal(action.updates[0].result_index, 1);
  assert.equal(action.updates[0].fit, 'good');
});

test('interpretMessage infers bad fit for "too hard for us" feedback', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05e9\u05d9\u05e8 4 \u05e7\u05e9\u05d4 \u05dc\u05e0\u05d5',
    replyContext: {
      results: [{ index: 4, song_id: 'song_d', title: '21st Century Schizoid Man', artist: 'April Wine' }]
    },
    currentDate: '2026-08-08',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'update_song_feedback',
                  result_index: 4
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'update_song_feedback');
  assert.equal(action.updates[0].result_index, 4);
  assert.equal(action.updates[0].fit, 'bad');
  assert.deepEqual(action.updates[0].issues, ['too_hard']);
});

test('interpretMessage repairs malformed update entries using the message result index', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05e9\u05d9\u05e8 4 \u05e7\u05dc \u05de\u05d3\u05d9',
    replyContext: {
      results: [{ index: 4, song_id: 'song_d', title: 'Another Brick in the wall', artist: 'Pink Floyd' }]
    },
    currentDate: '2026-08-08',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'update_song_feedback',
                  updates: [
                    {
                      result_index: '',
                      issues: ['too_easy']
                    }
                  ]
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'update_song_feedback');
  assert.equal(action.updates[0].result_index, 4);
  assert.equal(action.updates[0].fit, 'maybe');
  assert.deepEqual(action.updates[0].issues, ['too_easy']);
});

test('interpretMessage treats "easy for us to play" as positive feedback', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05e9\u05d9\u05e8 5 \u05e7\u05dc \u05dc\u05e0\u05d5 \u05dc\u05e0\u05d2\u05df',
    replyContext: {
      results: [{ index: 5, song_id: 'song_e', title: 'Black night', artist: 'Deep Purple' }]
    },
    currentDate: '2026-08-08',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'update_song_feedback',
                  result_index: 5
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'update_song_feedback');
  assert.equal(action.updates[0].result_index, 5);
  assert.equal(action.updates[0].fit, 'good');
  assert.deepEqual(action.updates[0].issues, []);
});

test('interpretMessage treats "too easy" feedback as non-negative', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05e9\u05d9\u05e8 2 \u05e7\u05dc \u05de\u05d3\u05d9',
    replyContext: {
      results: [{ index: 2, song_id: 'song_b', title: '1979', artist: 'The Smashing Pumpkins' }]
    },
    currentDate: '2026-08-08',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'update_song_feedback',
                  result_index: 2,
                  fit: 'bad'
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'update_song_feedback');
  assert.equal(action.updates[0].result_index, 2);
  assert.equal(action.updates[0].fit, 'maybe');
  assert.deepEqual(action.updates[0].issues, ['too_easy']);
});

test('interpretMessage treats challenging but enjoyable feedback as maybe instead of unknown', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05e9\u05d9\u05e8 1 \u05d4\u05d9\u05d4 \u05de\u05d0\u05ea\u05d2\u05e8 \u05d0\u05d1\u05dc \u05e0\u05d4\u05e0\u05d5 \u05dc\u05e0\u05d2\u05df',
    replyContext: {
      results: [{ index: 1, song_id: 'song_a', title: 'A Day in the Life', artist: 'The Beatles' }]
    },
    currentDate: '2026-08-08',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'update_song_feedback',
                  result_index: 1
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'update_song_feedback');
  assert.equal(action.updates[0].result_index, 1);
  assert.equal(action.updates[0].fit, 'maybe');
  assert.deepEqual(action.updates[0].issues, ['too_hard']);
});

test('interpretMessage treats bare worked feedback as good even when the model says bad', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05e9\u05d9\u05e8 1 \u05e2\u05d1\u05d3',
    replyContext: {
      results: [{ index: 1, song_id: 'song_a', title: 'Another Brick in the wall', artist: 'Pink Floyd' }]
    },
    currentDate: '2026-08-08',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'update_song_feedback',
                  result_index: 1,
                  fit: 'bad'
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'update_song_feedback');
  assert.equal(action.updates[0].result_index, 1);
  assert.equal(action.updates[0].fit, 'good');
  assert.deepEqual(action.updates[0].issues, []);
});

test('interpretMessage treats "did not work for us" feedback as bad instead of unknown', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05d1\u05d5\u05d8 \u05e9\u05d9\u05e8 2 \u05dc\u05d0 \u05d4\u05dc\u05da \u05dc\u05e0\u05d5',
    replyContext: {
      results: [{ index: 2, song_id: 'song_b', title: '21st Century Schizoid Man', artist: 'April Wine' }]
    },
    currentDate: '2026-08-09',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'update_song_feedback',
                  result_index: 2
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'update_song_feedback');
  assert.equal(action.updates[0].result_index, 2);
  assert.equal(action.updates[0].fit, 'bad');
  assert.deepEqual(action.updates[0].issues, ['doesnt_groove']);
});

test('interpretMessage retries one rate limit response and records usage counters', async () => {
  let callCount = 0;
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: '\u05ea\u05df \u05dc\u05d9 \u05de\u05e9\u05d4\u05d5 \u05e7\u05e6\u05d1\u05d9',
    replyContext: null,
    currentDate: '2026-08-08',
    maxRetries: 1,
    requestFn: async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: {
            get(name) {
              return name.toLowerCase() === 'retry-after' ? '0' : null;
            }
          },
          async text() {
            return 'rate limited';
          }
        };
      }

      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: 'search_songs',
                    query: {
                      requirements: {},
                      preferences: {},
                      exclusions: {},
                      limit: 5
                    }
                  })
                }
              }
            ],
            usage: {
              prompt_tokens: 120,
              completion_tokens: 40,
              total_tokens: 160,
              prompt_tokens_details: {
                cached_tokens: 80
              }
            }
          };
        }
      };
    }
  });

  const stats = getAgentUsageStats();
  assert.equal(callCount, 2);
  assert.equal(action.action, 'search_songs');
  assert.ok(stats.dayCalls >= 1);
  assert.ok(stats.dayInputTokens >= 120);
  assert.ok(stats.dayCachedTokens >= 80);
  assert.ok(stats.rateLimitResponses >= 1);
});
