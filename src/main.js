const { loadConfig } = require('./config');
const { createStateStore, loadState, loadSeenState, normalizeText } = require('./state');
const { extractSongs } = require('./llm');
const {
  formatSongsReply,
  parseSongsFromReplyText,
  resolveChordsUrlsForSongs
} = require('./chords');

const ADD_COMMAND = 'תוסיף למאגר';
const RANDOM_COMMAND = 'תביא שיר';

const HEBREW_NUMBER_WORDS = new Map([
  ['אחת', 1],
  ['אחד', 1],
  ['שניים', 2],
  ['שתי', 2],
  ['שתיים', 2],
  ['שנים', 2],
  ['שני', 2],
  ['שלוש', 3],
  ['שלושה', 3],
  ['ארבע', 4],
  ['ארבעה', 4],
  ['חמש', 5],
  ['חמישה', 5],
  ['שש', 6],
  ['שישה', 6],
  ['שבע', 7],
  ['שבעה', 7],
  ['שמונה', 8],
  ['תשע', 9],
  ['תשעה', 9],
  ['עשר', 10],
  ['עשרה', 10]
]);

const DEFAULT_REQUEST_COUNT = 5;
const SONG_REQUEST_COMMANDS = new Set([normalizeText('תביא'), normalizeText('תן')]);
const MAX_REQUEST_COUNT = 15;
const DIFFICULTY_TOKEN_MAP = new Map([
  [normalizeText('קל'), 'low'],
  [normalizeText('קלה'), 'low'],
  [normalizeText('קלים'), 'low'],
  [normalizeText('קלות'), 'low'],
  [normalizeText('בינוני'), 'medium'],
  [normalizeText('בינונית'), 'medium'],
  [normalizeText('בינוניים'), 'medium'],
  [normalizeText('בינוניות'), 'medium'],
  [normalizeText('קשה'), 'high'],
  [normalizeText('קשים'), 'high'],
  [normalizeText('קשות'), 'high']
]);
const FEEL_TOKEN_MAP = new Map([
  [normalizeText('קצבי'), 'upbeat'],
  [normalizeText('קצבי'), 'upbeat'],
  [normalizeText('קצביים'), 'upbeat'],
  [normalizeText('אנרגטי'), 'upbeat'],
  [normalizeText('אנרגטית'), 'upbeat'],
  [normalizeText('מקפיץ'), 'upbeat'],
  [normalizeText('מקפיצה'), 'upbeat'],
  [normalizeText('שקט'), 'calm'],
  [normalizeText('שקטה'), 'calm'],
  [normalizeText('רגוע'), 'calm'],
  [normalizeText('רגועה'), 'calm'],
  [normalizeText('רגועים'), 'calm'],
  [normalizeText('רגועים'), 'calm'],
  [normalizeText('בלדה'), 'ballad'],
  [normalizeText('בלדות'), 'ballad']
]);
const GENRE_FAMILY_TOKEN_MAP = new Map([
  [normalizeText('רוק'), 'rock'],
  [normalizeText('רוקיסטי'), 'rock'],
  [normalizeText('רוקנרול'), 'rock and roll'],
  [normalizeText('בלוז'), 'blues'],
  [normalizeText('בלוזי'), 'blues'],
  [normalizeText('מטאל'), 'metal'],
  [normalizeText('מטאלי'), 'metal'],
  [normalizeText('פופ'), 'pop'],
  [normalizeText('פופי'), 'pop'],
  [normalizeText('פאנק'), 'funk'],
  [normalizeText('פאנקי'), 'funk'],
  [normalizeText('גאז'), 'jazz'],
  [normalizeText('ג׳אז'), 'jazz'],
  [normalizeText("ג'אז"), 'jazz'],
  [normalizeText('גאזי'), 'jazz'],
  [normalizeText('ג׳אזי'), 'jazz'],
  [normalizeText("ג'אזי"), 'jazz'],
  [normalizeText('רגאיי'), 'reggae'],
  [normalizeText("רגאיי"), 'reggae'],
  [normalizeText('קאנטרי'), 'country'],
  [normalizeText('סול'), 'soul'],
  [normalizeText('ישראלי'), 'israeli'],
  [normalizeText('ישראלי'), 'israeli'],
  [normalizeText('מזרחי'), 'mizrahi'],
  [normalizeText('היפ הופ'), 'hip hop']
]);
const GENRE_FAMILY_MATCHERS = new Map([
  ['rock', ['rock']],
  ['blues', ['blues']],
  ['metal', ['metal']],
  ['pop', ['pop']],
  ['funk', ['funk']],
  ['jazz', ['jazz']],
  ['reggae', ['reggae']],
  ['country', ['country']],
  ['soul', ['soul']],
  ['israeli', ['israeli']],
  ['mizrahi', ['mizrahi']],
  ['hip hop', ['hip hop']],
  ['rock and roll', ['rock and roll']]
]);

function firstWord(value) {
  return normalizeText(value).split(' ')[0] || '';
}

function isRandomSongCommand(text) {
  return SONG_REQUEST_COMMANDS.has(firstWord(text));
}

function isAddSongCommand(text) {
  const normalized = normalizeText(text);
  const trigger = normalizeText(ADD_COMMAND);
  return normalized === trigger || normalized.startsWith(`${trigger} `);
}

function stripCommandPrefix(text, command) {
  const normalized = normalizeText(text);
  const trigger = normalizeText(command);
  if (!normalized.startsWith(trigger)) return String(text || '').trim();
  return String(text || '')
    .trim()
    .replace(new RegExp(`^${command}\\s*`, 'u'), '')
    .trim();
}

function isMessageInTargetGroup(record, groupName, chat) {
  if (!chat || chat.isGroup === false) return false;
  const target = normalizeText(groupName);
  const actual = normalizeText(chat.name || record?.chat?.name || '');
  return Boolean(target) && actual === target;
}

function parseCountToken(token) {
  const normalized = normalizeText(token);
  if (!normalized) return null;
  const numeric = Number.parseInt(normalized, 10);
  if (Number.isInteger(numeric) && numeric > 0) return numeric;
  return HEBREW_NUMBER_WORDS.get(normalized) || null;
}

function detectLanguageFilter(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  if (normalized.includes('עברית') || normalized.includes('בעברית') || normalized.includes('בערית') || normalized.includes('ישראלי') || normalized.includes('ישראלית') || normalized.includes('ישראלים')) {
    return 'he';
  }
  if (normalized.includes('אנגלית') || normalized.includes('באנגלית') || normalized.includes('באגלית') || normalized.includes('אנגלי') || normalized.includes('אנגליות')) {
    return 'en';
  }
  if (
    normalized.includes('מעורב') ||
    normalized.includes('מעורבב') ||
    normalized.includes('גם וגם') ||
    normalized.includes('משולב') ||
    normalized.includes('שילוב')
  ) {
    return 'mixed';
  }
  return null;
}

function capRequestCount(count) {
  const numeric = Number.isInteger(count) && count > 0 ? count : DEFAULT_REQUEST_COUNT;
  return Math.min(numeric, MAX_REQUEST_COUNT);
}

function inferDefaultCountForSegment(text) {
  const normalized = normalizeText(text);
  if (!normalized) return DEFAULT_REQUEST_COUNT;
  if (/(?:^|\s)שיר(?:\s|$)/u.test(normalized) && !/(?:^|\s)שירים(?:\s|$)/u.test(normalized)) {
    return 1;
  }
  return DEFAULT_REQUEST_COUNT;
}

function normalizeArtistComparable(value) {
  const normalized = normalizeText(value);
  if (!normalized) return '';

  return normalized
    .replace(/^(?:הלהקה|להקה|להקת|הזמרת|זמרת|הזמר|זמר|של|מאת)\s+/u, '')
    .replace(/^the\s+/u, '')
    .replace(/^ה(?=\p{L}{2,})/u, '')
    .trim();
}

function detectArtistFilter(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const match = normalized.match(/(?:^|\s)(?:של|מאת)\s+(.+)$/u);
  if (!match) return null;

  const artist = normalizeArtistComparable(match[1]);
  return artist || null;
}

function detectDifficultyFilter(text) {
  const tokens = normalizeText(text).split(/\s+/u).filter(Boolean);
  for (const token of tokens) {
    const difficulty = DIFFICULTY_TOKEN_MAP.get(token);
    if (difficulty) return difficulty;
  }
  return null;
}

function detectFeelFilter(text) {
  const tokens = normalizeText(text).split(/\s+/u).filter(Boolean);
  for (const token of tokens) {
    const feel = FEEL_TOKEN_MAP.get(token);
    if (feel) return feel;
  }
  return null;
}

function detectGenreFilters(text) {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const genres = [];
  const seen = new Set();

  for (const [token, genre] of GENRE_FAMILY_TOKEN_MAP.entries()) {
    if (normalized.includes(token) && !seen.has(genre)) {
      seen.add(genre);
      genres.push(genre);
    }
  }

  return genres;
}

function parseSongRequest(text) {
  const normalized = normalizeText(text);
  const command = firstWord(normalized);
  if (!SONG_REQUEST_COMMANDS.has(command)) return null;

  let remainder = normalized.replace(new RegExp(`^${command}\\s*`, 'u'), '').trim();
  const includeChords = remainder.includes('עם אקורדים');
  if (includeChords) {
    remainder = remainder.replace('עם אקורדים', '').trim();
  }

  if (!remainder || remainder === 'שיר' || remainder === 'שירים') {
    return {
      items: [{ count: 1, language: null, artist: null, genres: [], difficulty: null, feel: null }],
      includeChords
    };
  }

  const segments = remainder
    .replace(/^שירים?\s+/u, '')
    .split(/\s+ו(?=\s*(?:\d|\p{L}))/u)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const items = [];
  for (const segment of segments) {
    const tokens = segment.split(/\s+/u);
    let count = null;
    for (const token of tokens) {
      const parsed = parseCountToken(token);
      if (parsed) {
        count = parsed;
        break;
      }
    }
    count = count ? capRequestCount(count) : inferDefaultCountForSegment(segment);

    const language = detectLanguageFilter(segment);
    const artist = detectArtistFilter(segment);
    const genres = detectGenreFilters(segment);
    const difficulty = detectDifficultyFilter(segment);
    const feel = detectFeelFilter(segment);
    items.push({ count, language, artist, genres, difficulty, feel });
  }

  if (items.length === 0) {
    return { items: [{ count: 1, language: null, artist: null, genres: [], difficulty: null, feel: null }], includeChords };
  }

  return { items, includeChords };
}

function isChordsReplyCommand(text) {
  const normalized = normalizeText(text);
  const trigger = normalizeText('תביא אקורדים');
  return normalized === trigger || normalized.startsWith(`${trigger} `);
}

function matchesLanguage(song, language) {
  if (!language) return true;
  const storedLanguage = String(song?.language || '').toLowerCase();
  const lang = storedLanguage;
  if (language === 'he') {
    return lang === 'he' || lang === 'heb' || lang === 'hebrew';
  }
  if (language === 'en') {
    return lang === 'en' || lang === 'eng' || lang === 'english';
  }
  if (language === 'mixed') {
    return true;
  }
  return true;
}

function matchesArtist(song, artistQuery) {
  const query = normalizeArtistComparable(artistQuery);
  if (!query) return true;

  const candidates = [
    song?.artist,
    song?.normalized_artist,
    song?.source_text
  ]
    .map((value) => normalizeArtistComparable(value))
    .filter(Boolean);

  return candidates.some((candidate) => {
    return candidate === query || candidate.includes(query) || query.includes(candidate);
  });
}

function matchesDifficulty(song, difficulty) {
  if (!difficulty) return true;
  return String(song?.difficulty || '').trim().toLowerCase() === difficulty;
}

function matchesFeel(song, feel) {
  if (!feel) return true;
  return String(song?.feel || '').trim().toLowerCase() === feel;
}

function matchesGenre(song, genreQuery) {
  const queries = Array.isArray(genreQuery)
    ? genreQuery.map((genre) => String(genre || '').trim().toLowerCase()).filter(Boolean)
    : [String(genreQuery || '').trim().toLowerCase()].filter(Boolean);
  if (queries.length === 0) return true;
  const genres = Array.isArray(song?.genres)
    ? song.genres.map((genre) => String(genre || '').trim().toLowerCase()).filter(Boolean)
    : [];
  if (genres.length === 0) return false;

  return queries.every((query) => {
    const matchers = GENRE_FAMILY_MATCHERS.get(query) || [query];
    return genres.some((genre) => {
      if (genre === query) return true;
      return matchers.some((matcher) => genre === matcher || genre.includes(matcher));
    });
  });
}

function pickRandomSong(stateStore, predicate, usedKeys) {
  const songs = (stateStore.state.songs || []).filter(
    (song) => !usedKeys.has(song.message_id) && (!predicate || predicate(song))
  );
  if (songs.length === 0) return null;
  const choice = songs[Math.floor(Math.random() * songs.length)];
  if (!choice) return null;
  usedKeys.add(choice.message_id);
  return choice;
}

function pickSongsForRequest(stateStore, requestItems) {
  const selected = [];
  const usedKeys = new Set();
  const songs = stateStore.state.songs || [];

  for (const item of requestItems) {
    for (let index = 0; index < item.count; index += 1) {
      let choice = null;

      if (item.language === 'mixed') {
        const preferredLanguage = index % 2 === 0 ? 'he' : 'en';
        choice =
          pickRandomSong(
            stateStore,
            (song) =>
              matchesLanguage(song, preferredLanguage) &&
              matchesArtist(song, item.artist) &&
              matchesGenre(song, item.genres) &&
              matchesDifficulty(song, item.difficulty) &&
              matchesFeel(song, item.feel),
            usedKeys
          ) ||
          pickRandomSong(
            stateStore,
            (song) =>
              matchesLanguage(song, preferredLanguage === 'he' ? 'en' : 'he') &&
              matchesArtist(song, item.artist) &&
              matchesGenre(song, item.genres) &&
              matchesDifficulty(song, item.difficulty) &&
              matchesFeel(song, item.feel),
            usedKeys
          ) ||
          pickRandomSong(
            stateStore,
            (song) =>
              matchesArtist(song, item.artist) &&
              matchesGenre(song, item.genres) &&
              matchesDifficulty(song, item.difficulty) &&
              matchesFeel(song, item.feel),
            usedKeys
          );
      } else {
        choice = pickRandomSong(
          stateStore,
          (song) =>
            matchesLanguage(song, item.language) &&
            matchesArtist(song, item.artist) &&
            matchesGenre(song, item.genres) &&
            matchesDifficulty(song, item.difficulty) &&
            matchesFeel(song, item.feel),
          usedKeys
        );
      }

      if (!choice) break;
      selected.push(choice);
    }
  }

  return selected;
}

function buildMixedLanguageRequest(count, item = {}) {
  const cappedCount = capRequestCount(count);
  const heCount = Math.ceil(cappedCount / 2);
  const enCount = Math.floor(cappedCount / 2);
  return [
    { count: heCount, language: 'he', artist: item.artist ?? null, genres: Array.isArray(item.genres) ? item.genres : [], difficulty: item.difficulty ?? null, feel: item.feel ?? null },
    { count: enCount, language: 'en', artist: item.artist ?? null, genres: Array.isArray(item.genres) ? item.genres : [], difficulty: item.difficulty ?? null, feel: item.feel ?? null }
  ];
}

function formatRtlLine(index, song) {
  return `\u200F${index + 1}. ${String(song?.song_title || '').trim()}${song?.artist ? ` - ${String(song.artist).trim()}` : ''}`;
}

function normalizeSongKey(song) {
  return {
    title: normalizeText(song?.song_title || ''),
    artist: normalizeText(song?.artist || '')
  };
}

function findSongMatchesFromReply(stateStore, quotedText) {
  const parsedSongs = parseSongsFromReplyText(quotedText);
  const songs = stateStore.state.songs || [];
  const usedIds = new Set();

  return parsedSongs.map((parsedSong, index) => {
    const parsedKey = normalizeSongKey(parsedSong);
    let match = null;

    if (parsedKey.title) {
      match = songs.find((song) => {
        if (!song?.message_id || usedIds.has(song.message_id)) return false;
        const songKey = normalizeSongKey(song);
        if (songKey.title !== parsedKey.title) return false;
        if (parsedKey.artist && songKey.artist !== parsedKey.artist) return false;
        return true;
      }) || songs.find((song) => {
        if (!song?.message_id || usedIds.has(song.message_id)) return false;
        return normalizeSongKey(song).title === parsedKey.title;
      });
    }

    if (match?.message_id) {
      usedIds.add(match.message_id);
      return match;
    }

    return {
      message_id: `quoted:${index}`,
      source_text: parsedSong.song_title,
      song_title: parsedSong.song_title,
      artist: parsedSong.artist ?? null,
      language: null,
      chords_url: null,
      confidence: 0,
      used: false,
      created_at: new Date().toISOString(),
      normalized_title: normalizeText(parsedSong.song_title),
      normalized_artist: normalizeText(parsedSong.artist || '')
    };
  });
}

async function resolveChordsForSongs(stateStore, songs) {
  const prepared = Array.isArray(songs) ? songs.map((song) => ({ ...song })) : [];
  const missingSongs = prepared.filter((song) => !String(song?.chords_url || '').trim());
  if (missingSongs.length === 0) return prepared;

  let resolvedMissing = missingSongs;
  try {
    resolvedMissing = await resolveChordsUrlsForSongs(missingSongs, stateStore.config || {});
  } catch (error) {
    console.error('[chords] resolve failed:', error);
    return prepared;
  }

  const resolvedById = new Map(resolvedMissing.map((song) => [String(song?.message_id || ''), song]));

  return prepared.map((song) => {
    const resolved = resolvedById.get(String(song?.message_id || ''));
    if (!resolved) return song;
    const nextUrl = String(resolved.chords_url || '').trim() || null;
    if (nextUrl && song.message_id && !String(song.message_id).startsWith('quoted:')) {
      stateStore.setSongChordsUrl(song.message_id, nextUrl);
    }
    return { ...song, chords_url: nextUrl };
  });
}

function stripUrls(value) {
  return String(value || '')
    .replace(/https?:\/\/\S+/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUrlOnly(value) {
  const normalized = String(value || '').trim();
  return /^https?:\/\/\S+$/iu.test(normalized);
}

async function extractAndStoreBatch({
  config,
  stateStore,
  batch,
  contextLabel
}) {
  const payload = batch.filter((message) => {
    const id = message.id;
    return id && !stateStore.hasSeenMessage(id);
  });

  if (payload.length === 0) return [];

  console.log(`[extract:${contextLabel}] analyzing ${payload.length} messages`);
  const results = await extractSongs({
    provider: config.llmProvider,
    ollamaBaseUrl: config.ollamaBaseUrl,
    ollamaModel: config.ollamaModel,
    geminiApiKey: config.geminiApiKey,
    geminiModel: config.geminiModel,
    messages: payload,
    triggerText: ADD_COMMAND
  });
  console.log(`[extract:${contextLabel}] llm returned ${results.length} candidates`);

  const added = [];
  for (const result of results) {
    const original =
      payload.find((message) => message.id === result.message_id) ||
      (result.source_text
        ? payload.find((message) => normalizeText(message.text) === normalizeText(result.source_text))
        : null);
    if (!original) continue;
    if (!result.song_title) continue;

    const song = {
      message_id: original.id,
      source_text: result.source_text || original.text,
      song_title: result.song_title,
      artist: result.artist ?? null,
      language: result.language ?? null,
      confidence: result.confidence ?? 0,
      genres: Array.isArray(result.genres) ? result.genres : [],
      difficulty: result.difficulty ?? null,
      feel: result.feel ?? null,
      used: false,
      created_at: new Date((original.timestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      normalized_title: normalizeText(result.song_title),
      normalized_artist: normalizeText(result.artist || '')
    };

    const inserted = stateStore.addSong(song);
    if (inserted) {
      added.push(song);
      console.log(`[extract:${contextLabel}] added song: ${song.song_title}`);
    }
  }

  for (const message of payload) {
    stateStore.markSeenMessage(message.id);
  }

  if (payload.length > 0 || added.length > 0) {
    await stateStore.queueSave();
  }

  return added;
}

async function sendRandomSong({ chat, stateStore, includeChords = false }) {
  const nextSong = stateStore.getNextUnusedSong();
  if (!nextSong) {
    await chat.sendMessage('אין עדיין שירים 🤖');
    return;
  }

  const songs = [nextSong];
  if (includeChords && stateStore.config?.discoverChords !== false) {
    console.log(`[chords] random request enabled for ${songs.length} song(s)`);
    const resolved = await resolveChordsForSongs(stateStore, songs);
    console.log(
      `[chords] random resolved: ${resolved
        .map((song) => String(song?.chords_url || '').trim() || '(none)')
        .join(', ')}`
    );
    if (resolved.some((song, index) => song.chords_url !== songs[index].chords_url)) {
      await stateStore.queueSave();
    }
    await chat.sendMessage(formatSongsReply(resolved, { includeChords: true }));
    return;
  }

  await chat.sendMessage(formatSongsReply(songs));
}

async function sendSongRequest({ chat, stateStore, text }) {
  const request = parseSongRequest(text);
  if (!request) return false;

  if (
    request.items.length === 1 &&
    request.items[0].count === 1 &&
    !request.items[0].language &&
    !request.items[0].artist &&
    (!Array.isArray(request.items[0].genres) || request.items[0].genres.length === 0) &&
    !request.items[0].difficulty &&
    !request.items[0].feel
  ) {
    await sendRandomSong({ chat, stateStore, includeChords: request.includeChords });
    return true;
  }

  if (request.items.length === 1 && request.items[0].language === 'mixed') {
    request.items = buildMixedLanguageRequest(request.items[0].count, request.items[0]);
  }

  const picked = pickSongsForRequest(stateStore, request.items);
  if (picked.length === 0) {
    await chat.sendMessage('אין עדיין שירים 🤖');
    return true;
  }

  let songs = picked;
  if (request.includeChords && stateStore.config?.discoverChords !== false) {
    console.log(`[chords] request enabled for ${picked.length} song(s)`);
    const resolved = await resolveChordsForSongs(stateStore, picked);
    console.log(
      `[chords] request resolved: ${resolved
        .map((song) => String(song?.chords_url || '').trim() || '(none)')
        .join(', ')}`
    );
    if (resolved.some((song, index) => song.chords_url !== picked[index].chords_url)) {
      await stateStore.queueSave();
    }
    songs = resolved;
  }

  await chat.sendMessage(formatSongsReply(songs, { includeChords: request.includeChords }));
  return true;
}

async function sendChordsRequest({ chat, stateStore, quotedText }) {
  const songs = findSongMatchesFromReply(stateStore, quotedText);
  if (!songs.length) {
    await chat.sendMessage('יש להשיב להודעת שירים');
    return true;
  }

  let resolvedSongs = songs;
  if (stateStore.config?.discoverChords !== false) {
    console.log(`[chords] reply request enabled for ${songs.length} song(s)`);
    resolvedSongs = await resolveChordsForSongs(stateStore, songs);
    console.log(
      `[chords] reply resolved: ${resolvedSongs
        .map((song) => String(song?.chords_url || '').trim() || '(none)')
        .join(', ')}`
    );
    if (resolvedSongs.some((song, index) => song.chords_url !== songs[index].chords_url)) {
      await stateStore.queueSave();
    }
  }

  await chat.sendMessage(formatSongsReply(resolvedSongs, { includeChords: true }));
  return true;
}

async function handleAddSongCommand({ chat, stateStore, config, triggerRecord, extractSongsFn = extractSongs }) {
  const baseId = String(triggerRecord?.id || `add:${Date.now()}`).trim();
  const quotedText = String(triggerRecord?.quotedText || '').trim();
  const inlineText = stripCommandPrefix(triggerRecord?.text || '', ADD_COMMAND);
  const sourceText = stripUrls(quotedText || inlineText);

  if (!sourceText) {
    await chat.sendMessage('🤖 צריך טקסט של השיר');
    return;
  }

  if (isUrlOnly(quotedText || inlineText)) {
    await chat.sendMessage('🤖 צריך טקסט של השיר, קישור לבד לא מספיק');
    return;
  }

  const results = await extractSongsFn({
    provider: config.llmProvider,
    ollamaBaseUrl: config.ollamaBaseUrl,
    ollamaModel: config.ollamaModel,
    geminiApiKey: config.geminiApiKey,
    geminiModel: config.geminiModel,
    messages: [
      {
        id: `${baseId}:add`,
        text: sourceText,
        sender: triggerRecord?.sender || '',
        from: triggerRecord?.from || '',
        quotedText: null,
        timestamp: triggerRecord?.timestamp || null
      }
    ],
    triggerText: ADD_COMMAND
  });

  let addedCount = 0;
  for (const [index, result] of results.entries()) {
    const song = {
      message_id: `${baseId}:add:${index}`,
      source_text: result.source_text || sourceText,
      song_title: result.song_title,
      artist: result.artist ?? null,
      language: result.language ?? null,
      confidence: result.confidence ?? 0,
      genres: Array.isArray(result.genres) ? result.genres : [],
      difficulty: result.difficulty ?? null,
      feel: result.feel ?? null,
      used: false,
      created_at: new Date().toISOString(),
      normalized_title: normalizeText(result.song_title),
      normalized_artist: normalizeText(result.artist || '')
    };

    if (stateStore.addSong(song)) {
      addedCount += 1;
    }
  }

  if (addedCount > 0) {
    await stateStore.queueSave();
    await chat.sendMessage('🤖 הוספתי');
    return;
  }

  await chat.sendMessage('🤖 השיר קיים כבר');
}

async function bootstrap() {
  const {
    createWhatsAppClient,
    waitForReady,
    messageToRecord,
    readQuotedText
  } = require('./whatsapp');
  const config = loadConfig(process.env);
  const loadedState = await loadState(config.stateFile);
  const loadedSeenState = await loadSeenState(config.seenFile);
  const stateStore = createStateStore(config.stateFile, config.seenFile, loadedState, loadedSeenState);
  stateStore.config = config;

  if (!config.groupName) {
    throw new Error('GROUP_NAME is required for live listening');
  }

  const client = createWhatsAppClient({
    headless: config.headless,
    executablePath: config.executablePath,
    authDir: config.authDir
  });
  let shuttingDown = false;
  let clientDestroyed = false;
  let heartbeatTimer = null;

  async function destroyClient(reason) {
    if (clientDestroyed) return;
    clientDestroyed = true;
    try {
      console.log(`[shutdown] destroying WhatsApp client (${reason})`);
      await client.destroy();
    } catch (error) {
      console.error('[shutdown] client destroy failed:', error);
    }
  }

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] received ${signal}`);
    clearInterval(heartbeatTimer);
    await destroyClient(signal);
    process.exit(0);
  }

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  const pendingMessages = [];
  let readyToProcess = false;
  const startupTimeoutMs = 15000;
  const processedMessageIds = new Set();
  const heartbeatIntervalMs = 15 * 60 * 1000;
  heartbeatTimer = setInterval(() => {
    const groupName = config.groupName || '(unknown)';
    console.log(
      `[health] alive group=${groupName} songs=${stateStore.state.songs.length} seen=${stateStore.seenState.seenMessageIds.length}`
    );
  }, heartbeatIntervalMs);
  heartbeatTimer.unref();

  function markProcessed(messageId) {
    if (!messageId || processedMessageIds.has(messageId)) return false;
    processedMessageIds.add(messageId);
    if (processedMessageIds.size > 50) {
      processedMessageIds.clear();
    }
    return true;
  }

  async function handleLiveMessage(record) {
    const text = record.text || '';
    const chat = record.chat;
    if (!isMessageInTargetGroup(record, config.groupName, chat)) {
      return;
    }

    if (isChordsReplyCommand(text)) {
      console.log('[trigger] chords request');
      await sendChordsRequest({ chat, stateStore, quotedText: record.quotedText });
      return;
    }

    if (isRandomSongCommand(text)) {
      console.log('[trigger] random song');
      await sendSongRequest({ chat, stateStore, text });
      return;
    }

    if (isAddSongCommand(text)) {
      console.log('[trigger] add song');
      await handleAddSongCommand({ chat, stateStore, config, triggerRecord: record });
      return;
    }
  }

  async function finalizeStartup() {
    if (readyToProcess) return;
    readyToProcess = true;
    console.log('[bootstrap] saving state');
    stateStore.setBootstrapComplete();
    await stateStore.queueSave();

    if (pendingMessages.length > 0) {
      for (const message of pendingMessages.splice(0, pendingMessages.length)) {
        await handleLiveMessage(message);
      }
    }

    console.log('[whatsapp] watcher is live');
  }

  const handleIncomingMessage = async (message) => {
    try {
      const messageId = message.id?._serialized || message.id?.id || '';
      if (!markProcessed(messageId)) return;

      const text = String(message.body || '').trim();
      if (!text) return;

      const record = messageToRecord(message);
      record.quotedText = await readQuotedText(message);

      let chatId = record.chatId;
      if (typeof message.getChat === 'function') {
        try {
          const chat = await message.getChat();
          if (chat?.id?._serialized) {
            record.chat = chat;
            record.chatId = chat.id._serialized;
            chatId = record.chatId;
          }
        } catch (error) {
          // Ignore chat lookup failures here; we'll still keep the message record.
        }
      }

      if (record.chat && record.chat.isGroup === false) {
        return;
      }
      if (!record.chat && chatId && !String(chatId).endsWith('@g.us')) {
        return;
      }

      if (!isMessageInTargetGroup(record, config.groupName, record.chat)) {
        return;
      }

      console.log(
        `[message:raw] fromMe=${Boolean(message.fromMe)} from=${message.from || ''} to=${message.to || ''} text=${JSON.stringify(text)}`
      );

      console.log(
        `[message] fromMe=${Boolean(message.fromMe)} chatId=${chatId} from=${record.from} text=${JSON.stringify(text)}`
      );

      if (!readyToProcess) {
        pendingMessages.push(record);
        return;
      }

      await handleLiveMessage(record);
    } catch (error) {
      console.error('[message] failed:', error);
    }
  };

  client.on('message_create', handleIncomingMessage);
  client.on('message', handleIncomingMessage);
  console.log('[whatsapp] starting client');
  const readyPromise = waitForReady(client);
  readyPromise.then(() => {
    console.log('[whatsapp] ready');
    void finalizeStartup().catch((error) => {
      console.error('[fatal]', error);
      void destroyClient('finalizeStartup failure').finally(() => process.exit(1));
    });
  }).catch((error) => {
    console.error('[fatal]', error);
    void destroyClient('ready failure').finally(() => process.exit(1));
  });
  client.initialize();
  console.log('[whatsapp] initialize called');
  console.log('[whatsapp] waiting for ready');

  await Promise.race([
    readyPromise,
    new Promise((resolve) => {
      setTimeout(() => {
        resolve('timeout');
      }, startupTimeoutMs);
    })
  ]).then((result) => {
    if (result === 'timeout') {
      throw new Error(`WhatsApp startup timed out after ${startupTimeoutMs}ms`);
    }
  });
}

module.exports = {
  parseSongRequest,
  detectArtistFilter,
  normalizeArtistComparable,
  matchesArtist,
  matchesGenre,
  matchesDifficulty,
  matchesFeel,
  pickSongsForRequest,
  buildMixedLanguageRequest,
  handleAddSongCommand
};

if (require.main === module) {
  bootstrap().catch((error) => {
    console.error('[fatal]', error);
    process.exit(1);
  });
}
