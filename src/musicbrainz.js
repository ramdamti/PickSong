const MUSICBRAINZ_BASE_URL = 'https://musicbrainz.org/ws/2';
const MIN_REQUEST_INTERVAL_MS = 1000;

let lastRequestAt = 0;
let requestQueue = Promise.resolve();
const verificationCache = new Map();
const discoveryCache = new Map();

function normalizeMusicText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0591-\u05c7]/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getArtistCredit(recording) {
  return Array.isArray(recording?.['artist-credit'])
    ? recording['artist-credit'].map((item) => String(item?.name || item?.artist?.name || '').trim()).filter(Boolean).join(' ')
    : '';
}

async function queuedFetch(url, options, fetchFn) {
  const task = async () => {
    const waitMs = Math.max(0, MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (waitMs > 0) await sleep(waitMs);
    lastRequestAt = Date.now();
    return fetchFn(url, options);
  };
  const pending = requestQueue.then(task, task);
  requestQueue = pending.catch(() => {});
  return pending;
}

async function verifyMusicBrainzSong({ songTitle, artist, userAgent, fetchFn = fetch }) {
  const normalizedTitle = normalizeMusicText(songTitle);
  const normalizedArtist = normalizeMusicText(artist);
  if (!normalizedTitle || !normalizedArtist) return null;
  const cacheKey = `${normalizedTitle}::${normalizedArtist}`;
  if (verificationCache.has(cacheKey)) return verificationCache.get(cacheKey);

  const query = `recording:"${String(songTitle).replace(/"/gu, '\\"')}" AND artist:"${String(artist).replace(/"/gu, '\\"')}"`;
  const url = `${MUSICBRAINZ_BASE_URL}/recording/?${new URLSearchParams({ query, fmt: 'json', limit: '5' }).toString()}`;
  try {
    let response = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      response = await queuedFetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': String(userAgent || 'PickSong/1.0') }
      }, fetchFn);
      if (response.ok || (response.status !== 429 && response.status < 500)) break;
      console.warn(`[musicbrainz] retrying status=${response.status} attempt=${attempt + 1}`);
    }
    if (!response?.ok) throw new Error(`MusicBrainz ${response?.status || 'request failed'}`);
    const body = await response.json();
    const match = (Array.isArray(body?.recordings) ? body.recordings : []).find((recording) =>
      normalizeMusicText(recording?.title) === normalizedTitle &&
      normalizeMusicText(getArtistCredit(recording)) === normalizedArtist
    );
    const verified = match
      ? { song_title: String(match.title).trim(), artist: getArtistCredit(match), release_date: match['first-release-date'] || null }
      : null;
    verificationCache.set(cacheKey, verified);
    return verified;
  } catch (error) {
    console.warn(`[musicbrainz] verification_failed title=${JSON.stringify(songTitle)} artist=${JSON.stringify(artist)} error=${error.message}`);
    return null;
  }
}

function escapeSearchValue(value) {
  return String(value || '').replace(/["\\]/gu, '\\$&').trim();
}

function buildDiscoveryQuery({ language, genres = [], releaseYearFrom, releaseYearTo }) {
  const clauses = [];
  // MusicBrainz indexes the country of a release, rather than a song's language.
  // For Hebrew requests this is a useful first cut; callers also require a Hebrew
  // canonical identity before exposing any result.
  if (String(language || '').toLowerCase() === 'he') clauses.push('country:IL');
  const genre = Array.isArray(genres) ? genres.find((value) => /^[a-z][a-z -]*$/iu.test(String(value || '').trim())) : null;
  if (genre) clauses.push(`tag:"${escapeSearchValue(genre)}"`);
  const from = Number.parseInt(releaseYearFrom, 10);
  const to = Number.parseInt(releaseYearTo, 10);
  if (Number.isInteger(from) || Number.isInteger(to)) {
    clauses.push(`date:[${Number.isInteger(from) ? `${from}-01-01` : '*'} TO ${Number.isInteger(to) ? `${to}-12-31` : '*'}]`);
  }
  return clauses.join(' AND ') || 'primarytype:Album';
}

async function searchMusicBrainzRecordings({ language, genres, releaseYearFrom, releaseYearTo, limit = 30, userAgent, fetchFn = fetch }) {
  const query = buildDiscoveryQuery({ language, genres, releaseYearFrom, releaseYearTo });
  const broadQuery = Array.isArray(genres) && genres.length > 0
    ? buildDiscoveryQuery({ language, genres: [], releaseYearFrom, releaseYearTo })
    : null;
  const resultLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 30, 1), 100);
  const cacheKey = `${query}::${broadQuery || ''}::${resultLimit}`;
  if (discoveryCache.has(cacheKey)) return discoveryCache.get(cacheKey);
  try {
    const search = async (searchQuery) => {
      const url = `${MUSICBRAINZ_BASE_URL}/recording/?${new URLSearchParams({ query: searchQuery, fmt: 'json', limit: String(resultLimit) }).toString()}`;
      let response = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        response = await queuedFetch(url, {
          headers: { Accept: 'application/json', 'User-Agent': String(userAgent || 'PickSong/1.0') }
        }, fetchFn);
        if (response.ok || (response.status !== 429 && response.status < 500)) break;
        console.warn(`[musicbrainz] discovery_retrying status=${response.status} attempt=${attempt + 1}`);
      }
      if (!response?.ok) throw new Error(`MusicBrainz ${response?.status || 'request failed'}`);
      return response.json();
    };
    const bodies = [await search(query)];
    if (broadQuery && (Array.isArray(bodies[0]?.recordings) ? bodies[0].recordings.length : 0) < 15) {
      console.log(`[musicbrainz] discovery_broadening strict_results=${Array.isArray(bodies[0]?.recordings) ? bodies[0].recordings.length : 0}`);
      bodies.push(await search(broadQuery));
    }
    const results = [];
    const seen = new Set();
    for (const body of bodies) for (const recording of Array.isArray(body?.recordings) ? body.recordings : []) {
      const songTitle = String(recording?.title || '').trim();
      const artist = getArtistCredit(recording);
      const identity = `${normalizeMusicText(songTitle)}::${normalizeMusicText(artist)}`;
      if (!songTitle || !artist || !identity || seen.has(identity)) continue;
      seen.add(identity);
      results.push({ song_title: songTitle, artist, release_date: recording['first-release-date'] || null });
    }
    console.log(`[musicbrainz] discovery_results count=${results.length} query=${JSON.stringify(query)}`);
    discoveryCache.set(cacheKey, results);
    return results;
  } catch (error) {
    console.warn(`[musicbrainz] discovery_failed query=${JSON.stringify(query)} error=${error.message}`);
    return [];
  }
}

module.exports = { verifyMusicBrainzSong, searchMusicBrainzRecordings, buildDiscoveryQuery, normalizeMusicText };
