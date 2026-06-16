const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatSongsReply,
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

test('formatting is WhatsApp-safe and keeps the RTL header', () => {
  assert.equal(
    formatSongsReply([
      {
        song_title: 'Sultans of Swing',
        artist: 'Dire Straits',
        chords_url: 'https://tab4u.com/tabs/songs/123'
      }
    ]),
    '\u200F🤖 הבאתי:\n\u200FSultans of Swing - Dire Straits\n\u200F   אקורדים: https://tab4u.com/tabs/songs/123'
  );

  assert.equal(
    formatSongsReply([
      {
        song_title: 'Sultans of Swing',
        artist: 'Dire Straits',
        chords_url: null
      }
    ]),
    '\u200F🤖 הבאתי:\n\u200FSultans of Swing - Dire Straits'
  );

  assert.equal(
    formatSongsReply([
      {
        song_title: 'Sultans of Swing',
        artist: 'Dire Straits',
        chords_url: 'https://tab4u.com/tabs/songs/123'
      },
      {
        song_title: 'White Room',
        artist: 'Cream',
        chords_url: null
      }
    ]),
    '\u200F🤖 הבאתי:\n\u200F1. Sultans of Swing - Dire Straits\n\u200F   אקורדים: https://tab4u.com/tabs/songs/123\n\u200F2. White Room - Cream'
  );
});

test('resolver rejects wrong Hebrew Tab4U pages and accepts matching ones', async () => {
  const wrong = await resolveChordsUrlsForSongs(
    [
      {
        message_id: '1',
        song_title: 'ילד אסור ילד מותר',
        artist: 'ריקי גל',
        chords_url: null
      }
    ],
    {
      fetchImpl: async () => ({
        ok: true,
        text: async () =>
          '<a href="https://www.tab4u.com/tabs/songs/2273_%D7%A8%D7%95%D7%A0%D7%94_%D7%A7%D7%99%D7%A0%D7%9F_-%D7%94%D7%A7%D7%95%D7%9C_%D7%A9%D7%A7%D7%95%D7%A8%D7%90_%D7%9C%D7%99.html?type=ukulele">wrong</a>'
      })
    }
  );

  assert.equal(wrong[0].chords_url, null);

  const correct = await resolveChordsUrlsForSongs(
    [
      {
        message_id: '2',
        song_title: 'שער הרחמים',
        artist: 'מאיר בנאי',
        chords_url: null
      }
    ],
    {
      fetchImpl: async () => ({
        ok: true,
        text: async () =>
          '<a href="https://www.tab4u.com/tabs/songs/1879_%D7%9E%D7%90%D7%99%D7%A8_%D7%91%D7%A0%D7%90%D7%99_-%D7%A9%D7%A2%D7%A8_%D7%94%D7%A8%D7%97%D7%9E%D7%99%D7%9D.html">right</a>'
      })
    }
  );

  assert.equal(correct[0].chords_url, 'https://www.tab4u.com/tabs/songs/1879_%D7%9E%D7%90%D7%99%D7%A8_%D7%91%D7%A0%D7%90%D7%99_-%D7%A9%D7%A2%D7%A8_%D7%94%D7%A8%D7%97%D7%9E%D7%99%D7%9D.html');
});

test('resolver prefers actual chords pages and ignores google/search/homepages', async () => {
  const html = [
    '<a href="https://www.google.com/search?q=bad">google</a>',
    '<a href="https://tab4u.com/tabs/songs/dire-straits_-_sultans-of-swing">good</a>',
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

  assert.equal(result[0].chords_url, 'https://tab4u.com/tabs/songs/dire-straits_-_sultans-of-swing');
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
