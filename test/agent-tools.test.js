const assert = require('node:assert/strict');
const test = require('node:test');

const { READ_ONLY_SONG_TOOLS, READ_ONLY_TOOLS, executeReadOnlySongTool, executeReadOnlyTool } = require('../src/agent-tools');
const { saveEventSchedule } = require('../src/event-reminders');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

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

test('lookup_rehearsals returns the current non-cancelled WhatsApp event schedule', async () => {
  assert.equal(READ_ONLY_TOOLS.some((tool) => tool.function.name === 'lookup_rehearsals'), true);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'picksong-events-'));
  const eventsFile = path.join(directory, 'events.json');
  await saveEventSchedule(eventsFile, {
    group_name: 'The Imagine Sessions',
    events: [
      { id: 'upcoming', title: 'חזרת להקה', start_at: '2026-10-10T14:30:00.000Z', details: 'גרוב | חדר B' },
      { id: 'cancelled', title: 'חזרת להקה', start_at: '2026-10-24T15:00:00.000Z', cancelled: true }
    ]
  });
  const result = await executeReadOnlyTool({ name: 'lookup_rehearsals', eventsFile });
  assert.equal(result.status, 'found');
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0], {
    id: 'upcoming', title: 'חזרת להקה', start_at: '2026-10-10T14:30:00.000Z', details: 'גרוב | חדר B'
  });
  await fs.rm(directory, { recursive: true, force: true });
});
