const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSongRequest,
  matchesArtist,
  matchesGenre,
  matchesDifficulty,
  matchesFeel,
  pickSongsForRequest
} = require('../src/main');

test('parseSongRequest detects a single-song artist request', () => {
  assert.deepEqual(parseSongRequest('\u05ea\u05d1\u05d9\u05d0 \u05e9\u05d9\u05e8 \u05e9\u05dc \u05d4\u05d1\u05d9\u05d8\u05dc\u05e1'), {
    items: [{ count: 1, language: null, artist: '\u05d1\u05d9\u05d8\u05dc\u05e1', genres: [], difficulty: null, feel: null }],
    includeChords: false
  });
});

test('parseSongRequest detects a multi-song artist request with כמה', () => {
  assert.deepEqual(parseSongRequest('\u05ea\u05d1\u05d9\u05d0 \u05db\u05de\u05d4 \u05e9\u05d9\u05e8\u05d9\u05dd \u05e9\u05dc \u05d4\u05d1\u05d9\u05d8\u05dc\u05e1'), {
    items: [{ count: 5, language: null, artist: '\u05d1\u05d9\u05d8\u05dc\u05e1', genres: [], difficulty: null, feel: null }],
    includeChords: false
  });
});

test('parseSongRequest keeps language and artist filters together', () => {
  assert.deepEqual(parseSongRequest('\u05ea\u05d1\u05d9\u05d0 2 \u05e9\u05d9\u05e8\u05d9\u05dd \u05d1\u05d0\u05e0\u05d2\u05dc\u05d9\u05ea \u05e9\u05dc \u05d4\u05d1\u05d9\u05d8\u05dc\u05e1'), {
    items: [{ count: 2, language: 'en', artist: '\u05d1\u05d9\u05d8\u05dc\u05e1', genres: [], difficulty: null, feel: null }],
    includeChords: false
  });
});

test('parseSongRequest detects genre and difficulty filters in Hebrew', () => {
  assert.deepEqual(parseSongRequest('\u05ea\u05d1\u05d9\u05d0 \u05e9\u05d9\u05e8 \u05e8\u05d5\u05e7 \u05e7\u05e9\u05d4'), {
    items: [{ count: 1, language: null, artist: null, genres: ['rock'], difficulty: 'high', feel: null }],
    includeChords: false
  });
});

test('parseSongRequest detects feel filter in Hebrew', () => {
  assert.deepEqual(parseSongRequest('\u05ea\u05d1\u05d9\u05d0 \u05e9\u05d9\u05e8 \u05e7\u05e6\u05d1\u05d9'), {
    items: [{ count: 1, language: null, artist: null, genres: [], difficulty: null, feel: 'upbeat' }],
    includeChords: false
  });
});

test('matchesArtist ignores leading articles and band-role prefixes', () => {
  assert.equal(matchesArtist({ artist: 'The Beatles' }, 'beatles'), true);
  assert.equal(matchesArtist({ artist: '\u05d4\u05d1\u05d9\u05d8\u05dc\u05e1' }, '\u05d1\u05d9\u05d8\u05dc\u05e1'), true);
  assert.equal(matchesArtist({ artist: '\u05dc\u05d4\u05e7\u05ea \u05d4\u05d1\u05d9\u05d8\u05dc\u05e1' }, '\u05d4\u05d1\u05d9\u05d8\u05dc\u05e1'), true);
  assert.equal(matchesArtist({ artist: 'Cream' }, 'beatles'), false);
});

test('matchesGenre treats broad families as matching subgenres', () => {
  assert.equal(matchesGenre({ genres: ['alternative rock', 'psychedelic rock'] }, 'rock'), true);
  assert.equal(matchesGenre({ genres: ['blues rock'] }, 'blues'), true);
  assert.equal(matchesGenre({ genres: ['israeli rock'] }, 'israeli'), true);
  assert.equal(matchesGenre({ genres: ['funk metal'] }, 'metal'), true);
  assert.equal(matchesGenre({ genres: ['jazz fusion'] }, 'blues'), false);
});

test('matchesDifficulty and matchesFeel use normalized stored values', () => {
  assert.equal(matchesDifficulty({ difficulty: 'low' }, 'low'), true);
  assert.equal(matchesDifficulty({ difficulty: 'medium' }, 'high'), false);
  assert.equal(matchesFeel({ feel: 'upbeat' }, 'upbeat'), true);
  assert.equal(matchesFeel({ feel: 'ballad' }, 'calm'), false);
});

test('pickSongsForRequest returns only songs by the requested artist', () => {
  const stateStore = {
    state: {
      songs: [
        { message_id: '1', song_title: 'Something', artist: 'The Beatles', language: 'en' },
        { message_id: '2', song_title: 'Hey Jude', artist: 'The Beatles', language: 'en' },
        { message_id: '3', song_title: 'White Room', artist: 'Cream', language: 'en' }
      ]
    }
  };

  const picked = pickSongsForRequest(stateStore, [
    { count: 2, language: null, artist: 'beatles', genres: [], difficulty: null, feel: null }
  ]);

  assert.equal(picked.length, 2);
  assert.deepEqual(
    picked.map((song) => song.song_title).sort(),
    ['Hey Jude', 'Something']
  );
});

test('pickSongsForRequest applies genre, difficulty, and feel filters together', () => {
  const stateStore = {
    state: {
      songs: [
        {
          message_id: '1',
          song_title: 'Sultans of Swing',
          artist: 'Dire Straits',
          genres: ['rock', 'roots rock'],
          difficulty: 'high',
          feel: 'upbeat'
        },
        {
          message_id: '2',
          song_title: 'Brothers in Arms',
          artist: 'Dire Straits',
          genres: ['rock'],
          difficulty: 'medium',
          feel: 'ballad'
        },
        {
          message_id: '3',
          song_title: 'Still Got the Blues',
          artist: 'Gary Moore',
          genres: ['blues', 'blues rock'],
          difficulty: 'medium',
          feel: 'calm'
        }
      ]
    }
  };

  const picked = pickSongsForRequest(stateStore, [
    { count: 1, language: null, artist: null, genres: ['rock'], difficulty: 'high', feel: 'upbeat' }
  ]);

  assert.equal(picked.length, 1);
  assert.equal(picked[0].song_title, 'Sultans of Swing');
});

test('pickSongsForRequest supports hebrew-style family combinations like israeli bluesy', () => {
  const stateStore = {
    state: {
      songs: [
        {
          message_id: '1',
          song_title: 'Song A',
          artist: 'Artist A',
          genres: ['israeli rock'],
          difficulty: 'low',
          feel: 'upbeat'
        },
        {
          message_id: '2',
          song_title: 'Song B',
          artist: 'Artist B',
          genres: ['israeli pop', 'blues'],
          difficulty: 'medium',
          feel: 'calm'
        }
      ]
    }
  };

  const picked = pickSongsForRequest(stateStore, [
    { count: 1, language: null, artist: null, genres: ['israeli', 'blues'], difficulty: null, feel: null }
  ]);

  assert.equal(picked.length, 1);
  assert.equal(picked[0].song_title, 'Song B');
});
