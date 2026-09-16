const assert = require('node:assert/strict');
const test = require('node:test');

const { READ_ONLY_SONG_TOOLS, executeReadOnlySongTool } = require('../src/agent-tools');

test('lookup_song is a read-only exact catalog lookup', () => {
  const song = { song_id: 'song-1', song_title: 'Naga Bashamayim', artist: 'Mashina', difficulty: 'medium', genres: ['rock'] };
  const stateStore = {
    findSongsByNormalizedName(title, artist) {
      return title === 'Naga Bashamayim' && artist === 'Mashina' ? [song] : [];
    }
  };

  assert.equal(READ_ONLY_SONG_TOOLS[0].function.name, 'lookup_song');
  assert.deepEqual(executeReadOnlySongTool({
    stateStore,
    name: 'lookup_song',
    arguments: '{"song_title":"Naga Bashamayim","artist":"Mashina"}'
  }), {
    ok: true,
    status: 'found',
    songs: [{
      song_id: 'song-1', song_title: 'Naga Bashamayim', artist: 'Mashina', language: null,
      genres: ['rock'], difficulty: 'medium', feel: null, ai_metadata: null, band_status: null
    }]
  });
  assert.deepEqual(executeReadOnlySongTool({
    stateStore,
    name: 'lookup_song',
    arguments: '{"song_title":"Not in the catalog"}'
  }), { ok: true, status: 'not_found', songs: [] });
});

test('search_catalog returns local results without mutating the catalog', () => {
  const songs = [{
    song_id: 'song-1', song_title: 'Rock Song', artist: 'Band', language: 'en', genres: ['rock'], difficulty: 'medium', feel: 'upbeat',
    ai_metadata: {}, band_status: { fit: 'unknown', issues: [] }
  }];
  const stateStore = { getSongs() { return songs; } };
  const result = executeReadOnlySongTool({ stateStore, name: 'search_catalog', arguments: '{"query":{"requirements":{"genres":["rock"]},"limit":1}}' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'found');
  assert.equal(result.songs[0].song_title, 'Rock Song');
  assert.equal(songs.length, 1);
});
