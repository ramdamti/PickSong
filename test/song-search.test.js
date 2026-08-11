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
      keys_type: [],
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
        keys_type: [],
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
        keys_type: [],
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

  assert.deepEqual(artistResults.map((song) => song.song_title), ['Time']);
  assert.deepEqual(languageResults.map((song) => song.song_title), ['גשם']);
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

test('searchSongs trusts the stored language field even when title and artist are written in latin characters', () => {
  const latinScriptHebrewSong = createSong({
    song_title: 'Dancing queen',
    artist: 'ABBA',
    language: 'he'
  });
  const hebrewSong = createSong({
    song_title: 'גשם',
    artist: 'מאיר בנאי',
    language: 'he'
  });

  const results = searchSongs([latinScriptHebrewSong, hebrewSong], {
    requirements: { language: 'he' },
    preferences: {},
    exclusions: {},
    limit: 5
  });

  assert.deepEqual(
    results.map((song) => song.song_title).sort((left, right) => left.localeCompare(right)),
    ['Dancing queen', 'גשם'].sort((left, right) => left.localeCompare(right))
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

  assert.deepEqual(results.map((song) => song.song_title), ['Time']);
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

  assert.deepEqual(results.map((song) => song.song_title), ['Some Song']);
});

test('searchSongs matches Hebrew spelling variants for artist names', () => {
  const natashaSong = createSong({
    song_title: 'שינויים בהרגלי הצריחה',
    artist: 'החברים של נטשה',
    language: 'he'
  });
  const otherSong = createSong({
    song_title: 'גשם',
    artist: 'מאיר בנאי',
    language: 'he'
  });

  const results = searchSongs([natashaSong, otherSong], {
    requirements: { artist: 'החברים של נטאשה' },
    preferences: {},
    exclusions: {},
    limit: 5
  });

  assert.deepEqual(results.map((song) => song.song_title), ['שינויים בהרגלי הצריחה']);
});

test('searchSongs matches a single-token Hebrew artist variant inside a longer stored artist name', () => {
  const natashaSong = createSong({
    song_title: '\u05d0\u05dd \u05db\u05d1\u05e8 \u05dc\u05d1\u05d3',
    artist: '\u05d4\u05d7\u05d1\u05e8\u05d9\u05dd \u05e9\u05dc \u05e0\u05d8\u05e9\u05d4',
    language: 'he'
  });
  const otherSong = createSong({
    song_title: '\u05d2\u05e9\u05dd',
    artist: '\u05de\u05d0\u05d9\u05e8 \u05d1\u05e0\u05d0\u05d9',
    language: 'he'
  });

  const results = searchSongs([natashaSong, otherSong], {
    requirements: { artist: '\u05e0\u05d8\u05d0\u05e9\u05d4' },
    preferences: {},
    exclusions: {},
    limit: 5
  });

  assert.deepEqual(results.map((song) => song.song_title), ['\u05d0\u05dd \u05db\u05d1\u05e8 \u05dc\u05d1\u05d3']);
});

test('searchSongs matches partial Hebrew artist requests against multi-word and compound artist names', () => {
  const fortischarofSong = createSong({
    song_title: 'ניצוצות',
    artist: 'פורטיסחרוף',
    language: 'he'
  });
  const fortisSong = createSong({
    song_title: 'אמריקה',
    artist: 'רמי פורטיס',
    language: 'he'
  });
  const otherSong = createSong({
    song_title: 'גשם',
    artist: 'מאיר בנאי',
    language: 'he'
  });

  const results = searchSongs([fortischarofSong, fortisSong, otherSong], {
    requirements: { artist: 'פורטיס' },
    preferences: {},
    exclusions: {},
    limit: 5
  });

  assert.deepEqual(
    results.map((song) => song.song_title).sort((left, right) => left.localeCompare(right)),
    ['אמריקה', 'ניצוצות'].sort((left, right) => left.localeCompare(right))
  );
});

test('searchSongs randomizes equal-score songs instead of returning a fixed alphabetical order', () => {
  const songs = [
    createSong({ song_title: 'Alpha' }),
    createSong({ song_title: 'Beta' }),
    createSong({ song_title: 'Gamma' })
  ];

  const randomValues = [0.99, 0.0];
  const results = searchSongs(
    songs,
    {
      requirements: { genres: ['rock'] },
      preferences: {},
      exclusions: {},
      limit: 3
    },
    {
      random() {
        return randomValues.shift() ?? 0;
      }
    }
  );

  assert.deepEqual(results.map((song) => song.song_title), ['Beta', 'Alpha', 'Gamma']);
});

test('searchSongs distinguishes exact keyboard types', () => {
  const songs = [
    createSong({
      song_title: 'A Day in the Life',
      artist: 'The Beatles',
      ai_metadata: {
        ...createSong().ai_metadata,
        keys_role: 'important',
        keys_type: ['piano']
      }
    }),
    createSong({
      song_title: 'A Kind of Magic',
      artist: 'Queen',
      ai_metadata: {
        ...createSong().ai_metadata,
        keys_role: 'important',
        keys_type: ['synth']
      }
    }),
    createSong({
      song_title: 'Superstition',
      artist: 'Stevie Wonder',
      ai_metadata: {
        ...createSong().ai_metadata,
        keys_role: 'important',
        keys_type: ['clavinet']
      }
    }),
    createSong({
      song_title: 'Get Back',
      artist: 'The Beatles',
      ai_metadata: {
        ...createSong().ai_metadata,
        keys_role: 'important',
        keys_type: ['electric_piano']
      }
    })
  ];

  const pianoResults = searchSongs(songs, {
    requirements: { keys_type_any: ['piano'] },
    preferences: {},
    exclusions: {},
    limit: 5
  });
  const synthResults = searchSongs(songs, {
    requirements: { keys_type_any: ['synth'] },
    preferences: {},
    exclusions: {},
    limit: 5
  });
  const clavinetResults = searchSongs(songs, {
    requirements: { keys_type_any: ['clavinet'] },
    preferences: {},
    exclusions: {},
    limit: 5
  });
  const electricPianoResults = searchSongs(songs, {
    requirements: { keys_type_any: ['electric_piano'] },
    preferences: {},
    exclusions: {},
    limit: 5
  });

  assert.deepEqual(pianoResults.map((song) => song.song_title), ['A Day in the Life']);
  assert.deepEqual(synthResults.map((song) => song.song_title), ['A Kind of Magic']);
  assert.deepEqual(clavinetResults.map((song) => song.song_title), ['Superstition']);
  assert.deepEqual(electricPianoResults.map((song) => song.song_title), ['Get Back']);
});

test('searchSongs generic keyboard search requires a meaningful keyboard type and prefers important keys', () => {
  const songs = [
    createSong({
      song_title: 'Important Keys',
      ai_metadata: {
        ...createSong().ai_metadata,
        keys_role: 'important',
        keys_type: ['organ']
      }
    }),
    createSong({
      song_title: 'Optional Keys',
      ai_metadata: {
        ...createSong().ai_metadata,
        keys_role: 'optional',
        keys_type: ['synth']
      }
    }),
    createSong({
      song_title: 'No Keys Type',
      ai_metadata: {
        ...createSong().ai_metadata,
        keys_role: 'important',
        keys_type: []
      }
    })
  ];

  const results = searchSongs(songs, {
    requirements: { has_keys: true },
    preferences: {},
    exclusions: {},
    limit: 5
  });

  assert.deepEqual(results.map((song) => song.song_title), ['Important Keys', 'Optional Keys']);
});
