const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildResultContext,
  persistResultContext,
  resolveActiveResultContext,
  findSongIdsByIndexes
} = require('../src/result-context');

function createStateStoreMock() {
  const store = {
    state: {
      songs: [
        { song_id: 'song_a', song_title: 'Zombie', artist: 'The Cranberries' },
        { song_id: 'song_b', song_title: 'Dreams', artist: 'The Cranberries' }
      ]
    },
    _lastByChat: new Map(),
    _byMessageId: new Map(),
    setLastResults(chatId, context) {
      this._lastByChat.set(chatId, context);
      return true;
    },
    getLastResults(chatId) {
      return this._lastByChat.get(chatId) || null;
    },
    storeResultMessage(chatId, messageId, context) {
      this._byMessageId.set(messageId, { ...context, chat_id: chatId, bot_message_id: messageId });
      return true;
    },
    getResultMessage(messageId) {
      return this._byMessageId.get(messageId) || null;
    }
  };

  return store;
}

test('buildResultContext creates numbered song references', () => {
  const context = buildResultContext({
    chatId: 'chat-1',
    botMessageId: 'wamid-1',
    songs: [
      { song_id: 'song_a', song_title: 'Zombie', artist: 'The Cranberries' },
      { song_id: 'song_b', song_title: 'Dreams', artist: 'The Cranberries' }
    ],
    createdAt: '2026-08-08T12:00:00.000Z'
  });

  assert.equal(context.results[0].index, 1);
  assert.equal(context.results[1].song_id, 'song_b');
});

test('resolveActiveResultContext prioritizes quoted bot message context over last_results', () => {
  const store = createStateStoreMock();
  persistResultContext(store, {
    chatId: 'chat-1',
    botMessageId: 'wamid-old',
    songs: [{ song_id: 'song_a', song_title: 'Zombie', artist: 'The Cranberries' }],
    createdAt: '2026-08-08T10:00:00.000Z'
  });
  persistResultContext(store, {
    chatId: 'chat-1',
    botMessageId: 'wamid-new',
    songs: [{ song_id: 'song_b', song_title: 'Dreams', artist: 'The Cranberries' }],
    createdAt: '2026-08-08T11:00:00.000Z'
  });

  const resolved = resolveActiveResultContext(store, {
    chatId: 'chat-1',
    quoted: { id: 'wamid-old' }
  });

  assert.equal(resolved.source, 'reply');
  assert.equal(resolved.context.results[0].song_id, 'song_a');
});

test('resolveActiveResultContext falls back to chat last_results', () => {
  const store = createStateStoreMock();
  persistResultContext(store, {
    chatId: 'chat-1',
    botMessageId: 'wamid-new',
    songs: [{ song_id: 'song_b', song_title: 'Dreams', artist: 'The Cranberries' }],
    createdAt: '2026-08-08T11:00:00.000Z'
  });

  const resolved = resolveActiveResultContext(store, {
    chatId: 'chat-1',
    quoted: { id: '' }
  });

  assert.equal(resolved.source, 'last_results');
  assert.equal(resolved.context.results[0].song_id, 'song_b');
});

test('findSongIdsByIndexes filters the requested indexes deterministically', () => {
  const context = buildResultContext({
    chatId: 'chat-1',
    botMessageId: 'wamid-1',
    songs: [
      { song_id: 'song_a', song_title: 'Zombie', artist: 'The Cranberries' },
      { song_id: 'song_b', song_title: 'Dreams', artist: 'The Cranberries' }
    ],
    createdAt: '2026-08-08T12:00:00.000Z'
  });

  const results = findSongIdsByIndexes(context, [2, 99]);
  assert.equal(results.length, 1);
  assert.equal(results[0].song_id, 'song_b');
});
