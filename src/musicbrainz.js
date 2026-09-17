const MUSICBRAINZ_BASE_URL = 'https://musicbrainz.org/ws/2';
const MIN_REQUEST_INTERVAL_MS = 1000;

let lastRequestAt = 0;
let requestQueue = Promise.resolve();
const verificationCache = new Map();

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
    const response = await queuedFetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': String(userAgent || 'PickSong/1.0') }
    }, fetchFn);
    if (!response.ok) throw new Error(`MusicBrainz ${response.status}`);
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

module.exports = { verifyMusicBrainzSong, normalizeMusicText };
