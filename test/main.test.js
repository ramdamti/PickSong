const test = require('node:test');
const assert = require('node:assert/strict');

const {
  stripWakeWord,
  shouldHandleMessage,
  isMessageInTargetGroup,
  buildAgentReplyContext,
  buildAgentFailureReply,
  buildClarifyReply,
  isRecommendationReasonRequest,
  buildRecommendationReason,
  buildRecentMessageContext,
  isChordsReplyRequest,
  handleAgentMessage,
  executeAgentAction
} = require('../src/main');

test('stripWakeWord removes standalone bot trigger variants', () => {
  assert.equal(stripWakeWord('\u05d1\u05d5\u05d8 \u05ea\u05df \u05dc\u05d9 \u05e8\u05d5\u05e7'), '\u05ea\u05df \u05dc\u05d9 \u05e8\u05d5\u05e7');
  assert.equal(stripWakeWord('\u05d1\u05d5\u05d8, \u05ea\u05df \u05dc\u05d9 \u05e8\u05d5\u05e7'), '\u05ea\u05df \u05dc\u05d9 \u05e8\u05d5\u05e7');
  assert.equal(stripWakeWord('\u05d1\u05d5\u05d8: \u05ea\u05df \u05dc\u05d9 \u05e8\u05d5\u05e7'), '\u05ea\u05df \u05dc\u05d9 \u05e8\u05d5\u05e7');
  assert.equal(stripWakeWord('\u05d1\u05d5\u05d8 - \u05ea\u05df \u05dc\u05d9 \u05e8\u05d5\u05e7'), '\u05ea\u05df \u05dc\u05d9 \u05e8\u05d5\u05e7');
});

test('executeAgentAction returns multiple external recommendations from one request and filters hard songs', async () => {
  const sentMessages = [];
  const recordedCandidates = [];
  let receivedLimit = null;
  await executeAgentAction({
    action: { action: 'recommend_external_song', query: { limit: 3 } },
    chat: { sendMessage: async (message) => sentMessages.push(message) },
    record: { chatId: 'chat-1' },
    messageText: 'תביא 3 שירים מחוץ למאגר',
    replyContext: null,
    config: { llmBaseUrl: 'https://example.com', llmApiKey: 'test', llmModel: 'test-model' },
    stateStore: {
      getResultMessage() { return null; },
      getLastResults() { return null; },
      getSongs() { return []; },
      getRecentExternalRecommendations() { return ['Already Suggested - Artist']; },
      findSongsByNormalizedName() { return []; },
      recordExternalRecommendation(chatId, candidate) { recordedCandidates.push([chatId, candidate]); },
      async queueSave() {}
    },
    recommendExternalSongsFn: async ({ excludedCandidates, limit }) => {
      receivedLimit = limit;
      assert.deepEqual(excludedCandidates, ['Already Suggested - Artist']);
      return [
        { song_title: 'Hard Song', artist: 'Artist', difficulty: 'high', reason: 'קשה מדי.' },
        { song_title: 'Easy Song', artist: 'Artist', difficulty: 'low', reason: 'קל לנגן.' },
        { song_title: 'Medium Song', artist: 'Artist', difficulty: 'medium', reason: 'מתאים ללהקה.' }
      ];
    }
  });

  assert.equal(receivedLimit, 3);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /Easy Song - Artist/);
  assert.match(sentMessages[0], /Medium Song - Artist/);
  assert.doesNotMatch(sentMessages[0], /Hard Song/);
  assert.deepEqual(recordedCandidates, [
    ['chat-1', 'Easy Song - Artist'],
    ['chat-1', 'Medium Song - Artist']
  ]);
});

test('recommendation reasons are detected and grounded in stored song data', () => {
  const song = {
    song_title: 'Exodus', artist: 'Bob Marley and the Wailers', genres: ['reggae'], difficulty: 'medium',
    ai_metadata: { band_energy: 'medium', crowd_friendly: true }, band_status: { fit: 'unknown' }
  };
  assert.equal(isRecommendationReasonRequest('למה בחרת את זה?'), true);
  assert.equal(isRecommendationReasonRequest('תן לי עוד שיר'), false);
  assert.match(buildRecommendationReason(song, {}), /Exodus/);
  assert.match(buildRecommendationReason(song, {}), /ידידותי לקהל/);
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

  assert.deepEqual(
    shouldHandleMessage(
      {
        text: '\u05ea\u05df \u05de\u05d9\u05d3\u05e2 \u05e2\u05dc \u05d4\u05e9\u05d9\u05e8 \u05d4\u05d6\u05d4',
        quoted: { fromMe: false, text: '\u200f🤖 wish you where here - Pink Floyd' }
      },
      '\u05d1\u05d5\u05d8'
    ),
    {
      shouldHandle: true,
      reason: 'reply',
      messageText: '\u05ea\u05df \u05de\u05d9\u05d3\u05e2 \u05e2\u05dc \u05d4\u05e9\u05d9\u05e8 \u05d4\u05d6\u05d4'
    }
  );
  assert.equal(
    shouldHandleMessage(
      {
        text: '\u05ea\u05d5\u05e1\u05d9\u05e3',
        quoted: { fromMe: false, text: 'wish you where here - Pink Floyd' }
      },
      '\u05d1\u05d5\u05d8'
    ).shouldHandle,
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
  let capturedQuotedText = null;
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
      capturedQuotedText = params?.quotedText ?? null;
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
  assert.equal(capturedQuotedText, '');
  assert.equal(sentMessages.length, 1);
});

test('handleAgentMessage forwards replied text to the agent for general context', async () => {
  let capturedQuotedText = null;
  const sentMessages = [];
  const stateStore = {
    getResultMessage() {
      return null;
    },
    getLastResults() {
      return null;
    },
    getSongs() {
      return [];
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
      return { id: { _serialized: 'wamid-quoted-1' } };
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
      text: '\u05d1\u05d5\u05d8 \u05ea\u05df \u05dc\u05d9 \u05de\u05e9\u05d4\u05d5 \u05d1\u05e1\u05d2\u05e0\u05d5\u05df \u05d6\u05d4',
      quoted: { fromMe: false, text: 'Wish You Were Here - Pink Floyd' },
      chatId: 'chat-1'
    },
    interpretMessageFn: async (params) => {
      capturedQuotedText = params?.quotedText ?? null;
      return {
        action: 'search_songs',
        query: {
          requirements: {},
          preferences: {},
          exclusions: {},
          limit: 5
        }
      };
    }
  });

  assert.equal(handled, true);
  assert.equal(capturedQuotedText, 'Wish You Were Here - Pink Floyd');
  assert.equal(sentMessages.length, 1);
});

test('handleAgentMessage keeps a factual clarification across a bare reply instead of running an unrelated action', async () => {
  const sentMessages = [];
  const pendingClarifications = new Map();
  const stateStore = { getResultMessage() { return null; }, getLastResults() { return null; }, getSongs() { return []; } };
  const chat = { async sendMessage(text) { sentMessages.push(text); return { id: { _serialized: `wamid-${sentMessages.length}` } }; } };
  const config = { triggerText: 'bot', llmProvider: 'groq', llmBaseUrl: 'https://example.com', llmApiKey: 'test', llmModel: 'test-model' };

  await handleAgentMessage({
    chat, stateStore, config, pendingClarifications,
    record: { text: 'bot is this song hard?', quoted: { fromMe: false }, chatId: 'chat-1' },
    interpretMessageFn: async () => ({
      action: 'clarify',
      question: 'Which song and artist?',
      clarification: { intent: 'song_metadata', missing: 'song identity', subject: 'difficulty' }
    })
  });

  assert.deepEqual(pendingClarifications.get('chat-1').intent, 'song_metadata');
  await handleAgentMessage({
    chat, stateStore, config, pendingClarifications,
    record: { text: 'yes', quoted: { fromMe: false, text: sentMessages[0] }, chatId: 'chat-1' },
    interpretMessageFn: async (params) => {
      assert.deepEqual(params.pendingClarification.intent, 'song_metadata');
      return {
        action: 'clarify',
        question: 'I still need the song name and artist.',
        clarification: { intent: 'song_metadata', missing: 'song identity', subject: 'difficulty' }
      };
    }
  });

  assert.equal(pendingClarifications.get('chat-1').missing, 'song identity');
  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[1], /still need the song name/);
});

test('handleAgentMessage blocks a hallucinated add action for a song metadata question', async () => {
  const sentMessages = [];
  let added = false;
  const stateStore = {
    getResultMessage() { return null; },
    getLastResults() { return null; },
    getSongs() { return []; },
    addSong() { added = true; }
  };
  const chat = { async sendMessage(text) { sentMessages.push(text); return { id: { _serialized: 'wamid-1' } }; } };
  const config = { triggerText: 'bot', llmProvider: 'groq', llmBaseUrl: 'https://example.com', llmApiKey: 'test', llmModel: 'test-model' };

  await handleAgentMessage({
    chat, stateStore, config,
    record: { text: 'bot what is the difficulty of an imaginary song?', quoted: { fromMe: false }, chatId: 'chat-1' },
    interpretMessageFn: async () => ({
      action: 'add_song',
      song: { song_title: 'Completely Unrelated Song', artist: 'Nobody', difficulty: 'medium', feel: 'calm', genres: ['rock'] }
    })
  });

  assert.equal(added, false);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /לא הוספתי/);
});

test('handleAgentMessage asks the execution reviewer before an explicit durable action', async () => {
  const sentMessages = [];
  let added = false;
  const stateStore = {
    getResultMessage() { return null; },
    getLastResults() { return null; },
    getSongs() { return []; },
    addSong() { added = true; }
  };
  const chat = { async sendMessage(text) { sentMessages.push(text); return { id: { _serialized: 'wamid-1' } }; } };
  const config = { triggerText: 'bot', llmProvider: 'groq', llmBaseUrl: 'https://example.com', llmApiKey: 'test', llmModel: 'test-model' };

  await handleAgentMessage({
    chat, stateStore, config,
    record: { text: 'bot add an uncertain song', quoted: { fromMe: false }, chatId: 'chat-1' },
    interpretMessageFn: async () => ({
      action: 'add_song',
      song: { song_title: 'Uncertain Song', artist: 'Unknown', difficulty: 'medium', feel: 'calm', genres: ['rock'] }
    }),
    reviewActionExecutionFn: async ({ messageText, action }) => {
      assert.equal(messageText, 'add an uncertain song');
      assert.equal(action.action, 'add_song');
      return 'clarify';
    }
  });

  assert.equal(added, false);
  assert.match(sentMessages[0], /לא ביצעתי שינוי/);
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

test('handleAgentMessage answers metadata questions about an added song reply without calling the agent', async () => {
  let agentCalls = 0;
  const sentMessages = [];
  const song = {
    song_id: 'song_info_1',
    song_title: 'Wish You Were Here',
    artist: 'Pink Floyd',
    genres: ['rock'],
    difficulty: 'medium',
    feel: 'calm',
    ai_metadata: {
      singer_fit: 'great',
      original_vocal: 'male',
      vocal_range: 'medium',
      vocal_style: ['rock'],
      vocal_energy: 'medium',
      band_energy: 'medium',
      crowd_friendly: true,
      groove_level: 'medium',
      guitar_difficulty: 'medium',
      bass_difficulty: 'low',
      drums_difficulty: 'low',
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
    getSongs() {
      return [song];
    },
    getSongById(songId) {
      return songId === 'song_info_1' ? song : null;
    },
    findSongsByNormalizedName(title, artist) {
      return String(title).toLowerCase().includes('wish you where here') && String(artist).toLowerCase().includes('pink floyd')
        ? [song]
        : [];
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
      text: '\u05d1\u05d5\u05d8 \u05de\u05d4 \u05e8\u05de\u05ea \u05d4\u05e7\u05d5\u05e9\u05d9 \u05e9\u05dc \u05d4\u05e9\u05d9\u05e8',
      quoted: { fromMe: false, text: '\u200f🤖 \u05d4\u05d5\u05e1\u05e4\u05ea\u05d9: wish you where here - Pink Floyd' },
      chatId: 'chat-1'
    },
    interpretMessageFn: async () => {
      agentCalls += 1;
      return { action: 'clarify', question: 'unused' };
    }
  });

  assert.equal(handled, true);
  assert.equal(agentCalls, 0);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /\u05e8\u05de\u05ea \u05e7\u05d5\u05e9\u05d9: medium/);
  assert.doesNotMatch(sentMessages[0], /\u05e9\u05e4\u05d4:/);
});

test('handleAgentMessage answers a missing catalog song with the knowledge fallback', async () => {
  const sentMessages = [];
  let agentCalls = 0;
  const stateStore = {
    getSongs() { return []; },
    findSongsByNormalizedName() { return []; },
    getResultMessage() { return null; },
    getLastResults() { return null; }
  };
  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
      return { id: { _serialized: 'wamid-missing-info-1' } };
    }
  };

  const handled = await handleAgentMessage({
    chat,
    stateStore,
    config: { triggerText: 'בוט', llmBaseUrl: 'https://example.com', llmApiKey: 'test', llmModel: 'test-model' },
    record: { text: 'בוט האם השיר נגעה בשמיים של משינה קשה?', quoted: { fromMe: false }, chatId: 'chat-1' },
    interpretMessageFn: async () => {
      agentCalls += 1;
      throw new Error('the direct song-info route must not call the action agent');
    },
    unknownSongInfoFn: async ({ songTitle, artist, question }) => {
      assert.equal(songTitle, 'נגעה בשמיים');
      assert.equal(artist, 'משינה');
      assert.match(question, /קשה/);
      return 'רמת הקושי כנראה בינונית.';
    }
  });

  assert.equal(handled, true);
  assert.equal(agentCalls, 0);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /השיר לא קיים במאגר שלנו, אבל לפי מה שאני יודע: רמת הקושי כנראה בינונית\./);
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

test('handleAgentMessage polishes an agent banter reply before sending it', async () => {
  const sentMessages = [];
  const stateStore = { getResultMessage() { return null; }, getLastResults() { return null; }, getSongs() { return []; } };
  const chat = { async sendMessage(text) { sentMessages.push(text); return { id: { _serialized: 'wamid-banter-polish' } }; } };

  await handleAgentMessage({
    chat,
    stateStore,
    config: { triggerText: 'bot', llmBaseUrl: 'https://example.com', llmApiKey: 'test', llmModel: 'test-model' },
    record: { text: 'bot tell Zvik to stop bothering you', quoted: { fromMe: false }, chatId: 'chat-1' },
    interpretMessageFn: async () => ({ action: 'clarify', question: 'Zvik, stop bothering me.' }),
    polishBanterReplyFn: async ({ messageText, draftReply }) => {
      assert.equal(messageText, 'tell Zvik to stop bothering you');
      assert.equal(draftReply, 'Zvik, stop bothering me.');
      return 'Zvik, even a metronome has more self-awareness.';
    }
  });

  assert.deepEqual(sentMessages, ['‏🤖 Zvik, even a metronome has more self-awareness.']);
});

test('handleAgentMessage explains a replied recommendation without invoking the action agent', async () => {
  const sentMessages = [];
  const song = {
    song_id: 'song_exodus', song_title: 'Exodus', artist: 'Bob Marley and the Wailers', genres: ['reggae'], difficulty: 'medium',
    ai_metadata: { band_energy: 'medium', crowd_friendly: true }, band_status: { fit: 'unknown' }
  };
  const stateStore = {
    getSongs() { return [song]; },
    getSongById(id) { return id === song.song_id ? song : null; },
    getResultMessage(id) {
      return id === 'wamid-recommendation'
        ? { results: [{ index: 1, song_id: song.song_id, title: song.song_title, artist: song.artist }], query: {} }
        : null;
    },
    getLastResults() { return null; }
  };
  const chat = { async sendMessage(text) { sentMessages.push(text); return { id: { _serialized: 'wamid-explanation' } }; } };

  await handleAgentMessage({
    chat, stateStore,
    config: { triggerText: 'bot', llmBaseUrl: 'https://example.com', llmApiKey: 'test', llmModel: 'test-model' },
    record: { text: 'למה בחרת את זה?', quoted: { id: 'wamid-recommendation', fromMe: false, text: '‏🤖 הבאתי: Exodus - Bob Marley and the Wailers' }, chatId: 'chat-1' },
    interpretMessageFn: async () => { throw new Error('recommendation explanation must not call the agent'); }
  });

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /Exodus/);
  assert.match(sentMessages[0], /ידידותי לקהל/);
});

test('handleAgentMessage uses the text fallback for a JSON failure on banter', async () => {
  const sentMessages = [];
  const stateStore = { getResultMessage() { return null; }, getLastResults() { return null; }, getSongs() { return []; } };
  const chat = { async sendMessage(text) { sentMessages.push(text); return { id: { _serialized: 'wamid-fallback' } }; } };
  const jsonError = new Error('LLM request failed: 400 Bad Request json_validate_failed');
  jsonError.status = 400;

  await handleAgentMessage({
    chat,
    stateStore,
    config: { triggerText: 'bot', llmProvider: 'groq', llmBaseUrl: 'https://example.com', llmApiKey: 'test', llmModel: 'test-model' },
    record: { text: 'bot יש לך ערך כלשהו?', quoted: { fromMe: false }, chatId: 'chat-1' },
    interpretMessageFn: async () => { throw jsonError; },
    plainFallbackReplyFn: async () => 'יש לי ערך, פשוט הוא במינוס.'
  });

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /יש לי ערך, פשוט הוא במינוס/);
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

test.skip('legacy: buildClarifyReply collapsed agent replies into a fixed prompt', () => {
  assert.equal(
    buildClarifyReply(
      { action: 'clarify', question: 'האם תוכל להסביר מה בדיוק אתה רוצה לדעת?' },
      { messageText: 'תני מייקל גקסון', replyContext: null }
    ),
    'איזה שירים אתה רוצה?'
  );
});

test('buildClarifyReply forwards the agent-generated reply unchanged', () => {
  const action = { action: 'clarify', question: 'Playful agent reply' };
  assert.equal(buildClarifyReply(action), action.question);
});
