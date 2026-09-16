const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SYSTEM_PROMPT,
  FALLBACK_SYSTEM_PROMPT,
  buildAgentPrompt,
  buildFallbackAgentPrompt,
  interpretMessage,
  interpretAdditionConfirmation,
  interpretSongDifficulty,
  interpretPlainFallbackReply,
  polishBanterReply,
  parseExternalSongRecommendation,
  getAgentUsageStats
} = require('../src/llm');

test('SYSTEM_PROMPT stays compact and stable', () => {
  assert.ok(SYSTEM_PROMPT.length < 5300);
  assert.doesNotMatch(SYSTEM_PROMPT, /state\.json|songs\[|migration/i);
  assert.match(SYSTEM_PROMPT, /מתאים לזמר/);
  assert.match(SYSTEM_PROMPT, /מתאים לגיטריסט/);
  assert.match(SYSTEM_PROMPT, /Prefer taking a reasonable search interpretation/);
  assert.match(SYSTEM_PROMPT, /For banter\/off-topic/);
  assert.match(SYSTEM_PROMPT, /never redirect to songs/i);
  assert.match(SYSTEM_PROMPT, /supported_search_fields/);
  assert.match(SYSTEM_PROMPT, /closest supported query parameters/);
  assert.match(SYSTEM_PROMPT, /never use \? or echo\/parrot the user/);
  assert.match(SYSTEM_PROMPT, /Music\/rehearsal riffs only when natural/);
  assert.match(SYSTEM_PROMPT, /fluent, idiomatic casual Hebrew/);
  assert.match(SYSTEM_PROMPT, /fresh punchline/);
});

test('buildAgentPrompt includes reply context without full database payloads', () => {
  const prompt = buildAgentPrompt({
    messageText: '\u05ea\u05d1\u05d9\u05d0 \u05e2\u05d5\u05d3 \u05db\u05de\u05d5 3',
    quotedText: 'Yesterday - The Beatles',
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
  assert.match(prompt, /quoted_message/);
  assert.match(prompt, /Yesterday - The Beatles/);
  assert.match(prompt, /recent_messages/);
  assert.match(prompt, /משהו קצבי/);
  assert.match(SYSTEM_PROMPT, /get_band_failure_reasons/);
  assert.match(SYSTEM_PROMPT, /explain_song_rejection/);
  assert.match(SYSTEM_PROMPT, /update_song/);
  assert.match(SYSTEM_PROMPT, /remove_song/);
  assert.doesNotMatch(prompt, /"songs":\s*\[/);
  assert.doesNotMatch(prompt, /history/i);
});

test('callOpenAiCompatibleChat accepts standard tool calls without JSON mode', async () => {
  const { callOpenAiCompatibleChat } = require('../src/llm');
  let requestBody;
  const result = await callOpenAiCompatibleChat({
    baseUrl: 'https://example.com', apiKey: 'test', model: 'test-model', prompt: 'find this song',
    tools: [{ type: 'function', function: { name: 'lookup_song', parameters: { type: 'object' } } }],
    requestFn: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { tool_calls: [{ id: 'call-1', function: { name: 'lookup_song', arguments: '{"song_title":"Naga"}' } }] } }] };
        }
      };
    }
  });
  assert.equal(requestBody.response_format, undefined);
  assert.equal(requestBody.tools[0].function.name, 'lookup_song');
  assert.deepEqual(result.parsed.tool_calls, [{ id: 'call-1', name: 'lookup_song', arguments: '{"song_title":"Naga"}' }]);
});

test('interpretMessageWithTools executes a local lookup before choosing the final action', async () => {
  const { interpretMessageWithTools } = require('../src/llm');
  const requestBodies = [];
  const toolCalls = [];
  const responses = [
    { choices: [{ message: { tool_calls: [{ id: 'call-1', function: { name: 'lookup_song', arguments: '{"song_title":"Naga Bashamayim","artist":"Mashina"}' } }] } }] },
    { choices: [{ message: { content: '{"action":"get_song_info","song_title":"Naga Bashamayim","artist":"Mashina"}' } }] }
  ];
  const action = await interpretMessageWithTools({
    provider: 'groq', baseUrl: 'https://example.com', apiKey: 'test', model: 'test-model',
    messageText: 'what is the difficulty of Naga Bashamayim by Mashina?', quotedText: '', replyContext: null,
    recentMessages: [], pendingClarification: null, currentDate: '2026-09-16',
    tools: [{ type: 'function', function: { name: 'lookup_song', parameters: { type: 'object' } } }],
    executeToolCall: async (call) => {
      toolCalls.push(call);
      return { ok: true, status: 'found', songs: [{ song_title: 'Naga Bashamayim', artist: 'Mashina', difficulty: 'medium' }] };
    },
    requestFn: async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      return { ok: true, async json() { return responses.shift(); } };
    }
  });

  assert.equal(action.action, 'get_song_info');
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, 'lookup_song');
  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[1].messages.at(-1).role, 'tool');
  assert.match(requestBodies[1].messages.at(-1).content, /"found"/);
});

test('interpretAdditionConfirmation lets the agent classify a natural negative reply', async () => {
  const decision = await interpretAdditionConfirmation({
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: 'אז לא',
    pendingSong: { song_title: 'YYZ', artist: 'Rush', difficulty: 'high' },
    requestFn: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.match(body.messages[0].content, /Interpret natural Hebrew/i);
      assert.match(body.messages[1].content, /אז לא/);
      assert.equal(body.response_format, undefined);
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: 'negative' } }], usage: {} };
        }
      };
    }
  });

  assert.equal(decision, 'negative');
});

test('reviewAgentActionExecution uses text mode and fails closed on an unclear review', async () => {
  const { reviewAgentActionExecution } = require('../src/llm');
  let requestBody;
  const result = await reviewAgentActionExecution({
    baseUrl: 'https://example.com', apiKey: 'test', model: 'test-model',
    messageText: 'what is this song difficulty?',
    action: { action: 'add_song', song: { song_title: 'Wrong Song' } },
    requestFn: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, async json() { return { choices: [{ message: { content: 'clarify' } }] }; } };
    }
  });
  assert.equal(requestBody.response_format, undefined);
  assert.equal(result, 'clarify');
});

test('interpretSongDifficulty uses a dedicated agent assessment without JSON mode', async () => {
  const difficulty = await interpretSongDifficulty({
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    song: { song_title: 'Firth of Fifth', artist: 'Genesis', difficulty: 'medium' },
    requestFn: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.response_format, undefined);
      assert.match(body.messages[0].content, /performance difficulty/i);
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: 'high — demanding instrumental parts' } }], usage: {} };
        }
      };
    }
  });

  assert.equal(difficulty, 'high');
});

test('interpretPlainFallbackReply uses text mode for conversational recovery', async () => {
  const reply = await interpretPlainFallbackReply({
    baseUrl: 'https://api.example.com', apiKey: 'test', model: 'test-model',
    messageText: 'יש לך ערך כלשהו?', quotedText: '',
    requestFn: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.response_format, undefined);
      return { ok: true, async json() { return { choices: [{ message: { content: 'יש לי ערך, פשוט הוא במינוס.' } }], usage: {} }; } };
    }
  });

  assert.equal(reply, 'יש לי ערך, פשוט הוא במינוס.');
});

test('polishBanterReply uses text mode to produce the final Hebrew reply', async () => {
  const reply = await polishBanterReply({
    baseUrl: 'https://api.example.com', apiKey: 'test', model: 'test-model',
    messageText: 'תגיד לזאביק להפסיק לשגע אותך',
    draftReply: 'זאביק, תפסיק לשגע אותי.',
    requestFn: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.response_format, undefined);
      assert.match(body.messages[0].content, /final Hebrew copy editor/);
      return { ok: true, async json() { return { choices: [{ message: { content: 'זאביק, גם למטרונום יש יותר מודעות עצמית.' } }], usage: {} }; } };
    }
  });
  assert.equal(reply, 'זאביק, גם למטרונום יש יותר מודעות עצמית.');
});

test('parseExternalSongRecommendation accepts natural text alternatives to tabs', () => {
  assert.deepEqual(
    parseExternalSongRecommendation('Hysteria - Muse: קו בס בולט ואנרגיה גבוהה.'),
    { song_title: 'Hysteria', artist: 'Muse', reason: 'קו בס בולט ואנרגיה גבוהה.' }
  );
  assert.deepEqual(
    parseExternalSongRecommendation('Hysteria | Muse | קו בס בולט ואנרגיה גבוהה.'),
    { song_title: 'Hysteria', artist: 'Muse', reason: 'קו בס בולט ואנרגיה גבוהה.' }
  );
  assert.deepEqual(
    parseExternalSongRecommendation('Hysteria<TAB>Muse<TAB>קו בס בולט ואנרגיה גבוהה.'),
    { song_title: 'Hysteria', artist: 'Muse', reason: 'קו בס בולט ואנרגיה גבוהה.' }
  );
});

test('buildFallbackAgentPrompt keeps only compact context', () => {
  const prompt = buildFallbackAgentPrompt({
    messageText: 'תביא שירים של רוקפור',
    quotedText: 'מוזיקה ישראלית',
    replyContext: {
      results: [{ index: 2, song_id: 'song_b', title: 'חור בלבנה', artist: 'Rockfour' }]
    },
    currentDate: '2026-08-11'
  });

  assert.match(prompt, /quoted_message/);
  assert.match(prompt, /reply_context/);
  assert.doesNotMatch(prompt, /supported_search_fields/);
  assert.doesNotMatch(prompt, /recent_messages/);
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

test('interpretMessage rewrites rehearsal planning clarifications into prepare_rehearsal with default duration', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: 'בוט תכין רשימת שירים לחזרה הבאה',
    replyContext: null,
    recentMessages: [],
    currentDate: '2026-08-12',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'clarify',
                  question: 'איזה שירים אתה רוצה?'
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'prepare_rehearsal');
  assert.equal(action.duration_minutes, 180);
});

test('interpretMessage rewrites rehearsal search requests into prepare_rehearsal with explicit duration and query', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: 'בוט תכין רשימת שירים לחזרה הקרובה של 4 שעות בסגנון רוק שכיף לנגן',
    replyContext: null,
    recentMessages: [],
    currentDate: '2026-08-12',
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
                      genres: ['rock']
                    },
                    preferences: {
                      band_energy: 'high'
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

  assert.equal(action.action, 'prepare_rehearsal');
  assert.equal(action.duration_minutes, 240);
  assert.deepEqual(action.query.requirements.genres, ['rock']);
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

test('interpretMessage rewrites clarify into add_song for explicit add requests with song and artist', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: 'תוסיף wish you where here של pink floyd',
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
                  action: 'clarify',
                  question: 'איזה שירים אתה רוצה?'
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'add_song');
  assert.equal(action.song.song_title, 'wish you where here');
  assert.equal(action.song.artist, 'pink floyd');
});

test('interpretMessage repairs incomplete add_song payloads from explicit add requests', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: 'תוסיף wish you where here של pink floyd',
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
                  action: 'add_song',
                  song: {
                    song_title: '',
                    artist: 'pink floyd'
                  }
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'add_song');
  assert.equal(action.song.song_title, 'wish you where here');
  assert.equal(action.song.artist, 'pink floyd');
});

test('interpretMessage preserves the agent resolution of artist-title shorthand', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: 'בוט תוסיף sting -its probably me',
    replyContext: null,
    recentMessages: [],
    currentDate: '2026-08-11',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [{
            message: {
              content: JSON.stringify({ action: 'add_song', song: { song_title: 'its probably me', artist: 'sting' } })
            }
          }]
        };
      }
    })
  });

  assert.equal(action.action, 'add_song');
  assert.equal(action.song.artist, 'sting');
  assert.equal(action.song.song_title, 'its probably me');
});

test('interpretMessage removes the recognized artist from a dashed title left intact by the model', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: 'add Sting - Its Probably Me',
    replyContext: null,
    recentMessages: [],
    currentDate: '2026-08-11',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                action: 'add_song',
                song: { song_title: 'Sting - Its Probably Me', artist: 'Sting' }
              })
            }
          }]
        };
      }
    })
  });

  assert.equal(action.song.song_title, 'Its Probably Me');
  assert.equal(action.song.artist, 'Sting');
});

test('interpretMessage retries a duplicated identity in shorthand and accepts the corrected resolution', async () => {
  let callCount = 0;
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: 'בוט תוסיף sting - its probably me',
    replyContext: null,
    recentMessages: [],
    currentDate: '2026-08-11',
    requestFn: async () => {
      callCount += 1;
      const song = callCount === 1
        ? { song_title: 'its probably me', artist: 'its probably me' }
        : { song_title: 'its probably me', artist: 'sting' };
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: JSON.stringify({ action: 'add_song', song }) } }] };
        }
      };
    }
  });

  assert.equal(callCount, 2);
  assert.equal(action.song.artist, 'sting');
  assert.equal(action.song.song_title, 'its probably me');
});

test('interpretMessage trusts the explicit Hebrew title-artist separator over a conflicting model guess', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: 'בוט תוסיף הללויה של משה',
    replyContext: null,
    recentMessages: [],
    currentDate: '2026-08-11',
    requestFn: async () => ({
      ok: true,
      async json() {
        return {
          choices: [{
            message: { content: JSON.stringify({ action: 'add_song', song: { song_title: 'משה', artist: 'הללויה' } }) }
          }]
        };
      }
    })
  });

  assert.equal(action.song.song_title, 'הללויה');
  assert.equal(action.song.artist, 'משה');
});

test('interpretMessage completes an add after an artist-only reply to the bot question', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: 'Sting',
    quotedText: '‏🤖 מי המבצע של "Its Probably Me"?',
    replyContext: null,
    recentMessages: [],
    currentDate: '2026-08-11',
    requestFn: async () => ({
      ok: true,
      async json() {
        return { choices: [{ message: { content: JSON.stringify({ action: 'search_songs', query: {} }) } }] };
      }
    })
  });

  assert.equal(action.action, 'add_song');
  assert.equal(action.song.song_title, 'Its Probably Me');
  assert.equal(action.song.artist, 'Sting');
});

test('interpretMessage splits a dashed quoted title after the user supplies its artist', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: 'Rush',
    quotedText: '🤖 Who is the artist of "YYZ - Rush"?',
    replyContext: null,
    recentMessages: [],
    currentDate: '2026-08-11',
    requestFn: async () => ({
      ok: true,
      async json() {
        return { choices: [{ message: { content: JSON.stringify({ action: 'search_songs', query: {} }) } }] };
      }
    })
  });

  assert.equal(action.action, 'add_song');
  assert.equal(action.song.song_title, 'YYZ');
  assert.equal(action.song.artist, 'Rush');
});

test('interpretMessage retries after a locally invalid add_song payload and recovers with the compact prompt', async () => {
  let callCount = 0;
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: 'תוסיף With A Little Help From My Friends',
    replyContext: null,
    recentMessages: [],
    currentDate: '2026-08-11',
    requestFn: async () => {
      callCount += 1;
      const content = callCount === 1
        ? { action: 'add_song', song: {} }
        : { action: 'add_song', song: { song_title: 'With A Little Help From My Friends', artist: 'Joe Cocker' } };
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: JSON.stringify(content) } }] };
        }
      };
    }
  });

  assert.equal(callCount, 2);
  assert.equal(action.action, 'add_song');
  assert.equal(action.song.song_title, 'With A Little Help From My Friends');
});

test('interpretMessage returns a useful clarification rather than throwing after two invalid add_song payloads', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: 'תוסיף With A Little Help From My Friends',
    replyContext: null,
    recentMessages: [],
    currentDate: '2026-08-11',
    requestFn: async () => ({
      ok: true,
      async json() {
        return { choices: [{ message: { content: JSON.stringify({ action: 'add_song', song: {} }) } }] };
      }
    })
  });

  assert.equal(action.action, 'clarify');
  assert.match(action.question, /מי המבצע/u);
});

test('interpretMessage preserves an agent-generated conversational statement', async () => {
  const question = 'רק עושה סאונדצ׳ק לנשמה 😄';
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: 'בוט אתה בשוק ממני?',
    replyContext: null,
    recentMessages: [],
    currentDate: '2026-08-11',
    requestFn: async () => ({
      ok: true,
      async json() {
        return { choices: [{ message: { content: JSON.stringify({ action: 'clarify', question }) } }] };
      }
    })
  });

  assert.equal(action.action, 'clarify');
  assert.equal(action.question, question);
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

test('interpretMessage retries once with compact prompt after json_validate_failed', async () => {
  let callCount = 0;
  const systemPrompts = [];
  const userPrompts = [];

  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: 'תביא שירים של רוקפור',
    quotedText: '',
    replyContext: null,
    recentMessages: [],
    currentDate: '2026-08-11',
    requestFn: async (_url, options) => {
      callCount += 1;
      const payload = JSON.parse(options.body);
      systemPrompts.push(payload.messages[0].content);
      userPrompts.push(payload.messages[1].content);

      if (callCount === 1) {
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          headers: {
            get() {
              return null;
            }
          },
          async text() {
            return JSON.stringify({
              error: {
                code: 'json_validate_failed',
                message: 'Failed to validate JSON.'
              }
            });
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
                      requirements: {
                        artist: 'Rockfour'
                      },
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
      };
    }
  });

  assert.equal(callCount, 2);
  assert.equal(systemPrompts[0], SYSTEM_PROMPT);
  assert.equal(systemPrompts[1], FALLBACK_SYSTEM_PROMPT);
  assert.match(userPrompts[0], /supported_search_fields/);
  assert.doesNotMatch(userPrompts[1], /supported_search_fields/);
  assert.equal(action.action, 'search_songs');
  assert.equal(action.query.requirements.artist, 'רוקפור');
});

test('interpretMessage rewrites replacement follow-ups into replacement search queries', async () => {
  const action = await interpretMessage({
    provider: 'groq',
    baseUrl: 'https://api.example.com',
    apiKey: 'test',
    model: 'test-model',
    messageText: 'תחליף את 2,5,7',
    quotedText: '',
    replyContext: {
      results: [
        { index: 1, song_id: 'song_a', title: 'Zombie', artist: 'The Cranberries' },
        { index: 2, song_id: 'song_b', title: 'Dreams', artist: 'The Cranberries' },
        { index: 5, song_id: 'song_e', title: '1979', artist: 'The Smashing Pumpkins' },
        { index: 7, song_id: 'song_g', title: 'Alive', artist: 'Pearl Jam' }
      ]
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
                  action: 'clarify',
                  question: 'איזה שירים אתה רוצה?'
                })
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(action.action, 'search_songs');
  assert.deepEqual(action.query.replace_result_indexes, [2, 5, 7]);
  assert.equal(action.query.avoid_previous_results, true);
  assert.equal(action.query.limit, 3);
});
