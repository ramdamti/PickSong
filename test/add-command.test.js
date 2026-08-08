const test = require('node:test');
const assert = require('node:assert/strict');

const { handleAgentMessage, executeAgentAction } = require('../src/main');

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
  assert.deepEqual(sentMessages, ['\u05d4\u05d5\u05e1\u05e4\u05ea\u05d9: Zombie - The Cranberries']);
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
  assert.equal(sentMessages[0], '\u05e2\u05d3\u05db\u05e0\u05ea\u05d9: Zombie - לא עבד');
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
  assert.equal(sentMessages[0], '\u05e2\u05d3\u05db\u05e0\u05ea\u05d9: Zombie (Live) - The Cranberries');
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
  assert.equal(sentMessages[0], '\u05e2\u05d3\u05db\u05e0\u05ea\u05d9: Zombie - Cranberries');
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
  assert.equal(sentMessages[0], '\u05d4\u05e1\u05e8\u05ea\u05d9: Zombie - The Cranberries');
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
  assert.equal(sentMessages[0], '\u05d4\u05e1\u05e8\u05ea\u05d9: Zombie - The Cranberries');
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
