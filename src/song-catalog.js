const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_SEARCH_URL = 'https://api.spotify.com/v1/search';
const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';

let spotifyToken = null;

function normalizeCatalogSong(song) {
  const songTitle = String(song?.song_title || song?.name || song?.trackName || '').trim();
  const artist = String(song?.artist || song?.artistName || '').trim();
  if (!songTitle || !artist) return null;
  return {
    song_title: songTitle,
    artist,
    release_date: song.release_date || song.releaseDate || song?.album?.release_date || null,
    catalog_source: song.catalog_source || null
  };
}

async function getSpotifyToken({ clientId, clientSecret, fetchFn = fetch }) {
  if (spotifyToken?.expiresAt > Date.now() + 60_000) return spotifyToken.value;
  if (!clientId || !clientSecret) return null;
  const response = await fetchFn(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!response.ok) throw new Error(`Spotify token ${response.status}`);
  const body = await response.json();
  if (!body?.access_token) throw new Error('Spotify token response missing access_token');
  spotifyToken = { value: body.access_token, expiresAt: Date.now() + (Number(body.expires_in || 3600) * 1000) };
  return spotifyToken.value;
}

function buildSpotifyQuery({ genres = [], releaseYearFrom, releaseYearTo }) {
  const genre = Array.isArray(genres) ? genres.find((value) => /^[a-z][a-z -]*$/iu.test(String(value || '').trim())) : null;
  const terms = [genre ? `genre:${genre}` : 'genre:rock'];
  const from = Number.parseInt(releaseYearFrom, 10);
  const to = Number.parseInt(releaseYearTo, 10);
  if (Number.isInteger(from) || Number.isInteger(to)) terms.push(`year:${Number.isInteger(from) ? from : 1900}-${Number.isInteger(to) ? to : new Date().getFullYear()}`);
  return terms.join(' ');
}

async function searchSpotifySongs({ clientId, clientSecret, genres, releaseYearFrom, releaseYearTo, limit, fetchFn = fetch }) {
  const token = await getSpotifyToken({ clientId, clientSecret, fetchFn });
  if (!token) return [];
  const url = `${SPOTIFY_SEARCH_URL}?${new URLSearchParams({ q: buildSpotifyQuery({ genres, releaseYearFrom, releaseYearTo }), type: 'track', market: 'IL', limit: String(Math.min(limit, 50)) })}`;
  const response = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Spotify search ${response.status}`);
  const body = await response.json();
  return (Array.isArray(body?.tracks?.items) ? body.tracks.items : []).map((track) => normalizeCatalogSong({
    song_title: track.name, artist: track.artists?.map((artist) => artist.name).filter(Boolean).join(', '), release_date: track.album?.release_date, catalog_source: 'spotify'
  })).filter(Boolean);
}

function buildItunesTerm({ language, genres = [] }) {
  const genre = Array.isArray(genres) ? String(genres[0] || '').trim() : '';
  if (String(language || '').toLowerCase() === 'he') return genre.toLowerCase() === 'rock' ? 'רוק ישראלי' : 'ישראלי';
  return genre || 'rock';
}

async function searchItunesSongs({ language, genres, limit, fetchFn = fetch }) {
  const url = `${ITUNES_SEARCH_URL}?${new URLSearchParams({ term: buildItunesTerm({ language, genres }), country: 'il', media: 'music', entity: 'song', limit: String(Math.min(limit, 200)) })}`;
  const response = await fetchFn(url);
  if (!response.ok) throw new Error(`iTunes search ${response.status}`);
  const body = await response.json();
  return (Array.isArray(body?.results) ? body.results : []).map((song) => normalizeCatalogSong({ ...song, catalog_source: 'itunes' })).filter(Boolean);
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

async function discoverCatalogSongs({ language, genres, releaseYearFrom, releaseYearTo, limit = 50, spotifyClientId, spotifyClientSecret, fetchFn = fetch }) {
  const spotify = await searchSpotifySongs({ clientId: spotifyClientId, clientSecret: spotifyClientSecret, genres, releaseYearFrom, releaseYearTo, limit, fetchFn }).catch((error) => {
    console.warn(`[spotify] discovery_failed error=${error.message}`);
    return [];
  });
  const iTunes = spotify.length >= Math.min(limit, 15) ? [] : await searchItunesSongs({ language, genres, limit, fetchFn }).catch((error) => {
    console.warn(`[itunes] discovery_failed error=${error.message}`);
    return [];
  });
  const songs = uniqueSongs([...spotify, ...iTunes]);
  console.log(`[catalog] discovery_results spotify=${spotify.length} itunes=${iTunes.length} total=${songs.length}`);
  return songs;
}

module.exports = { discoverCatalogSongs, searchSpotifySongs, searchItunesSongs, buildSpotifyQuery, buildItunesTerm };
