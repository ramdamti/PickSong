const test = require('node:test');
const assert = require('node:assert/strict');
const { searchSpotifySongs, searchItunesSongs, buildSpotifyQuery, buildItunesTerm } = require('../src/song-catalog');

test('Spotify catalog search uses a server token and Israeli market', async () => {
  const requests = [];
  const songs = await searchSpotifySongs({
    clientId: 'id', clientSecret: 'secret', genres: ['rock'], releaseYearFrom: 1990, releaseYearTo: 1999, limit: 10,
    fetchFn: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.includes('/api/token')) return { ok: true, async json() { return { access_token: 'token', expires_in: 3600 }; } };
      return { ok: true, async json() { return { tracks: { items: [
        { name: 'Real Song', artists: [{ name: 'Real Artist' }], album: { release_date: '1994-06-01' } }
      ] } }; } };
    }
  });
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /market=IL/);
  assert.match(decodeURIComponent(requests[1].url), /genre:rock\+year:1990-1999/);
  assert.deepEqual(songs, [{ song_title: 'Real Song', artist: 'Real Artist', release_date: '1994-06-01' }]);
});

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
  assert.deepEqual(songs, [{ song_title: 'Real Song', artist: 'Real Artist', release_date: '1994-06-01T00:00:00Z' }]);
  assert.equal(buildSpotifyQuery({ genres: ['rock'] }), 'genre:rock');
  assert.equal(buildItunesTerm({ language: 'he', genres: ['rock'] }), 'רוק ישראלי');
});
