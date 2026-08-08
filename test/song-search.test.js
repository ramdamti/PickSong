const test = require('node:test');
const assert = require('node:assert/strict');

const { searchSongs } = require('../src/song-search');

function createSong(overrides = {}) {
  return {
    song_title: 'Song',
    artist: 'Artist',
    language: 'en',
    genres: ['rock'],
    difficulty: 'medium',
    feel: 'upbeat',
    ai_metadata: {
      original_vocal: 'female',
      vocal_range: 'medium-high',
      vocal_style: ['rock'],
      singer_fit: 'great',
      vocal_energy: 'high',
      band_energy: 'high',
      crowd_friendly: true,
      groove_level: 'high',
      guitar_difficulty: 'low',
      bass_difficulty: 'medium',
      drums_difficulty: 'medium',
      keys_role: 'optional',
      keys_difficulty: 'low',
      bass_interest: 'high'
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

test('searchSongs prefers stronger AI metadata matches when hard requirements are equal', () => {
  const songs = [
    createSong({
      song_title: 'Better Match',
      ai_metadata: {
        original_vocal: 'female',
        vocal_range: 'medium-high',
        vocal_style: ['rock'],
        singer_fit: 'great',
        vocal_energy: 'high',
        band_energy: 'high',
        crowd_friendly: true,
        groove_level: 'high',
        guitar_difficulty: 'low',
        bass_difficulty: 'medium',
        drums_difficulty: 'medium',
        keys_role: 'optional',
        keys_difficulty: 'low',
        bass_interest: 'high'
      }
    }),
    createSong({
      song_title: 'Worse Match',
      ai_metadata: {
        original_vocal: 'male',
        vocal_range: 'low',
        vocal_style: ['rock'],
        singer_fit: 'poor',
        vocal_energy: 'low',
        band_energy: 'low',
        crowd_friendly: false,
        groove_level: 'low',
        guitar_difficulty: 'high',
        bass_difficulty: 'low',
        drums_difficulty: 'low',
        keys_role: 'important',
        keys_difficulty: 'high',
        bass_interest: 'low'
      }
    })
  ];

  const results = searchSongs(songs, {
    requirements: { genres: ['rock'] },
    preferences: {
      original_vocal: 'female',
      vocal_range: 'medium-high',
      singer_fit: 'great',
      groove_level: 'high',
      guitar_difficulty: 'low',
      bass_interest: 'high'
    },
    exclusions: {},
    limit: 2
  });

  assert.equal(results[0].song_title, 'Better Match');
});

test('searchSongs strongly penalizes bad band fit even with decent metadata', () => {
  const songs = [
    createSong({
      song_title: 'Good Status',
      band_status: {
        fit: 'good',
        issues: [],
        notes: '',
        attempts: 1,
        last_reviewed: null,
        last_rehearsed: null,
        last_played: null
      }
    }),
    createSong({
      song_title: 'Bad Status',
      band_status: {
        fit: 'bad',
        issues: ['vocals_too_high'],
        notes: '',
        attempts: 2,
        last_reviewed: null,
        last_rehearsed: null,
        last_played: null
      }
    })
  ];

  const results = searchSongs(songs, {
    requirements: { genres: ['rock'] },
    preferences: {},
    exclusions: {},
    limit: 2
  });

  assert.equal(results[0].song_title, 'Good Status');
});

test('searchSongs enforces artist and language as hard requirements', () => {
  const pinkFloyd = createSong({
    song_title: 'Time',
    artist: 'Pink Floyd',
    language: 'en'
  });
  const theWho = createSong({
    song_title: 'Baba O Riley',
    artist: 'The Who',
    language: 'en'
  });
  const hebrewSong = createSong({
    song_title: 'גשם',
    artist: 'מאיר בנאי',
    language: 'he'
  });

  const artistResults = searchSongs([pinkFloyd, theWho], {
    requirements: { artist: 'Pink Floyd' },
    preferences: {},
    exclusions: {},
    limit: 5
  });
  const languageResults = searchSongs([pinkFloyd, hebrewSong], {
    requirements: { language: 'he' },
    preferences: {},
    exclusions: {},
    limit: 5
  });

  assert.deepEqual(
    artistResults.map((song) => song.song_title),
    ['Time']
  );
  assert.deepEqual(
    languageResults.map((song) => song.song_title),
    ['גשם']
  );
});

test('searchSongs returns no matches when an explicit genre requirement is absent from the catalog', () => {
  const rockSong = createSong({
    song_title: 'Time',
    artist: 'Pink Floyd',
    genres: ['rock']
  });
  const popSong = createSong({
    song_title: 'All Right Now',
    artist: 'Free',
    genres: ['pop']
  });

  const results = searchSongs([rockSong, popSong], {
    requirements: { genres: ['blues'] },
    preferences: {},
    exclusions: {},
    limit: 5
  });

  assert.deepEqual(results, []);
});

test('searchSongs does not treat latin-title songs as Hebrew just because the stored language tag says he', () => {
  const mislabeledEnglishSong = createSong({
    song_title: 'Dancing queen',
    artist: 'ABBA',
    language: 'he'
  });
  const hebrewSong = createSong({
    song_title: 'גשם',
    artist: 'מאיר בנאי',
    language: 'he'
  });

  const results = searchSongs([mislabeledEnglishSong, hebrewSong], {
    requirements: { language: 'he' },
    preferences: {},
    exclusions: {},
    limit: 5
  });

  assert.deepEqual(
    results.map((song) => song.song_title),
    ['גשם']
  );
});

test('searchSongs matches common Hebrew artist transliterations against English catalog artists', () => {
  const pinkFloyd = createSong({
    song_title: 'Time',
    artist: 'Pink Floyd',
    language: 'en'
  });
  const theWho = createSong({
    song_title: 'Baba O Riley',
    artist: 'The Who',
    language: 'en'
  });

  const results = searchSongs([pinkFloyd, theWho], {
    requirements: { artist: 'פינק פלויד' },
    preferences: {},
    exclusions: {},
    limit: 5
  });

  assert.deepEqual(
    results.map((song) => song.song_title),
    ['Time']
  );
});

test('searchSongs can match a Hebrew artist request from catalog source_text even without an alias entry', () => {
  const catalogSong = createSong({
    song_title: 'Some Song',
    artist: 'Some English Band',
    language: 'en',
    source_text: 'אפשר לעשות שיר של להקה דמיונית'
  });
  const otherSong = createSong({
    song_title: 'Other Song',
    artist: 'Another Band',
    language: 'en',
    source_text: 'Other Song'
  });

  const results = searchSongs([catalogSong, otherSong], {
    requirements: { artist: 'להקה דמיונית' },
    preferences: {},
    exclusions: {},
    limit: 5
  });

  assert.deepEqual(
    results.map((song) => song.song_title),
    ['Some Song']
  );
});
