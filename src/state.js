const fs = require('fs/promises');
const crypto = require('crypto');

const MAX_SEEN_MESSAGE_IDS = 50;
const MAX_RECENT_RECOMMENDATION_IDS = 25;
const CURRENT_SCHEMA_VERSION = 2;
const REQUIRED_AI_METADATA_FIELDS = [
  'original_vocal',
  'vocal_range',
  'vocal_style',
  'singer_fit',
  'vocal_energy',
  'band_energy',
  'crowd_friendly',
  'groove_level',
  'guitar_difficulty',
  'bass_difficulty',
  'drums_difficulty',
  'keys_role',
  'keys_difficulty',
  'bass_interest'
];
const ALLOWED_DIFFICULTIES = new Set(['low', 'medium', 'high']);
const ALLOWED_FEELS = new Set(['upbeat', 'calm', 'ballad']);
const ALLOWED_BAND_FITS = new Set(['unknown', 'good', 'maybe', 'bad']);

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]+/gu, '')
    .trim();
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function createDefaultState() {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    ai_enrichment: {
      complete: false,
      version: null,
      generated_at: null,
      source: null,
      band_status_overrides_ai: true,
      fields: [...REQUIRED_AI_METADATA_FIELDS]
    },
    songs: [],
    chats: {},
    result_messages: {}
  };
}

function normalizeGenres(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const genres = [];
  for (const item of value) {
    const genre = String(item || '').trim().toLowerCase();
    if (!genre || seen.has(genre)) continue;
    seen.add(genre);
    genres.push(genre);
  }
  return genres;
}

function normalizeDifficulty(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ALLOWED_DIFFICULTIES.has(normalized) ? normalized : null;
}

function normalizeFeel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ALLOWED_FEELS.has(normalized) ? normalized : null;
}

function createDefaultAiMetadata() {
  return {
    original_vocal: 'unknown',
    vocal_range: 'unknown',
    vocal_style: [],
    singer_fit: 'unknown',
    vocal_energy: 'medium',
    band_energy: 'medium',
    crowd_friendly: false,
    groove_level: 'medium',
    guitar_difficulty: 'medium',
    bass_difficulty: 'medium',
    drums_difficulty: 'medium',
    keys_role: 'optional',
    keys_difficulty: 'medium',
    bass_interest: 'medium'
  };
}

function normalizeAiMetadata(value = {}) {
  const base = createDefaultAiMetadata();
  const source = value && typeof value === 'object' ? value : {};

  return {
    ...base,
    ...source,
    original_vocal: String(source.original_vocal ?? base.original_vocal).trim().toLowerCase(),
    vocal_range: String(source.vocal_range ?? base.vocal_range).trim().toLowerCase(),
    vocal_style: Array.isArray(source.vocal_style)
      ? Array.from(
          new Set(
            source.vocal_style
              .map((item) => String(item || '').trim().toLowerCase())
              .filter(Boolean)
          )
        )
      : [],
    singer_fit: String(source.singer_fit ?? base.singer_fit).trim().toLowerCase(),
    vocal_energy: String(source.vocal_energy ?? base.vocal_energy).trim().toLowerCase(),
    band_energy: String(source.band_energy ?? base.band_energy).trim().toLowerCase(),
    crowd_friendly: Boolean(source.crowd_friendly),
    groove_level: String(source.groove_level ?? base.groove_level).trim().toLowerCase(),
    guitar_difficulty: String(source.guitar_difficulty ?? base.guitar_difficulty).trim().toLowerCase(),
    bass_difficulty: String(source.bass_difficulty ?? base.bass_difficulty).trim().toLowerCase(),
    drums_difficulty: String(source.drums_difficulty ?? base.drums_difficulty).trim().toLowerCase(),
    keys_role: String(source.keys_role ?? base.keys_role).trim().toLowerCase(),
    keys_difficulty: String(source.keys_difficulty ?? base.keys_difficulty).trim().toLowerCase(),
    bass_interest: String(source.bass_interest ?? base.bass_interest).trim().toLowerCase()
  };
}

function createDefaultBandStatus() {
  return {
    fit: 'unknown',
    issues: [],
    notes: '',
    attempts: 0,
    last_reviewed: null,
    last_rehearsed: null,
    last_played: null
  };
}

function normalizeBandStatus(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const fit = String(source.fit || 'unknown').trim().toLowerCase();

  return {
    ...createDefaultBandStatus(),
    ...source,
    fit: ALLOWED_BAND_FITS.has(fit) ? fit : 'unknown',
    issues: Array.isArray(source.issues)
      ? Array.from(new Set(source.issues.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)))
      : [],
    notes: String(source.notes || ''),
    attempts: Number.isInteger(source.attempts) && source.attempts >= 0 ? source.attempts : 0,
    last_reviewed: source.last_reviewed || null,
    last_rehearsed: source.last_rehearsed || null,
    last_played: source.last_played || null
  };
}

function createSongId(song) {
  const title = normalizeText(song?.song_title || '');
  const artist = normalizeText(song?.artist || '');
  const digest = crypto.createHash('sha1').update(`${title}::${artist}`, 'utf8').digest('hex');
  return `song_${digest.slice(0, 12)}`;
}

function normalizeSong(rawSong) {
  const song = rawSong && typeof rawSong === 'object' ? rawSong : {};
  const normalizedTitle = song.normalized_title || normalizeText(song.song_title);
  const normalizedArtist = song.normalized_artist || normalizeText(song.artist || '');

  return {
    ...song,
    message_id: String(song.message_id || '').trim(),
    source_text: String(song.source_text || '').trim(),
    song_title: String(song.song_title || '').trim(),
    artist: song.artist === null || song.artist === undefined ? null : String(song.artist).trim(),
    language: song.language ? String(song.language).trim().toLowerCase() : null,
    chords_url: song.chords_url ? String(song.chords_url).trim() : null,
    confidence: Number.isFinite(Number(song.confidence)) ? Number(song.confidence) : 0,
    genres: normalizeGenres(song.genres),
    difficulty: normalizeDifficulty(song.difficulty),
    feel: normalizeFeel(song.feel),
    used: Boolean(song.used),
    created_at: song.created_at || new Date().toISOString(),
    normalized_title: normalizedTitle,
    normalized_artist: normalizedArtist,
    song_id: String(song.song_id || createSongId({ song_title: song.song_title, artist: song.artist })).trim(),
    ai_metadata: normalizeAiMetadata(song.ai_metadata),
    band_status: normalizeBandStatus(song.band_status)
  };
}

function normalizeResultEntry(value) {
  if (!value || typeof value !== 'object') return null;
  const index = Number.parseInt(value.index, 10);
  if (!Number.isInteger(index) || index <= 0) return null;

  return {
    index,
    song_id: String(value.song_id || '').trim(),
    title: value.title === undefined || value.title === null ? null : String(value.title).trim(),
    artist: value.artist === undefined || value.artist === null ? null : String(value.artist).trim()
  };
}

function normalizeResultContext(value) {
  if (!value || typeof value !== 'object') return null;
  const results = Array.isArray(value.results)
    ? value.results.map(normalizeResultEntry).filter(Boolean)
    : [];

  return {
    bot_message_id: value.bot_message_id ? String(value.bot_message_id).trim() : null,
    chat_id: value.chat_id ? String(value.chat_id).trim() : null,
    created_at: value.created_at || null,
    results
  };
}

function normalizeChats(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value);
  const chats = {};

  for (const [chatId, chatValue] of entries) {
    if (!chatValue || typeof chatValue !== 'object') continue;
    const lastResults = normalizeResultContext(chatValue.last_results);
    const resultMessagesSource =
      chatValue.result_messages && typeof chatValue.result_messages === 'object' && !Array.isArray(chatValue.result_messages)
        ? chatValue.result_messages
        : {};
    const resultMessages = {};

    for (const [messageId, messageValue] of Object.entries(resultMessagesSource)) {
      const normalized = normalizeResultContext({
        ...messageValue,
        bot_message_id: messageValue?.bot_message_id || messageId,
        chat_id: messageValue?.chat_id || chatId
      });
      if (normalized) {
        resultMessages[String(messageId).trim()] = normalized;
      }
    }

    chats[String(chatId).trim()] = {
      last_results: lastResults,
      result_messages: resultMessages,
      recent_recommendations: Array.isArray(chatValue.recent_recommendations)
        ? Array.from(new Set(chatValue.recent_recommendations.map((item) => String(item || '').trim()).filter(Boolean))).slice(-MAX_RECENT_RECOMMENDATION_IDS)
        : []
    };
  }

  return chats;
}

function normalizeTopLevelResultMessages(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const resultMessages = {};
  for (const [messageId, messageValue] of Object.entries(value)) {
    const normalized = normalizeResultContext({
      ...messageValue,
      bot_message_id: messageValue?.bot_message_id || messageId
    });
    if (normalized) {
      resultMessages[String(messageId).trim()] = normalized;
    }
  }
  return resultMessages;
}

function validateCanonicalState(state, filePath = 'state.json') {
  const problems = [];
  const location = String(filePath || 'state.json');

  if (state.schema_version !== CURRENT_SCHEMA_VERSION) {
    problems.push(`Expected schema_version ${CURRENT_SCHEMA_VERSION}, got ${JSON.stringify(state.schema_version)}`);
  }

  if (!state.ai_enrichment || state.ai_enrichment.complete !== true) {
    problems.push('Expected ai_enrichment.complete to be true');
  }

  if (!Array.isArray(state.songs)) {
    problems.push('Expected songs to be an array');
  }

  for (const [index, song] of (state.songs || []).entries()) {
    const prefix = `songs[${index}]`;

    if (!song.song_id) problems.push(`${prefix}.song_id is required`);
    if (!song.song_title) problems.push(`${prefix}.song_title is required`);
    if (!song.artist) problems.push(`${prefix}.artist is required`);
    if (!song.message_id) problems.push(`${prefix}.message_id is required`);
    if (!song.normalized_title) problems.push(`${prefix}.normalized_title is required`);
    if (!song.normalized_artist) problems.push(`${prefix}.normalized_artist is required`);
    if (!Array.isArray(song.genres) || song.genres.length === 0) problems.push(`${prefix}.genres must be a non-empty array`);
    if (!ALLOWED_DIFFICULTIES.has(String(song.difficulty || '').trim().toLowerCase())) {
      problems.push(`${prefix}.difficulty must be low, medium, or high`);
    }
    if (!ALLOWED_FEELS.has(String(song.feel || '').trim().toLowerCase())) {
      problems.push(`${prefix}.feel must be upbeat, calm, or ballad`);
    }
    if (!song.ai_metadata || typeof song.ai_metadata !== 'object') {
      problems.push(`${prefix}.ai_metadata is required`);
    } else {
      for (const field of REQUIRED_AI_METADATA_FIELDS) {
        if (!(field in song.ai_metadata)) {
          problems.push(`${prefix}.ai_metadata.${field} is required`);
        }
      }
    }
    if (!song.band_status || typeof song.band_status !== 'object') {
      problems.push(`${prefix}.band_status is required`);
    } else if (!ALLOWED_BAND_FITS.has(String(song.band_status.fit || '').trim().toLowerCase())) {
      problems.push(`${prefix}.band_status.fit must be one of unknown, good, maybe, bad`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid canonical dataset in ${location}:\n- ${problems.join('\n- ')}`);
  }
}

function normalizeState(raw, options = {}) {
  const { validateCanonical = false, filePath = 'state.json' } = options;
  const base = createDefaultState();
  const source = raw && typeof raw === 'object' ? raw : {};

  const state = {
    ...base,
    ...source,
    schema_version: Number.isInteger(source.schema_version) ? source.schema_version : base.schema_version,
    ai_enrichment: source.ai_enrichment && typeof source.ai_enrichment === 'object'
      ? {
          ...base.ai_enrichment,
          ...source.ai_enrichment,
          fields: Array.isArray(source.ai_enrichment.fields)
            ? Array.from(new Set(source.ai_enrichment.fields.map((item) => String(item || '').trim()).filter(Boolean)))
            : [...base.ai_enrichment.fields]
        }
      : cloneJson(base.ai_enrichment),
    songs: Array.isArray(source.songs)
      ? source.songs.filter((song) => song && typeof song === 'object').map(normalizeSong).filter((song) => song.song_title)
      : [],
    chats: normalizeChats(source.chats),
    result_messages: normalizeTopLevelResultMessages(source.result_messages)
  };

  if (validateCanonical && (state.songs.length > 0 || source.ai_enrichment || source.schema_version !== undefined)) {
    validateCanonicalState(state, filePath);
  }

  return state;
}

function createDefaultSeenState() {
  return {
    seenMessageIds: [],
    lastBootstrapAt: null
  };
}

function normalizeSeenState(raw) {
  const state = createDefaultSeenState();
  if (!raw || typeof raw !== 'object') return state;

  const seenMessageIds = new Set();
  const maybeIds = Array.isArray(raw.seenMessageIds) ? raw.seenMessageIds : [];
  for (const id of maybeIds) {
    if (id) seenMessageIds.add(String(id));
  }
  state.seenMessageIds = Array.from(seenMessageIds).slice(-MAX_SEEN_MESSAGE_IDS);
  state.lastBootstrapAt = raw.lastBootstrapAt || null;
  return state;
}

async function loadState(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return normalizeState(JSON.parse(content), { validateCanonical: true, filePath });
  } catch (error) {
    if (error.code === 'ENOENT') return createDefaultState();
    throw error;
  }
}

async function saveState(filePath, state) {
  const payload = JSON.stringify(state, null, 2);
  await fs.writeFile(filePath, payload, 'utf8');
}

async function loadSeenState(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return normalizeSeenState(JSON.parse(content));
  } catch (error) {
    if (error.code === 'ENOENT') return createDefaultSeenState();
    throw error;
  }
}

async function saveSeenState(filePath, state) {
  const payload = JSON.stringify(state, null, 2);
  await fs.writeFile(filePath, payload, 'utf8');
}

function createStateStore(stateFilePath, seenFilePath, initialState, initialSeenState) {
  let state = normalizeState(initialState, { validateCanonical: false, filePath: stateFilePath });
  let seenState = normalizeSeenState(initialSeenState);
  let saveChain = Promise.resolve();

  function getRandomSongCandidate() {
    if (state.songs.length === 0) return null;

    const weights = state.songs.map((song) => {
      const confidence = Number.isFinite(Number(song.confidence)) ? Number(song.confidence) : 0.5;
      const baseWeight = Math.min(Math.max(confidence, 0.05), 1);
      const artistBonus = song.artist ? 0.05 : 0;
      return baseWeight + artistBonus;
    });

    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    if (totalWeight <= 0) {
      return state.songs[Math.floor(Math.random() * state.songs.length)] || null;
    }

    let cursor = Math.random() * totalWeight;
    for (let index = 0; index < state.songs.length; index += 1) {
      cursor -= weights[index];
      if (cursor <= 0) {
        return state.songs[index];
      }
    }

    return state.songs[state.songs.length - 1] || null;
  }

  function snapshot() {
    return cloneJson(state);
  }

  function seenSnapshot() {
    return {
      seenMessageIds: [...seenState.seenMessageIds],
      lastBootstrapAt: seenState.lastBootstrapAt
    };
  }

  function queueSave() {
    saveChain = saveChain
      .then(async () => {
        await saveState(stateFilePath, snapshot());
        await saveSeenState(seenFilePath, seenSnapshot());
      })
      .catch((error) => {
        console.error('[state] save failed:', error);
      });
    return saveChain;
  }

  function hasSeenMessage(messageId) {
    return seenState.seenMessageIds.includes(messageId);
  }

  function markSeenMessage(messageId) {
    if (!messageId || hasSeenMessage(messageId)) return false;
    seenState.seenMessageIds.push(messageId);
    if (seenState.seenMessageIds.length > MAX_SEEN_MESSAGE_IDS) {
      seenState.seenMessageIds.splice(0, seenState.seenMessageIds.length - MAX_SEEN_MESSAGE_IDS);
    }
    return true;
  }

  function addSong(song) {
    const normalizedSong = normalizeSong(song);
    const existing = state.songs.find(
      (item) =>
        item.message_id === normalizedSong.message_id ||
        item.song_id === normalizedSong.song_id ||
        (item.normalized_title === normalizedSong.normalized_title &&
          item.normalized_artist === normalizedSong.normalized_artist &&
          item.normalized_title)
    );
    if (existing) return false;
    state.songs.push(normalizedSong);
    markSeenMessage(normalizedSong.message_id);
    return true;
  }

  function getNextUnusedSong() {
    return getRandomSongCandidate();
  }

  function getSongs() {
    return state.songs;
  }

  function getSongById(songId) {
    const normalizedSongId = String(songId || '').trim();
    if (!normalizedSongId) return null;
    return state.songs.find((song) => String(song.song_id || '').trim() === normalizedSongId) || null;
  }

  function findSongByNormalizedName(songTitle, artist) {
    const normalizedTitle = normalizeText(songTitle || '');
    const normalizedArtist = normalizeText(artist || '');
    if (!normalizedTitle) return null;

    return state.songs.find((song) => {
      if (song.normalized_title !== normalizedTitle) return false;
      if (normalizedArtist && song.normalized_artist !== normalizedArtist) return false;
      return true;
    }) || null;
  }

  function findSongsByNormalizedName(songTitle, artist) {
    const normalizedTitle = normalizeText(songTitle || '');
    const normalizedArtist = normalizeText(artist || '');
    if (!normalizedTitle) return [];

    return state.songs.filter((song) => {
      if (song.normalized_title !== normalizedTitle) return false;
      if (normalizedArtist && song.normalized_artist !== normalizedArtist) return false;
      return true;
    });
  }

  function updateSongById(songId, updater) {
    const song = getSongById(songId);
    if (!song) return null;

    const nextSong =
      typeof updater === 'function'
        ? updater(cloneJson(song))
        : { ...song, ...(updater && typeof updater === 'object' ? updater : {}) };
    if (!nextSong || typeof nextSong !== 'object') return null;

    const normalizedSong = normalizeSong({ ...song, ...nextSong, song_id: song.song_id });
    const index = state.songs.findIndex((item) => item.song_id === song.song_id);
    if (index === -1) return null;
    state.songs[index] = normalizedSong;
    return normalizedSong;
  }

  function removeSongById(songId) {
    const normalizedSongId = String(songId || '').trim();
    const index = state.songs.findIndex((song) => String(song.song_id || '').trim() === normalizedSongId);
    if (index === -1) return null;
    const [removed] = state.songs.splice(index, 1);
    return removed || null;
  }

  function markSongUsed(messageId) {
    const song = state.songs.find((item) => item.message_id === messageId);
    if (!song) return false;
    song.used = true;
    return true;
  }

  function setSongChordsUrl(messageId, chordsUrl) {
    const song = state.songs.find((item) => item.message_id === messageId);
    if (!song) return false;
    const normalized = chordsUrl ? String(chordsUrl).trim() : null;
    if (song.chords_url === normalized) return false;
    song.chords_url = normalized;
    return true;
  }

  function setLastResults(chatId, context) {
    const normalizedChatId = String(chatId || '').trim();
    if (!normalizedChatId) return false;
    const normalizedContext = normalizeResultContext({ ...context, chat_id: normalizedChatId });
    if (!normalizedContext) return false;
    const existingChat = state.chats[normalizedChatId] || { last_results: null, result_messages: {} };
    state.chats[normalizedChatId] = {
      last_results: normalizedContext,
      result_messages: existingChat.result_messages || {},
      recent_recommendations: existingChat.recent_recommendations || []
    };
    return true;
  }

  function getLastResults(chatId) {
    const normalizedChatId = String(chatId || '').trim();
    return state.chats[normalizedChatId]?.last_results || null;
  }

  function storeResultMessage(chatId, botMessageId, context) {
    const normalizedChatId = String(chatId || '').trim();
    const normalizedBotMessageId = String(botMessageId || '').trim();
    if (!normalizedChatId || !normalizedBotMessageId) return false;

    const normalizedContext = normalizeResultContext({
      ...context,
      chat_id: normalizedChatId,
      bot_message_id: normalizedBotMessageId
    });
    if (!normalizedContext) return false;

    if (!state.chats[normalizedChatId]) {
      state.chats[normalizedChatId] = { last_results: null, result_messages: {}, recent_recommendations: [] };
    }
    state.chats[normalizedChatId].result_messages[normalizedBotMessageId] = normalizedContext;
    state.result_messages[normalizedBotMessageId] = normalizedContext;
    return true;
  }

  function getResultMessage(botMessageId) {
    const normalizedBotMessageId = String(botMessageId || '').trim();
    if (!normalizedBotMessageId) return null;
    return state.result_messages[normalizedBotMessageId] || null;
  }

  function setBootstrapComplete() {
    seenState.lastBootstrapAt = new Date().toISOString();
  }

  function getRecentRecommendations(chatId) {
    const normalizedChatId = String(chatId || '').trim();
    return Array.isArray(state.chats[normalizedChatId]?.recent_recommendations)
      ? [...state.chats[normalizedChatId].recent_recommendations]
      : [];
  }

  function recordRecommendations(chatId, songIds) {
    const normalizedChatId = String(chatId || '').trim();
    if (!normalizedChatId) return false;
    const normalizedSongIds = Array.isArray(songIds)
      ? songIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    if (!normalizedSongIds.length) return false;

    if (!state.chats[normalizedChatId]) {
      state.chats[normalizedChatId] = { last_results: null, result_messages: {}, recent_recommendations: [] };
    }

    const existing = Array.isArray(state.chats[normalizedChatId].recent_recommendations)
      ? state.chats[normalizedChatId].recent_recommendations
      : [];
    const merged = Array.from(new Set([...existing, ...normalizedSongIds]));
    state.chats[normalizedChatId].recent_recommendations = merged.slice(-MAX_RECENT_RECOMMENDATION_IDS);
    return true;
  }

  function isEmpty() {
    return state.songs.length === 0;
  }

  return {
    get state() {
      return state;
    },
    get seenState() {
      return seenState;
    },
    hasSeenMessage,
    markSeenMessage,
    addSong,
    getNextUnusedSong,
    getSongs,
    getSongById,
    findSongByNormalizedName,
    findSongsByNormalizedName,
    updateSongById,
    removeSongById,
    markSongUsed,
    setSongChordsUrl,
    setLastResults,
    getLastResults,
    getRecentRecommendations,
    recordRecommendations,
    storeResultMessage,
    getResultMessage,
    setBootstrapComplete,
    isEmpty,
    queueSave
  };
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  REQUIRED_AI_METADATA_FIELDS,
  createDefaultState,
  createDefaultSeenState,
  loadState,
  loadSeenState,
  saveState,
  saveSeenState,
  createStateStore,
  normalizeState,
  validateCanonicalState,
  normalizeText
};
