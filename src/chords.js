const ALLOWED_CHORD_HOSTS = [
  {
    hostSuffix: 'tab4u.com',
    pathPrefix: '/tabs/songs/'
  },
  {
    hostSuffix: 'ultimate-guitar.com',
    pathPrefix: '/tab/'
  },
  {
    hostSuffix: 'songsterr.com',
    pathPrefix: '/a/wsa/'
  }
];

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizeUrlCandidate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw, 'https://duckduckgo.com');
    if (url.hostname === 'duckduckgo.com' && url.pathname === '/l/') {
      const redirected = url.searchParams.get('uddg');
      return redirected ? decodeURIComponent(redirected) : '';
    }
    return url.toString();
  } catch (error) {
    return '';
  }
}

function isAllowedChordsUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch (error) {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  const pathname = url.pathname.toLowerCase();

  for (const rule of ALLOWED_CHORD_HOSTS) {
    if (hostname === rule.hostSuffix || hostname.endsWith(`.${rule.hostSuffix}`)) {
      return pathname.startsWith(rule.pathPrefix);
    }
  }

  return false;
}

function formatSongLine(song) {
  const title = String(song?.song_title || '').trim();
  const artist = String(song?.artist || '').trim();
  const base = title && artist ? `${title} - ${artist}` : title || artist || '';
  const chordsUrl = String(song?.chords_url || '').trim();
  if (base && chordsUrl) {
    return `${base} ([לחץ כאן](${chordsUrl}))`;
  }
  return base;
}

function extractCandidateUrls(html) {
  const matches = [];
  const regex = /href="([^"]+)"/gi;
  let match;
  while ((match = regex.exec(String(html || '')))) {
    const rawHref = decodeHtmlEntities(match[1]);
    const normalized = normalizeUrlCandidate(rawHref);
    if (normalized) matches.push(normalized);
  }
  return matches;
}

function buildSearchQueries(song) {
  const title = String(song?.song_title || '').trim();
  const artist = String(song?.artist || '').trim();
  const q = [title, artist].filter(Boolean).join(' ').trim();
  if (!q) return [];

  return [
    `site:tab4u.com/tabs/songs/ ${q}`,
    `site:ultimate-guitar.com/tab/ ${q}`,
    `site:tabs.ultimate-guitar.com/tab/ ${q}`,
    `site:songsterr.com/a/wsa/ ${q}`
  ];
}

async function searchForChordsUrl(song, fetchImpl) {
  const queries = buildSearchQueries(song);
  for (const query of queries) {
    const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetchImpl(searchUrl, {
      headers: {
        'user-agent': 'Mozilla/5.0'
      }
    });
    if (!response.ok) continue;

    const html = await response.text();
    const candidates = extractCandidateUrls(html);
    for (const candidate of candidates) {
      if (isAllowedChordsUrl(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

async function resolveChordsUrlsForSongs(songs, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is required to resolve chords URLs');
  }

  const items = Array.isArray(songs) ? songs : [];
  const resolved = await Promise.all(
    items.map(async (song) => {
      const chordsUrl = String(song?.chords_url || '').trim();
      if (chordsUrl) {
        return { ...song, chords_url: chordsUrl };
      }

      const found = await searchForChordsUrl(song, fetchImpl);
      return {
        ...song,
        chords_url: found || null
      };
    })
  );

  return resolved;
}

async function prepareSongsForReply(songs, options = {}) {
  const resolver = options.resolver || resolveChordsUrlsForSongs;
  const items = Array.isArray(songs) ? songs.map((song) => ({ ...song })) : [];
  const missingSongs = items.filter((song) => !String(song?.chords_url || '').trim());

  if (missingSongs.length === 0) {
    return items;
  }

  const resolvedMissing = await resolver(missingSongs, options);
  const resolvedById = new Map(
    Array.isArray(resolvedMissing)
      ? resolvedMissing.map((song) => [String(song?.message_id || ''), song])
      : []
  );

  return items.map((song) => {
    const resolved = resolvedById.get(String(song?.message_id || ''));
    if (resolved && String(resolved.chords_url || '').trim()) {
      return { ...song, chords_url: String(resolved.chords_url).trim() };
    }
    return song;
  });
}

module.exports = {
  prepareSongsForReply,
  resolveChordsUrlsForSongs,
  formatSongLine,
  isAllowedChordsUrl
};
