const { searchSongs } = require('./song-search');
const { loadEventSchedule } = require('./event-reminders');

function compactSong(song) {
  return {
    song_id: song.song_id,
    song_title: song.song_title,
    artist: song.artist || null,
    language: song.language || null,
    genres: Array.isArray(song.genres) ? song.genres : [],
    difficulty: song.difficulty || null,
    feel: song.feel || null,
    ai_metadata: song.ai_metadata || null,
    band_status: song.band_status || null
  };
}

const READ_ONLY_SONG_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'lookup_song',
      description: 'Look up an existing song in the local band catalog by its exact title and, when known, artist. Never creates or changes a song.',
      parameters: {
        type: 'object',
        properties: {
          song_title: { type: 'string', description: 'The song title to look up.' },
          artist: { type: 'string', description: 'Optional artist to disambiguate the exact title.' }
        },
        required: ['song_title'],
        additionalProperties: false
      }
    }
  }
  ,
  {
    type: 'function',
    function: {
      name: 'search_catalog',
      description: 'Search the local band catalog for song recommendations. Never creates or changes a song.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'object', description: 'Structured local catalog query using requirements, preferences, exclusions, and limit.' }
        },
        required: ['query'],
        additionalProperties: false
      }
    }
  }
];

const READ_ONLY_EVENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'lookup_rehearsals',
      description: 'Retrieve the current WhatsApp rehearsal events for the band. Use for any question about a rehearsal date, the next rehearsal, rehearsals in a month, or the full rehearsal schedule. Never creates or changes an event.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  }
];

const READ_ONLY_TOOLS = [...READ_ONLY_SONG_TOOLS, ...READ_ONLY_EVENT_TOOLS];

function parseToolArguments(rawArguments) {
  if (rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)) {
    return rawArguments;
  }
  try {
    const parsed = JSON.parse(String(rawArguments || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function executeReadOnlySongTool({ stateStore, name, arguments: rawArguments }) {
  const args = parseToolArguments(rawArguments);
  if (name === 'search_catalog') {
    const query = args.query && typeof args.query === 'object' && !Array.isArray(args.query) ? args.query : {};
    const songs = typeof stateStore?.getSongs === 'function' ? stateStore.getSongs() : [];
    const results = searchSongs(songs, { ...query, limit: Math.min(Math.max(Number.parseInt(query.limit, 10) || 5, 1), 10) });
    return { ok: true, status: results.length ? 'found' : 'not_found', songs: results.map(compactSong) };
  }
  if (name !== 'lookup_song') {
    return { ok: false, error: 'unknown_tool' };
  }

  const songTitle = String(args.song_title || '').trim();
  const artist = String(args.artist || '').trim();
  if (!songTitle) {
    return { ok: false, error: 'song_title_required' };
  }

  const matches = typeof stateStore?.findSongsByNormalizedName === 'function'
    ? stateStore.findSongsByNormalizedName(songTitle, artist)
    : [];
  if (matches.length === 0) {
    return { ok: true, status: 'not_found', songs: [] };
  }
  if (matches.length > 1) {
    return { ok: true, status: 'ambiguous', songs: matches.map(compactSong) };
  }
  return { ok: true, status: 'found', songs: [compactSong(matches[0])] };
}

async function executeReadOnlyTool({ stateStore, eventsFile, name, arguments: rawArguments }) {
  if (name === 'lookup_rehearsals') {
    const schedule = await loadEventSchedule(eventsFile);
    return {
      ok: true,
      status: schedule.events.length ? 'found' : 'not_found',
      time_zone: schedule.time_zone,
      events: schedule.events
        .filter((event) => !event.cancelled)
        .sort((left, right) => new Date(left.start_at) - new Date(right.start_at))
        .map(({ id, title, start_at, details }) => ({ id, title, start_at, details }))
    };
  }
  return executeReadOnlySongTool({ stateStore, name, arguments: rawArguments });
}

module.exports = {
  READ_ONLY_SONG_TOOLS,
  READ_ONLY_EVENT_TOOLS,
  READ_ONLY_TOOLS,
  executeReadOnlySongTool,
  executeReadOnlyTool,
  parseToolArguments
};
