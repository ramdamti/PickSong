const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  createStateStore,
  loadState,
  normalizeState,
  validateCanonicalState
} = require('../src/state');

function createCanonicalSong(overrides = {}) {
  return {
    message_id: 'import-1',
    source_text: 'Zombie',
    song_title: 'Zombie',
    artist: 'The Cranberries',
    language: 'en',
    chords_url: null,
    confidence: 0.95,
    genres: ['rock', 'alternative rock'],
    difficulty: 'medium',
    feel: 'upbeat',
    used: false,
    created_at: '2026-08-08T00:00:00.000Z',
    normalized_title: 'zombie',
    normalized_artist: 'the cranberries',
    song_id: 'song_123456789abc',
    ai_metadata: {
      original_vocal: 'female',
      vocal_range: 'medium-high',
      vocal_style: ['rock', 'powerful'],
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

function createCanonicalState(overrides = {}) {
  return {
    schema_version: 3,
    ai_enrichment: {
      complete: true,
      version: 1,
      generated_at: '2026-08-08',
      source: 'test fixture',
      band_status_overrides_ai: true,
      fields: [
        'original_vocal',
        'vocal_range',
        'vocal_style',
        'singer_fit',
        'vocal_energy',
        'band_energy',
        'crowd_friendly',
        'groove_level',
        'guitar_difficulty',
        'bass_difficulty',
        'drums_difficulty',
        'keys_role',
        'keys_type',
        'keys_difficulty',
        'bass_interest'
      ]
    },
    songs: [createCanonicalSong()],
    chats: {},
    result_messages: {},
    ...overrides
  };
}

test('validateCanonicalState accepts canonical state', () => {
  const state = createCanonicalState();
  assert.doesNotThrow(() => validateCanonicalState(state, 'fixture.json'));
});

test('validateCanonicalState rejects missing canonical fields', () => {
  const state = createCanonicalState({
    songs: [createCanonicalSong({ song_id: '' })]
  });

  assert.throws(
    () => validateCanonicalState(state, 'fixture.json'),
    /songs\[0\]\.song_id is required/
  );
});

test('normalizeState preserves canonical song fields and top-level metadata', () => {
  const raw = createCanonicalState({
    custom_top_level: { keep: true },
    songs: [createCanonicalSong({ custom_song_field: 'keep me' })]
  });

  const normalized = normalizeState(raw, { validateCanonical: true, filePath: 'fixture.json' });

  assert.equal(normalized.schema_version, 3);
  assert.equal(normalized.ai_enrichment.complete, true);
  assert.deepEqual(normalized.custom_top_level, { keep: true });
  assert.equal(normalized.songs[0].song_id, 'song_123456789abc');
  assert.equal(normalized.songs[0].custom_song_field, 'keep me');
  assert.equal(normalized.songs[0].band_status.fit, 'unknown');
});

test('createStateStore stores per-chat result context and preserves it on save', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picksong-state-'));
  const stateFile = path.join(tempDir, 'state.json');
  const seenFile = path.join(tempDir, 'seen.json');

  try {
    const initialState = createCanonicalState();
    const store = createStateStore(stateFile, seenFile, initialState, { seenMessageIds: [], lastBootstrapAt: null });

    store.setLastResults('chat-1', {
      created_at: '2026-08-08T01:00:00.000Z',
      results: [{ index: 1, song_id: 'song_123456789abc', title: 'Zombie', artist: 'The Cranberries' }]
    });
    store.storeResultMessage('chat-1', 'wamid-1', {
      created_at: '2026-08-08T01:00:00.000Z',
      results: [{ index: 1, song_id: 'song_123456789abc', title: 'Zombie', artist: 'The Cranberries' }]
    });

    await store.queueSave();

    const reloaded = await loadState(stateFile);
    assert.equal(reloaded.schema_version, 3);
    assert.equal(reloaded.chats['chat-1'].last_results.results[0].song_id, 'song_123456789abc');
    assert.equal(reloaded.result_messages['wamid-1'].results[0].title, 'Zombie');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('createStateStore addSong fills canonical placeholders for legacy add flow', () => {
  const store = createStateStore('state.json', 'seen.json', createCanonicalState(), {
    seenMessageIds: [],
    lastBootstrapAt: null
  });

  const inserted = store.addSong({
    message_id: 'msg-new',
    source_text: 'New Song',
    song_title: 'New Song',
    artist: 'New Artist',
    language: 'en',
    genres: ['rock'],
    difficulty: 'low',
    feel: 'upbeat'
  });

  assert.equal(inserted, true);
  const added = store.state.songs.find((song) => song.message_id === 'msg-new');
  assert.ok(added);
  assert.match(added.song_id, /^song_[a-f0-9]{12}$/);
  assert.equal(added.ai_metadata.original_vocal, 'unknown');
  assert.deepEqual(added.ai_metadata.keys_type, []);
  assert.equal(added.band_status.fit, 'unknown');
});

test('loadState accepts the schema-v3 workspace dataset', async () => {
  const loaded = await loadState(path.resolve('state.json'));

  assert.equal(loaded.schema_version, 3);
  assert.ok(loaded.songs.length > 0);
  assert.ok(loaded.songs.every((song) => Array.isArray(song.ai_metadata.keys_type)));
});

test('createStateStore tracks recent recommendations per chat', () => {
  const store = createStateStore('state.json', 'seen.json', createCanonicalState(), {
    seenMessageIds: [],
    lastBootstrapAt: null
  });

  const recorded = store.recordRecommendations('chat-1', ['song_a', 'song_b', 'song_a']);

  assert.equal(recorded, true);
  assert.deepEqual(store.getRecentRecommendations('chat-1'), ['song_a', 'song_b']);
});
