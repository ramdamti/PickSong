const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatSongLine,
  prepareSongsForReply,
  resolveChordsUrlsForSongs
} = require('../src/chords');

test('song with chords_url is not sent to resolver', async () => {
  let calls = 0;
  let received = null;

  const songs = [
    {
      message_id: 'a',
      song_title: 'Song A',
      artist: 'Artist A',
      chords_url: 'https://tab4u.com/tabs/songs/a'
    },
    {
      message_id: 'b',
      song_title: 'Song B',
      artist: 'Artist B',
      chords_url: null
    }
  ];

  const result = await prepareSongsForReply(songs, {
    resolver: async (missingSongs) => {
      calls += 1;
      received = missingSongs;
      return missingSongs.map((song) => ({ ...song, chords_url: 'https://songsterr.com/a/wsa/b' }));
    }
  });

  assert.equal(calls, 1);
  assert.equal(received.length, 1);
  assert.equal(received[0].message_id, 'b');
  assert.equal(result[0].chords_url, 'https://tab4u.com/tabs/songs/a');
  assert.equal(result[1].chords_url, 'https://songsterr.com/a/wsa/b');
});

test('if all selected songs have chords_url, resolver is not called', async () => {
  let calls = 0;

  const songs = [
    {
      message_id: 'a',
      song_title: 'Song A',
      artist: 'Artist A',
      chords_url: 'https://tab4u.com/tabs/songs/a'
    }
  ];

  const result = await prepareSongsForReply(songs, {
    resolver: async () => {
      calls += 1;
      return [];
    }
  });

  assert.equal(calls, 0);
  assert.equal(result[0].chords_url, 'https://tab4u.com/tabs/songs/a');
});

test('three songs with missing chords are sent in one batch call', async () => {
  let calls = 0;
  let batchSize = 0;

  const songs = [
    { message_id: '1', song_title: 'One', artist: 'A', chords_url: null },
    { message_id: '2', song_title: 'Two', artist: 'B', chords_url: null },
    { message_id: '3', song_title: 'Three', artist: 'C', chords_url: null }
  ];

  const result = await prepareSongsForReply(songs, {
    resolver: async (missingSongs) => {
      calls += 1;
      batchSize = missingSongs.length;
      return missingSongs.map((song) => ({ ...song, chords_url: `https://tab4u.com/tabs/songs/${song.message_id}` }));
    }
  });

  assert.equal(calls, 1);
  assert.equal(batchSize, 3);
  assert.deepEqual(result.map((song) => song.message_id), ['1', '2', '3']);
});

test('original order is preserved', async () => {
  const songs = [
    { message_id: '1', song_title: 'One', artist: 'A', chords_url: null },
    { message_id: '2', song_title: 'Two', artist: 'B', chords_url: null },
    { message_id: '3', song_title: 'Three', artist: 'C', chords_url: null }
  ];

  const result = await prepareSongsForReply(songs, {
    resolver: async (missingSongs) =>
      [...missingSongs].reverse().map((song, index) => ({
        ...song,
        chords_url: `https://tab4u.com/tabs/songs/${index}`
      }))
  });

  assert.deepEqual(result.map((song) => song.message_id), ['1', '2', '3']);
});

test('formatting includes inline chords link only when present', () => {
  assert.equal(
    formatSongLine({
      song_title: 'Sultans of Swing',
      artist: 'Dire Straits',
      chords_url: 'https://tab4u.com/tabs/songs/123'
    }),
    'Sultans of Swing - Dire Straits ([לחץ כאן](https://tab4u.com/tabs/songs/123))'
  );

  assert.equal(
    formatSongLine({
      song_title: 'Sultans of Swing',
      artist: 'Dire Straits',
      chords_url: null
    }),
    'Sultans of Swing - Dire Straits'
  );
});

test('resolver prefers actual chords pages and ignores google/search/homepages', async () => {
  const html = [
    '<a href="https://www.google.com/search?q=bad">google</a>',
    '<a href="https://tab4u.com/tabs/songs/sultans-of-swing">good</a>',
    '<a href="https://tab4u.com/">home</a>'
  ].join('\n');

  const result = await resolveChordsUrlsForSongs(
    [
      {
        message_id: '1',
        song_title: 'Sultans of Swing',
        artist: 'Dire Straits',
        chords_url: null
      }
    ],
    {
      fetchImpl: async () => ({
        ok: true,
        text: async () => html
      })
    }
  );

  assert.equal(result[0].chords_url, 'https://tab4u.com/tabs/songs/sultans-of-swing');
});

test('resolver failure leaves songs available for reply', async () => {
  const songs = [
    {
      message_id: '1',
      song_title: 'Sultans of Swing',
      artist: 'Dire Straits',
      chords_url: null
    }
  ];

  const result = await prepareSongsForReply(songs, {
    resolver: async () => {
      throw new Error('network failed');
    }
  }).catch(() => songs);

  assert.equal(result[0].song_title, 'Sultans of Swing');
  assert.equal(result[0].chords_url, null);
});
