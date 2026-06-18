const DEFAULT_SEARXNG_BASE_URL = 'http://127.0.0.1:8080';
const DEFAULT_SEARXNG_TIMEOUT_MS = 10000;
const DEFAULT_SEARXNG_MAX_RESULTS = 5;
const MAX_ALLOWED_CANDIDATES_PER_SONG = 10;

const ALLOWED_CHORD_HOSTS = [
  {
    hostSuffix: 'tab4u.com',
    pathPrefix: '/tabs/songs/'
  },
  {
    hostSuffix: 'nagnu.co.il',
    pathPrefix: '/'
  },
  {
    hostSuffix: 'ultimate-guitar.com',
    pathPrefix: '/tab/'
  },
  {
    hostSuffix: 'songsterr.com',
    pathPrefix: '/a/wsa/'
  },
  {
    hostSuffix: 'guitarsongs.club',
    pathPrefix: '/'
  }
];

function decodeText(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch (error) {
    return String(value || '');
  }
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizeComparableText(value) {
  return decodeText(value)
    .normalize('NFKD')
    .replace(/[\u0591-\u05C7]/g, '')
    .toLowerCase()
    .replace(/[_\-]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanSearchText(value, maxLength = 160) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function getSongLanguage(song) {
  const title = cleanSearchText(song?.song_title || '');
  const sourceText = cleanSearchText(song?.source_text || '');
  const language = String(song?.language || '').trim().toLowerCase();
  if (language) return language;
  return /[\u0590-\u05FF]/.test(`${title} ${sourceText}`) ? 'he' : 'en';
}

function quoteSearchText(value, maxLength = 160) {
  const cleaned = cleanSearchText(value, maxLength);
  return cleaned ? `"${cleaned}"` : '';
}

function normalizeHostname(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\.+/, '')
    .replace(/^www\./, '');
}

function normalizeUrlCandidate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return '';
    }
    return url.toString();
  } catch (error) {
    return '';
  }
}

function getSongComparableText(song) {
  return {
    title: normalizeComparableText(song?.song_title || ''),
    artist: normalizeComparableText(song?.artist || '')
  };
}

function tokenizeComparableText(value) {
  return normalizeComparableText(value)
    .split(' ')
    .filter(Boolean);
}

function normalizeMatchTokens(value) {
  const tokens = tokenizeComparableText(value);
  if (tokens.length === 0) return tokens;
  if (['the', 'a', 'an'].includes(tokens[0])) {
    return tokens.slice(1);
  }
  return tokens;
}

function hasStrongTextMatch(needle, haystack) {
  const normalizedNeedle = normalizeComparableText(needle);
  const normalizedHaystack = normalizeComparableText(haystack);
  if (!normalizedNeedle || !normalizedHaystack) return false;
  if (normalizedHaystack.includes(normalizedNeedle)) return true;

  const needleTokens = normalizeMatchTokens(normalizedNeedle);
  if (needleTokens.length === 0) return false;

  const haystackTokens = new Set(normalizeMatchTokens(normalizedHaystack));
  let matched = 0;
  for (const token of needleTokens) {
    if (haystackTokens.has(token)) matched += 1;
  }

  return matched / needleTokens.length >= 0.8;
}

function normalizeSongLine(song) {
  const title = String(song?.song_title || '').trim();
  const artist = String(song?.artist || '').trim();
  return title && artist ? `${title} - ${artist}` : title || artist || '';
}

function stripDirectionalMarks(value) {
  return String(value || '').replace(/[\u200e\u200f]/g, '').trim();
}

function getChordsPathText(value) {
  try {
    const url = new URL(String(value || '').trim());
    return decodeText(url.pathname);
  } catch (error) {
    return '';
  }
}

function isStrongChordsMatch(song, chordsUrl) {
  const pathText = normalizeComparableText(getChordsPathText(chordsUrl));
  if (!pathText) return false;

  const { title, artist } = getSongComparableText(song);
  if (!title || !hasStrongTextMatch(title, pathText)) return false;
  if (artist && pathText.includes(artist)) return true;
  return true;
}

function getAllowedChordHost(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch (error) {
    return null;
  }

  const hostname = normalizeHostname(url.hostname);
  const pathname = url.pathname.toLowerCase();

  for (const rule of ALLOWED_CHORD_HOSTS) {
    const ruleHost = normalizeHostname(rule.hostSuffix);
    if (hostname === ruleHost || hostname.endsWith(`.${ruleHost}`)) {
      if (pathname.startsWith(rule.pathPrefix)) {
        return {
          host: hostname,
          ruleHost,
          pathPrefix: rule.pathPrefix
        };
      }
    }
  }

  return null;
}

function isAllowedChordsUrl(value) {
  return Boolean(getAllowedChordHost(value));
}

function detectChordPageType(candidate) {
  let url;
  try {
    url = new URL(String(candidate?.url || '').trim());
  } catch (error) {
    return { type: 'unknown', reason: 'invalid url' };
  }

  const path = normalizeComparableText(url.pathname);
  const query = normalizeComparableText(url.search);
  const text = normalizeComparableText(candidate?.text || '');
  const combined = [path, query, text].filter(Boolean).join(' ');

  if (
    url.hostname.toLowerCase().endsWith('tab4u.com') &&
    url.pathname.toLowerCase().startsWith('/tabs/songs/')
  ) {
    return { type: 'chords', reason: 'tab4u song page marker' };
  }

  if (
    url.hostname.toLowerCase().endsWith('songsterr.com') &&
    url.pathname.toLowerCase().startsWith('/a/wsa/')
  ) {
    return { type: 'chords', reason: 'songsterr song page marker' };
  }

  if (/\b(chords?|אקורדים)\b/u.test(combined)) {
    return { type: 'chords', reason: 'chords indicator' };
  }

  if (
    /\b(tab|tabs|tablature)\b/u.test(combined) ||
    /\b(guitar tab|bass tab|ukulele tab)\b/u.test(combined) ||
    /\btype (bass|ukulele)\b/u.test(combined)
  ) {
    if (/\b(bass tab|ukulele tab)\b/u.test(combined)) {
      return { type: 'tabs', reason: 'explicit bass-tab marker' };
    }
    return { type: 'tabs', reason: 'tablature indicator' };
  }

  return { type: 'unknown', reason: 'no page-type marker' };
}

function hasPositiveChordEvidence(candidate) {
  let url;
  try {
    url = new URL(String(candidate?.url || '').trim());
  } catch (error) {
    return false;
  }

  const combined = normalizeComparableText([
    url.pathname,
    url.search,
    candidate?.text || ''
  ].join(' '));

  return /\b(chords?|אקורדים)\b/u.test(combined);
}

function explainChordsMatch(song, chordsUrl, candidateText = '') {
  let url;
  try {
    url = new URL(String(chordsUrl || '').trim());
  } catch (error) {
    return { ok: false, reason: 'invalid url' };
  }

  const allowedHost = getAllowedChordHost(url);
  if (!allowedHost) {
    return {
      ok: false,
      reason: 'unsupported host',
      host: normalizeHostname(url.hostname)
    };
  }

  const pathText = normalizeComparableText(decodeText(url.pathname));
  if (!pathText) {
    return { ok: false, reason: 'empty path text' };
  }

  if (allowedHost.ruleHost === 'songsterr.com') {
    return { ok: true, reason: 'matched', page_type: 'chords', page_type_reason: 'songsterr song page marker' };
  }

  const { title, artist } = getSongComparableText(song);
  const sourceText = normalizeComparableText(song?.source_text || '');
  if (!title) {
    return { ok: false, reason: 'missing title' };
  }

  const combinedText = [pathText, normalizeComparableText(candidateText)].filter(Boolean).join(' ');
  const titleMatches = hasStrongTextMatch(title, combinedText);
  const sourceMatches = sourceText ? hasStrongTextMatch(sourceText, combinedText) : false;
  if (!titleMatches && !sourceMatches) {
    return { ok: false, reason: 'weak title match' };
  }

  const pageType = detectChordPageType({ url: chordsUrl, text: candidateText });
  if (pageType.type === 'tabs') {
    return {
      ok: false,
      reason: 'tablature page, not chords',
      page_type: pageType.type,
      page_type_reason: pageType.reason
    };
  }
  if (pageType.type === 'unknown' && !hasPositiveChordEvidence({ url: chordsUrl, text: candidateText })) {
    return {
      ok: false,
      reason: 'page type is unknown and lacks chord evidence',
      page_type: pageType.type,
      page_type_reason: pageType.reason
    };
  }

  if (artist && !hasStrongTextMatch(artist, combinedText)) {
    return { ok: false, reason: 'weak artist match', page_type: pageType.type, page_type_reason: pageType.reason };
  }

  return { ok: true, reason: 'matched', page_type: pageType.type, page_type_reason: pageType.reason };
}

function formatSongsReply(songs, options = {}) {
  const items = Array.isArray(songs) ? songs.filter(Boolean) : [];
  if (items.length === 0) return '';

  const single = items.length === 1;
  const includeChords = options.includeChords === true;

  const lines = ['\u200F🤖 הבאתי:'];
  items.forEach((song, index) => {
    const base = single ? normalizeSongLine(song) : `${index + 1}. ${normalizeSongLine(song)}`;
    lines.push(`\u200F${base}`);
    const chordsUrl = includeChords ? String(song?.chords_url || '').trim() : '';
    if (chordsUrl) {
      lines.push(`\u200F   אקורדים: ${chordsUrl}`);
    }
  });

  return lines.join('\n');
}

function parseSongsFromReplyText(text) {
  const lines = String(text || '')
    .split(/\r?\n/u)
    .map((line) => stripDirectionalMarks(line))
    .filter(Boolean);

  const songs = [];

  for (const line of lines) {
    if (/^🤖\s*הבאתי:$/u.test(line)) continue;
    if (/^אקורדים:/u.test(line)) continue;

    const withoutNumber = line.replace(/^\d+\.\s*/u, '');
    const artistIndex = withoutNumber.lastIndexOf(' - ');
    let songTitle = withoutNumber;
    let artist = null;

    if (artistIndex > -1) {
      songTitle = withoutNumber.slice(0, artistIndex).trim();
      artist = withoutNumber.slice(artistIndex + 3).trim() || null;
    }

    if (!songTitle) continue;
    songs.push({
      song_title: songTitle,
      artist
    });
  }

  return songs;
}

function createCandidateDiagnostic({ url, host, query, allowedHost, title, snippet, engine, engines, rawUrl }) {
  return {
    rawUrl: rawUrl || null,
    url,
    host,
    query,
    title: title || '',
    snippet: snippet || '',
    engine: engine || '',
    engines: Array.isArray(engines) ? engines : [],
    allowedHost,
    pageType: null,
    pageTypeReason: null,
    rejectReason: null
  };
}

function getSearxngConfig(options = {}) {
  const baseUrl = String(
    options.baseUrl ||
      options.searxngBaseUrl ||
      process.env.SEARXNG_BASE_URL ||
      DEFAULT_SEARXNG_BASE_URL
  )
    .trim()
    .replace(/\/$/, '');
  const timeoutValue =
    options.timeoutMs !== undefined
      ? options.timeoutMs
      : options.searxngTimeoutMs !== undefined
        ? options.searxngTimeoutMs
        : process.env.SEARXNG_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(Number(timeoutValue))
    ? Number(timeoutValue)
    : Number.isFinite(Number(process.env.SEARXNG_TIMEOUT_MS))
      ? Number(process.env.SEARXNG_TIMEOUT_MS)
      : DEFAULT_SEARXNG_TIMEOUT_MS;
  const maxResultsValue =
    options.maxResults !== undefined
      ? options.maxResults
      : options.searxngMaxResults !== undefined
        ? options.searxngMaxResults
        : process.env.SEARXNG_MAX_RESULTS;
  const maxResults = Number.isFinite(Number(maxResultsValue))
    ? Number(maxResultsValue)
    : Number.isFinite(Number(process.env.SEARXNG_MAX_RESULTS))
      ? Number(process.env.SEARXNG_MAX_RESULTS)
      : DEFAULT_SEARXNG_MAX_RESULTS;
  const enginesValue =
    options.engines !== undefined
      ? options.engines
      : options.searxngEngines !== undefined
      ? options.searxngEngines
      : process.env.SEARXNG_ENGINES;
  const engines = Array.isArray(enginesValue)
    ? enginesValue.map((value) => String(value).trim()).filter(Boolean)
    : String(enginesValue || '')
        .split(',')
        .map((value) => String(value).trim())
        .filter(Boolean);

  return {
    baseUrl,
    timeoutMs: Math.max(1000, Math.floor(timeoutMs)),
    maxResults: Math.max(1, Math.floor(maxResults)),
    engines
  };
}

function buildSearchQueriesV2(song) {
  const title = cleanSearchText(song?.song_title || song?.source_text || '');
  const artist = cleanSearchText(song?.artist || '');
  const language = getSongLanguage(song);
  const fallbackKeyword = language === 'he' ? 'chords' : null;
  const primaryKeyword = language === 'he' ? 'אקורדים' : 'chords';
  const hosts = language === 'he'
    ? ['tab4u.com', 'nagnu.co.il', 'ultimate-guitar.com']
    : ['ultimate-guitar.com', 'songsterr.com', 'tabs.ultimate-guitar.com', 'tab4u.com', 'guitarsongs.club'];
  const queries = [];

  const getSiteTarget = (host) => {
    if (host === 'ultimate-guitar.com' || host === 'tabs.ultimate-guitar.com') {
      return `${host}/tab/`;
    }
    if (host === 'songsterr.com') {
      return 'songsterr.com/a/wsa/';
    }
    if (host === 'tab4u.com') {
      return 'tab4u.com/tabs/songs/';
    }
    return host;
  };

  const addQuery = (host, keyword) => {
    const siteTarget = getSiteTarget(host);
    const query = [
      `site:${siteTarget}`,
      quoteSearchText(title),
      quoteSearchText(artist),
      keyword
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (query) queries.push(query);
  };

  for (const host of hosts) {
    addQuery(host, primaryKeyword);
  }

  if (fallbackKeyword) {
    for (const host of hosts) {
      addQuery(host, fallbackKeyword);
    }
  }

  return Array.from(new Set(queries));
}

async function fetchSearxngResults(query, fetchImpl, options = {}) {
  const config = getSearxngConfig(options);
  const searchUrl = new URL('/search', config.baseUrl);
  searchUrl.search = new URLSearchParams({
    q: query,
    format: 'json',
    pageno: '1'
  }).toString();
  if (config.engines.length > 0) {
    searchUrl.searchParams.set('engines', config.engines.join(','));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('SearXNG request timed out')), config.timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetchImpl(searchUrl.toString(), {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0',
        accept: 'application/json'
      }
    });

    if (!response) {
      throw new Error('SearXNG request failed: no response');
    }

    if (response.status === 403) {
      throw new Error('SearXNG rejected JSON output. Enable json under search.formats in settings.yml.');
    }

    if (!response.ok) {
      throw new Error(`SearXNG request failed: HTTP ${response.status}`);
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw new Error(`SearXNG request failed: invalid JSON (${error.message || error})`);
    }

    if (!data || !Array.isArray(data.results)) {
      throw new Error('SearXNG request failed: missing results array');
    }

    const results = data.results
      .map((item) => {
        const rawUrl = item?.url || item?.link || '';
        const url = normalizeUrlCandidate(rawUrl);
        if (!url) return null;
        const title = String(item?.title || '').trim();
        const snippet = String(item?.content || item?.snippet || '').trim();
        const engine = String(item?.engine || '').trim();
        const engines = Array.isArray(item?.engines) ? item.engines.map((value) => String(value).trim()).filter(Boolean) : [];
        return {
          rawUrl,
          url,
          title,
          snippet,
          text: [title, snippet].filter(Boolean).join(' ').trim(),
          engine,
          engines
        };
      })
      .filter(Boolean)
      .slice(0, config.maxResults);

    return { query, searchUrl: searchUrl.toString(), results };
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? `SearXNG request failed: timeout after ${config.timeoutMs}ms`
      : (error?.message || String(error));
    return {
      query,
      searchUrl: searchUrl.toString(),
      results: [],
      error: message
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function searchForChordsUrl(song, fetchImpl, options = {}) {
  const debug = await searchForChordsUrlWithDebug(song, fetchImpl, options);
  return debug.chords_url;
}

async function searchForChordsUrlWithDebug(song, fetchImpl, options = {}) {
  const queries = buildSearchQueriesV2(song);
  const config = getSearxngConfig(options);
  const queryDiagnostics = [];
  const candidateDiagnostics = [];
  const seenUrls = new Set();
  let searchResultsReceived = 0;
  let unsupportedHostsSkipped = 0;
  let duplicateUrlsSkipped = 0;
  let allowedCandidatesInspected = 0;
  let bestAllowedCandidate = null;
  let lastUnsupportedCandidate = null;
  let lastAllowedCandidate = null;

  for (const query of queries) {
    const result = await fetchSearxngResults(query, fetchImpl, config);
    queryDiagnostics.push({
      query: result.query,
      searchUrl: result.searchUrl,
      resultsReturned: Array.isArray(result.results) ? result.results.length : 0,
      error: result.error || null
    });
    searchResultsReceived += Array.isArray(result.results) ? result.results.length : 0;

    if (!Array.isArray(result.results)) continue;

    for (const candidate of result.results) {
      const normalizedUrl = normalizeUrlCandidate(candidate.url);
      if (!normalizedUrl) {
        continue;
      }

      try {
        const url = new URL(normalizedUrl);
        const host = normalizeHostname(url.hostname);
        const allowedHost = getAllowedChordHost(url);
        const diagnostic = createCandidateDiagnostic({
          url: url.toString(),
          host,
          query: result.query,
          allowedHost: Boolean(allowedHost),
          title: candidate.title,
          snippet: candidate.snippet,
          engine: candidate.engine,
          engines: candidate.engines,
          rawUrl: candidate.rawUrl
        });

        if (!allowedHost) {
          unsupportedHostsSkipped += 1;
          diagnostic.rejectReason = 'unsupported host';
          candidateDiagnostics.push(diagnostic);
          lastUnsupportedCandidate = diagnostic;
          continue;
        }

        if (seenUrls.has(url.toString())) {
          duplicateUrlsSkipped += 1;
          diagnostic.rejectReason = 'duplicate url';
          candidateDiagnostics.push(diagnostic);
          continue;
        }
        seenUrls.add(url.toString());

        if (allowedCandidatesInspected >= MAX_ALLOWED_CANDIDATES_PER_SONG) {
          diagnostic.rejectReason = 'candidate limit reached';
          candidateDiagnostics.push(diagnostic);
          continue;
        }

        allowedCandidatesInspected += 1;
        const candidateText = [candidate.title, candidate.snippet].filter(Boolean).join(' ').trim();
        const match = explainChordsMatch(song, url.toString(), candidateText);
        diagnostic.pageType = match.page_type || 'unknown';
        diagnostic.pageTypeReason = match.page_type_reason || null;
        diagnostic.rejectReason = match.ok ? null : match.reason;
        candidateDiagnostics.push(diagnostic);

        if (match.ok) {
          return {
            chords_url: url.toString(),
            reason: 'matched',
            search_backend: 'SearXNG',
            searxng_url: config.baseUrl,
            queries_tried: queries,
            query_diagnostics: queryDiagnostics,
            search_results_received: searchResultsReceived,
            unsupported_hosts_skipped: unsupportedHostsSkipped,
            duplicate_urls_skipped: duplicateUrlsSkipped,
            allowed_candidates_inspected: allowedCandidatesInspected,
            best_candidate: diagnostic,
            candidate_diagnostics: candidateDiagnostics
          };
        }

        lastAllowedCandidate = diagnostic;
        bestAllowedCandidate = diagnostic;
      } catch (error) {
        continue;
      }
    }
  }

  const summaryCandidate = bestAllowedCandidate || lastUnsupportedCandidate || candidateDiagnostics[candidateDiagnostics.length - 1] || null;
  const searchError = queryDiagnostics.find((item) => item.error)?.error || null;

  return {
    chords_url: null,
    reason: summaryCandidate?.rejectReason || (searchError ? 'search error' : 'no candidate found'),
    search_error: searchError,
    rejected_candidate: summaryCandidate?.url || null,
    rejected_host: summaryCandidate?.host || null,
    page_type: summaryCandidate?.allowedHost ? summaryCandidate?.pageType || 'unknown' : null,
    page_type_reason: summaryCandidate?.allowedHost ? summaryCandidate?.pageTypeReason || null : null,
    search_backend: 'SearXNG',
    searxng_url: config.baseUrl,
    queries_tried: queries,
    query_diagnostics: queryDiagnostics,
    search_results_received: searchResultsReceived,
    unsupported_hosts_skipped: unsupportedHostsSkipped,
    duplicate_urls_skipped: duplicateUrlsSkipped,
    allowed_candidates_inspected: allowedCandidatesInspected,
    best_candidate: summaryCandidate,
    candidate_diagnostics: candidateDiagnostics
  };
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

      const found = await searchForChordsUrl(song, fetchImpl, options);
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
  formatSongLine: normalizeSongLine,
  formatSongsReply,
  parseSongsFromReplyText,
  searchForChordsUrlWithDebug,
  explainChordsMatch,
  isStrongChordsMatch,
  isAllowedChordsUrl
};
