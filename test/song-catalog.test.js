const test = require('node:test');
const assert = require('node:assert/strict');
const { searchItunesSongs, buildItunesTerm, buildItunesTerms } = require('../src/song-catalog');

test('iTunes catalog search needs no token and uses the Israeli store', async () => {
  let requestUrl;
  const songs = await searchItunesSongs({
    language: 'he', genres: ['rock'], limit: 10,
    fetchFn: async (url) => {
      requestUrl = url;
      return { ok: true, async json() { return { results: [
        { trackName: 'Real Song', artistName: 'Real Artist', releaseDate: '1994-06-01T00:00:00Z' }
      ] }; } };
    }
  });
  assert.match(requestUrl, /country=il/);
  assert.match(decodeURIComponent(requestUrl), /term=רוק\+ישראלי/);
  assert.deepEqual(songs, [{ song_title: 'Real Song', artist: 'Real Artist', release_date: '1994-06-01T00:00:00Z', catalog_source: 'itunes' }]);
  assert.equal(buildItunesTerm({ language: 'he', genres: ['rock'] }), 'רוק ישראלי');
  assert.equal(buildItunesTerm({ language: 'he', genres: [] }), 'רוק ישראלי');
});

test('iTunes discovery expands a generic request across the band styles', () => {
  assert.deepEqual(buildItunesTerms({ language: 'en', genres: [] }), ['rock', 'blues', 'funk']);
});
