const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSongRequest,
  matchesArtist,
  pickSongsForRequest
} = require('../src/main');

test('parseSongRequest detects a single-song artist request', () => {
  assert.deepEqual(parseSongRequest('תביא שיר של הביטלס'), {
    items: [{ count: 1, language: null, artist: 'ביטלס' }],
    includeChords: false
  });
});

test('parseSongRequest detects a multi-song artist request with כמה', () => {
  assert.deepEqual(parseSongRequest('תביא כמה שירים של הביטלס'), {
    items: [{ count: 5, language: null, artist: 'ביטלס' }],
    includeChords: false
  });
});

test('parseSongRequest keeps language and artist filters together', () => {
  assert.deepEqual(parseSongRequest('תביא 2 שירים באנגלית של הביטלס'), {
    items: [{ count: 2, language: 'en', artist: 'ביטלס' }],
    includeChords: false
  });
});

test('matchesArtist ignores leading articles and band-role prefixes', () => {
  assert.equal(matchesArtist({ artist: 'The Beatles' }, 'beatles'), true);
  assert.equal(matchesArtist({ artist: 'הביטלס' }, 'ביטלס'), true);
  assert.equal(matchesArtist({ artist: 'להקת הביטלס' }, 'הביטלס'), true);
  assert.equal(matchesArtist({ artist: 'Cream' }, 'beatles'), false);
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

  const picked = pickSongsForRequest(stateStore, [{ count: 2, language: null, artist: 'beatles' }]);

  assert.equal(picked.length, 2);
  assert.deepEqual(
    picked.map((song) => song.song_title).sort(),
    ['Hey Jude', 'Something']
  );
});
