const test = require('node:test');
const assert = require('node:assert/strict');

const {
  stripWakeWord,
  shouldHandleMessage,
  isMessageInTargetGroup,
  buildAgentReplyContext,
  buildAgentFailureReply,
  buildClarifyReply,
  buildRecentMessageContext,
  isChordsReplyRequest,
  handleAgentMessage
} = require('../src/main');

test('stripWakeWord removes standalone bot trigger variants', () => {
  assert.equal(stripWakeWord('\u05d1\u05d5\u05d8 \u05ea\u05df \u05dc\u05d9 \u05e8\u05d5\u05e7'), '\u05ea\u05df \u05dc\u05d9 \u05e8\u05d5\u05e7');
  assert.equal(stripWakeWord('\u05d1\u05d5\u05d8, \u05ea\u05df \u05dc\u05d9 \u05e8\u05d5\u05e7'), '\u05ea\u05df \u05dc\u05d9 \u05e8\u05d5\u05e7');
  assert.equal(stripWakeWord('\u05d1\u05d5\u05d8: \u05ea\u05df \u05dc\u05d9 \u05e8\u05d5\u05e7'), '\u05ea\u05df \u05dc\u05d9 \u05e8\u05d5\u05e7');
  assert.equal(stripWakeWord('\u05d1\u05d5\u05d8 - \u05ea\u05df \u05dc\u05d9 \u05e8\u05d5\u05e7'), '\u05ea\u05df \u05dc\u05d9 \u05e8\u05d5\u05e7');
});

test('shouldHandleMessage accepts direct bot requests and ignores raw reply markers', () => {
  assert.deepEqual(
    shouldHandleMessage({ text: '\u200f🤖 יש עכשיו עומס על המנוע. נסו שוב עוד רגע.', fromMe: true, quoted: { fromMe: false } }, '\u05d1\u05d5\u05d8'),
    {
      shouldHandle: false,
      reason: 'bot_self_message',
      messageText: null
    }
  );

  assert.deepEqual(
    shouldHandleMessage({ text: '\u05d1\u05d5\u05d8 \u05ea\u05df 5 \u05e9\u05d9\u05e8\u05d9\u05dd', quoted: { fromMe: false } }, '\u05d1\u05d5\u05d8'),
    {
      shouldHandle: true,
      reason: 'wake_word',
      messageText: '\u05ea\u05df 5 \u05e9\u05d9\u05e8\u05d9\u05dd'
    }
  );

  assert.equal(
    shouldHandleMessage({ text: '2 \u05d5-4 \u05dc\u05d0 \u05d4\u05ea\u05d0\u05d9\u05de\u05d5', quoted: { fromMe: true } }, '\u05d1\u05d5\u05d8').shouldHandle,
    false
  );

  assert.equal(
    shouldHandleMessage({ text: '\u05ea\u05df \u05dc\u05d9 \u05e8\u05d5\u05e7', quoted: { fromMe: false } }, '\u05d1\u05d5\u05d8').shouldHandle,
    false
  );
});

test('buildAgentReplyContext returns stored numbered results only', () => {
  const stateStore = {
    getResultMessage() {
      return {
        results: [{ index: 1, song_id: 'song_a', title: 'Zombie', artist: 'The Cranberries' }]
      };
    },
    getLastResults() {
      throw new Error('last_results should not be used when quoted message context exists');
    }
  };

  const context = buildAgentReplyContext(stateStore, {
    chatId: 'chat-1',
    quoted: { id: 'wamid-1', text: '\u200f🤖 1. Zombie - The Cranberries' }
  });

  assert.deepEqual(context, {
    source: 'reply',
    results: [{ index: 1, song_id: 'song_a', title: 'Zombie', artist: 'The Cranberries' }]
  });
});

test('buildAgentReplyContext ignores quoted messages without the bot prefix', () => {
  const stateStore = {
    getResultMessage() {
      throw new Error('bot context lookup should not run for non-bot quoted text');
    }
  };

  const context = buildAgentReplyContext(stateStore, {
    chatId: 'chat-1',
    quoted: { id: 'wamid-1', text: '1. Zombie - The Cranberries' }
  });

  assert.equal(context, null);
});

test('isChordsReplyRequest detects Hebrew and English chord requests', () => {
  assert.equal(isChordsReplyRequest('תביא אקורדים'), true);
  assert.equal(isChordsReplyRequest('אפשר chords?'), true);
  assert.equal(isChordsReplyRequest('מתי ניגנו את זה?'), false);
});

test('buildRecentMessageContext keeps the last three compact messages', () => {
  const recent = buildRecentMessageContext([
    { text: 'אחד', fromMe: false, sender: 'A' },
    { text: 'שתיים', fromMe: true, sender: 'Me' },
    { text: 'שלוש', fromMe: false, sender: 'B' },
    { text: 'ארבע', fromMe: false, sender: 'C' }
  ]);

  assert.deepEqual(recent, [
    { text: 'שתיים', from_me: true, sender: 'Me' },
    { text: 'שלוש', from_me: false, sender: 'B' },
    { text: 'ארבע', from_me: false, sender: 'C' }
  ]);
});

test('isMessageInTargetGroup accepts any configured group id or name', () => {
  assert.equal(
    isMessageInTargetGroup(
      { chatId: '1201@g.us' },
      { groupIds: ['1201@g.us', '1202@g.us'], groupNames: ['Band A', 'Band B'] },
      { id: { _serialized: '1201@g.us' }, isGroup: true, name: 'Ignored' }
    ),
    true
  );

  assert.equal(
    isMessageInTargetGroup(
      { chatId: 'other@g.us' },
      { groupIds: [], groupNames: ['Band A', 'Band B'] },
      { id: { _serialized: 'other@g.us' }, isGroup: true, name: 'Band B' }
    ),
    true
  );

  assert.equal(
    isMessageInTargetGroup(
      { chatId: 'other@g.us' },
      { groupIds: ['1201@g.us'], groupNames: ['Band A'] },
      { id: { _serialized: 'other@g.us' }, isGroup: true, name: 'Band C' }
    ),
    false
  );
});

test('handleAgentMessage performs one agent call for a normal search request', async () => {
  let agentCalls = 0;
  const sentMessages = [];
  let capturedRecentMessages = null;
  const stateStore = {
    getResultMessage() {
      return null;
    },
    getLastResults() {
      return null;
    },
    getSongs() {
      return [
        {
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
        }
      ];
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
      return { id: { _serialized: 'wamid-1' } };
    }
  };

  const handled = await handleAgentMessage({
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
      text: '\u05d1\u05d5\u05d8 \u05ea\u05df \u05dc\u05d9 \u05e9\u05d9\u05e8 \u05e8\u05d5\u05e7',
      quoted: { fromMe: false },
      chatId: 'chat-1'
    },
    recentMessages: [
      { text: 'מחפשים משהו רגוע', from_me: false, sender: 'Member A' },
      { text: 'לא בלדה', from_me: false, sender: 'Member B' },
      { text: 'עדיף באנגלית', from_me: false, sender: 'Member C' }
    ],
    interpretMessageFn: async (params) => {
      agentCalls += 1;
      capturedRecentMessages = params?.recentMessages || null;
      return {
        action: 'search_songs',
        query: {
          requirements: { genres: ['rock'] },
          preferences: {},
          exclusions: {},
          limit: 5
        }
      };
    }
  });

  assert.equal(handled, true);
  assert.equal(agentCalls, 1);
  assert.deepEqual(capturedRecentMessages, [
    { text: 'מחפשים משהו רגוע', from_me: false, sender: 'Member A' },
    { text: 'לא בלדה', from_me: false, sender: 'Member B' },
    { text: 'עדיף באנגלית', from_me: false, sender: 'Member C' }
  ]);
  assert.equal(sentMessages.length, 1);
});

test('handleAgentMessage rewrites generic add-to-library requests using the latest recent song message', async () => {
  let agentCalls = 0;
  let capturedMessageText = null;
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
      return { id: { _serialized: 'wamid-add-1' } };
    }
  };

  const handled = await handleAgentMessage({
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
      text: '\u05d1\u05d5\u05d8 \u05ea\u05d5\u05e1\u05d9\u05e3 \u05dc\u05de\u05d0\u05d2\u05e8',
      quoted: { fromMe: false },
      chatId: 'chat-1'
    },
    recentMessages: [
      { text: 'wish you where here - pink floyd', from_me: true, sender: 'Me' }
    ],
    interpretMessageFn: async (params) => {
      agentCalls += 1;
      capturedMessageText = params?.messageText || null;
      return {
        action: 'add_song',
        song: {
          song_title: 'Wish You Were Here',
          artist: 'Pink Floyd',
          genres: ['rock'],
          difficulty: 'medium',
          feel: 'calm',
          confidence: 0.95
        }
      };
    }
  });

  assert.equal(handled, true);
  assert.equal(agentCalls, 1);
  assert.equal(capturedMessageText, '\u05ea\u05d5\u05e1\u05d9\u05e3 wish you where here \u05e9\u05dc pink floyd');
  assert.equal(stateStore.song.song_title, 'Wish You Were Here');
  assert.equal(stateStore.song.artist, 'Pink Floyd');
  assert.equal(sentMessages.length, 1);
});

test('handleAgentMessage rewrites plain add requests using the replied song message first', async () => {
  let agentCalls = 0;
  let capturedMessageText = null;
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
      return { id: { _serialized: 'wamid-add-2' } };
    }
  };

  const handled = await handleAgentMessage({
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
      text: '\u05d1\u05d5\u05d8 \u05ea\u05d5\u05e1\u05d9\u05e3',
      quoted: { fromMe: false, text: 'wish you where here - pink floyd' },
      chatId: 'chat-1'
    },
    recentMessages: [
      { text: 'something else - another artist', from_me: false, sender: 'Member A' }
    ],
    interpretMessageFn: async (params) => {
      agentCalls += 1;
      capturedMessageText = params?.messageText || null;
      return {
        action: 'add_song',
        song: {
          song_title: 'Wish You Were Here',
          artist: 'Pink Floyd',
          genres: ['rock'],
          difficulty: 'medium',
          feel: 'calm',
          confidence: 0.95
        }
      };
    }
  });

  assert.equal(handled, true);
  assert.equal(agentCalls, 1);
  assert.equal(capturedMessageText, '\u05ea\u05d5\u05e1\u05d9\u05e3 wish you where here \u05e9\u05dc pink floyd');
  assert.equal(stateStore.song.song_title, 'Wish You Were Here');
  assert.equal(stateStore.song.artist, 'Pink Floyd');
  assert.equal(sentMessages.length, 1);
});

test('handleAgentMessage returns reply-context songs with chords without calling the agent', async () => {
  let agentCalls = 0;
  let saved = 0;
  const sentMessages = [];
  const song = {
    message_id: 'import-1',
    song_id: 'song_a',
    song_title: 'Zombie',
    artist: 'The Cranberries',
    chords_url: null,
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
      if (messageId !== 'wamid-1') return null;
      return {
        results: [{ index: 1, song_id: 'song_a', title: 'Zombie', artist: 'The Cranberries' }]
      };
    },
    getSongById(songId) {
      return songId === 'song_a' ? song : null;
    },
    setSongChordsUrl(messageId, chordsUrl) {
      if (messageId !== 'import-1') return false;
      song.chords_url = chordsUrl;
      return true;
    },
    async queueSave() {
      saved += 1;
    }
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
      triggerText: '\u05d1\u05d5\u05d8',
      discoverChords: true
    },
    record: {
      text: 'תביא אקורדים',
      quoted: { id: 'wamid-1', text: '\u200f🤖 1. Zombie - The Cranberries' },
      chatId: 'chat-1'
    },
    interpretMessageFn: async () => {
      agentCalls += 1;
      return { action: 'clarify', question: 'unused' };
    },
    prepareSongsForReplyFn: async () => [{ ...song, chords_url: 'https://tab4u.com/tabs/songs/123' }]
  });

  assert.equal(handled, true);
  assert.equal(agentCalls, 0);
  assert.equal(saved, 1);
  assert.equal(song.chords_url, 'https://tab4u.com/tabs/songs/123');
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /Zombie - The Cranberries/);
  assert.match(sentMessages[0], /אקורדים: https:\/\/tab4u.com\/tabs\/songs\/123/);
});

test('handleAgentMessage blocks generic fallback for short specific hints with an empty search query', async () => {
  const sentMessages = [];
  const stateStore = {
    getResultMessage() {
      return null;
    },
    getLastResults() {
      return null;
    },
    getSongs() {
      return [
        {
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
        }
      ];
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
      text: 'בוט מייקל גקסון',
      quoted: { fromMe: false },
      chatId: 'chat-1'
    },
    interpretMessageFn: async () => ({
      action: 'search_songs',
      query: {}
    })
  });

  assert.equal(handled, true);
  assert.deepEqual(sentMessages, ['\u200F🤖 איזה שירים אתה רוצה?']);
});

test('buildAgentFailureReply returns a specific message for rate limits', () => {
  assert.equal(
    buildAgentFailureReply({ rateLimited: true, status: 429, message: 'Too Many Requests' }),
    'יש עכשיו עומס על המנוע. נסו שוב עוד רגע.'
  );
});

test('buildAgentFailureReply returns a clarification message for invalid agent output', () => {
  assert.equal(
    buildAgentFailureReply(new Error('agent_action.updates must be a non-empty array')),
    'לא הבנתי עד הסוף את הבקשה. נסו לנסח שוב במשפט קצר.'
  );
});

test('buildClarifyReply collapses broad recommendation clarifications into a fixed prompt', () => {
  assert.equal(
    buildClarifyReply(
      { action: 'clarify', question: 'האם תוכל להסביר מה בדיוק אתה רוצה לדעת?' },
      { messageText: 'תני מייקל גקסון', replyContext: null }
    ),
    'איזה שירים אתה רוצה?'
  );
});
