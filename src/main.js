const { loadConfig } = require('./config');
const { createStateStore, loadState, loadSeenState, normalizeText } = require('./state');
const { interpretMessage, callOpenAiCompatibleChat } = require('./llm');
const {
  persistResultContext,
  resolveActiveResultContext,
  findSongIdsByIndexes
} = require('./result-context');
const { searchSongs, countHardFilterMatches } = require('./song-search');
const { formatSongsReply, prepareSongsForReply } = require('./chords');
const { ALLOWED_UPDATE_FIELDS } = require('./schemas');

const CURRENT_DATE = '2026-08-08';
const MUTABLE_SONG_FIELDS = new Set(ALLOWED_UPDATE_FIELDS);
const BOT_PREFIX = '\u200F🤖 ';
const DEFAULT_REHEARSAL_DURATION_MINUTES = 180;
const REHEARSAL_BREAK_MINUTES = 12;
const DEFAULT_SONG_DURATION_SECONDS = 4 * 60;
const SONG_TRANSITION_SECONDS = 90;
const SONG_REHEARSAL_DISCUSSION_SECONDS = 180;
const JAM_BUFFER_BY_FEEL_SECONDS = {
  upbeat: 120,
  calm: 75,
  ballad: 90
};
const MISTAKE_BUFFER_BY_DIFFICULTY_SECONDS = {
  low: 75,
  medium: 120,
  high: 180
};
const FIT_LABELS = {
  unknown: '\u05dc\u05d0 \u05d9\u05d3\u05d5\u05e2',
  good: '\u05e2\u05d5\u05d1\u05d3 \u05d8\u05d5\u05d1',
  maybe: '\u05d0\u05d5\u05dc\u05d9',
  bad: '\u05dc\u05d0 \u05e2\u05d1\u05d3'
};

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripWakeWord(text, triggerText = '\u05d1\u05d5\u05d8') {
  const source = String(text || '').trim();
  const trigger = String(triggerText || '').trim();
  if (!source || !trigger) return null;

  const pattern = new RegExp(`^${escapeRegex(trigger)}(?:\\s*[:,\\-]\\s*|\\s+|$)`, 'iu');
  if (!pattern.test(source)) return null;

  return source.replace(pattern, '').trim();
}

function isMessageInTargetGroup(record, config, chat) {
  if (chat && chat.isGroup === false) return false;
  const configuredGroupIds = Array.isArray(config?.groupIds) && config.groupIds.length > 0
    ? config.groupIds.map((value) => String(value || '').trim()).filter(Boolean)
    : [String(config?.groupId || '').trim()].filter(Boolean);
  const actualChatId = String(chat?.id?._serialized || record?.chatId || '').trim();
  if (configuredGroupIds.length > 0 && actualChatId) {
    return configuredGroupIds.includes(actualChatId);
  }

  if (!chat) return false;
  const configuredGroupNames = Array.isArray(config?.groupNames) && config.groupNames.length > 0
    ? config.groupNames.map((value) => normalizeText(value)).filter(Boolean)
    : [normalizeText(config?.groupName || '')].filter(Boolean);
  const actual = normalizeText(chat.name || record?.chat?.name || '');
  return configuredGroupNames.length > 0 && configuredGroupNames.includes(actual);
}

function summarizeMessageRouting(record, config) {
  const handling = shouldHandleMessage(record, config.triggerText);
  const chatName = record?.chat?.name || record?.chat?.formattedTitle || '';
  const inTargetGroup = isMessageInTargetGroup(record, config, record?.chat);

  return {
    handling,
    chatName,
    inTargetGroup
  };
}

function shouldHandleMessage(record, triggerText = '\u05d1\u05d5\u05d8') {
  const quotedText = String(record?.quoted?.text || record?.quotedText || '').trim();
  if (record?.fromMe && /^\u200f?🤖(?:\s|$)/u.test(String(record?.text || '').trim())) {
    return {
      shouldHandle: false,
      reason: 'bot_self_message',
      messageText: null
    };
  }

  const strippedText = stripWakeWord(record?.text || '', triggerText);
  if (strippedText !== null) {
    return {
      shouldHandle: true,
      reason: 'wake_word',
      messageText: strippedText
    };
  }

  const messageText = String(record?.text || '').trim();
  if (/^\u200f?🤖(?:\s|$)/u.test(quotedText) && messageText) {
    return {
      shouldHandle: true,
      reason: 'reply',
      messageText
    };
  }

  return {
    shouldHandle: false,
    reason: 'ignored',
    messageText: null
  };
}

function buildAgentReplyContext(stateStore, record) {
  const quotedText = String(record?.quoted?.text || '').trim();
  if (!/^\u200f?🤖(?:\s|$)/u.test(quotedText)) {
    return null;
  }
  const resolved = resolveActiveResultContext(stateStore, record);
  if (!resolved.context) return null;
  return {
    source: resolved.source,
    results: resolved.context.results
  };
}

function extractBotMessageId(sentMessage) {
  return (
    sentMessage?.id?._serialized ||
    sentMessage?.id?.id ||
    sentMessage?._data?.id?.id ||
    ''
  );
}

function prefixBotReply(text) {
  const body = String(text || '').trim();
  if (!body) return BOT_PREFIX.trim();
  if (/^\u200f?🤖(?:\s|$)/u.test(body)) {
    return body;
  }
  return `${BOT_PREFIX}${body}`;
}

async function sendBotMessage(chat, text) {
  return chat.sendMessage(prefixBotReply(text));
}

function buildChatResponder(message, chatId) {
  return {
    id: { _serialized: chatId || '' },
    isGroup: true,
    name: '',
    async sendMessage(text) {
      if (typeof message.reply === 'function') {
        return message.reply(prefixBotReply(text));
      }
      throw new Error('Chat responder is unavailable for this message');
    }
  };
}

function classifyAgentFailure(error) {
  if (error?.rateLimited || Number(error?.status) === 429) {
    return 'rate_limited';
  }

  const message = String(error?.message || '').trim();
  if (
    /Could not parse agent JSON response/i.test(message) ||
    /agent_action\./i.test(message) ||
    /query must be an object/i.test(message)
  ) {
    return 'invalid_agent_output';
  }

  return 'generic_failure';
}

function buildAgentFailureReply(error) {
  const failureType = classifyAgentFailure(error);
  if (failureType === 'rate_limited') {
    return 'יש עכשיו עומס על המנוע. נסו שוב עוד רגע.';
  }
  if (failureType === 'invalid_agent_output') {
    return 'לא הבנתי עד הסוף את הבקשה. נסו לנסח שוב במשפט קצר.';
  }
  return 'יש לי עכשיו עומס קטן. נסו שוב עוד רגע.';
}

function shouldUseGenericClarifyReply(messageText, replyContext) {
  if (replyContext?.results?.length) {
    return false;
  }

  const source = String(messageText || '').trim().toLowerCase();
  if (!source) {
    return true;
  }

  if (
    /(?:להסיר|תסיר|למחוק|תמחק|לעדכן|תעדכן|שנה|לשנות|למה|מדוע|פרטים|מידע|similar|דומה|כמו\s+\d+|שיר\s+\d+|\d+\s+לא)/iu.test(source)
  ) {
    return false;
  }

  return true;
}

function buildClarifyReply(action, { messageText, replyContext }) {
  if (shouldUseGenericClarifyReply(messageText, replyContext)) {
    return 'איזה שירים אתה רוצה?';
  }

  return action.question;
}

function querySectionHasContent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).some((entry) => {
    if (Array.isArray(entry)) {
      return entry.length > 0;
    }
    if (entry && typeof entry === 'object') {
      return querySectionHasContent(entry);
    }
    return entry !== undefined && entry !== null && String(entry).trim() !== '';
  });
}

function searchQueryHasSemanticConstraints(query) {
  const normalized = query && typeof query === 'object' && !Array.isArray(query) ? query : {};
  return (
    querySectionHasContent(normalized.requirements) ||
    querySectionHasContent(normalized.preferences) ||
    querySectionHasContent(normalized.exclusions) ||
    Number.isInteger(Number.parseInt(normalized.reference_result_index, 10))
  );
}

function looksLikeBareSpecificHint(messageText) {
  const source = String(messageText || '').trim();
  if (!source) return false;

  const compact = source.replace(/\s+/g, ' ').trim();
  const tokens = compact.split(' ').filter(Boolean);
  if (tokens.length === 0 || tokens.length > 4) {
    return false;
  }

  if (/(?:תביא|תן|תני|find|give|show|play|עוד|שירים?|songs?|something|משהו|רשימה)/iu.test(compact)) {
    return false;
  }

  return /[\p{L}]/u.test(compact);
}

function shouldBlockGenericSearchFallback(action, { messageText, replyContext }) {
  if (action?.action !== 'search_songs') {
    return false;
  }
  if (replyContext?.results?.length) {
    return false;
  }
  if (searchQueryHasSemanticConstraints(action.query || {})) {
    return false;
  }

  return looksLikeBareSpecificHint(messageText);
}

function isChordsReplyRequest(messageText) {
  const normalized = String(messageText || '').trim();
  if (!normalized) return false;
  return /(?:^|[\s,.:!?-])(אקורדים|אקורד|chords?)(?:$|[\s,.:!?-])/iu.test(normalized);
}

function isSongInfoRequest(messageText) {
  const normalized = String(messageText || '').trim();
  if (!normalized) return false;
  return /(?:מידע|פרטים|תן מידע|תביא מידע|ספר לי על|מה אתה יודע על|מתי ניגנו|מתי ניגנתם|info|details)/iu.test(normalized);
}

function parseSongIdentityLine(text) {
  const source = String(text || '').trim();
  if (!source) return null;
  const dashSeparatorIndex = source.lastIndexOf(' - ');
  if (dashSeparatorIndex > 0) {
    const songTitle = source.slice(0, dashSeparatorIndex).trim();
    const artist = source.slice(dashSeparatorIndex + 3).trim();
    if (songTitle && artist) {
      return { song_title: songTitle, artist, confidence: 0.5 };
    }
  }

  const hebrewSeparatorIndex = source.lastIndexOf(' של ');
  if (hebrewSeparatorIndex > 0) {
    const songTitle = source.slice(0, hebrewSeparatorIndex).trim();
    const artist = source.slice(hebrewSeparatorIndex + 4).trim();
    if (songTitle && artist) {
      return { song_title: songTitle, artist, confidence: 0.5 };
    }
  }

  const englishSplit = source.match(/^(.*?)\s+by\s+(.+)$/i);
  if (englishSplit) {
    const songTitle = String(englishSplit[1] || '').trim();
    const artist = String(englishSplit[2] || '').trim();
    if (songTitle && artist) {
      return { song_title: songTitle, artist, confidence: 0.5 };
    }
  }

  return null;
}

function normalizeSongIdentityLine(text) {
  return String(text || '')
    .replace(/^\u200f?🤖\s*/u, '')
    .replace(/^\d+[.)]\s*/u, '')
    .replace(/^(?:הבאתי|הנה|קבל|קיבלת|מצאתי|המלצות|הרשימה)\s*:\s*/iu, '')
    .trim();
}

function parseSongIdentityText(text) {
  const source = String(text || '').trim();
  if (!source) return null;

  const direct = parseSongIdentityLine(normalizeSongIdentityLine(source));
  if (direct) {
    return direct;
  }

  const candidates = source
    .split(/\r?\n/u)
    .map((line) => normalizeSongIdentityLine(line))
    .map((line) => parseSongIdentityLine(line))
    .filter(Boolean);

  if (candidates.length !== 1) {
    return null;
  }

  return candidates[0];
}

function inferReferencedResultIndexes(messageText) {
  const matches = Array.from(String(messageText || '').matchAll(/(?:^|[^\d])(\d{1,3})(?=$|[^\d])/gu));
  return Array.from(
    new Set(
      matches
        .map((match) => Number.parseInt(match[1], 10))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
}

function extractSongIdentityFromInfoRequest(messageText) {
  const source = String(messageText || '').trim();
  if (!source) return null;

  const stripped = source
    .replace(/^(?:תן|תני|תביא|תביאי|ספר|ספרי)\s+(?:לי\s+)?(?:מידע|פרטים)\s+(?:על\s+)?/iu, '')
    .replace(/^(?:מה\s+אתה\s+יודע\s+על|מה\s+את\s+יודעת\s+על|ספר\s+לי\s+על|tell me about)\s+/iu, '')
    .trim();

  if (!stripped || stripped === source) {
    return null;
  }

  return parseSongIdentityText(stripped);
}

function inferSongInfoAction(messageText, replyContext, quotedText = '') {
  if (!isSongInfoRequest(messageText)) {
    return null;
  }

  const resultIndexes = inferReferencedResultIndexes(messageText);
  const contextResults = Array.isArray(replyContext?.results) ? replyContext.results : [];
  if (resultIndexes.length === 1 && contextResults.some((entry) => entry?.index === resultIndexes[0])) {
    return {
      action: 'get_song_info',
      result_index: resultIndexes[0]
    };
  }

  const directSongIdentity = extractSongIdentityFromInfoRequest(messageText);
  if (directSongIdentity) {
    return {
      action: 'get_song_info',
      song_title: directSongIdentity.song_title,
      artist: directSongIdentity.artist
    };
  }

  if (
    contextResults.length === 1 &&
    /(?:השיר הזה|השיר\s+הזה|זה|this song|this one)/iu.test(String(messageText || '').trim())
  ) {
    return {
      action: 'get_song_info',
      result_index: contextResults[0].index
    };
  }

  const quotedSongIdentity = parseSongIdentityText(quotedText);
  if (quotedSongIdentity) {
    return {
      action: 'get_song_info',
      song_title: quotedSongIdentity.song_title,
      artist: quotedSongIdentity.artist
    };
  }

  return null;
}

function inferDirectAddSongFromMessage(messageText) {
  const source = String(messageText || '').trim();
  if (!source) return null;

  const explicitAdd = source.match(/^(?:תוסיף|תוסיפי|להוסיף|הוסף|add)\s+(.+)$/iu);
  if (!explicitAdd) return null;

  const candidate = String(explicitAdd[1] || '').trim();
  if (!candidate || /^(?:למאגר|לרשימה|למאגר השירים)$/iu.test(candidate)) {
    return null;
  }

  return parseSongIdentityText(candidate);
}

function isGenericAddToLibraryRequest(messageText) {
  const source = String(messageText || '').trim();
  if (!source) return false;

  return /^(?:תוסיף|תוסיפי|להוסיף|הוסף|add)(?:\s+(?:למאגר|לרשימה|למאגר השירים))?\s*$/iu.test(source);
}

function inferRecentAddSongPayload(messageText, recentMessages, quotedText = '') {
  const direct = inferDirectAddSongFromMessage(messageText);
  if (direct) {
    return direct;
  }

  if (!isGenericAddToLibraryRequest(messageText)) {
    return null;
  }

  const quotedCandidate = parseSongIdentityText(quotedText);
  if (quotedCandidate) {
    return quotedCandidate;
  }

  const items = Array.isArray(recentMessages) ? recentMessages : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const candidate = parseSongIdentityText(items[index]?.text || '');
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function buildAgentMessageText(messageText, recentMessages, quotedText = '') {
  const source = String(messageText || '').trim();
  const directAddSong = inferDirectAddSongFromMessage(source);
  if (directAddSong) {
    return source;
  }

  const inferredAddSong = inferRecentAddSongPayload(source, recentMessages, quotedText);
  if (!inferredAddSong) {
    return source;
  }

  return `תוסיף ${inferredAddSong.song_title} של ${inferredAddSong.artist}`;
}

function buildRecentMessageContext(records, limit = 3) {
  const items = Array.isArray(records) ? records : [];
  return items
    .slice(-limit)
    .map((record) => ({
      text: String(record?.text || '').trim(),
      from_me: Boolean(record?.fromMe),
      sender: String(record?.sender || record?.from || '').trim()
    }))
    .filter((entry) => entry.text);
}

async function sendReplyContextChords({
  stateStore,
  chat,
  record,
  replyContext,
  discoverChords,
  prepareSongsForReplyFn = prepareSongsForReply
}) {
  const contextResults = Array.isArray(replyContext?.results) ? replyContext.results : [];
  const songs = contextResults
    .map((entry) => entry?.song_id ? stateStore.getSongById(entry.song_id) : null)
    .filter(Boolean);

  if (!songs.length) {
    await sendBotMessage(chat, 'לא מצאתי לאיזה שירים להביא אקורדים.');
    return true;
  }

  const preparedSongs = discoverChords
    ? await prepareSongsForReplyFn(songs, {})
    : songs.map((song) => ({ ...song }));

  let hasUpdates = false;
  if (typeof stateStore.setSongChordsUrl === 'function') {
    for (const song of preparedSongs) {
      const chordsUrl = String(song?.chords_url || '').trim();
      if (!chordsUrl) continue;
      if (stateStore.setSongChordsUrl(song.message_id, chordsUrl)) {
        hasUpdates = true;
      }
    }
  }
  if (hasUpdates) {
    await stateStore.queueSave();
  }

  await sendBotMessage(chat, formatSongsReply(preparedSongs, { includeChords: true }));
  return true;
}

function resolveSongFromAction(stateStore, action, activeContext) {
  if (action.song_id) {
    return { song: stateStore.getSongById(action.song_id), reason: null };
  }

  if (Number.isInteger(action.result_index) && activeContext?.context) {
    const [entry] = findSongIdsByIndexes(activeContext.context, [action.result_index]);
    if (entry?.song_id) {
      return { song: stateStore.getSongById(entry.song_id), reason: null };
    }
  }

  if (action.song_title) {
    const matches = typeof stateStore.findSongsByNormalizedName === 'function'
      ? stateStore.findSongsByNormalizedName(action.song_title, action.artist || '')
      : (() => {
          const match = typeof stateStore.findSongByNormalizedName === 'function'
            ? stateStore.findSongByNormalizedName(action.song_title, action.artist || '')
            : null;
          return match ? [match] : [];
        })();
    if (matches.length === 1) {
      return { song: matches[0], reason: null };
    }
    if (matches.length > 1) {
      return { song: null, reason: 'ambiguous' };
    }
  }

  return { song: null, reason: 'missing' };
}

function formatSongInfo(song) {
  const keysType = Array.isArray(song?.ai_metadata?.keys_type) && song.ai_metadata.keys_type.length > 0
    ? song.ai_metadata.keys_type.join(', ')
    : 'אין סוג קלידים משמעותי';
  const issues = Array.isArray(song?.band_status?.issues) && song.band_status.issues.length > 0
    ? song.band_status.issues.join(', ')
    : '\u05d0\u05d9\u05df';
  const notes = String(song?.band_status?.notes || '').trim();
  const attempts = Number.isInteger(song?.band_status?.attempts) ? song.band_status.attempts : 0;
  const reviewed = song?.band_status?.last_reviewed || '\u05d0\u05d9\u05df';
  const rehearsed = song?.band_status?.last_rehearsed || '\u05d0\u05d9\u05df';
  const played = song?.band_status?.last_played || '\u05d0\u05d9\u05df';
  return [
    `${song.song_title}${song.artist ? ` - ${song.artist}` : ''}`,
    `\u05de\u05e6\u05d1: ${FIT_LABELS[song.band_status.fit] || song.band_status.fit}`,
    `קלידים: ${keysType}`,
    `תפקיד קלידים: ${song?.ai_metadata?.keys_role || 'לא ידוע'}`,
    `קושי קלידים: ${song?.ai_metadata?.keys_difficulty || 'לא ידוע'}`,
    `\u05d1\u05e2\u05d9\u05d5\u05ea: ${issues}`,
    `\u05e0\u05d9\u05e1\u05d9\u05d5\u05e0\u05d5\u05ea: ${attempts}`,
    `\u05e0\u05e1\u05e7\u05e8 \u05dc\u05d0\u05d7\u05e8\u05d5\u05e0\u05d4: ${reviewed}`,
    `\u05d7\u05d6\u05e8\u05d4 \u05dc\u05d0\u05d7\u05e8\u05d5\u05e0\u05d4: ${rehearsed}`,
    `\u05e0\u05d5\u05d2\u05df \u05dc\u05d0\u05d7\u05e8\u05d5\u05e0\u05d4: ${played}`,
    notes ? `\u05d4\u05e2\u05e8\u05d5\u05ea: ${notes}` : null
  ].filter(Boolean).join('\n');
}

function explainSongStatus(song) {
  const fit = String(song?.band_status?.fit || 'unknown').trim();
  const issues = Array.isArray(song?.band_status?.issues) ? song.band_status.issues : [];
  const notes = String(song?.band_status?.notes || '').trim();

  if (fit === 'bad') {
    if (issues.length > 0 || notes) {
      return [
        `${song.song_title}${song.artist ? ` - ${song.artist}` : ''}`,
        `\u05dc\u05d0 \u05e2\u05d1\u05d3 \u05dc\u05e0\u05d5.`,
        issues.length > 0 ? `\u05d1\u05e2\u05d9\u05d5\u05ea: ${issues.join(', ')}` : null,
        notes ? `\u05d4\u05e2\u05e8\u05d5\u05ea: ${notes}` : null
      ].filter(Boolean).join('\n');
    }
    return `${song.song_title}${song.artist ? ` - ${song.artist}` : ''}\n\u05de\u05e1\u05d5\u05de\u05df \u05db\u05dc\u05d0 \u05e2\u05d5\u05d1\u05d3 \u05dc\u05d4\u05e8\u05db\u05d1.`;
  }

  return formatSongInfo(song);
}

function sanitizeSongUpdates(song, updates) {
  const sanitized = {};
  for (const field of Object.keys(updates || {})) {
    if (!MUTABLE_SONG_FIELDS.has(field)) continue;
    sanitized[field] = updates[field];
  }

  return {
    ...sanitized,
    normalized_title: sanitized.song_title ? normalizeText(sanitized.song_title) : song.normalized_title,
    normalized_artist: sanitized.artist ? normalizeText(sanitized.artist) : song.normalized_artist
  };
}

function buildSongForInsert(rawSong, record) {
  const song = rawSong && typeof rawSong === 'object' ? rawSong : {};
  const songTitle = String(song.song_title || '').trim();
  const artist = song.artist === null || song.artist === undefined ? null : String(song.artist).trim();

  return {
    ...song,
    message_id: String(song.message_id || `agent:add:${Date.now()}`).trim(),
    source_text: String(song.source_text || record?.text || '').trim(),
    song_title: songTitle,
    artist,
    language: song.language ? String(song.language).trim().toLowerCase() : null,
    chords_url: song.chords_url ? String(song.chords_url).trim() : null,
    confidence: Number.isFinite(Number(song.confidence)) ? Number(song.confidence) : 0.5,
    genres: Array.isArray(song.genres)
      ? Array.from(new Set(song.genres.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)))
      : [],
    difficulty: song.difficulty ? String(song.difficulty).trim().toLowerCase() : null,
    feel: song.feel ? String(song.feel).trim().toLowerCase() : null,
    duration_seconds: Number.isInteger(Number.parseInt(song.duration_seconds, 10)) && Number.parseInt(song.duration_seconds, 10) > 0
      ? Number.parseInt(song.duration_seconds, 10)
      : null,
    used: Boolean(song.used),
    created_at: song.created_at || new Date().toISOString(),
    normalized_title: normalizeText(songTitle),
    normalized_artist: normalizeText(artist),
    ai_metadata: song.ai_metadata && typeof song.ai_metadata === 'object' ? song.ai_metadata : undefined,
    band_status: song.band_status && typeof song.band_status === 'object' ? song.band_status : undefined
  };
}

function buildFeedbackConfirmation(updatedSongs) {
  if (updatedSongs.length === 0) {
    return '\u05dc\u05d0 \u05de\u05e6\u05d0\u05ea\u05d9 \u05de\u05d4 \u05dc\u05e2\u05d3\u05db\u05df.';
  }

  if (updatedSongs.length === 1) {
    const song = updatedSongs[0];
    return `\u05e2\u05d3\u05db\u05e0\u05ea\u05d9: ${song.song_title} - ${FIT_LABELS[song.band_status.fit] || song.band_status.fit}`;
  }

  return [
    '\u05e2\u05d3\u05db\u05e0\u05ea\u05d9:',
    ...updatedSongs.map((song) => `- ${song.song_title} - ${FIT_LABELS[song.band_status.fit] || song.band_status.fit}`)
  ].join('\n');
}

function formatBadSongsSummary(songs) {
  if (!songs.length) {
    return '\u05d0\u05d9\u05df \u05dc\u05e0\u05d5 \u05db\u05e8\u05d2\u05e2 \u05e9\u05d9\u05e8\u05d9\u05dd \u05e9\u05e1\u05d5\u05de\u05e0\u05d5 \u05db\u05dc\u05d0 \u05e2\u05d1\u05d3\u05d5.';
  }

  return [
    '\u05d4\u05d4\u05e6\u05e2\u05d5\u05ea \u05e9\u05dc\u05d0 \u05e2\u05d1\u05d3\u05d5 \u05dc\u05e0\u05d5:',
    ...songs.map((song) => {
      const issues = Array.isArray(song?.band_status?.issues) && song.band_status.issues.length > 0
        ? song.band_status.issues.join(', ')
        : '\u05d0\u05d9\u05df \u05e4\u05d9\u05e8\u05d5\u05d8';
      return `- ${song.song_title}${song.artist ? ` - ${song.artist}` : ''}: ${issues}`;
    })
  ].join('\n');
}

function formatMinutesLabel(totalMinutes) {
  const minutes = Math.max(0, Math.round(Number(totalMinutes) || 0));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours <= 0) {
    return `${minutes} דק'`;
  }
  return `${hours}:${String(remainder).padStart(2, '0')} שעות`;
}

function formatSlotDuration(seconds) {
  const minutes = Math.max(1, Math.round((Number(seconds) || 0) / 60));
  return `${minutes} דק'`;
}

function formatSongDuration(seconds) {
  const totalSeconds = Math.max(0, Number.parseInt(seconds, 10) || 0);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  if (minutes <= 0) {
    return `${remainder} שנ'`;
  }
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function forceRtlLines(text) {
  return String(text || '')
    .split('\n')
    .map((line) => (line ? `\u200F${line}` : line))
    .join('\n');
}

function getSongDurationSeconds(song) {
  const parsed = Number.parseInt(song?.duration_seconds, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SONG_DURATION_SECONDS;
}

function buildDurationEstimationPrompt(songs) {
  return JSON.stringify({
    songs: (Array.isArray(songs) ? songs : []).map((song) => ({
      song_id: String(song?.song_id || '').trim(),
      song_title: String(song?.song_title || '').trim(),
      artist: String(song?.artist || '').trim(),
      genres: Array.isArray(song?.genres) ? song.genres : [],
      feel: song?.feel || null,
      difficulty: song?.difficulty || null
    }))
  });
}

async function estimateMissingDurations({
  songs,
  config,
  estimateSongDurationsFn
}) {
  const missingSongs = (Array.isArray(songs) ? songs : []).filter((song) => !Number.isInteger(Number.parseInt(song?.duration_seconds, 10)));
  if (!missingSongs.length) {
    return [];
  }

  if (typeof estimateSongDurationsFn === 'function') {
    const estimated = await estimateSongDurationsFn(missingSongs);
    return Array.isArray(estimated) ? estimated : [];
  }

  if (!config?.llmBaseUrl || !config?.llmModel) {
    return [];
  }

  const systemPrompt = [
    'You estimate song durations for rehearsal planning.',
    'Return exactly one JSON object. No prose.',
    'Schema: {"durations":[{"song_id":"...","duration_seconds":123}]}',
    'duration_seconds must be a positive integer.',
    'Estimate likely studio-song duration, not rehearsal slot duration.',
    'Include only songs you can estimate confidently.'
  ].join('\n');

  try {
    const { parsed } = await callOpenAiCompatibleChat({
      baseUrl: config.llmBaseUrl,
      apiKey: config.llmApiKey,
      model: config.llmModel,
      systemPrompt,
      prompt: buildDurationEstimationPrompt(missingSongs),
      maxCompletionTokens: 400
    });
    return Array.isArray(parsed?.durations) ? parsed.durations : [];
  } catch (error) {
    console.error('[duration_estimate] failed', error);
    return [];
  }
}

function estimateRehearsalSongSlotSeconds(song) {
  const feel = String(song?.feel || '').trim().toLowerCase();
  const difficulty = String(song?.difficulty || '').trim().toLowerCase();
  return getSongDurationSeconds(song)
    + (JAM_BUFFER_BY_FEEL_SECONDS[feel] || 60)
    + (MISTAKE_BUFFER_BY_DIFFICULTY_SECONDS[difficulty] || 75)
    + SONG_REHEARSAL_DISCUSSION_SECONDS
    + SONG_TRANSITION_SECONDS;
}

function wantsCoherentRehearsalSet(messageText) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return false;
  return /(?:קשר ביניהם|קשור(?:ים|ות)? ביניהם|קו משותף|אותו וייב|אותה אווירה|זורם יחד|flow together|cohesive|similar vibe)/iu.test(source);
}

function listOverlapScore(left, right) {
  const leftItems = Array.isArray(left) ? left.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean) : [];
  const rightItems = Array.isArray(right) ? right.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean) : [];
  if (!leftItems.length || !rightItems.length) return 0;
  const rightSet = new Set(rightItems);
  let matches = 0;
  for (const item of leftItems) {
    if (rightSet.has(item)) matches += 1;
  }
  return matches;
}

function normalizedScalar(value) {
  return String(value || '').trim().toLowerCase();
}

function scoreRehearsalCoherence(candidate, selectedSongs, anchorSong) {
  if (!anchorSong) return 0;

  let score = 0;
  score += listOverlapScore(candidate?.genres, anchorSong?.genres) * 6;
  score += listOverlapScore(candidate?.genres, selectedSongs.flatMap((song) => song?.genres || [])) * 2;

  if (normalizedScalar(candidate?.feel) && normalizedScalar(candidate?.feel) === normalizedScalar(anchorSong?.feel)) {
    score += 5;
  }
  if (normalizedScalar(candidate?.difficulty) && normalizedScalar(candidate?.difficulty) === normalizedScalar(anchorSong?.difficulty)) {
    score += 3;
  }
  if (normalizedScalar(candidate?.ai_metadata?.band_energy) && normalizedScalar(candidate?.ai_metadata?.band_energy) === normalizedScalar(anchorSong?.ai_metadata?.band_energy)) {
    score += 3;
  }
  if (normalizedScalar(candidate?.ai_metadata?.groove_level) && normalizedScalar(candidate?.ai_metadata?.groove_level) === normalizedScalar(anchorSong?.ai_metadata?.groove_level)) {
    score += 2;
  }

  const sameArtistCount = selectedSongs.filter((song) => normalizedScalar(song?.artist) === normalizedScalar(candidate?.artist)).length;
  if (sameArtistCount > 0) {
    score -= 12 + (sameArtistCount * 4);
  }

  const sameFeelCount = selectedSongs.filter((song) => normalizedScalar(song?.feel) === normalizedScalar(candidate?.feel)).length;
  if (sameFeelCount >= 2) {
    score -= 4 + sameFeelCount;
  }

  const sameLanguageCount = selectedSongs.filter((song) => normalizedScalar(song?.language) === normalizedScalar(candidate?.language)).length;
  if (sameLanguageCount >= 3) {
    score -= 3 + sameLanguageCount;
  }

  const sameDifficultyCount = selectedSongs.filter((song) => normalizedScalar(song?.difficulty) === normalizedScalar(candidate?.difficulty)).length;
  if (sameDifficultyCount >= 3) {
    score -= 2;
  }

  return score;
}

function orderRehearsalSongsForCohesion(songs) {
  const pool = Array.isArray(songs) ? songs.filter(Boolean) : [];
  if (pool.length <= 2) {
    return pool;
  }

  const ordered = [pool[0]];
  const remaining = pool.slice(1);
  const anchorSong = ordered[0];

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const score = scoreRehearsalCoherence(candidate, ordered, anchorSong);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    ordered.push(remaining.splice(bestIndex, 1)[0]);
  }

  return ordered;
}

function buildRehearsalPlanSongs({ songs, query, activeContext, stateStore, chatId, messageText = '' }) {
  const plannerQuery = {
    ...(query || {}),
    requirements: {
      ...((query && query.requirements) || {}),
      excludeRejected:
        typeof query?.requirements?.excludeRejected === 'boolean'
          ? query.requirements.excludeRejected
          : true
    },
    limit: Math.min(Math.max(Array.isArray(songs) ? songs.length : 0, 1), 50)
  };

  const { candidateSongs, afterPreviousFilter } = buildSearchCandidates({
    songs,
    query: plannerQuery,
    activeContext,
    stateStore,
    chatId
  });

  const matches = runSongSearchWithFallback({
    songs,
    query: plannerQuery,
    candidateSongs,
    afterPreviousFilter
  });

  if (wantsCoherentRehearsalSet(messageText) && matches.length > 0) {
    return orderRehearsalSongsForCohesion(matches);
  }

  return matches;
}

function buildRehearsalPlan({ songs, durationMinutes }) {
  const totalMinutes = Number.isInteger(Number.parseInt(durationMinutes, 10))
    ? Number.parseInt(durationMinutes, 10)
    : DEFAULT_REHEARSAL_DURATION_MINUTES;
  const breakCount = totalMinutes > 180 ? 2 : 1;
  const breakMinutes = breakCount * REHEARSAL_BREAK_MINUTES;
  const availableSongSeconds = Math.max(0, (totalMinutes - breakMinutes) * 60);
  const selectedSongs = [];
  let selectedSeconds = 0;

  for (const song of Array.isArray(songs) ? songs : []) {
    const slotSeconds = estimateRehearsalSongSlotSeconds(song);
    const remainingSeconds = availableSongSeconds - selectedSeconds;
    if (selectedSongs.length > 0 && slotSeconds > remainingSeconds) {
      continue;
    }
    selectedSongs.push({ song, slotSeconds });
    selectedSeconds += slotSeconds;
    if (selectedSeconds >= availableSongSeconds) {
      break;
    }
  }

  const chunkCount = breakCount + 1;
  const chunkTargetSeconds = chunkCount > 0 ? Math.floor(availableSongSeconds / chunkCount) : availableSongSeconds;
  const items = [];
  let chunkSeconds = 0;
  let insertedBreaks = 0;

  for (let index = 0; index < selectedSongs.length; index += 1) {
    const entry = selectedSongs[index];
    items.push({
      type: 'song',
      song: entry.song,
      slotSeconds: entry.slotSeconds
    });
    chunkSeconds += entry.slotSeconds;

    const songsRemaining = selectedSongs.length - index - 1;
    const breaksRemaining = breakCount - insertedBreaks;
    if (breaksRemaining > 0 && songsRemaining > breaksRemaining && chunkSeconds >= chunkTargetSeconds) {
      items.push({
        type: 'break',
        minutes: REHEARSAL_BREAK_MINUTES
      });
      insertedBreaks += 1;
      chunkSeconds = 0;
    }
  }

  return {
    durationMinutes: totalMinutes,
    breakCount,
    breakMinutes,
    songMinutes: Math.round(selectedSeconds / 60),
    totalPlannedMinutes: Math.round((selectedSeconds / 60) + breakMinutes),
    slackMinutes: Math.max(0, totalMinutes - Math.round((selectedSeconds / 60) + breakMinutes)),
    songs: selectedSongs.map((entry) => entry.song),
    items
  };
}

function formatRehearsalPlanReply(plan) {
  if (!plan?.songs?.length) {
    return 'לא מצאתי מספיק שירים מתאימים לחזרה.';
  }

  const lines = [
    `רשימת חזרה ל-${formatMinutesLabel(plan.durationMinutes)}`,
    `זמן נגינה מתוכנן: ${formatMinutesLabel(plan.songMinutes)}`,
    `הפסקות: ${plan.breakCount} x ${REHEARSAL_BREAK_MINUTES} דק'`,
    plan.slackMinutes > 0 ? `רזרבה: ${plan.slackMinutes} דק'` : null,
    ''
  ].filter(Boolean);

  let songIndex = 0;
  for (const item of plan.items) {
    if (item.type === 'break') {
      lines.push(`הפסקה - ${item.minutes} דק'`);
      continue;
    }
    songIndex += 1;
    lines.push(
      `${songIndex}. ${item.song.song_title}${item.song.artist ? ` - ${item.song.artist}` : ''}${
        item.song.duration_seconds ? ` | שיר ${formatSongDuration(item.song.duration_seconds)}` : ''
      }`
    );
  }

  return forceRtlLines(lines.join('\n'));
}

async function sendRehearsalPlanReply({ chat, stateStore, chatId, plan, query = null }) {
  if (!plan?.songs?.length) {
    await sendBotMessage(chat, 'לא מצאתי מספיק שירים מתאימים לחזרה.');
    return;
  }

  const sentMessage = await sendBotMessage(chat, formatRehearsalPlanReply(plan));
  const botMessageId = extractBotMessageId(sentMessage);
  persistResultContext(stateStore, {
    chatId,
    botMessageId,
    songs: plan.songs,
    query,
    createdAt: new Date().toISOString()
  });
  if (typeof stateStore.recordRecommendations === 'function') {
    stateStore.recordRecommendations(
      chatId,
      plan.songs.map((song) => song.song_id).filter(Boolean)
    );
  }
  await stateStore.queueSave();
}

function buildBandStatusQuery(fit) {
  return {
    requirements: {},
    preferences: {},
    exclusions: {
      band_fit: Array.from(new Set(['unknown', 'good', 'maybe', 'bad'].filter((value) => value !== fit)))
    },
    limit: 10
  };
}

function cloneQuery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return {
    ...value,
    requirements:
      value.requirements && typeof value.requirements === 'object' && !Array.isArray(value.requirements)
        ? { ...value.requirements }
        : {},
    preferences:
      value.preferences && typeof value.preferences === 'object' && !Array.isArray(value.preferences)
        ? { ...value.preferences }
        : {},
    exclusions:
      value.exclusions && typeof value.exclusions === 'object' && !Array.isArray(value.exclusions)
        ? { ...value.exclusions }
        : {}
  };
}

function sanitizeQueryForResultContext(query, fallbackLimit = null) {
  const cloned = cloneQuery(query);
  delete cloned.avoid_previous_results;
  delete cloned.replace_result_indexes;
  if (!Number.isInteger(Number.parseInt(cloned.limit, 10)) && Number.isInteger(fallbackLimit) && fallbackLimit > 0) {
    cloned.limit = fallbackLimit;
  }
  return cloned;
}

function mergeSearchQueries(baseQuery, overrideQuery) {
  const base = cloneQuery(baseQuery);
  const override = cloneQuery(overrideQuery);

  return {
    ...base,
    ...override,
    requirements: {
      ...(base.requirements || {}),
      ...(override.requirements || {})
    },
    preferences: {
      ...(base.preferences || {}),
      ...(override.preferences || {})
    },
    exclusions: {
      ...(base.exclusions || {}),
      ...(override.exclusions || {})
    }
  };
}

function buildSearchCandidates({ songs, query, activeContext, stateStore, chatId }) {
  const excludedSongIds =
    query?.avoid_previous_results && activeContext?.context
      ? new Set(activeContext.context.results.map((entry) => entry.song_id).filter(Boolean))
      : null;
  const afterPreviousFilter = excludedSongIds
    ? songs.filter((song) => !excludedSongIds.has(song.song_id))
    : songs;
  const requestedLimit = Number.parseInt(query?.limit, 10);
  const recentRecommendationIds = new Set(
    typeof stateStore.getRecentRecommendations === 'function'
      ? stateStore.getRecentRecommendations(chatId)
      : []
  );

  const candidateSongs =
    recentRecommendationIds.size > 0
      ? (() => {
          const filtered = afterPreviousFilter.filter((song) => !recentRecommendationIds.has(song.song_id));
          return filtered.length >= (Number.isInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : 5)
            ? filtered
            : afterPreviousFilter;
        })()
      : afterPreviousFilter;

  return {
    candidateSongs,
    afterPreviousFilter
  };
}

function runSongSearchWithFallback({ songs, query, candidateSongs, afterPreviousFilter }) {
  const hardMatchCount = countHardFilterMatches(songs, query || {});
  console.log(
    `[search] artist=${JSON.stringify(query?.requirements?.artist || null)} language=${JSON.stringify(query?.requirements?.language || null)} genres=${JSON.stringify(query?.requirements?.genres || [])} keys_type_hard=${JSON.stringify(query?.requirements?.keys_type_any || [])} keys_type_pref=${JSON.stringify(query?.preferences?.keys_type_any || [])} keys_type_excluded=${JSON.stringify(query?.exclusions?.keys_type_any || [])} keys_difficulty=${JSON.stringify(query?.preferences?.keys_difficulty || query?.requirements?.keys_difficulty || null)} hard_matches=${hardMatchCount}`
  );

  let matches = searchSongs(candidateSongs, query || {});
  if (matches.length === 0 && hardMatchCount > 0) {
    matches = searchSongs(afterPreviousFilter, query || {});
  }
  if (matches.length === 0 && hardMatchCount > 0 && afterPreviousFilter !== songs) {
    matches = searchSongs(songs, query || {});
  }
  return matches;
}

function buildReplacementIndexes(query, activeContext) {
  const indexes = Array.isArray(query?.replace_result_indexes)
    ? Array.from(
        new Set(
          query.replace_result_indexes
            .map((value) => Number.parseInt(value, 10))
            .filter((value) => Number.isInteger(value) && value > 0)
        )
      )
    : [];
  if (!indexes.length || !activeContext?.context) {
    return [];
  }
  const validIndexes = new Set(activeContext.context.results.map((entry) => entry.index));
  return indexes.filter((index) => validIndexes.has(index));
}

function shuffleSongs(songs) {
  const items = Array.isArray(songs) ? [...songs] : [];
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
  return items;
}

function fillReplacementSongsWithRandomFallbacks({
  songs,
  candidateSongs,
  afterPreviousFilter,
  context,
  replacementSongs,
  replacementIndexes
}) {
  const needed = Math.max(0, replacementIndexes.length - replacementSongs.length);
  if (!needed) {
    return replacementSongs;
  }

  const excludedSongIds = new Set(
    context.results
      .map((entry) => entry.song_id)
      .concat(replacementSongs.map((song) => song?.song_id))
      .filter(Boolean)
  );

  const fallbackPool = [];
  for (const source of [candidateSongs, afterPreviousFilter, songs]) {
    for (const song of Array.isArray(source) ? source : []) {
      if (!song?.song_id || excludedSongIds.has(song.song_id)) {
        continue;
      }
      excludedSongIds.add(song.song_id);
      fallbackPool.push(song);
    }
  }

  return replacementSongs.concat(shuffleSongs(fallbackPool).slice(0, needed));
}

function rebuildResultListWithReplacements({ context, stateStore, replacementIndexes, replacementSongs }) {
  const replacementMap = new Map();
  replacementIndexes.forEach((index, replacementPosition) => {
    replacementMap.set(index, replacementSongs[replacementPosition] || null);
  });

  return context.results
    .map((entry) => {
      const originalSong = entry.song_id ? stateStore.getSongById(entry.song_id) : null;
      if (replacementMap.has(entry.index)) {
        return replacementMap.get(entry.index) || originalSong;
      }
      return originalSong;
    })
    .filter(Boolean);
}

async function sendSongsReply({ chat, stateStore, chatId, songs, query = null }) {
  if (!songs.length) {
    await sendBotMessage(chat, '\u05dc\u05d0 \u05de\u05e6\u05d0\u05ea\u05d9 \u05e9\u05d9\u05e8\u05d9\u05dd \u05de\u05ea\u05d0\u05d9\u05de\u05d9\u05dd.');
    return;
  }

  const sentMessage = await sendBotMessage(chat, formatSongsReply(songs));
  const botMessageId = extractBotMessageId(sentMessage);
  persistResultContext(stateStore, {
    chatId,
    botMessageId,
    songs,
    query,
    createdAt: new Date().toISOString()
  });
  if (typeof stateStore.recordRecommendations === 'function') {
    stateStore.recordRecommendations(
      chatId,
      songs.map((song) => song.song_id).filter(Boolean)
    );
  }
  await stateStore.queueSave();
}

async function executeAgentAction({ action, stateStore, chat, record, messageText, replyContext, config = {}, estimateSongDurationsFn }) {
  const activeContext = resolveActiveResultContext(stateStore, record);
  const songs = stateStore.getSongs();

  if (action.action === 'clarify') {
    await sendBotMessage(chat, buildClarifyReply(action, { messageText, replyContext }));
    return;
  }

  if (action.action === 'search_songs') {
    const replacementIndexes = buildReplacementIndexes(action.query, activeContext);
    if (replacementIndexes.length > 0) {
      const baseQuery = mergeSearchQueries(activeContext.context?.query || {}, action.query || {});
      const replacementQuery = {
        ...baseQuery,
        limit: replacementIndexes.length,
        avoid_previous_results: true
      };
        const { candidateSongs, afterPreviousFilter } = buildSearchCandidates({
          songs,
          query: replacementQuery,
          activeContext,
          stateStore,
          chatId: record.chatId
        });
        const replacementMatches = runSongSearchWithFallback({
          songs,
          query: replacementQuery,
          candidateSongs,
          afterPreviousFilter
        });
        const replacementSongs = fillReplacementSongsWithRandomFallbacks({
          songs,
          candidateSongs,
          afterPreviousFilter,
          context: activeContext.context,
          replacementSongs: replacementMatches,
          replacementIndexes
        });
        if (!replacementSongs.length) {
          await sendBotMessage(chat, '\u05dc\u05d0 \u05de\u05e6\u05d0\u05ea\u05d9 \u05d4\u05d7\u05dc\u05e4\u05d5\u05ea \u05de\u05ea\u05d0\u05d9\u05de\u05d5\u05ea.');
          return;
        }
      const rebuiltSongs = rebuildResultListWithReplacements({
        context: activeContext.context,
        stateStore,
        replacementIndexes,
        replacementSongs
      });
      await sendSongsReply({
        chat,
        stateStore,
        chatId: record.chatId,
        songs: rebuiltSongs,
        query: sanitizeQueryForResultContext(baseQuery, rebuiltSongs.length)
      });
      return;
    }

    const { candidateSongs, afterPreviousFilter } = buildSearchCandidates({
      songs,
      query: action.query || {},
      activeContext,
      stateStore,
      chatId: record.chatId
    });
    const matches = runSongSearchWithFallback({
      songs,
      query: action.query || {},
      candidateSongs,
      afterPreviousFilter
    });
    await sendSongsReply({
      chat,
      stateStore,
      chatId: record.chatId,
      songs: matches,
      query: sanitizeQueryForResultContext(action.query || {}, matches.length)
    });
    return;
  }

  if (action.action === 'prepare_rehearsal') {
    let rehearsalSongs = buildRehearsalPlanSongs({
      songs,
      query: action.query || {},
      activeContext,
      stateStore,
      chatId: record.chatId,
      messageText
    });
    const durationEstimates = await estimateMissingDurations({
      songs: rehearsalSongs,
      config,
      estimateSongDurationsFn
    });
    if (Array.isArray(durationEstimates) && durationEstimates.length > 0) {
      for (const entry of durationEstimates) {
        const songId = String(entry?.song_id || '').trim();
        const durationSeconds = Number.parseInt(entry?.duration_seconds, 10);
        if (!songId || !Number.isInteger(durationSeconds) || durationSeconds <= 0) {
          continue;
        }
        stateStore.updateSongById(songId, (song) => ({
          ...song,
          duration_seconds: durationSeconds
        }));
      }
      await stateStore.queueSave();
      rehearsalSongs = buildRehearsalPlanSongs({
        songs: stateStore.getSongs(),
        query: action.query || {},
        activeContext,
        stateStore,
        chatId: record.chatId,
        messageText
      });
    }
    const plan = buildRehearsalPlan({
      songs: rehearsalSongs,
      durationMinutes: action.duration_minutes
    });
    await sendRehearsalPlanReply({
      chat,
      stateStore,
      chatId: record.chatId,
      plan,
      query: sanitizeQueryForResultContext(action.query || {}, plan.songs.length)
    });
    return;
  }

  if (action.action === 'find_similar_songs') {
    const referenceIndex = Number.parseInt(action.query?.reference_result_index, 10);
    if (!Number.isInteger(referenceIndex) || !activeContext.context) {
      await sendBotMessage(chat, '\u05dc\u05d0\u05d9\u05d6\u05d5 \u05e8\u05e9\u05d9\u05de\u05d4 \u05d0\u05ea\u05d4 \u05de\u05ea\u05db\u05d5\u05d5\u05df?');
      return;
    }

    const [entry] = findSongIdsByIndexes(activeContext.context, [referenceIndex]);
    const similarSong = entry?.song_id ? stateStore.getSongById(entry.song_id) : null;
    if (!similarSong) {
      await sendBotMessage(chat, '\u05dc\u05d0 \u05de\u05e6\u05d0\u05ea\u05d9 \u05d0\u05ea \u05d4\u05e9\u05d9\u05e8 \u05e9\u05d4\u05ea\u05db\u05d5\u05d5\u05e0\u05ea \u05d0\u05dc\u05d9\u05d5.');
      return;
    }

    const matches = searchSongs(
      songs.filter((song) => song.song_id !== similarSong.song_id),
      { ...action.query, limit: action.query?.limit || 5 },
      { similarSong }
    );
    await sendSongsReply({
      chat,
      stateStore,
      chatId: record.chatId,
      songs: matches,
      query: sanitizeQueryForResultContext(action.query || {}, matches.length)
    });
    return;
  }

  if (action.action === 'get_band_good_songs' || action.action === 'get_band_bad_songs' || action.action === 'get_band_maybe_songs') {
    const fit =
      action.action === 'get_band_good_songs'
        ? 'good'
        : action.action === 'get_band_bad_songs'
          ? 'bad'
          : 'maybe';
    const matches = searchSongs(songs, buildBandStatusQuery(fit));
    if (action.action === 'get_band_bad_songs') {
      await sendBotMessage(chat, formatBadSongsSummary(matches));
      return;
    }
    await sendSongsReply({
      chat,
      stateStore,
      chatId: record.chatId,
      songs: matches,
      query: sanitizeQueryForResultContext(buildBandStatusQuery(fit), matches.length)
    });
    return;
  }

  if (action.action === 'get_band_failure_reasons') {
    const matches = searchSongs(songs, buildBandStatusQuery('bad'));
    await sendBotMessage(chat, formatBadSongsSummary(matches));
    return;
  }

  if (action.action === 'add_song') {
    const songToInsert = buildSongForInsert(action.song, record);
    const inserted = stateStore.addSong(songToInsert);

    if (!inserted) {
      await sendBotMessage(chat, '\u05d4\u05e9\u05d9\u05e8 \u05db\u05d1\u05e8 \u05e7\u05d9\u05d9\u05dd.');
      return;
    }

    await stateStore.queueSave();
    await sendBotMessage(chat, `\u05d4\u05d5\u05e1\u05e4\u05ea\u05d9: ${songToInsert.song_title}${songToInsert.artist ? ` - ${songToInsert.artist}` : ''}`);
    return;
  }

  if (action.action === 'update_song_feedback') {
    if (!activeContext.context) {
      await sendBotMessage(chat, '\u05dc\u05d0\u05d9\u05d6\u05d5 \u05e8\u05e9\u05d9\u05de\u05d4 \u05d0\u05ea\u05d4 \u05de\u05ea\u05db\u05d5\u05d5\u05df?');
      return;
    }

    const updatedSongs = [];
    for (const update of action.updates) {
      const [entry] = findSongIdsByIndexes(activeContext.context, [update.result_index]);
      if (!entry?.song_id) continue;
      const updated = stateStore.updateSongById(entry.song_id, (song) => ({
        ...song,
        band_status: {
          ...song.band_status,
          fit: update.fit || song.band_status.fit,
          issues: update.issues || song.band_status.issues,
          notes: update.notes || song.band_status.notes,
          attempts: (song.band_status.attempts || 0) + 1,
          last_reviewed: new Date().toISOString()
        }
      }));
      if (updated) updatedSongs.push(updated);
    }

    await stateStore.queueSave();
    await sendBotMessage(chat, buildFeedbackConfirmation(updatedSongs));
    return;
  }

  if (action.action === 'get_song_info') {
    const { song, reason } = resolveSongFromAction(stateStore, action, activeContext);
    if (!song) {
      await sendBotMessage(chat,
        reason === 'ambiguous'
          ? '\u05d9\u05e9 \u05db\u05de\u05d4 \u05e9\u05d9\u05e8\u05d9\u05dd \u05de\u05ea\u05d0\u05d9\u05de\u05d9\u05dd. \u05ea\u05db\u05d5\u05d5\u05df \u05d1\u05e9\u05dd \u05d4\u05d0\u05d5\u05de\u05df \u05d0\u05d5 \u05d1\u05de\u05e1\u05e4\u05e8 \u05de\u05d4\u05e8\u05e9\u05d9\u05de\u05d4.'
          : '\u05dc\u05d0 \u05de\u05e6\u05d0\u05ea\u05d9 \u05d0\u05d9\u05d6\u05d4 \u05e9\u05d9\u05e8 \u05d4\u05ea\u05db\u05d5\u05d5\u05e0\u05ea.'
      );
      return;
    }

    await sendBotMessage(chat, formatSongInfo(song));
    return;
  }

  if (action.action === 'explain_song_rejection') {
    const { song, reason } = resolveSongFromAction(stateStore, action, activeContext);
    if (!song) {
      await sendBotMessage(chat,
        reason === 'ambiguous'
          ? '\u05d9\u05e9 \u05db\u05de\u05d4 \u05e9\u05d9\u05e8\u05d9\u05dd \u05de\u05ea\u05d0\u05d9\u05de\u05d9\u05dd. \u05ea\u05db\u05d5\u05d5\u05df \u05d1\u05e9\u05dd \u05d4\u05d0\u05d5\u05de\u05df \u05d0\u05d5 \u05d1\u05de\u05e1\u05e4\u05e8 \u05de\u05d4\u05e8\u05e9\u05d9\u05de\u05d4.'
          : '\u05dc\u05d0 \u05de\u05e6\u05d0\u05ea\u05d9 \u05d0\u05d9\u05d6\u05d4 \u05e9\u05d9\u05e8 \u05d4\u05ea\u05db\u05d5\u05d5\u05e0\u05ea.'
      );
      return;
    }

    await sendBotMessage(chat, explainSongStatus(song));
    return;
  }

  if (action.action === 'remove_song') {
    const { song, reason } = resolveSongFromAction(stateStore, action, activeContext);
    if (!song) {
      await sendBotMessage(chat,
        reason === 'ambiguous'
          ? '\u05d9\u05e9 \u05db\u05de\u05d4 \u05e9\u05d9\u05e8\u05d9\u05dd \u05de\u05ea\u05d0\u05d9\u05de\u05d9\u05dd. \u05ea\u05db\u05d5\u05d5\u05df \u05d1\u05e9\u05dd \u05d4\u05d0\u05d5\u05de\u05df \u05d0\u05d5 \u05d1\u05de\u05e1\u05e4\u05e8 \u05de\u05d4\u05e8\u05e9\u05d9\u05de\u05d4.'
          : '\u05dc\u05d0 \u05de\u05e6\u05d0\u05ea\u05d9 \u05d0\u05d9\u05d6\u05d4 \u05e9\u05d9\u05e8 \u05dc\u05d4\u05e1\u05d9\u05e8.'
      );
      return;
    }

    stateStore.removeSongById(song.song_id);
    await stateStore.queueSave();
    await sendBotMessage(chat, `\u05d4\u05e1\u05e8\u05ea\u05d9: ${song.song_title}${song.artist ? ` - ${song.artist}` : ''}`);
    return;
  }

  if (action.action === 'update_song') {
    const { song, reason } = resolveSongFromAction(stateStore, action, activeContext);
    if (!song) {
      await sendBotMessage(chat,
        reason === 'ambiguous'
          ? '\u05d9\u05e9 \u05db\u05de\u05d4 \u05e9\u05d9\u05e8\u05d9\u05dd \u05de\u05ea\u05d0\u05d9\u05de\u05d9\u05dd. \u05ea\u05db\u05d5\u05d5\u05df \u05d1\u05e9\u05dd \u05d4\u05d0\u05d5\u05de\u05df \u05d0\u05d5 \u05d1\u05de\u05e1\u05e4\u05e8 \u05de\u05d4\u05e8\u05e9\u05d9\u05de\u05d4.'
          : '\u05dc\u05d0 \u05de\u05e6\u05d0\u05ea\u05d9 \u05d0\u05d9\u05d6\u05d4 \u05e9\u05d9\u05e8 \u05dc\u05e2\u05d3\u05db\u05df.'
      );
      return;
    }

    const updates = action.updates && typeof action.updates === 'object' ? action.updates : {};
    const sanitizedUpdates = sanitizeSongUpdates(song, updates);
    const updated = stateStore.updateSongById(song.song_id, {
      ...song,
      ...sanitizedUpdates
    });
    await stateStore.queueSave();
    await sendBotMessage(chat, `\u05e2\u05d3\u05db\u05e0\u05ea\u05d9: ${updated.song_title}${updated.artist ? ` - ${updated.artist}` : ''}`);
    return;
  }

  throw new Error(`Unhandled agent action: ${action.action}`);
}

async function handleAgentMessage({
  chat,
  stateStore,
  config,
  record,
  recentMessages = [],
  interpretMessageFn = interpretMessage,
  prepareSongsForReplyFn = prepareSongsForReply,
  estimateSongDurationsFn
}) {
  const handling = shouldHandleMessage(record, config.triggerText);
  const replyContext = buildAgentReplyContext(stateStore, record);
  if (!handling.shouldHandle && !replyContext) return false;

  const messageText = handling.shouldHandle
    ? handling.messageText
    : String(record?.text || '').trim();
  if (!messageText) {
    await sendBotMessage(chat, '\u05de\u05d4 \u05dc\u05d7\u05e4\u05e9?');
    return true;
  }

  if (replyContext?.results?.length && isChordsReplyRequest(messageText)) {
    return sendReplyContextChords({
      stateStore,
      chat,
      record,
      replyContext,
      discoverChords: config.discoverChords !== false,
      prepareSongsForReplyFn
    });
  }

  const quotedText = record?.quoted?.text || record?.quotedText || '';
  const inferredSongInfoAction = inferSongInfoAction(messageText, replyContext, quotedText);
  if (inferredSongInfoAction) {
    await executeAgentAction({
      action: inferredSongInfoAction,
      stateStore,
      chat,
      config,
      record,
      messageText,
      replyContext,
      estimateSongDurationsFn
    });
    return true;
  }

  try {
    const agentMessageText = buildAgentMessageText(
      messageText,
      recentMessages,
      quotedText
    );
    const action = await interpretMessageFn({
      provider: config.llmProvider,
      baseUrl: config.llmBaseUrl,
      apiKey: config.llmApiKey,
      model: config.llmModel,
      messageText: agentMessageText,
      quotedText,
      replyContext,
      recentMessages,
      currentDate: CURRENT_DATE
    });

    if (shouldBlockGenericSearchFallback(action, { messageText: agentMessageText, replyContext })) {
      await sendBotMessage(chat, 'איזה שירים אתה רוצה?');
      return true;
    }

    await executeAgentAction({
      action,
      stateStore,
      chat,
      config,
      record,
      messageText: agentMessageText,
      replyContext,
      estimateSongDurationsFn
    });
  } catch (error) {
    console.error('[agent] failed:', error);
    await sendBotMessage(chat, buildAgentFailureReply(error));
  }
  return true;
}

async function bootstrap() {
  const {
    createWhatsAppClient,
    waitForReady,
    messageToRecord,
    readQuotedMessage
  } = require('./whatsapp');
  const config = loadConfig(process.env);
  const loadedState = await loadState(config.stateFile);
  const loadedSeenState = await loadSeenState(config.seenFile);
  const stateStore = createStateStore(config.stateFile, config.seenFile, loadedState, loadedSeenState);
  stateStore.config = config;

  const hasTargetNames = Array.isArray(config.groupNames) && config.groupNames.length > 0;
  const hasTargetIds = Array.isArray(config.groupIds) && config.groupIds.length > 0;
  if (!hasTargetNames && !hasTargetIds) {
    throw new Error('At least one target group is required for live listening');
  }

  const client = createWhatsAppClient({
    headless: config.headless,
    executablePath: config.executablePath,
    authDir: config.authDir
  });
  console.log(
    `[config] groups=${JSON.stringify(config.groupNames)} groupIds=${JSON.stringify(config.groupIds)} trigger=${JSON.stringify(config.triggerText)} provider=${config.llmProvider}`
  );
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
  const recentMessagesByChat = new Map();
  let readyToProcess = false;
  const startupTimeoutMs = 60000;
  const processedMessageIds = new Set();
  const heartbeatIntervalMs = 15 * 60 * 1000;
  heartbeatTimer = setInterval(() => {
    const groupLabel = (config.groupNames || []).join(', ') || (config.groupIds || []).join(', ') || '(unknown)';
    console.log(
      `[health] alive groups=${groupLabel} songs=${stateStore.state.songs.length} seen=${stateStore.seenState.seenMessageIds.length}`
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

  function getRecentMessagesForChat(chatId) {
    const normalizedChatId = String(chatId || '').trim();
    if (!normalizedChatId) return [];
    return recentMessagesByChat.get(normalizedChatId) || [];
  }

  function rememberRecentMessage(record) {
    const normalizedChatId = String(record?.chatId || '').trim();
    const text = String(record?.text || '').trim();
    if (!normalizedChatId || !text) return;
    if (/^\u200f?🤖(?:\s|$)/u.test(text)) return;

    const existing = recentMessagesByChat.get(normalizedChatId) || [];
    existing.push({
      text,
      fromMe: Boolean(record?.fromMe),
      sender: String(record?.sender || record?.from || '').trim()
    });
    if (existing.length > 3) {
      existing.splice(0, existing.length - 3);
    }
    recentMessagesByChat.set(normalizedChatId, existing);
  }

  async function handleLiveMessage(record) {
    const chat = record.chat;
    if (!isMessageInTargetGroup(record, config, chat)) {
      return;
    }

    const recentMessages = buildRecentMessageContext(getRecentMessagesForChat(record.chatId));
    await handleAgentMessage({ chat, stateStore, config, record, recentMessages });
  }

  async function processMessageObject(message, source) {
    const messageId = message.id?._serialized || message.id?.id || '';
    if (!markProcessed(messageId)) return;
    if (stateStore.hasSeenMessage(messageId)) return;

    const text = String(message.body || '').trim();
    if (!text) return;

    const record = messageToRecord(message);
    const quoted = await readQuotedMessage(message);
    record.quoted = quoted || record.quoted;
    record.quotedText = quoted?.text || null;

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

    if (!record.chat && chatId && String(chatId).endsWith('@g.us')) {
      record.chat = buildChatResponder(message, chatId);
    }

    if (record.chat && record.chat.isGroup === false) {
      console.log(`[message] ignored non-group source=${source} chatId=${chatId} text=${JSON.stringify(text)}`);
      return;
    }
    if (!record.chat && chatId && !String(chatId).endsWith('@g.us')) {
      console.log(`[message] ignored non-group source=${source} chatId=${chatId} text=${JSON.stringify(text)}`);
      return;
    }

    const routing = summarizeMessageRouting(record, config);
    if (!routing.inTargetGroup) {
      console.log(
        `[message] ignored group_mismatch source=${source} chatId=${chatId} actualGroup=${JSON.stringify(routing.chatName)} targetGroups=${JSON.stringify(config.groupNames)} targetGroupIds=${JSON.stringify(config.groupIds)} text=${JSON.stringify(text)}`
      );
      return;
    }

    stateStore.markSeenMessage(messageId);

    console.log(
      `[message] source=${source} chatId=${chatId} group=${JSON.stringify(routing.chatName)} from=${record.from} text=${JSON.stringify(text)} reason=${routing.handling.reason}`
    );

    if (!readyToProcess) {
      pendingMessages.push(record);
      rememberRecentMessage(record);
      return;
    }

    await handleLiveMessage(record);
    rememberRecentMessage(record);
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

  const handleIncomingMessage = async (message, source) => {
    try {
      await processMessageObject(message, source);
    } catch (error) {
      console.error('[message] failed:', error);
    }
  };

  client.on('message_create', (message) => {
    if (!message?.fromMe) return;
    void handleIncomingMessage(message, 'message_create');
  });
  client.on('message', (message) => {
    if (message?.fromMe) return;
    void handleIncomingMessage(message, 'message');
  });
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
  stripWakeWord,
  shouldHandleMessage,
  isMessageInTargetGroup,
  buildAgentReplyContext,
  buildAgentFailureReply,
  buildClarifyReply,
  buildRecentMessageContext,
  isChordsReplyRequest,
  handleAgentMessage,
  executeAgentAction
};

if (require.main === module) {
  bootstrap().catch((error) => {
    console.error('[fatal]', error);
    process.exit(1);
  });
}
