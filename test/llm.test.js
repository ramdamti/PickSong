const test = require('node:test');
const assert = require('node:assert/strict');

const { SYSTEM_PROMPT, buildAgentPrompt, interpretMessage, getAgentUsageStats } = require('../src/llm');

test('SYSTEM_PROMPT stays compact and stable', () => {
  assert.ok(SYSTEM_PROMPT.length < 2600);
  assert.doesNotMatch(SYSTEM_PROMPT, /state\.json|songs\[|migration/i);
  assert.match(SYSTEM_PROMPT, /מתאים לזמר/);
  assert.match(SYSTEM_PROMPT, /מתאים לגיטריסט/);
  assert.match(SYSTEM_PROMPT, /Prefer taking a reasonable search interpretation/);
  assert.match(SYSTEM_PROMPT, /Use clarify only when execution would be unsafe or impossible/);
});

test('buildAgentPrompt includes reply context without full database payloads', () => {
  const prompt = buildAgentPrompt({
    messageText: '\u05ea\u05d1\u05d9\u05d0 \u05e2\u05d5\u05d3 \u05db\u05de\u05d5 3',
    replyContext: {
      results: [{ index: 3, song_id: 'song_a', title: 'Zombie', artist: 'The Cranberries' }]
    },
    currentDate: '2026-08-08'
  });

  assert.match(prompt, /reply_context/);
  assert.match(prompt, /"index": 3/);
  assert.match(prompt, /"song_id": "song_a"/);
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
