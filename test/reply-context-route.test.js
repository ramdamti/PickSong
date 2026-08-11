const test = require('node:test');
const assert = require('node:assert/strict');

const { handleAgentMessage } = require('../src/main');

test('handleAgentMessage accepts stored reply context even when quoted.fromMe is false', async () => {
  let agentCalls = 0;
  const sentMessages = [];
  const song = {
    song_id: 'song_a',
    song_title: 'Zombie',
    artist: 'The Cranberries',
    genres: ['rock'],
    difficulty: 'medium',
    feel: 'upbeat',
    ai_metadata: {
      singer_fit: 'great',
      original_vocal: 'female',
      vocal_range: 'medium-high',
      vocal_style: ['rock'],
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
    }
  };
  const stateStore = {
    getResultMessage(messageId) {
      if (messageId !== 'wamid-bot-list') return null;
      return {
        results: [{ index: 1, song_id: 'song_a', title: 'Zombie', artist: 'The Cranberries' }]
      };
    },
    getLastResults() {
      return null;
    },
    getSongs() {
      return [song];
    },
    getSongById(songId) {
      return songId === 'song_a' ? song : null;
    },
    async queueSave() {}
  };
  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
    }
  };

  const handled = await handleAgentMessage({
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
      text: 'מתי ניגנו את 1',
      quoted: { id: 'wamid-bot-list', fromMe: false },
      chatId: 'chat-1'
    },
    interpretMessageFn: async () => {
      agentCalls += 1;
      return { action: 'get_song_info', result_index: 1 };
    }
  });

  assert.equal(handled, true);
  assert.equal(agentCalls, 1);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /Zombie/);
});
