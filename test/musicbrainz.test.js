const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyMusicBrainzSong } = require('../src/musicbrainz');

test('verifyMusicBrainzSong accepts only an exact title and artist match', async () => {
  let request;
  const verified = await verifyMusicBrainzSong({
    songTitle: 'שיר אמיתי', artist: 'אמן אמיתי', userAgent: 'PickSongTest/1.0',
    fetchFn: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        async json() {
          return {
            recordings: [
              { title: 'שיר אחר', 'artist-credit': [{ name: 'אמן אמיתי' }] },
              { title: 'שיר אמיתי', 'artist-credit': [{ name: 'אמן אמיתי' }], 'first-release-date': '1994-06-01' }
            ]
          };
        }
      };
    }
  });

  assert.equal(request.options.headers['User-Agent'], 'PickSongTest/1.0');
  assert.match(request.url, /recording/);
  assert.deepEqual(verified, { song_title: 'שיר אמיתי', artist: 'אמן אמיתי', release_date: '1994-06-01' });
});

test('verifyMusicBrainzSong rejects a candidate without an exact match', async () => {
  const verified = await verifyMusicBrainzSong({
    songTitle: 'Not Real', artist: 'Made Up',
    fetchFn: async () => ({ ok: true, async json() { return { recordings: [] }; } })
  });

  assert.equal(verified, null);
});
