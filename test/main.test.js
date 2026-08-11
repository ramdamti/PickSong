const test = require('node:test');
const assert = require('node:assert/strict');

const {
  stripWakeWord,
  shouldHandleMessage,
  isMessageInTargetGroup,
  buildAgentReplyContext,
  buildAgentFailureReply,
  buildClarifyReply,
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
    interpretMessageFn: async () => {
      agentCalls += 1;
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
  assert.equal(sentMessages.length, 1);
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
