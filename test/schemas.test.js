const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateAgentAction,
  validateResultContext,
  validateSong
} = require('../src/schemas');

function createSong() {
  return {
    song_id: 'song_123456789abc',
    song_title: 'Zombie',
    artist: 'The Cranberries',
    genres: ['rock', 'alternative rock'],
    difficulty: 'medium',
    feel: 'upbeat',
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
      keys_type: ['piano'],
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
}

test('validateSong accepts canonical song payload', () => {
  const validated = validateSong(createSong());
  assert.equal(validated.song_id, 'song_123456789abc');
  assert.equal(validated.band_status.fit, 'unknown');
});

test('validateAgentAction accepts add_song action', () => {
  const validated = validateAgentAction({
    action: 'add_song',
    song: createSong()
  });

  assert.equal(validated.action, 'add_song');
  assert.equal(validated.song.song_title, 'Zombie');
});

test('validateAgentAction rejects invalid feedback issue enums', () => {
  assert.throws(
    () =>
      validateAgentAction({
        action: 'update_song_feedback',
        updates: [
          {
            result_index: 2,
            fit: 'bad',
            issues: ['not_allowed']
          }
        ]
      }),
    /must be one of/
  );
});

test('validateResultContext requires positive result indexes', () => {
  assert.throws(
    () =>
      validateResultContext({
        results: [{ index: 0, song_id: 'song_123' }]
      }),
    /positive integer/
  );
});

test('validateAgentAction rejects unsupported update_song fields', () => {
  assert.throws(
    () =>
      validateAgentAction({
        action: 'update_song',
        song_id: 'song_123456789abc',
        updates: {
          source_text: 'should not be mutable'
        }
      }),
    /unsupported fields/
  );
});

test('validateAgentAction tolerates missing or malformed search query payloads', () => {
  const validated = validateAgentAction({
    action: 'search_songs',
    query: 'not-an-object'
  });

  assert.equal(validated.action, 'search_songs');
  assert.deepEqual(validated.query, {});
});

test('validateAgentAction accepts keyboard type search constraints', () => {
  const validated = validateAgentAction({
    action: 'search_songs',
    query: {
      requirements: {
        keys_type_any: ['piano'],
        has_keys: true
      },
      preferences: {
        keys_type_any: ['electric_piano']
      },
      exclusions: {
        keys_type_any: ['synth']
      },
      limit: 3
    }
  });

  assert.deepEqual(validated.query.requirements.keys_type_any, ['piano']);
  assert.equal(validated.query.requirements.has_keys, true);
  assert.deepEqual(validated.query.preferences.keys_type_any, ['electric_piano']);
  assert.deepEqual(validated.query.exclusions.keys_type_any, ['synth']);
});

test('validateSong rejects invalid keyboard type values', () => {
  assert.throws(
    () =>
      validateSong({
        ...createSong(),
        ai_metadata: {
          ...createSong().ai_metadata,
          keys_type: ['accordion']
        }
      }),
    /must be one of/
  );
});
