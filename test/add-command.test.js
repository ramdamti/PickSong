const test = require('node:test');
const assert = require('node:assert/strict');

const { handleAgentMessage, executeAgentAction } = require('../src/main');
const BOT_PREFIX = '\u200F🤖 ';

function createSong(overrides = {}) {
  return {
    message_id: 'import-1',
    source_text: 'Zombie',
    song_title: 'Zombie',
    artist: 'The Cranberries',
    language: 'en',
    confidence: 0.95,
    genres: ['rock', 'alternative rock'],
    difficulty: 'medium',
    feel: 'upbeat',
    used: false,
    created_at: '2026-08-08T00:00:00.000Z',
    normalized_title: 'zombie',
    normalized_artist: 'the cranberries',
    song_id: 'song_a',
    ai_metadata: {
      original_vocal: 'female',
      vocal_range: 'medium-high',
      vocal_style: ['rock'],
      singer_fit: 'great',
      vocal_energy: 'high',
      band_energy: 'high',
      crowd_friendly: true,
      groove_level: 'medium',
      guitar_difficulty: 'low',
      bass_difficulty: 'low',
      drums_difficulty: 'medium',
      keys_role: 'optional',
      keys_type: [],
      keys_difficulty: 'low',
      bass_interest: 'medium'
    },
    band_status: {
      fit: 'unknown',
      issues: [],
      notes: '',
      attempts: 0,
      last_reviewed: null,
      last_rehearsed: null,
      last_played: null
    },
    ...overrides
  };
}

test('handleAgentMessage routes wake-word add_song requests through the agent', async () => {
  const sentMessages = [];
  const stateStore = {
    addSong(song) {
      this.song = song;
      return true;
    },
    async queueSave() {},
    getSongs() {
      return [];
    },
    getResultMessage() {
      return null;
    },
    getLastResults() {
      return null;
    }
  };
  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
      return { id: { _serialized: 'wamid-1' } };
    }
  };

  await handleAgentMessage({
    chat,
    stateStore,
    config: {
      triggerText: '\u05d1\u05d5\u05d8',
      llmProvider: 'groq',
      llmBaseUrl: 'https://example.com',
      llmApiKey: 'test',
      llmModel: 'test-model'
    },
    record: {
      text: '\u05d1\u05d5\u05d8 \u05ea\u05d5\u05e1\u05d9\u05e3 \u05d0\u05ea Zombie \u05e9\u05dc The Cranberries',
      quoted: { fromMe: false },
      chatId: 'chat-1'
    },
    interpretMessageFn: async () => ({
      action: 'add_song',
      song: createSong({ song_id: 'song_new' })
    })
  });

  assert.equal(stateStore.song.song_title, 'Zombie');
  assert.deepEqual(sentMessages, [`${BOT_PREFIX}\u05d4\u05d5\u05e1\u05e4\u05ea\u05d9: Zombie - The Cranberries`]);
});

test('handleAgentMessage accepts sparse add_song payloads for explicit add requests', async () => {
  const sentMessages = [];
  const stateStore = {
    addSong(song) {
      this.song = song;
      return true;
    },
    async queueSave() {},
    getSongs() {
      return [];
    },
    getResultMessage() {
      return null;
    },
    getLastResults() {
      return null;
    }
  };
  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
      return { id: { _serialized: 'wamid-1b' } };
    }
  };

  await handleAgentMessage({
    chat,
    stateStore,
    config: {
      triggerText: '\u05d1\u05d5\u05d8',
      llmProvider: 'groq',
      llmBaseUrl: 'https://example.com',
      llmApiKey: 'test',
      llmModel: 'test-model'
    },
    record: {
      text: 'בוט תוסיף wish you where here של pink floyd',
      quoted: { fromMe: false },
      chatId: 'chat-1'
    },
    interpretMessageFn: async () => ({
      action: 'add_song',
      song: {
        song_title: 'wish you where here',
        artist: 'pink floyd'
      }
    })
  });

  assert.equal(stateStore.song.song_title, 'wish you where here');
  assert.equal(stateStore.song.artist, 'pink floyd');
  assert.equal(sentMessages.length, 1);
});

test('handleAgentMessage resolves explicit song-info requests without sending them to the agent', async () => {
  const sentMessages = [];
  const song = createSong({
    song_title: 'High Hopes',
    artist: 'Pink Floyd',
    normalized_title: 'high hopes',
    normalized_artist: 'pink floyd'
  });
  const stateStore = {
    getSongs() {
      return [song];
    },
    findSongsByNormalizedName(songTitle, artist) {
      if (songTitle === 'High Hopes' && artist === 'Pink Floyd') {
        return [song];
      }
      return [];
    },
    getResultMessage() {
      return null;
    },
    getLastResults() {
      return null;
    }
  };
  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
      return { id: { _serialized: 'wamid-info-1' } };
    }
  };

  await handleAgentMessage({
    chat,
    stateStore,
    config: {
      triggerText: 'בוט',
      llmProvider: 'groq',
      llmBaseUrl: 'https://example.com',
      llmApiKey: 'test',
      llmModel: 'test-model'
    },
    record: {
      text: 'בוט תן פרטים על High Hopes - Pink Floyd',
      quoted: { fromMe: false },
      chatId: 'chat-1'
    },
    interpretMessageFn: async () => {
      throw new Error('LLM should not be called for explicit song info');
    }
  });

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /High Hopes/);
  assert.match(sentMessages[0], /Pink Floyd/);
});

test('handleAgentMessage resolves song-info reply requests from a bot-formatted quoted song', async () => {
  const sentMessages = [];
  const song = createSong({
    song_id: 'song_a',
    song_title: 'Paranoid',
    artist: 'Grand Funk Railroad',
    normalized_title: 'paranoid',
    normalized_artist: 'grand funk railroad'
  });
  const stateStore = {
    getSongs() {
      return [song];
    },
    getSongById(songId) {
      return songId === 'song_a' ? song : null;
    },
    getResultMessage() {
      return null;
    },
    getLastResults(chatId) {
      if (chatId !== 'chat-1') return null;
      return {
        results: [
          { index: 1, song_id: 'song_a', title: 'Paranoid', artist: 'Grand Funk Railroad' }
        ]
      };
    }
  };
  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
      return { id: { _serialized: 'wamid-info-2' } };
    }
  };

  await handleAgentMessage({
    chat,
    stateStore,
    config: {
      triggerText: 'בוט',
      llmProvider: 'groq',
      llmBaseUrl: 'https://example.com',
      llmApiKey: 'test',
      llmModel: 'test-model'
    },
    record: {
      text: 'תני מידע על השיר הזה',
      quoted: {
        text: '‏🤖 הבאתי:\nparanoid - Grand Funk Railroad'
      },
      quotedText: '‏🤖 הבאתי:\nparanoid - Grand Funk Railroad',
      quotedId: 'wamid-bot-song-1',
      chatId: 'chat-1'
    },
    interpretMessageFn: async () => {
      throw new Error('LLM should not be called for quoted song info');
    }
  });

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /Paranoid/);
  assert.match(sentMessages[0], /Grand Funk Railroad/);
});

test('executeAgentAction get_band_failure_reasons summarizes bad songs with reasons', async () => {
  const sentMessages = [];
  const badSong = createSong({
    song_title: 'Zombie',
    artist: 'The Cranberries',
    band_status: {
      fit: 'bad',
      issues: ['vocals_too_high'],
      notes: '',
      attempts: 2,
      last_reviewed: null,
      last_rehearsed: null,
      last_played: null
    }
  });
  const stateStore = {
    getSongs() {
      return [badSong];
    },
    getResultMessage() {
      return null;
    },
    getLastResults() {
      return null;
    }
  };
  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
    }
  };

  await executeAgentAction({
    action: { action: 'get_band_failure_reasons' },
    stateStore,
    chat,
    record: {
      chatId: 'chat-1',
      quoted: { id: '' }
    }
  });

  assert.match(sentMessages[0], /ההצעות שלא עבדו לנו/);
  assert.match(sentMessages[0], /Zombie - The Cranberries/);
  assert.match(sentMessages[0], /vocals_too_high/);
});

test('executeAgentAction search_songs can avoid previous result songs for a fresh list', async () => {
  const sentMessages = [];
  const firstSong = createSong({ song_id: 'song_a', song_title: 'Zombie', artist: 'The Cranberries' });
  const secondSong = createSong({ song_id: 'song_b', song_title: '1979', artist: 'The Smashing Pumpkins' });
  const stateStore = {
    getSongs() {
      return [firstSong, secondSong];
    },
    getResultMessage() {
      return null;
    },
    getLastResults(chatId) {
      if (chatId !== 'chat-1') return null;
      return {
        results: [{ index: 1, song_id: 'song_a', title: 'Zombie', artist: 'The Cranberries' }]
      };
    },
    setLastResults() {
      return true;
    },
    storeResultMessage() {
      return true;
    },
    async queueSave() {}
  };
  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
      return { id: { _serialized: 'wamid-2' } };
    }
  };

  await executeAgentAction({
    action: {
      action: 'search_songs',
      query: {
        avoid_previous_results: true,
        limit: 5
      }
    },
    stateStore,
    chat,
    record: {
      chatId: 'chat-1',
      quoted: { id: '' }
    }
  });

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /1979/);
  assert.doesNotMatch(sentMessages[0], /Zombie/);
});

test('executeAgentAction search_songs rotates away from recently recommended songs when enough alternatives exist', async () => {
  const sentMessages = [];
  const firstSong = createSong({ song_id: 'song_a', song_title: 'Zombie', artist: 'The Cranberries' });
  const secondSong = createSong({ song_id: 'song_b', song_title: '1979', artist: 'The Smashing Pumpkins' });
  const thirdSong = createSong({ song_id: 'song_c', song_title: 'The One I Love', artist: 'R.E.M.' });
  const stateStore = {
    getSongs() {
      return [firstSong, secondSong, thirdSong];
    },
    getRecentRecommendations(chatId) {
      return chatId === 'chat-1' ? ['song_a'] : [];
    },
    getResultMessage() {
      return null;
    },
    getLastResults() {
      return null;
    },
    setLastResults() {
      return true;
    },
    storeResultMessage() {
      return true;
    },
    recordRecommendations() {
      return true;
    },
    async queueSave() {}
  };
  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
      return { id: { _serialized: 'wamid-3' } };
    }
  };

  await executeAgentAction({
    action: {
      action: 'search_songs',
      query: {
        limit: 2
      }
    },
    stateStore,
    chat,
    record: {
      chatId: 'chat-1',
      quoted: { id: '' }
    }
  });

  assert.equal(sentMessages.length, 1);
  assert.doesNotMatch(sentMessages[0], /Zombie/);
  assert.match(sentMessages[0], /1979|The One I Love/);
});

test('executeAgentAction search_songs falls back to broader candidates when filtered candidates return no songs', async () => {
  const sentMessages = [];
  const fortischarofSong = createSong({ song_id: 'song_a', song_title: 'ניצוצות', artist: 'פורטיסחרוף', language: 'he' });
  const fortisSong = createSong({ song_id: 'song_b', song_title: 'אמריקה', artist: 'רמי פורטיס', language: 'he' });
  const stateStore = {
    getSongs() {
      return [fortischarofSong, fortisSong];
    },
    getRecentRecommendations() {
      return ['song_a', 'song_b'];
    },
    getResultMessage() {
      return null;
    },
    getLastResults() {
      return null;
    },
    setLastResults() {
      return true;
    },
    storeResultMessage() {
      return true;
    },
    recordRecommendations() {
      return true;
    },
    async queueSave() {}
  };
  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
      return { id: { _serialized: 'wamid-3b' } };
    }
  };

  await executeAgentAction({
    action: {
      action: 'search_songs',
      query: {
        requirements: { artist: 'פורטיס' },
        limit: 1
      }
    },
    stateStore,
    chat,
    record: {
      chatId: 'chat-1',
      quoted: { id: '' }
    }
  });

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /פורטיס|ניצוצות|אמריקה/);
});

test('executeAgentAction search_songs replaces only requested result indexes in the active list', async () => {
  const sentMessages = [];
  const firstSong = createSong({ song_id: 'song_a', song_title: 'Zombie', artist: 'The Cranberries' });
  const secondSong = createSong({ song_id: 'song_b', song_title: 'Dreams', artist: 'The Cranberries' });
  const thirdSong = createSong({ song_id: 'song_c', song_title: 'Alive', artist: 'Pearl Jam' });
  const replacementOne = createSong({ song_id: 'song_d', song_title: '1979', artist: 'The Smashing Pumpkins' });
  const replacementTwo = createSong({ song_id: 'song_e', song_title: 'Jeremy', artist: 'Pearl Jam' });
  const allSongs = [firstSong, secondSong, thirdSong, replacementOne, replacementTwo];
  const stateStore = {
    getSongs() {
      return allSongs;
    },
    getSongById(songId) {
      return allSongs.find((song) => song.song_id === songId) || null;
    },
    getRecentRecommendations() {
      return [];
    },
    getResultMessage() {
      return null;
    },
    getLastResults(chatId) {
      if (chatId !== 'chat-1') return null;
      return {
        query: {
          requirements: { genres: ['rock'] },
          limit: 3
        },
        results: [
          { index: 1, song_id: 'song_a', title: 'Zombie', artist: 'The Cranberries' },
          { index: 2, song_id: 'song_b', title: 'Dreams', artist: 'The Cranberries' },
          { index: 3, song_id: 'song_c', title: 'Alive', artist: 'Pearl Jam' }
        ]
      };
    },
    setLastResults(_chatId, context) {
      this.savedContext = context;
      return true;
    },
    storeResultMessage() {
      return true;
    },
    recordRecommendations() {
      return true;
    },
    async queueSave() {}
  };
  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
      return { id: { _serialized: 'wamid-replace-1' } };
    }
  };

  await executeAgentAction({
    action: {
      action: 'search_songs',
      query: {
        replace_result_indexes: [2, 3],
        avoid_previous_results: true
      }
    },
    stateStore,
    chat,
    record: {
      chatId: 'chat-1',
      quoted: { id: '' }
    }
  });

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /Zombie/);
  assert.match(sentMessages[0], /1979/);
  assert.match(sentMessages[0], /Jeremy/);
  assert.doesNotMatch(sentMessages[0], /Dreams/);
  assert.doesNotMatch(sentMessages[0], /Alive/);
  assert.equal(stateStore.savedContext.query.requirements.genres[0], 'rock');
  assert.equal(stateStore.savedContext.results.length, 3);
});

test('executeAgentAction search_songs backfills missing replacements with random alternatives', async () => {
  const sentMessages = [];
  const firstSong = createSong({ song_id: 'song_a', song_title: 'Zombie', artist: 'The Cranberries' });
  const secondSong = createSong({ song_id: 'song_b', song_title: 'Dreams', artist: 'The Cranberries' });
  const thirdSong = createSong({ song_id: 'song_c', song_title: 'Alive', artist: 'Pearl Jam' });
  const replacementOne = createSong({ song_id: 'song_d', song_title: '1979', artist: 'The Smashing Pumpkins' });
  const fallbackRandom = createSong({
    song_id: 'song_e',
    song_title: 'Blue in Green',
    artist: 'Miles Davis',
    genres: ['jazz'],
    normalized_title: 'blue in green',
    normalized_artist: 'miles davis'
  });
  const allSongs = [firstSong, secondSong, thirdSong, replacementOne, fallbackRandom];
  const stateStore = {
    getSongs() {
      return allSongs;
    },
    getSongById(songId) {
      return allSongs.find((song) => song.song_id === songId) || null;
    },
    getRecentRecommendations() {
      return [];
    },
    getResultMessage() {
      return null;
    },
    getLastResults(chatId) {
      if (chatId !== 'chat-1') return null;
      return {
        query: {
          requirements: { genres: ['rock'] },
          limit: 3
        },
        results: [
          { index: 1, song_id: 'song_a', title: 'Zombie', artist: 'The Cranberries' },
          { index: 2, song_id: 'song_b', title: 'Dreams', artist: 'The Cranberries' },
          { index: 3, song_id: 'song_c', title: 'Alive', artist: 'Pearl Jam' }
        ]
      };
    },
    setLastResults(_chatId, context) {
      this.savedContext = context;
      return true;
    },
    storeResultMessage() {
      return true;
    },
    recordRecommendations() {
      return true;
    },
    async queueSave() {}
  };
  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
      return { id: { _serialized: 'wamid-replace-2' } };
    }
  };

  await executeAgentAction({
    action: {
      action: 'search_songs',
      query: {
        replace_result_indexes: [2, 3],
        avoid_previous_results: true
      }
    },
    stateStore,
    chat,
    record: {
      chatId: 'chat-1',
      quoted: { id: '' }
    }
  });

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /Zombie/);
  assert.match(sentMessages[0], /1979/);
  assert.match(sentMessages[0], /Blue in Green/);
  assert.doesNotMatch(sentMessages[0], /Dreams/);
  assert.doesNotMatch(sentMessages[0], /Alive/);
  assert.equal(stateStore.savedContext.results.length, 3);
});

test('executeAgentAction prepare_rehearsal builds a timed rehearsal list with a break', async () => {
  const sentMessages = [];
  const rehearsalSongs = [
    createSong({ song_id: 'song_r1', song_title: 'Song One', artist: 'Band A', genres: ['rock'], duration_seconds: 1500 }),
    createSong({ song_id: 'song_r2', song_title: 'Song Two', artist: 'Band B', genres: ['rock'], duration_seconds: 1500 }),
    createSong({ song_id: 'song_r3', song_title: 'Song Three', artist: 'Band C', genres: ['rock'], duration_seconds: 1500 }),
    createSong({ song_id: 'song_r4', song_title: 'Song Four', artist: 'Band D', genres: ['rock'], duration_seconds: 1500 }),
    createSong({ song_id: 'song_r5', song_title: 'Song Five', artist: 'Band E', genres: ['rock'], duration_seconds: 1500 }),
    createSong({ song_id: 'song_r6', song_title: 'Song Six', artist: 'Band F', genres: ['rock'], duration_seconds: 1500 })
  ];
  const stateStore = {
    getSongs() {
      return rehearsalSongs;
    },
    getSongById(songId) {
      return rehearsalSongs.find((song) => song.song_id === songId) || null;
    },
    getRecentRecommendations() {
      return [];
    },
    getResultMessage() {
      return null;
    },
    getLastResults() {
      return null;
    },
    setLastResults(_chatId, context) {
      this.savedContext = context;
      return true;
    },
    storeResultMessage() {
      return true;
    },
    recordRecommendations() {
      return true;
    },
    async queueSave() {}
  };
  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
      return { id: { _serialized: 'wamid-rehearsal-1' } };
    }
  };

  await executeAgentAction({
    action: {
      action: 'prepare_rehearsal',
      duration_minutes: 180,
      query: {
        requirements: {
          genres: ['rock']
        }
      }
    },
    stateStore,
    chat,
    record: {
      chatId: 'chat-1',
      quoted: { id: '' }
    }
  });

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /רשימת חזרה/);
  assert.match(sentMessages[0], /הפסקה - 12 דק'/);
  assert.match(sentMessages[0], /Song One - Band A/);
  assert.match(sentMessages[0], /Song (?:Two|Three|Four|Five|Six) - Band [B-F]/);
  assert.equal(stateStore.savedContext.query.requirements.genres[0], 'rock');
  assert.equal(stateStore.savedContext.results.length, 5);
});

test('executeAgentAction prepare_rehearsal keeps some cohesion without collapsing to one artist', async () => {
  const sentMessages = [];
  const rehearsalSongs = [
    createSong({ song_id: 'song_c1', song_title: 'Rock One', artist: 'Band A', genres: ['rock', 'alternative rock'], feel: 'upbeat', duration_seconds: 900 }),
    createSong({ song_id: 'song_c2', song_title: 'Rock Two', artist: 'Band A', genres: ['rock', 'alternative rock'], feel: 'upbeat', duration_seconds: 900 }),
    createSong({ song_id: 'song_c3', song_title: 'Rock Three', artist: 'Band B', genres: ['rock', 'alternative rock'], feel: 'upbeat', duration_seconds: 900 }),
    createSong({ song_id: 'song_c4', song_title: 'Rock Four', artist: 'Band C', genres: ['rock', 'hard rock'], feel: 'upbeat', duration_seconds: 900 }),
    createSong({ song_id: 'song_c5', song_title: 'Rock Ballad', artist: 'Band D', genres: ['rock', 'soft rock'], feel: 'ballad', duration_seconds: 900 }),
    createSong({ song_id: 'song_c6', song_title: 'Pop Detour', artist: 'Band E', genres: ['pop'], feel: 'calm', duration_seconds: 900 })
  ];
  const stateStore = {
    getSongs() {
      return rehearsalSongs;
    },
    getSongById(songId) {
      return rehearsalSongs.find((song) => song.song_id === songId) || null;
    },
    getRecentRecommendations() {
      return [];
    },
    getResultMessage() {
      return null;
    },
    getLastResults() {
      return null;
    },
    setLastResults(_chatId, context) {
      this.savedContext = context;
      return true;
    },
    storeResultMessage() {
      return true;
    },
    recordRecommendations() {
      return true;
    },
    async queueSave() {}
  };
  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
      return { id: { _serialized: 'wamid-rehearsal-2' } };
    }
  };

  await executeAgentAction({
    action: {
      action: 'prepare_rehearsal',
      duration_minutes: 120,
      query: {
        requirements: {
          genres: ['rock']
        }
      }
    },
    stateStore,
    chat,
    record: {
      chatId: 'chat-1',
      quoted: { id: '' }
    },
    messageText: 'תכין רשימת שירים לחזרה של שעתיים עם שירי רוק שכיף לנגן ושיש קשר ביניהם'
  });

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /Rock Two - Band A/);
  assert.match(sentMessages[0], /Rock Three - Band B/);
  assert.match(sentMessages[0], /Rock Four - Band C/);
  assert.doesNotMatch(sentMessages[0], /Pop Detour - Band E/);
  assert.ok(stateStore.savedContext.results.length >= 3);
});

test('executeAgentAction updates feedback by result index using stored context', async () => {
  const sentMessages = [];
  let saved = false;
  const updated = createSong();
  const stateStore = {
    getSongs() {
      return [updated];
    },
    getSongById(songId) {
      return songId === 'song_a' ? updated : null;
    },
    updateSongById(songId, updater) {
      const nextSong = updater(updated);
      Object.assign(updated, nextSong);
      return updated;
    },
    getResultMessage(messageId) {
      if (messageId !== 'wamid-1') return null;
      return {
        results: [{ index: 1, song_id: 'song_a', title: 'Zombie', artist: 'The Cranberries' }]
      };
    },
    getLastResults() {
      return null;
    },
    async queueSave() {
      saved = true;
    }
  };
  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
    }
  };

  await executeAgentAction({
    action: {
      action: 'update_song_feedback',
      updates: [
        {
          result_index: 1,
          fit: 'bad',
          issues: ['vocals_too_high'],
          notes: 'Try lower key'
        }
      ]
    },
    stateStore,
    chat,
    record: {
      chatId: 'chat-1',
      quoted: { id: 'wamid-1' }
    }
  });

  assert.equal(saved, true);
  assert.equal(updated.band_status.fit, 'bad');
  assert.deepEqual(updated.band_status.issues, ['vocals_too_high']);
  assert.match(sentMessages[0], /^\u200F🤖 /u);
  assert.match(sentMessages[0], /Zombie - /u);
  assert.match(sentMessages[0], /\u05dc\u05d0 \u05e2\u05d1\u05d3/u);
});

test('executeAgentAction confirms positive feedback as good instead of unknown', async () => {
  const sentMessages = [];
  let saved = false;
  const updated = createSong();
  const stateStore = {
    getSongs() {
      return [updated];
    },
    getSongById(songId) {
      return songId === 'song_a' ? updated : null;
    },
    updateSongById(songId, updater) {
      const nextSong = updater(updated);
      Object.assign(updated, nextSong);
      return updated;
    },
    getResultMessage(messageId) {
      if (messageId !== 'wamid-1') return null;
      return {
        results: [{ index: 1, song_id: 'song_a', title: 'Zombie', artist: 'The Cranberries' }]
      };
    },
    getLastResults() {
      return null;
    },
    async queueSave() {
      saved = true;
    }
  };
  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
    }
  };

  await executeAgentAction({
    action: {
      action: 'update_song_feedback',
      updates: [
        {
          result_index: 1,
          fit: 'good',
          issues: [],
          notes: 'היה כיף לנגן את השיר'
        }
      ]
    },
    stateStore,
    chat,
    record: {
      chatId: 'chat-1',
      quoted: { id: 'wamid-1' }
    }
  });

  assert.equal(saved, true);
  assert.equal(updated.band_status.fit, 'good');
  assert.match(sentMessages[0], /^\u200F🤖 /u);
  assert.match(sentMessages[0], /Zombie - /u);
  assert.match(sentMessages[0], /\u05e2\u05d5\u05d1\u05d3 \u05d8\u05d5\u05d1/u);
});

test('executeAgentAction confirms too-easy feedback as maybe instead of bad', async () => {
  const sentMessages = [];
  let saved = false;
  const updated = createSong();
  const stateStore = {
    getSongs() {
      return [updated];
    },
    getSongById(songId) {
      return songId === 'song_a' ? updated : null;
    },
    updateSongById(songId, updater) {
      const nextSong = updater(updated);
      Object.assign(updated, nextSong);
      return updated;
    },
    getResultMessage(messageId) {
      if (messageId !== 'wamid-1') return null;
      return {
        results: [{ index: 1, song_id: 'song_a', title: 'Zombie', artist: 'The Cranberries' }]
      };
    },
    getLastResults() {
      return null;
    },
    async queueSave() {
      saved = true;
    }
  };
  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
    }
  };

  await executeAgentAction({
    action: {
      action: 'update_song_feedback',
      updates: [
        {
          result_index: 1,
          fit: 'maybe',
          issues: ['too_easy'],
          notes: 'קל מדי'
        }
      ]
    },
    stateStore,
    chat,
    record: {
      chatId: 'chat-1',
      quoted: { id: 'wamid-1' }
    }
  });

  assert.equal(saved, true);
  assert.equal(updated.band_status.fit, 'maybe');
  assert.match(sentMessages[0], /^\u200F🤖 /u);
  assert.match(sentMessages[0], /Zombie - /u);
  assert.match(sentMessages[0], /\u05d0\u05d5\u05dc\u05d9/u);
});

test('executeAgentAction explain_song_rejection explains why a bad song was rejected', async () => {
  const sentMessages = [];
  const song = createSong({
    band_status: {
      fit: 'bad',
      issues: ['vocals_too_high', 'wrong_style'],
      notes: 'Try lower key',
      attempts: 2,
      last_reviewed: '2026-08-08T10:00:00.000Z',
      last_rehearsed: '2026-08-01T10:00:00.000Z',
      last_played: null
    }
  });
  const stateStore = {
    getSongs() {
      return [song];
    },
    getSongById(songId) {
      return songId === 'song_a' ? song : null;
    },
    getResultMessage(messageId) {
      if (messageId !== 'wamid-1') return null;
      return {
        results: [{ index: 1, song_id: 'song_a', title: 'Zombie', artist: 'The Cranberries' }]
      };
    },
    getLastResults() {
      return null;
    }
  };
  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
    }
  };

  await executeAgentAction({
    action: {
      action: 'explain_song_rejection',
      result_index: 1
    },
    stateStore,
    chat,
    record: {
      chatId: 'chat-1',
      quoted: { id: 'wamid-1' }
    }
  });

  assert.match(sentMessages[0], /לא עבד לנו/);
  assert.match(sentMessages[0], /בעיות: vocals_too_high, wrong_style/);
  assert.match(sentMessages[0], /הערות: Try lower key/);
});

test('executeAgentAction update_song applies only allowed mutable fields', async () => {
  const sentMessages = [];
  let saved = false;
  const song = createSong();
  const stateStore = {
    getSongs() {
      return [song];
    },
    getSongById(songId) {
      return songId === 'song_a' ? song : null;
    },
    getResultMessage() {
      return null;
    },
    getLastResults() {
      return null;
    },
    updateSongById(songId, updates) {
      Object.assign(song, updates);
      return song;
    },
    async queueSave() {
      saved = true;
    }
  };
  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
    }
  };

  await executeAgentAction({
    action: {
      action: 'update_song',
      song_id: 'song_a',
      updates: {
        song_title: 'Zombie (Live)',
        source_text: 'should be ignored'
      }
    },
    stateStore,
    chat,
    record: {
      chatId: 'chat-1',
      quoted: { id: '' }
    }
  });

  assert.equal(saved, true);
  assert.equal(song.song_title, 'Zombie (Live)');
  assert.equal(song.source_text, 'Zombie');
  assert.equal(sentMessages[0], `${BOT_PREFIX}\u05e2\u05d3\u05db\u05e0\u05ea\u05d9: Zombie (Live) - The Cranberries`);
});

test('executeAgentAction update_song resolves by result index from stored bot context', async () => {
  const sentMessages = [];
  let saved = false;
  const song = createSong();
  const stateStore = {
    getSongs() {
      return [song];
    },
    getSongById(songId) {
      return songId === 'song_a' ? song : null;
    },
    getResultMessage(messageId) {
      if (messageId !== 'wamid-1') return null;
      return {
        results: [{ index: 2, song_id: 'song_a', title: 'Zombie', artist: 'The Cranberries' }]
      };
    },
    getLastResults() {
      return null;
    },
    updateSongById(songId, updates) {
      Object.assign(song, updates);
      return song;
    },
    async queueSave() {
      saved = true;
    }
  };
  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
    }
  };

  await executeAgentAction({
    action: {
      action: 'update_song',
      result_index: 2,
      updates: {
        artist: 'Cranberries'
      }
    },
    stateStore,
    chat,
    record: {
      chatId: 'chat-1',
      quoted: { id: 'wamid-1' }
    }
  });

  assert.equal(saved, true);
  assert.equal(song.artist, 'Cranberries');
  assert.equal(sentMessages[0], `${BOT_PREFIX}\u05e2\u05d3\u05db\u05e0\u05ea\u05d9: Zombie - Cranberries`);
});

test('executeAgentAction remove_song resolves by title and artist when no result context exists', async () => {
  const sentMessages = [];
  let removedSongId = null;
  const song = createSong({
    song_title: 'Zombie',
    artist: 'The Cranberries'
  });
  const stateStore = {
    getSongs() {
      return [song];
    },
    getSongById() {
      return null;
    },
    findSongsByNormalizedName(title, artist) {
      if (title === 'Zombie' && artist === 'The Cranberries') return [song];
      return [];
    },
    getResultMessage() {
      return null;
    },
    getLastResults() {
      return null;
    },
    removeSongById(songId) {
      removedSongId = songId;
      return song;
    },
    async queueSave() {}
  };
  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
    }
  };

  await executeAgentAction({
    action: {
      action: 'remove_song',
      song_title: 'Zombie',
      artist: 'The Cranberries'
    },
    stateStore,
    chat,
    record: {
      chatId: 'chat-1',
      quoted: { id: '' }
    }
  });

  assert.equal(removedSongId, 'song_a');
  assert.equal(sentMessages[0], `${BOT_PREFIX}\u05d4\u05e1\u05e8\u05ea\u05d9: Zombie - The Cranberries`);
});

test('executeAgentAction remove_song resolves by result index from stored bot context', async () => {
  const sentMessages = [];
  let removedSongId = null;
  const song = createSong();
  const stateStore = {
    getSongs() {
      return [song];
    },
    getSongById(songId) {
      return songId === 'song_a' ? song : null;
    },
    getResultMessage(messageId) {
      if (messageId !== 'wamid-1') return null;
      return {
        results: [{ index: 4, song_id: 'song_a', title: 'Zombie', artist: 'The Cranberries' }]
      };
    },
    getLastResults() {
      return null;
    },
    removeSongById(songId) {
      removedSongId = songId;
      return song;
    },
    async queueSave() {}
  };
  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
    }
  };

  await executeAgentAction({
    action: {
      action: 'remove_song',
      result_index: 4
    },
    stateStore,
    chat,
    record: {
      chatId: 'chat-1',
      quoted: { id: 'wamid-1' }
    }
  });

  assert.equal(removedSongId, 'song_a');
  assert.equal(sentMessages[0], `${BOT_PREFIX}\u05d4\u05e1\u05e8\u05ea\u05d9: Zombie - The Cranberries`);
});

test('executeAgentAction update_song asks for clarification on ambiguous title matches', async () => {
  const sentMessages = [];
  const song = createSong();
  const stateStore = {
    getSongs() {
      return [song];
    },
    getSongById() {
      return null;
    },
    findSongsByNormalizedName(title) {
      if (title === 'Zombie') return [song, { ...song, song_id: 'song_b', artist: 'Another Artist' }];
      return [];
    },
    getResultMessage() {
      return null;
    },
    getLastResults() {
      return null;
    }
  };
  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
    }
  };

  await executeAgentAction({
    action: {
      action: 'update_song',
      song_title: 'Zombie',
      updates: {
        difficulty: 'low'
      }
    },
    stateStore,
    chat,
    record: {
      chatId: 'chat-1',
      quoted: { id: '' }
    }
  });

  assert.match(sentMessages[0], /יש כמה שירים מתאימים/);
});
