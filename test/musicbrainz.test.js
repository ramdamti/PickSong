const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyMusicBrainzSong, searchMusicBrainzRecordings, buildDiscoveryQuery } = require('../src/musicbrainz');

test('verifyMusicBrainzSong accepts only an exact title and artist match', async () => {
  const verified = await verifyMusicBrainzSong({
    songTitle: 'Real Song', artist: 'Real Artist', userAgent: 'PickSongTest/1.0',
    fetchFn: async () => ({ ok: true, async json() { return { recordings: [
      { title: 'Other Song', 'artist-credit': [{ name: 'Real Artist' }] },
      { title: 'Real Song', 'artist-credit': [{ name: 'Real Artist' }], 'first-release-date': '1994-06-01' }
    ] }; } })
  });
  assert.deepEqual(verified, { song_title: 'Real Song', artist: 'Real Artist', release_date: '1994-06-01' });
});

test('verifyMusicBrainzSong rejects a candidate without an exact match', async () => {
  const verified = await verifyMusicBrainzSong({
    songTitle: 'Not Real', artist: 'Made Up',
    fetchFn: async () => ({ ok: true, async json() { return { recordings: [] }; } })
  });
  assert.equal(verified, null);
});

test('searchMusicBrainzRecordings discovers candidates before recommendation', async () => {
  let request;
  const candidates = await searchMusicBrainzRecordings({
    language: 'he', genres: ['rock'], releaseYearFrom: 1990, releaseYearTo: 1999, userAgent: 'PickSongTest/1.0',
    fetchFn: async (url, options) => {
      request = { url, options };
      return { ok: true, async json() { return { recordings: [
        { title: 'Real Song', 'artist-credit': [{ name: 'Real Artist' }], 'first-release-date': '1994-06-01' },
        { title: 'Real Song', 'artist-credit': [{ name: 'Real Artist' }], 'first-release-date': '1994-06-01' }
      ] }; } };
    }
  });
  assert.equal(request.options.headers['User-Agent'], 'PickSongTest/1.0');
  assert.match(decodeURIComponent(request.url), /country:IL/);
  assert.match(decodeURIComponent(request.url), /date:\[1990-01-01\+TO\+1999-12-31\]/);
  assert.deepEqual(candidates, [{ song_title: 'Real Song', artist: 'Real Artist', release_date: '1994-06-01' }]);
  assert.match(buildDiscoveryQuery({ language: 'he', genres: ['rock'] }), /country:IL/);
});
