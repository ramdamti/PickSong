const fs = require('fs/promises');

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]+/gu, '')
    .trim();
}

function createDefaultState() {
  return {
    songs: [],
    seenMessageIds: [],
    lastBootstrapAt: null
  };
}

function normalizeState(raw) {
  const state = createDefaultState();
  if (!raw || typeof raw !== 'object') return state;

  if (Array.isArray(raw.songs)) {
    state.songs = raw.songs
      .filter((song) => song && typeof song === 'object')
      .map((song) => ({
        message_id: String(song.message_id || '').trim(),
        source_text: String(song.source_text || '').trim(),
        song_title: String(song.song_title || '').trim(),
        artist: song.artist === null || song.artist === undefined ? null : String(song.artist).trim(),
        language: song.language ? String(song.language).trim() : null,
        confidence: Number.isFinite(Number(song.confidence)) ? Number(song.confidence) : 0,
        used: Boolean(song.used),
        created_at: song.created_at || new Date().toISOString(),
        normalized_title: song.normalized_title || normalizeText(song.song_title),
        normalized_artist: song.normalized_artist || normalizeText(song.artist || '')
      }))
      .filter((song) => song.song_title);
  }

  const seenMessageIds = new Set();
  const maybeIds = Array.isArray(raw.seenMessageIds) ? raw.seenMessageIds : [];
  for (const id of maybeIds) {
    if (id) seenMessageIds.add(String(id));
  }
  for (const song of state.songs) {
    if (song.message_id) seenMessageIds.add(song.message_id);
  }
  state.seenMessageIds = Array.from(seenMessageIds);
  state.lastBootstrapAt = raw.lastBootstrapAt || null;
  return state;
}

async function loadState(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return normalizeState(JSON.parse(content));
  } catch (error) {
    if (error.code === 'ENOENT') return createDefaultState();
    throw error;
  }
}

async function saveState(filePath, state) {
  const payload = JSON.stringify(state, null, 2);
  await fs.writeFile(filePath, payload, 'utf8');
}

function createStateStore(filePath, initialState) {
  let state = normalizeState(initialState);
  let saveChain = Promise.resolve();

  function snapshot() {
    return {
      songs: state.songs.map((song) => ({ ...song })),
      seenMessageIds: [...state.seenMessageIds],
      lastBootstrapAt: state.lastBootstrapAt
    };
  }

  function queueSave() {
    saveChain = saveChain
      .then(() => saveState(filePath, snapshot()))
      .catch((error) => {
        console.error('[state] save failed:', error);
      });
    return saveChain;
  }

  function hasSeenMessage(messageId) {
    return state.seenMessageIds.includes(messageId);
  }

  function markSeenMessage(messageId) {
    if (!messageId || hasSeenMessage(messageId)) return false;
    state.seenMessageIds.push(messageId);
    return true;
  }

  function addSong(song) {
    const existing = state.songs.find(
      (item) =>
        item.message_id === song.message_id ||
        (item.normalized_title === song.normalized_title &&
          item.normalized_artist === song.normalized_artist &&
          item.normalized_title)
    );
    if (existing) return false;
    state.songs.push({
      message_id: song.message_id,
      source_text: song.source_text,
      song_title: song.song_title,
      artist: song.artist ?? null,
      language: song.language ?? null,
      confidence: Number.isFinite(Number(song.confidence)) ? Number(song.confidence) : 0,
      used: Boolean(song.used),
      created_at: song.created_at || new Date().toISOString(),
      normalized_title: song.normalized_title || normalizeText(song.song_title),
      normalized_artist: song.normalized_artist || normalizeText(song.artist || '')
    });
    markSeenMessage(song.message_id);
    return true;
  }

  function getNextUnusedSong() {
    return state.songs.find((song) => !song.used) || null;
  }

  function markSongUsed(messageId) {
    const song = state.songs.find((item) => item.message_id === messageId);
    if (!song || song.used) return false;
    song.used = true;
    return true;
  }

  function setBootstrapComplete() {
    state.lastBootstrapAt = new Date().toISOString();
  }

  function isEmpty() {
    return state.songs.length === 0;
  }

  return {
    get state() {
      return state;
    },
    hasSeenMessage,
    markSeenMessage,
    addSong,
    getNextUnusedSong,
    markSongUsed,
    setBootstrapComplete,
    isEmpty,
    queueSave
  };
}

module.exports = {
  createDefaultState,
  loadState,
  saveState,
  createStateStore,
  normalizeText
};
