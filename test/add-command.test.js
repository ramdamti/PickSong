const test = require('node:test');
const assert = require('node:assert/strict');

const { handleAddSongCommand } = require('../src/main');

test('handleAddSongCommand stores llm genres difficulty and feel', async () => {
  const sentMessages = [];
  const addedSongs = [];
  let saved = false;

  const chat = {
    async sendMessage(text) {
      sentMessages.push(text);
    }
  };

  const stateStore = {
    addSong(song) {
      addedSongs.push(song);
      return true;
    },
    async queueSave() {
      saved = true;
    }
  };

  const config = {
    llmProvider: 'gemini',
    geminiApiKey: 'test',
    geminiModel: 'test-model'
  };

  const triggerRecord = {
    id: 'msg-1',
    text: 'תוסיף למאגר Sultans of swing',
    quotedText: '',
    sender: 'user',
    from: 'group',
    timestamp: 1
  };

  const extractSongsFn = async () => [
    {
      message_id: 'msg-1:add',
      is_song_suggestion: true,
      song_title: 'Sultans of Swing',
      artist: 'Dire Straits',
      language: 'en',
      confidence: 0.95,
      source_text: 'Sultans of swing',
      genres: ['rock', 'roots rock'],
      difficulty: 'high',
      feel: 'upbeat'
    }
  ];

  await handleAddSongCommand({ chat, stateStore, config, triggerRecord, extractSongsFn });

  assert.equal(addedSongs.length, 1);
  assert.equal(saved, true);
  assert.deepEqual(sentMessages, ['🤖 הוספתי']);
  assert.equal(addedSongs[0].song_title, 'Sultans of Swing');
  assert.deepEqual(addedSongs[0].genres, ['rock', 'roots rock']);
  assert.equal(addedSongs[0].difficulty, 'high');
  assert.equal(addedSongs[0].feel, 'upbeat');
});
