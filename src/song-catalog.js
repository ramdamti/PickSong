const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';

function normalizeCatalogSong(song) {
  const songTitle = String(song?.trackName || '').trim();
  const artist = String(song?.artistName || '').trim();
  if (!songTitle || !artist) return null;
  return {
    song_title: songTitle,
    artist,
    release_date: song.releaseDate || null,
    catalog_source: 'itunes'
  };
}

function buildItunesTerm({ language, genres = [] }) {
  const genre = Array.isArray(genres) ? String(genres[0] || '').trim() : '';
  if (String(language || '').toLowerCase() === 'he') return genre.toLowerCase() === 'rock' || !genre ? 'רוק ישראלי' : 'ישראלי';
  return genre || 'rock';
}

function buildItunesTerms({ language, genres = [] }) {
  const requestedGenres = Array.isArray(genres) ? genres.map((genre) => String(genre || '').trim().toLowerCase()).filter(Boolean) : [];
  const terms = requestedGenres.length ? requestedGenres : ['rock', 'blues', 'funk'];
  const hebrewTerms = { rock: 'רוק ישראלי', blues: 'בלוז ישראלי', funk: 'פאנק ישראלי' };
  const isHebrew = String(language || '').toLowerCase() === 'he';
  return [...new Set(terms.map((genre) => isHebrew ? (hebrewTerms[genre] || 'ישראלי') : genre))];
}

async function searchItunesSongs({ language, genres, term, limit, fetchFn = fetch }) {
  const url = `${ITUNES_SEARCH_URL}?${new URLSearchParams({ term: term || buildItunesTerm({ language, genres }), country: 'il', media: 'music', entity: 'song', limit: String(Math.min(limit, 200)) })}`;
  const response = await fetchFn(url);
  if (!response.ok) throw new Error(`iTunes search ${response.status}`);
  const body = await response.json();
  return (Array.isArray(body?.results) ? body.results : []).map(normalizeCatalogSong).filter(Boolean);
}

function uniqueSongs(songs) {
  const seen = new Set();
  return songs.filter((song) => {
    const key = `${song.song_title.toLocaleLowerCase()}::${song.artist.toLocaleLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function discoverCatalogSongs({ language, genres, limit = 50, fetchFn = fetch }) {
  try {
    const terms = buildItunesTerms({ language, genres });
    const resultSets = await Promise.all(terms.map((term) => searchItunesSongs({ language, genres, term, limit, fetchFn })));
    const songs = uniqueSongs(resultSets.flat());
    console.log(`[catalog] discovery_results itunes=${songs.length}`);
    return songs;
  } catch (error) {
    console.warn(`[itunes] discovery_failed error=${error.message}`);
    return [];
  }
}

module.exports = { discoverCatalogSongs, searchItunesSongs, buildItunesTerm, buildItunesTerms };
