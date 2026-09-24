const { loadConfig } = require('./config');
const { createStateStore, loadState, loadSeenState, normalizeText } = require('./state');
const { interpretMessageWithTools, interpretAdditionConfirmation, interpretSongDifficulty, reviewAgentActionExecution, interpretPlainFallbackReply, recommendExternalSongs, composeUnsupportedReply, interpretUnknownSongInfo, resolveSongReference, callOpenAiCompatibleChat, isExternalCatalogRecommendationRequest, buildExternalRecommendationAction, getAgentUsageStats } = require('./llm');
const { READ_ONLY_SONG_TOOLS, executeReadOnlySongTool } = require('./agent-tools');
const {
  persistResultContext,
  resolveActiveResultContext,
  findSongIdsByIndexes
} = require('./result-context');
const { searchSongs, countHardFilterMatches } = require('./song-search');
const { formatSongsReply, prepareSongsForReply } = require('./chords');
const { ALLOWED_UPDATE_FIELDS } = require('./schemas');
const { discoverCatalogSongs } = require('./song-catalog');

function currentDateInIsrael() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}
const MUTABLE_SONG_FIELDS = new Set(ALLOWED_UPDATE_FIELDS);
const BOT_PREFIX = '\u200F🤖 ';
const DEFAULT_REHEARSAL_DURATION_MINUTES = 180;
const REHEARSAL_BREAK_MINUTES = 12;
const DEFAULT_SONG_DURATION_SECONDS = 4 * 60;
const recentVoiceRepliesByChat = new Map();
const SONG_TRANSITION_SECONDS = 90;
const SONG_REHEARSAL_DISCUSSION_SECONDS = 180;
const HIGH_DIFFICULTY_ADD_CONFIRMATION_TTL_MS = 15 * 60 * 1000;
const PENDING_CLARIFICATION_TTL_MS = 15 * 60 * 1000;
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
    return forceRtlLines(body);
  }
  return forceRtlLines(`${BOT_PREFIX}${body}`);
}

function formatSongIdentity(song) {
  const title = String(song?.song_title || '').trim();
  const artist = String(song?.artist || '').trim();
  return title && artist ? `${title} - ${artist}` : title || artist;
}

function formatBoldSongIdentity(song) {
  const identity = formatSongIdentity(song);
  return song?.is_recommendation && identity ? `*${identity}*` : identity;
}

async function sendBotMessage(chat, text) {
  return chat.sendMessage(prefixBotReply(text));
}

async function sendBotMessageToId(client, chatId, text) {
  return client.sendMessage(chatId, prefixBotReply(text));
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

function formatRetryDelay(retryAfterMs) {
  const totalSeconds = Math.ceil(Number(retryAfterMs) / 1000);
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return null;
  if (totalSeconds < 60) {
    return `${totalSeconds} שניות`;
  }
  const minutes = Math.ceil(totalSeconds / 60);
  return `${minutes} דקות`;
}

function buildAgentFailureReply(error) {
  const failureType = classifyAgentFailure(error);
  if (failureType === 'rate_limited') {
    const retryDelay = formatRetryDelay(error?.retryAfterMs);
    return retryDelay
      ? `המנוע נחנק לרגע — נסו שוב בעוד כ-${retryDelay}.`
      : 'המנוע נחנק לרגע — נסו שוב עוד רגע.';
  }
  if (failureType === 'invalid_agent_output') {
    return 'לא הבנתי עד הסוף את הבקשה. נסו לנסח שוב במשפט קצר.';
  }
  return 'נתקע לי משהו במנוע — נסו שוב עוד רגע.';
}

function formatGroqStatusReply(stats) {
  const snapshot = stats?.lastRateLimit;
  if (!snapshot) {
    return 'עוד אין לי מדידת Groq מהתהליך הזה. אחרי הקריאה הבאה אוכל להראות את המכסות.';
  }
  const formatNumber = (value) => Number.isFinite(value) ? value.toLocaleString('en-US') : '?';
  const formatRemaining = (remaining, limit) => {
    if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0) return '?';
    return `${Math.max(0, Math.min(100, Math.round((remaining / limit) * 100)))}% נשאר`;
  };
  const lines = ['מצב Groq (מהתגובה האחרונה):'];
  if (Number.isFinite(snapshot.tokenLimit) || Number.isFinite(snapshot.tokenRemaining)) {
    lines.push(`TPM: ${formatRemaining(snapshot.tokenRemaining, snapshot.tokenLimit)} (${formatNumber(snapshot.tokenRemaining)} / ${formatNumber(snapshot.tokenLimit)})${snapshot.tokenReset ? ` · איפוס ${snapshot.tokenReset}` : ''}`);
  }
  if (Number.isFinite(snapshot.requestLimit) || Number.isFinite(snapshot.requestRemaining)) {
    lines.push(`בקשות: ${formatRemaining(snapshot.requestRemaining, snapshot.requestLimit)} (${formatNumber(snapshot.requestRemaining)} / ${formatNumber(snapshot.requestLimit)})${snapshot.requestReset ? ` · איפוס ${snapshot.requestReset}` : ''}`);
  }
  const localDayTokens = Math.max(0, (Number(stats.dayInputTokens) || 0) + (Number(stats.dayOutputTokens) || 0) - (Number(stats.dayCachedTokens) || 0));
  lines.push(`התהליך היום: ${formatNumber(localDayTokens)} טוקנים, ${formatNumber(stats.dayCalls)} קריאות${stats.rateLimitResponses ? `, ${formatNumber(stats.rateLimitResponses)} חסימות` : ''}.`);
  const averageTokensPerCall = stats.dayCalls > 0 ? localDayTokens / stats.dayCalls : null;
  if (Number.isFinite(averageTokensPerCall) && averageTokensPerCall > 0 && Number.isFinite(snapshot.tokenRemaining)) {
    const byTokens = Math.floor(Math.max(0, snapshot.tokenRemaining) / averageTokensPerCall);
    const byRequests = Number.isFinite(snapshot.requestRemaining) ? Math.max(0, Math.floor(snapshot.requestRemaining)) : Infinity;
    const estimatedMessages = Math.min(byTokens, byRequests);
    lines.push(`הערכה עד לאיפוס ה־TPM: כ-${formatNumber(estimatedMessages)} הודעות ממוצעות (${formatNumber(Math.round(averageTokensPerCall))} טוקנים לקריאה).`);
  } else {
    lines.push('הערכת הודעות תופיע אחרי שתהיה לי לפחות קריאה אחת למדוד.');
  }
  return lines.join('\n');
}

function buildClarifyReply(action) {
  return action.question;
}

function getRecentVoiceReplies(chatId) {
  return recentVoiceRepliesByChat.get(String(chatId || '')) || [];
}

function rememberVoiceReply(chatId, reply) {
  const key = String(chatId || '');
  if (!key || !reply) return;
  recentVoiceRepliesByChat.set(key, [...getRecentVoiceReplies(key), String(reply).trim()].slice(-3));
}

function isRecommendationReasonRequest(messageText) {
  const text = String(messageText || '').trim();
  return /(?:למה\s+(?:בחרת|דווקא)|למה\s+זה|תגיד\s+למה|why\s+(?:did\s+you\s+choose|this|that)|why\s+choose)/iu.test(text);
}

function requiresBotFirstPerson(messageText) {
  return /(?:\b(?:bot|the\s+bot)\b|בוט)/iu.test(String(messageText || ''));
}

function hasMeaningfulSongQuery(query) {
  const sections = [query?.requirements || {}, query?.preferences || {}, query?.exclusions || {}];
  return sections.some((section) => Object.values(section).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== false && value !== ''
  ));
}

function buildRecommendationReason(song, query = null) {
  if (!song) return 'ההמלצה הגיעה מההתאמה למאגר, בלי סיבה מפורטת שנשמרה.';
  const metadata = song.ai_metadata || {};
  const facts = [];
  const genres = (Array.isArray(song.genres) ? song.genres : []).filter((genre) => genre && genre !== 'unknown');
  if (genres.length) facts.push(`הוא יושב באזור של ${genres.slice(0, 2).join(', ')}`);
  if (metadata.band_energy === 'high') facts.push('יש לו אנרגיה גבוהה');
  else if (metadata.band_energy === 'medium') facts.push('הוא נותן אנרגיה טובה בלי להפוך את החזרה לאולימפיאדה');
  if (metadata.crowd_friendly === true) facts.push('הוא גם ידידותי לקהל');
  if (song.difficulty === 'low') facts.push('הוא לא אמור לשבור אתכם טכנית');
  else if (song.difficulty === 'medium') facts.push('הוא מאתגר במידה סבירה');
  if (song.band_status?.fit === 'good') facts.push('הוא כבר סומן כמתאים להרכב שלכם');

  const identity = `${song.song_title}${song.artist ? ` - ${song.artist}` : ''}`;
  const intro = hasMeaningfulSongQuery(query)
    ? `בחרתי ב־${identity} כי הוא התאים לסינון שביקשתם`
    : `ביקשתם משהו שהחשק כבר מוכן לנגן, בלי פילטר טכני, אז הלכתי על ${identity}`;
  return facts.length ? `${intro}: ${facts.join(', ')}.` : `${intro}.`;
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

  // Imperative recommendation requests are not song titles. Keep this
  // distinction narrow: it prevents a genuine bare title/artist hint from
  // triggering a random catalog list, while allowing "recommend a song" to
  // use the safe local-catalog default.
  if (/(?:תביא|תן|תני|תמליץ|המלץ|find|give|show|play|עוד|שיר(?:ים)?|songs?|something|משהו|רשימה)/iu.test(compact)) {
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
  // A reply to a song may ask for any stored field, not only use the word
  // "information". The quoted-song resolution below still makes this
  // deterministic and prevents an unrelated catalog search.
  if (/(?:מידע|פרטים|תן מידע|תביא מידע|ספר לי על|מה אתה יודע על|מתי ניגנו|מתי ניגנתם|info|details)/iu.test(normalized)) {
    return true;
  }
  const asksQuestion = /(?:^|\s)(?:מה|כמה|האם|איך|what|how|is|are)(?:\s|$)|[?？]$/iu.test(normalized);
  const mentionsMetadata = /(?:רמת?\s*(?:ה)?קושי|כמה\s+קשה|קשה|קל|קושי|ז[׳']?אנר|סגנון|אווירה|feel|שפה|אורך|משך|ווקאל|ווקל|קול|זמר|טווח|אנרגיה|קהל|גרוב|גיטרה|בס|תופים|קלידים|פסנתר|סינת|אורגן|סטטוס|ניסיונות|חזרה|נוגן|difficulty|genre|language|duration|vocal|range|energy|crowd|groove|guitar|bass|drums|keys|piano|synth|organ|status|attempts|rehears)/iu.test(normalized);
  return asksQuestion && mentionsMetadata;
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
    .replace(/^(?:הבאתי|הנה|קבל|קיבלת|מצאתי|המלצות|הרשימה|הוספתי)\s*:\s*/iu, '')
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

function extractSongIdentityFromMetadataQuestion(messageText) {
  const source = String(messageText || '').trim();
  if (!isSongInfoRequest(source)) return null;

  // Handles natural Hebrew questions such as "האם השיר נגעה בשמיים של
  // משינה קשה?". This is intentionally evaluated locally: the database is
  // the authority for the answer, so a model should not need to guess the
  // identity before we can look it up.
  const candidate = source
    .replace(/[?？]+$/u, '')
    .replace(/^מה\s+רמת?\s*(?:ה)?קושי\s+של\s+/iu, '')
    .replace(/^האם\s+/iu, '')
    .replace(/^השיר\s+/iu, '')
    .replace(/\s+(?:קשה|קל|ברמת?\s*(?:ה)?קושי|מתאים\s+לזמר(?:ת)?|difficulty|genre|ז[׳']?אנר|שפה|משך|אורך)$/iu, '')
    .trim();
  return parseSongIdentityText(candidate);
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

  const metadataQuestionIdentity = extractSongIdentityFromMetadataQuestion(messageText);
  if (metadataQuestionIdentity) {
    return {
      action: 'get_song_info',
      song_title: metadataQuestionIdentity.song_title,
      artist: metadataQuestionIdentity.artist
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

  const candidate = normalizeAddSongSubject(explicitAdd[1]);
  if (!candidate || /^(?:למאגר|לרשימה|למאגר השירים)$/iu.test(candidate)) {
    return null;
  }

  return parseSongIdentityText(candidate);
}

function normalizeAddSongSubject(value) {
  return String(value || '')
    .trim()
    .replace(/^את\s+/iu, '')
    // "תוסיף למאגר <song>" and "תוסיף לרשימה <song>" are add commands;
    // the destination is not part of the song title.
    .replace(/^(?:למאגר(?:\s+השירים)?|לרשימה)\s+/iu, '')
    .trim();
}

function normalizeExplicitAddMessage(messageText) {
  const source = String(messageText || '').trim();
  const explicitAdd = source.match(/^(תוסיף|תוסיפי|להוסיף|הוסף|add)\s+(.+)$/iu);
  if (!explicitAdd) return source;

  const subject = normalizeAddSongSubject(explicitAdd[2]);
  return subject ? `תוסיף ${subject}` : source;
}

function isExplicitAddRequest(messageText) {
  const source = String(messageText || '').trim();
  return /^(?:תוסיף|תוסיפי|להוסיף|הוסף|add)(?:\s|$)/iu.test(source);
}

function isArtistReplyToAddClarification(messageText, quotedText = '') {
  const artist = String(messageText || '').trim();
  const quoted = String(quotedText || '').trim();
  if (!artist || artist.length > 120 || !quoted) return false;

  // This is deliberately narrow: it is the one add flow that does not repeat
  // the add verb, because the bot explicitly asked for the missing performer.
  return /(?:מי\s+המבצע\s+של|who\s+(?:is\s+the\s+)?(?:artist|performer)\s+(?:for|of))/iu.test(quoted);
}

function isAuthorizedAddAction(messageText, quotedText = '') {
  return isExplicitAddRequest(messageText) || isArtistReplyToAddClarification(messageText, quotedText);
}

function isMutationAction(action) {
  return ['add_song', 'update_song', 'remove_song', 'update_song_feedback'].includes(action?.action);
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

function buildAgentMessageText(messageText, recentMessages, quotedText = '', pendingClarification = null) {
  const source = String(messageText || '').trim();
  const pendingSubject = String(pendingClarification?.subject || '').trim();
  if (
    pendingClarification?.intent === 'add_song' &&
    pendingClarification?.missing === 'artist' &&
    pendingSubject
  ) {
    // Older recovery prompts could mistakenly ask for an artist even though
    // the original subject already contained "title - artist". Keep that
    // known identity authoritative; never turn a frustrated reply into an
    // artist name.
    const knownIdentity = parseSongIdentityText(pendingSubject);
    if (knownIdentity) {
      return `תוסיף ${knownIdentity.song_title} של ${knownIdentity.artist}`;
    }
  }
  if (
    pendingClarification?.intent === 'add_song' &&
    pendingClarification?.missing === 'artist' &&
    pendingSubject &&
    source &&
    !isExplicitAddRequest(source)
  ) {
    return `תוסיף ${pendingSubject} של ${source}`;
  }

  const directAddSong = inferDirectAddSongFromMessage(source);
  if (directAddSong) {
    return normalizeExplicitAddMessage(source);
  }

  const inferredAddSong = inferRecentAddSongPayload(source, recentMessages, quotedText);
  if (!inferredAddSong) {
    return normalizeExplicitAddMessage(source);
  }

  return `תוסיף ${inferredAddSong.song_title} של ${inferredAddSong.artist}`;
}

function isScheduleInquiry(messageText) {
  const text = normalizeText(messageText);
  const scheduleTerms = /(?:חזר(?:ה|ות)|rehearsal|אירוע(?:ים)?|event(?:s)?|לו["״']?ז|schedule|calendar|יומן|חודש|ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר|january|february|march|april|may|june|july|august|september|october|november|december|שבת|שישי|חמישי|רביעי|שלישי|שני|ראשון)/iu;
  const requestTerms = /(?:מתי|איזה|אילו|מה\s+יש|תביא|תראה|הראה|רשימה|כל\s+החזרות|הבא(?:ה)?|הקרוב(?:ה)?|next|upcoming|all|[?？])/iu;
  return scheduleTerms.test(text) && requestTerms.test(text);
}

const HEBREW_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'
];

function eventDateParts(event) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(event.start_at));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: values.hour, minute: values.minute };
}

function getScheduleReply(messageText, scheduledRehearsals, now = new Date()) {
  const events = (Array.isArray(scheduledRehearsals) ? scheduledRehearsals : [])
    .filter((event) => event && !event.cancelled && !Number.isNaN(new Date(event.start_at).getTime()))
    .sort((left, right) => new Date(left.start_at) - new Date(right.start_at));
  if (!events.length) return 'אין לי כרגע חזרות רשומות בלוח.';

  const text = normalizeText(messageText);
  const englishMonths = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const requestedMonth = [...HEBREW_MONTHS, ...englishMonths].findIndex((month) => text.includes(month));
  const futureEvents = events.filter((event) => new Date(event.start_at).getTime() >= now.getTime());
  let selected = futureEvents;
  let label = 'החזרות הקרובות';

  if (requestedMonth >= 0) {
    const month = (requestedMonth % 12) + 1;
    selected = events.filter((event) => eventDateParts(event).month === month && new Date(event.start_at).getTime() >= now.getTime());
    label = `חזרות ב${HEBREW_MONTHS[month - 1]}`;
  } else if (/(?:חודש\s+הקרוב|החודש|this\s+month|next\s+month)/iu.test(text)) {
    const current = eventDateParts({ start_at: now.toISOString() });
    const nextMonth = current.month === 12 ? 1 : current.month + 1;
    const nextYear = current.month === 12 ? current.year + 1 : current.year;
    selected = events.filter((event) => {
      const parts = eventDateParts(event);
      return (parts.year === current.year && parts.month === current.month) || (parts.year === nextYear && parts.month === nextMonth);
    }).filter((event) => new Date(event.start_at).getTime() >= now.getTime());
    label = 'חזרות בחודש הקרוב';
  } else if (/(?:החזרה\s+הבא(?:ה)?|מתי\s+החזרה|next\s+rehearsal)/iu.test(text)) {
    const event = futureEvents[0];
    if (!event) return 'אין לי כרגע חזרה עתידית רשומה.';
    const parts = eventDateParts(event);
    return `החזרה הבאה: ${event.title} — ${String(parts.day).padStart(2, '0')}.${String(parts.month).padStart(2, '0')}.${parts.year} ב־${parts.hour}:${parts.minute}${event.details ? `, ${event.details}` : ''}.`;
  }

  if (!selected.length) return `אין חזרות רשומות ב${label.replace(/^חזרות ב/, '')}.`;
  return `${label}:\n${selected.map((event) => {
    const parts = eventDateParts(event);
    return `- ${String(parts.day).padStart(2, '0')}.${String(parts.month).padStart(2, '0')}.${parts.year}, ${parts.hour}:${parts.minute} — ${event.title}${event.details ? `, ${event.details}` : ''}`;
  }).join('\n')}`;
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
    `שפה: ${song.language || 'לא ידוע'}`,
    `ז'אנרים: ${Array.isArray(song.genres) && song.genres.length > 0 ? song.genres.join(', ') : 'לא ידוע'}`,
    `רמת קושי: ${song.difficulty || 'לא ידוע'}`,
    `אווירה: ${song.feel || 'לא ידוע'}`,
    `אורך: ${song.duration_seconds ? `${song.duration_seconds} שניות` : 'לא ידוע'}`,
    `ווקאל מקורי: ${song?.ai_metadata?.original_vocal || 'לא ידוע'}`,
    `טווח ווקאלי: ${song?.ai_metadata?.vocal_range || 'לא ידוע'}`,
    `סגנון ווקאלי: ${Array.isArray(song?.ai_metadata?.vocal_style) && song.ai_metadata.vocal_style.length > 0 ? song.ai_metadata.vocal_style.join(', ') : 'לא ידוע'}`,
    `התאמה לזמר: ${song?.ai_metadata?.singer_fit || 'לא ידוע'}`,
    `אנרגיה ווקאלית: ${song?.ai_metadata?.vocal_energy || 'לא ידוע'}`,
    `אנרגיית להקה: ${song?.ai_metadata?.band_energy || 'לא ידוע'}`,
    `ידידותי לקהל: ${song?.ai_metadata?.crowd_friendly === true ? 'כן' : song?.ai_metadata?.crowd_friendly === false ? 'לא' : 'לא ידוע'}`,
    `גרוב: ${song?.ai_metadata?.groove_level || 'לא ידוע'}`,
    `קושי גיטרה: ${song?.ai_metadata?.guitar_difficulty || 'לא ידוע'}`,
    `קושי בס: ${song?.ai_metadata?.bass_difficulty || 'לא ידוע'}`,
    `קושי תופים: ${song?.ai_metadata?.drums_difficulty || 'לא ידוע'}`,
    `\u05de\u05e6\u05d1: ${FIT_LABELS[song.band_status.fit] || song.band_status.fit}`,
    `קלידים: ${keysType}`,
    `תפקיד קלידים: ${song?.ai_metadata?.keys_role || 'לא ידוע'}`,
    `קושי קלידים: ${song?.ai_metadata?.keys_difficulty || 'לא ידוע'}`,
    `עניין לבס: ${song?.ai_metadata?.bass_interest || 'לא ידוע'}`,
    `\u05d1\u05e2\u05d9\u05d5\u05ea: ${issues}`,
    `\u05e0\u05d9\u05e1\u05d9\u05d5\u05e0\u05d5\u05ea: ${attempts}`,
    `\u05e0\u05e1\u05e7\u05e8 \u05dc\u05d0\u05d7\u05e8\u05d5\u05e0\u05d4: ${reviewed}`,
    `\u05d7\u05d6\u05e8\u05d4 \u05dc\u05d0\u05d7\u05e8\u05d5\u05e0\u05d4: ${rehearsed}`,
    `\u05e0\u05d5\u05d2\u05df \u05dc\u05d0\u05d7\u05e8\u05d5\u05e0\u05d4: ${played}`,
    notes ? `\u05d4\u05e2\u05e8\u05d5\u05ea: ${notes}` : null
  ].filter(Boolean).join('\n');
}

function formatRequestedSongInfo(song, messageText) {
  const text = String(messageText || '').trim();
  // Full metadata is intentionally opt-in. A normal question about one field
  // should be answer-sized, not a dump of every stored property.
  if (/(?:מידע|פרטים|כל הנתונים|כל המידע|full\s+(?:info|metadata)|all\s+(?:info|metadata)|details)/iu.test(text)) {
    return formatSongInfo(song);
  }

  const metadata = song?.ai_metadata || {};
  const fields = [
    [/קושי\s*(?:גיטרה|לגיטרה)|גיטרה.*(?:קשה|קל)/iu, 'קושי גיטרה', metadata.guitar_difficulty],
    [/קושי\s*(?:בס)|בס.*(?:קשה|קל)/iu, 'קושי בס', metadata.bass_difficulty],
    [/קושי\s*(?:תופים)|תופים.*(?:קשה|קל)/iu, 'קושי תופים', metadata.drums_difficulty],
    [/קושי\s*(?:קלידים|פסנתר|סינת|אורגן)|(?:קלידים|פסנתר|סינת|אורגן).*(?:קשה|קל)/iu, 'קושי קלידים', metadata.keys_difficulty],
    [/(?:רמת?\s*(?:ה)?קושי|כמה\s+קשה|קשה|קל|difficulty)/iu, 'רמת קושי', song.difficulty],
    [/(?:ז[׳']?אנר|סגנון|genre)/iu, "ז'אנרים", Array.isArray(song.genres) ? song.genres.join(', ') : null],
    [/(?:שפה|language)/iu, 'שפה', song.language],
    [/(?:אווירה|feel)/iu, 'אווירה', song.feel],
    [/(?:אורך|משך|duration)/iu, 'אורך', song.duration_seconds ? `${song.duration_seconds} שניות` : null],
    [/(?:טווח\s*(?:ווקאלי|קול)|vocal\s*range)/iu, 'טווח ווקאלי', metadata.vocal_range],
    [/(?:קהל|crowd)/iu, 'ידידותי לקהל', metadata.crowd_friendly === true ? 'כן' : metadata.crowd_friendly === false ? 'לא' : null]
  ];
  const match = fields.find(([pattern]) => pattern.test(text));
  if (!match) return null;
  const [, label, value] = match;
  return value ? `${label}: ${value}` : null;
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
  const aiMetadata = song.ai_metadata && typeof song.ai_metadata === 'object'
    ? { ...song.ai_metadata }
    : {};

  // Older prompts (and occasional model replies) place the keyboard fields on
  // the song itself. The canonical state stores them under ai_metadata, so do
  // not silently discard useful metadata during insertion.
  if (aiMetadata.keys_role === undefined && song.keys_role !== undefined) {
    aiMetadata.keys_role = song.keys_role;
  }
  if (aiMetadata.keys_type === undefined) {
    if (Array.isArray(song.keys_type_any)) aiMetadata.keys_type = song.keys_type_any;
    else if (Array.isArray(song.keys_type)) aiMetadata.keys_type = song.keys_type;
  }
  if (aiMetadata.keys_difficulty === undefined && song.keys_difficulty !== undefined) {
    aiMetadata.keys_difficulty = song.keys_difficulty;
  }
  const hasDemandingInstrumentPart = [
    aiMetadata.guitar_difficulty,
    aiMetadata.bass_difficulty,
    aiMetadata.drums_difficulty,
    aiMetadata.keys_difficulty
  ].some((value) => String(value || '').trim().toLowerCase() === 'high');
  const requestedDifficulty = song.difficulty ? String(song.difficulty).trim().toLowerCase() : null;
  // Overall difficulty must not contradict a demanding part returned by the
  // agent. This preserves the agent's instrumental assessment for every song.
  const difficulty = hasDemandingInstrumentPart ? 'high' : requestedDifficulty;

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
    difficulty,
    feel: song.feel ? String(song.feel).trim().toLowerCase() : null,
    duration_seconds: Number.isInteger(Number.parseInt(song.duration_seconds, 10)) && Number.parseInt(song.duration_seconds, 10) > 0
      ? Number.parseInt(song.duration_seconds, 10)
      : null,
    used: Boolean(song.used),
    created_at: song.created_at || new Date().toISOString(),
    normalized_title: normalizeText(songTitle),
    normalized_artist: normalizeText(artist),
    ai_metadata: Object.keys(aiMetadata).length > 0 ? aiMetadata : undefined,
    band_status: song.band_status && typeof song.band_status === 'object' ? song.band_status : undefined
  };
}

async function insertSongAndReply({ stateStore, chat, song }) {
  const inserted = stateStore.addSong(song);
  if (!inserted) {
    await sendBotMessage(chat, '\u05d4\u05e9\u05d9\u05e8 \u05db\u05d1\u05e8 \u05e7\u05d9\u05d9\u05dd.');
    return false;
  }

  await stateStore.queueSave();
  await sendBotMessage(chat, `\u05d4\u05d5\u05e1\u05e4\u05ea\u05d9: ${formatBoldSongIdentity(song)}`);
  return true;
}

function feedbackConfirmationLabel(song, messageText) {
  const request = String(messageText || '').trim();
  const issues = Array.isArray(song?.band_status?.issues) ? song.band_status.issues : [];

  // Prefer the user's own feedback vocabulary over the internal fit category.
  if (issues.includes('too_hard') || /(?:קשה|קשוח|מאתגר|מסובך|hard|challenging)/iu.test(request)) {
    return 'קשה';
  }
  if (issues.includes('too_easy') || /(?:קל מדי|קל|easy)/iu.test(request)) {
    return 'קל מדי';
  }
  if (/(?:לא עבד|לא עובד|didn['’]?t work|doesn['’]?t work)/iu.test(request)) {
    return 'לא עבד';
  }
  if (/(?:לא מתאים|לא מתאימה|לא לנו|not suitable|doesn['’]?t fit)/iu.test(request)) {
    return 'לא מתאים';
  }
  if (issues.includes('doesnt_groove') || /(?:לא גרובי|לא יושב|לא זורם)/iu.test(request)) {
    return 'לא זורם';
  }

  return FIT_LABELS[song?.band_status?.fit] || song?.band_status?.fit;
}

function buildFeedbackConfirmation(updatedSongs, messageText) {
  if (updatedSongs.length === 0) {
    return '\u05dc\u05d0 \u05de\u05e6\u05d0\u05ea\u05d9 \u05de\u05d4 \u05dc\u05e2\u05d3\u05db\u05df.';
  }

  if (updatedSongs.length === 1) {
    const song = updatedSongs[0];
    return `\u05e2\u05d3\u05db\u05e0\u05ea\u05d9: ${song.song_title} - ${feedbackConfirmationLabel(song, messageText)}`;
  }

  return [
    '\u05e2\u05d3\u05db\u05e0\u05ea\u05d9:',
    ...updatedSongs.map((song) => `- ${song.song_title} - ${feedbackConfirmationLabel(song, messageText)}`)
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
      return `- ${formatBoldSongIdentity(song)}: ${issues}`;
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
    .map((line) => (line && !line.startsWith('\u200F') ? `\u200F${line}` : line))
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
      `${songIndex}. ${formatBoldSongIdentity(item.song)}${
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

async function sendSongsReply({ chat, stateStore, chatId, songs, query = null, includeRecommendationReason = false }) {
  if (!songs.length) {
    await sendBotMessage(chat, '\u05dc\u05d0 \u05de\u05e6\u05d0\u05ea\u05d9 \u05e9\u05d9\u05e8\u05d9\u05dd \u05de\u05ea\u05d0\u05d9\u05de\u05d9\u05dd.');
    return;
  }

  const reply = includeRecommendationReason
    ? `${formatSongsReply(songs)}\nלמה: ${buildRecommendationReason(songs[0], query)}`
    : formatSongsReply(songs);
  const sentMessage = await sendBotMessage(chat, reply);
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

async function executeAgentAction({ action, stateStore, chat, record, messageText, replyContext, config = {}, estimateSongDurationsFn, pendingAdditions, pendingClarifications, reviewSongDifficultyFn, unknownSongInfoFn, polishBanterReplyFn, recommendExternalSongsFn, discoverExternalSongsFn = discoverCatalogSongs, composeUnsupportedReplyFn }) {
  const activeContext = resolveActiveResultContext(stateStore, record);
  const songs = stateStore.getSongs();
  const chatId = String(record?.chatId || '').trim();

  if (action.action === 'respond') {
    let reply = action.reply;
    if (typeof polishBanterReplyFn === 'function') {
      try {
        reply = await polishBanterReplyFn({
          baseUrl: config.llmBaseUrl,
          apiKey: config.llmApiKey,
          model: config.llmModel,
          messageText,
          draftReply: reply,
          recentReplies: getRecentVoiceReplies(chatId),
          selfReferenceRequired: requiresBotFirstPerson(messageText)
        }) || reply;
      } catch (error) {
        console.warn(`[agent] respond_polish_failed: ${error.message}`);
      }
    }
    rememberVoiceReply(chatId, reply);
    await sendBotMessage(chat, reply);
    return;
  }

  if (action.action === 'unsupported') {
    let reply = null;
    if (typeof composeUnsupportedReplyFn === 'function') {
      try {
        reply = await composeUnsupportedReplyFn({
          baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey, model: config.llmModel,
          messageText, requestedCapability: action.requested_capability, recentReplies: getRecentVoiceReplies(chatId)
        });
      } catch (error) {
        console.warn(`[agent] unsupported_reply_failed: ${error.message}`);
      }
    }
    reply = reply || 'היכולת הזו עדיין עושה פרצופים בחדר החזרות.';
    rememberVoiceReply(chatId, reply);
    await sendBotMessage(chat, reply);
    return;
  }

  if (action.action === 'clarify') {
    if (pendingClarifications instanceof Map && chatId) {
      if (action.clarification) {
        pendingClarifications.set(chatId, { ...action.clarification, createdAt: Date.now() });
      } else {
        pendingClarifications.delete(chatId);
      }
    }
    let reply = buildClarifyReply(action, { messageText, replyContext });
    // A no-context clarify is the agent's banter channel. Let a dedicated
    // language agent polish it, while factual clarifications remain untouched.
    if (!action.clarification && typeof polishBanterReplyFn === 'function') {
      try {
        const polished = await polishBanterReplyFn({
          baseUrl: config.llmBaseUrl,
          apiKey: config.llmApiKey,
          model: config.llmModel,
          messageText,
          draftReply: reply
        });
        if (polished) reply = polished;
      } catch (error) {
        console.warn(`[agent] banter_polish_failed: ${error.message}`);
      }
    }
    await sendBotMessage(chat, reply);
    return;
  }

  if (pendingClarifications instanceof Map && chatId) {
    pendingClarifications.delete(chatId);
  }

  if (action.action === 'recommend_external_song') {
    if (typeof recommendExternalSongsFn !== 'function') {
      await sendBotMessage(chat, 'אין לי כרגע דרך למצוא המלצה מחוץ למאגר.');
      return;
    }
    const excludedCandidates = typeof stateStore.getRecentExternalRecommendations === 'function'
      ? stateStore.getRecentExternalRecommendations(chatId)
      : [];
    const requestedLimit = Math.min(Math.max(Number.parseInt(action.query?.limit, 10) || 1, 1), 10);
    const accepted = [];
    const acceptedArtists = new Set();
    const consideredCandidates = new Set(excludedCandidates);
    const requestedLanguage = String(action.query?.requirements?.language || '').toLowerCase();
    const requestedHebrew = requestedLanguage === 'he';
    const requestedEnglish = requestedLanguage === 'en';
    const releaseYearFrom = Number.parseInt(action.query?.requirements?.release_year_from, 10);
    const releaseYearTo = Number.parseInt(action.query?.requirements?.release_year_to, 10);
    const discoveredCandidates = config.catalogSearchEnabled === false
      ? null
      : await discoverExternalSongsFn({
        language: requestedLanguage,
        genres: action.query?.requirements?.genres,
        releaseYearFrom,
        releaseYearTo,
        limit: 50
      });
    const sourceCandidates = Array.isArray(discoveredCandidates)
      ? discoveredCandidates.filter((candidate) => {
        const identity = `${candidate?.song_title || ''} ${candidate?.artist || ''}`;
        const hasHebrewIdentity = /[\u0590-\u05ff]/u.test(identity);
        const hasLatinIdentity = /[A-Za-z]/u.test(identity);
        const candidateKey = `${candidate?.song_title || ''} - ${candidate?.artist || ''}`;
        const releaseYear = Number.parseInt(String(candidate?.release_date || '').slice(0, 4), 10);
        const alreadyInCatalog = candidate?.song_title && candidate?.artist && (typeof stateStore.findSongsByNormalizedName === 'function'
          ? stateStore.findSongsByNormalizedName(candidate.song_title, candidate.artist).length > 0
          : songs.some((song) => normalizeText(song.song_title) === normalizeText(candidate.song_title) && normalizeText(song.artist) === normalizeText(candidate.artist)));
        return candidate?.song_title && candidate?.artist &&
          !excludedCandidates.includes(candidateKey) &&
          !alreadyInCatalog &&
          // The Israeli iTunes storefront also contains international music.
          // A Hebrew/Israeli request therefore needs an actual Hebrew catalog
          // identity, rather than merely a result returned by an Israeli-store
          // search term.
          !(requestedHebrew && !hasHebrewIdentity) &&
          !(requestedEnglish && hasHebrewIdentity) &&
          (candidate.catalog_source === 'itunes' || (!Number.isInteger(releaseYearFrom) && !Number.isInteger(releaseYearTo)) ||
            (Number.isInteger(releaseYear) &&
              (!Number.isInteger(releaseYearFrom) || releaseYear >= releaseYearFrom) &&
              (!Number.isInteger(releaseYearTo) || releaseYear <= releaseYearTo)));
      })
      : null;
    console.log(`[catalog] eligible_candidates raw=${Array.isArray(discoveredCandidates) ? discoveredCandidates.length : 0} eligible=${sourceCandidates?.length ?? 0} language=${JSON.stringify(requestedLanguage || null)}`);
    if (sourceCandidates && sourceCandidates.length === 0) {
      await sendBotMessage(chat, 'לא מצאתי כרגע שירים מאומתים שמתאימים לבקשה מחוץ למאגר.');
      return;
    }
    const sourceCandidateByIdentity = new Map((sourceCandidates || []).map((candidate) => [
      `${normalizeText(candidate.song_title)}::${normalizeText(candidate.artist)}`,
      candidate
    ]));
    const collectRecommendations = async (recommendations) => {
      for (const recommendation of Array.isArray(recommendations) ? recommendations : []) {
      if (!recommendation?.song_title || !recommendation?.artist) continue;
      if (/^unknown$/i.test(String(recommendation.song_title).trim()) || /^unknown$/i.test(String(recommendation.artist).trim())) {
        console.warn('[external_recommendation] rejected_unknown_identity');
        continue;
      }
      const candidate = `${recommendation.song_title} - ${recommendation.artist}`;
      if (consideredCandidates.has(candidate)) continue;
      consideredCandidates.add(candidate);
      const identity = `${recommendation.song_title} ${recommendation.artist}`;
      const hasHebrewIdentity = /[\u0590-\u05ff]/u.test(identity);
      const hasLatinIdentity = /[A-Za-z]/u.test(identity);
      const sourceCandidate = sourceCandidateByIdentity.get(`${normalizeText(recommendation.song_title)}::${normalizeText(recommendation.artist)}`);
      const usesCatalogHebrewIdentity = requestedHebrew && sourceCandidate?.catalog_source === 'itunes';
      if ((requestedEnglish && hasHebrewIdentity) || (!usesCatalogHebrewIdentity && requestedHebrew && !hasHebrewIdentity) || (!usesCatalogHebrewIdentity && hasHebrewIdentity && hasLatinIdentity)) {
        console.warn(`[external_recommendation] rejected_noncanonical_identity title=${JSON.stringify(recommendation.song_title)} artist=${JSON.stringify(recommendation.artist)}`);
        continue;
      }
      if (recommendation.difficulty === 'high') {
        console.warn(`[external_recommendation] rejected_high_difficulty title=${JSON.stringify(recommendation.song_title)} artist=${JSON.stringify(recommendation.artist)}`);
        continue;
      }
      if (sourceCandidates && !sourceCandidate) {
        console.warn(`[external_recommendation] rejected_not_from_catalog title=${JSON.stringify(recommendation.song_title)} artist=${JSON.stringify(recommendation.artist)}`);
        continue;
      }
      const verified = sourceCandidate || { song_title: recommendation.song_title, artist: recommendation.artist };
      if (!verified?.song_title || !verified?.artist) {
        console.warn(`[external_recommendation] rejected_unverified title=${JSON.stringify(recommendation.song_title)} artist=${JSON.stringify(recommendation.artist)}`);
        continue;
      }
      const artistKey = normalizeText(verified.artist);
      if (sourceCandidates && acceptedArtists.has(artistKey)) {
        console.warn(`[external_recommendation] rejected_duplicate_artist artist=${JSON.stringify(verified.artist)}`);
        continue;
      }
      const releaseYear = Number.parseInt(String(verified.release_date || '').slice(0, 4), 10);
      if (
        // With catalog discovery disabled, the model has no authoritative
        // release-date field to attach to its recommendation. The requested
        // era is still in its prompt, but rejecting an absent date here would
        // make every era request fail closed.
        sourceCandidates &&
        verified.catalog_source !== 'itunes' &&
        (Number.isInteger(releaseYearFrom) || Number.isInteger(releaseYearTo)) &&
        (!Number.isInteger(releaseYear) ||
          (Number.isInteger(releaseYearFrom) && releaseYear < releaseYearFrom) ||
          (Number.isInteger(releaseYearTo) && releaseYear > releaseYearTo))
      ) {
        console.warn(`[external_recommendation] rejected_release_year title=${JSON.stringify(verified.song_title)} artist=${JSON.stringify(verified.artist)} release_year=${JSON.stringify(verified.release_date || null)}`);
        continue;
      }
      const existing = typeof stateStore.findSongsByNormalizedName === 'function'
        ? stateStore.findSongsByNormalizedName(verified.song_title, verified.artist)
        : songs.filter((song) => normalizeText(song.song_title) === normalizeText(verified.song_title) && normalizeText(song.artist) === normalizeText(verified.artist));
      if (!existing.length) {
        console.log(`[external_recommendation] title=${JSON.stringify(verified.song_title)} artist=${JSON.stringify(verified.artist)}`);
        accepted.push({
          ...recommendation,
          song_title: verified.song_title,
          artist: verified.artist,
          song_id: `external:${normalizeText(verified.song_title)}:${normalizeText(verified.artist)}`,
          is_recommendation: true
        });
        acceptedArtists.add(artistKey);
        if (accepted.length >= requestedLimit) return;
      }
    }
    };
    const requestRecommendations = async (limit) => recommendExternalSongsFn({
      baseUrl: config.llmBaseUrl,
      apiKey: config.llmApiKey,
      model: config.llmModel,
      messageText,
      query: action.query || {},
      excludedCandidates: Array.from(consideredCandidates),
      catalogCandidates: sourceCandidates || [],
      limit
    });
    await collectRecommendations(await requestRecommendations(requestedLimit));
    if (accepted.length < requestedLimit) {
      console.warn(`[external_recommendation] retrying_for_missing=${requestedLimit - accepted.length}`);
      await collectRecommendations(await requestRecommendations(requestedLimit - accepted.length));
    }
    if (accepted.length) {
      const reply = accepted.length === 1
        ? `מצאתי מחוץ למאגר: ${formatBoldSongIdentity(accepted[0])}\nלמה: ${accepted[0].reason}`
        : `מצאתי מחוץ למאגר:\n${accepted.map((song, index) => `${index + 1}. ${formatBoldSongIdentity(song)}\nלמה: ${song.reason}`).join('\n\n')}`;
      const sentMessage = await sendBotMessage(chat, reply);
      // Store external results too, so a reply such as "another one" keeps
      // the original artist/era/style constraints rather than becoming a new
      // generic request.
      if (typeof stateStore.setLastResults === 'function') {
        try {
          persistResultContext(stateStore, {
            chatId,
            botMessageId: extractBotMessageId(sentMessage),
            songs: accepted,
            query: action.query || {},
            createdAt: new Date().toISOString()
          });
        } catch (error) {
          // The recommendation is already delivered; context is optional and
          // must never trigger a second, misleading failure reply.
          console.error('[external_recommendation] result_context_failed:', error);
        }
      }
      if (typeof stateStore.recordExternalRecommendation === 'function') {
        for (const recommendation of accepted) {
          stateStore.recordExternalRecommendation(chatId, `${recommendation.song_title} - ${recommendation.artist}`);
        }
        await stateStore.queueSave();
      }
      return;
    }
    await sendBotMessage(chat, 'לא מצאתי כרגע המלצה בטוחה מחוץ למאגר.');
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
      query: sanitizeQueryForResultContext(action.query || {}, matches.length),
      includeRecommendationReason: isRecommendationReasonRequest(messageText)
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
    if (typeof reviewSongDifficultyFn === 'function') {
      try {
        const reviewedDifficulty = await reviewSongDifficultyFn({
          baseUrl: config.llmBaseUrl,
          apiKey: config.llmApiKey,
          model: config.llmModel,
          song: songToInsert
        });
        if (reviewedDifficulty) {
          songToInsert.difficulty = reviewedDifficulty;
          console.log(`[agent] difficulty_review=${reviewedDifficulty} title=${JSON.stringify(songToInsert.song_title)} artist=${JSON.stringify(songToInsert.artist)}`);
        }
      } catch (error) {
        // Keep the original agent assessment when a review is unavailable.
        console.warn(`[agent] difficulty_review_failed: ${error.message}`);
      }
    }
    const chatId = String(record?.chatId || '').trim();
    if (songToInsert.difficulty === 'high' && pendingAdditions instanceof Map && chatId) {
      pendingAdditions.set(chatId, { song: songToInsert, createdAt: Date.now() });
      await sendBotMessage(chat, `\u05d4\u05e9\u05d9\u05e8 ${formatBoldSongIdentity(songToInsert)} \u05d1\u05e8\u05de\u05ea \u05e7\u05d5\u05e9\u05d9 \u05d2\u05d1\u05d5\u05d4\u05d4 \u2014 \u05d0\u05ea\u05d4 \u05d1\u05d8\u05d5\u05d7 \u05e9\u05dc\u05d4\u05d5\u05e1\u05d9\u05e3 \u05d0\u05d5\u05ea\u05d5?`);
      return;
    }
    await insertSongAndReply({ stateStore, chat, song: songToInsert });
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
    await sendBotMessage(chat, buildFeedbackConfirmation(updatedSongs, messageText));
    return;
  }

  if (action.action === 'get_song_info') {
    const { song, reason } = resolveSongFromAction(stateStore, action, activeContext);
    if (!song) {
      console.log(`[song_info] catalog_lookup=${reason} title=${JSON.stringify(action.song_title || null)} artist=${JSON.stringify(action.artist || null)} knowledge_handler=${typeof unknownSongInfoFn === 'function'}`);
      if (reason === 'missing' && typeof unknownSongInfoFn === 'function' && action.song_title) {
        try {
          const answer = await unknownSongInfoFn({
            baseUrl: config.llmBaseUrl,
            apiKey: config.llmApiKey,
            model: config.llmModel,
            songTitle: action.song_title,
            artist: action.artist,
            question: messageText
          });
          if (answer) {
            console.log(`[song_info] source=agent_knowledge catalog=missing title=${JSON.stringify(action.song_title)} artist=${JSON.stringify(action.artist || null)}`);
            await sendBotMessage(chat, `השיר לא קיים במאגר שלנו, אבל לפי מה שאני יודע: ${answer}`);
            return;
          }
          console.warn(`[song_info] agent_knowledge_empty catalog=missing title=${JSON.stringify(action.song_title)} artist=${JSON.stringify(action.artist || null)}`);
        } catch (error) {
          console.warn(`[agent] unknown_song_info_failed: ${error.message}`);
        }
      }
      // We already have an unambiguous song identity. Do not claim otherwise
      // merely because the catalog and the optional knowledge lookup lack it.
      if (reason === 'missing' && action.song_title) {
        await sendBotMessage(chat, 'השיר לא קיים במאגר שלנו, ואין לי כרגע מידע אמין יותר עליו.');
        return;
      }
      await sendBotMessage(chat,
        reason === 'ambiguous'
          ? '\u05d9\u05e9 \u05db\u05de\u05d4 \u05e9\u05d9\u05e8\u05d9\u05dd \u05de\u05ea\u05d0\u05d9\u05de\u05d9\u05dd. \u05ea\u05db\u05d5\u05d5\u05df \u05d1\u05e9\u05dd \u05d4\u05d0\u05d5\u05de\u05df \u05d0\u05d5 \u05d1\u05de\u05e1\u05e4\u05e8 \u05de\u05d4\u05e8\u05e9\u05d9\u05de\u05d4.'
          : '\u05dc\u05d0 \u05de\u05e6\u05d0\u05ea\u05d9 \u05d0\u05d9\u05d6\u05d4 \u05e9\u05d9\u05e8 \u05d4\u05ea\u05db\u05d5\u05d5\u05e0\u05ea.'
      );
      return;
    }

    const localAnswer = formatRequestedSongInfo(song, messageText);
    if (localAnswer) {
      console.log(`[song_info] source=catalog title=${JSON.stringify(song.song_title)} artist=${JSON.stringify(song.artist || null)}`);
      await sendBotMessage(chat, localAnswer);
      return;
    }
    if (typeof unknownSongInfoFn === 'function') {
      try {
        const answer = await unknownSongInfoFn({
          baseUrl: config.llmBaseUrl,
          apiKey: config.llmApiKey,
          model: config.llmModel,
          songTitle: song.song_title,
          artist: song.artist,
          question: messageText,
          catalogSong: song
        });
        if (answer) {
          console.log(`[song_info] source=agent_knowledge catalog=partial title=${JSON.stringify(song.song_title)} artist=${JSON.stringify(song.artist || null)}`);
          await sendBotMessage(chat, `במאגר אין לי נתון מדויק לזה, אבל לפי מה שאני יודע: ${answer}`);
          return;
        }
      } catch (error) {
        console.warn(`[agent] known_song_info_gap_failed: ${error.message}`);
      }
    }
    await sendBotMessage(chat, `על ${formatBoldSongIdentity(song)} אין לי מידע מדויק על זה במאגר.`);
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
    await sendBotMessage(chat, `\u05d4\u05e1\u05e8\u05ea\u05d9: ${formatBoldSongIdentity(song)}`);
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
    await sendBotMessage(chat, `\u05e2\u05d3\u05db\u05e0\u05ea\u05d9: ${formatBoldSongIdentity(updated)}`);
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
  pendingAdditions,
  pendingClarifications,
  interpretMessageFn = interpretMessageWithTools,
  interpretAdditionConfirmationFn = interpretAdditionConfirmation,
  reviewSongDifficultyFn,
  reviewActionExecutionFn,
  unknownSongInfoFn = interpretUnknownSongInfo,
  resolveSongReferenceFn,
  plainFallbackReplyFn = interpretPlainFallbackReply,
  polishBanterReplyFn,
  recommendExternalSongsFn = recommendExternalSongs,
  composeUnsupportedReplyFn = composeUnsupportedReply,
  prepareSongsForReplyFn = prepareSongsForReply,
  estimateSongDurationsFn,
  scheduledRehearsals = []
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

  if (isScheduleInquiry(messageText)) {
    await sendBotMessage(chat, getScheduleReply(messageText, scheduledRehearsals));
    return true;
  }

  const pendingChatId = String(record?.chatId || '').trim();
  let pendingClarification = pendingClarifications instanceof Map ? pendingClarifications.get(pendingChatId) : null;
  if (pendingClarification && Date.now() - Number(pendingClarification.createdAt || 0) > PENDING_CLARIFICATION_TTL_MS) {
    pendingClarifications.delete(pendingChatId);
    pendingClarification = null;
  }
  const pendingAddition = pendingAdditions instanceof Map ? pendingAdditions.get(pendingChatId) : null;
  if (pendingAddition) {
    if (Date.now() - Number(pendingAddition.createdAt || 0) > HIGH_DIFFICULTY_ADD_CONFIRMATION_TTL_MS) {
      pendingAdditions.delete(pendingChatId);
    } else {
      const confirmation = await interpretAdditionConfirmationFn({
        baseUrl: config.llmBaseUrl,
        apiKey: config.llmApiKey,
        model: config.llmModel,
        messageText,
        pendingSong: pendingAddition.song
      });
      if (confirmation === 'positive') {
        pendingAdditions.delete(pendingChatId);
        await insertSongAndReply({ stateStore, chat, song: pendingAddition.song });
        return true;
      }
      if (confirmation === 'negative') {
        pendingAdditions.delete(pendingChatId);
        await sendBotMessage(chat, '\u05e1\u05d1\u05d1\u05d4, \u05dc\u05d0 \u05d4\u05d5\u05e1\u05e4\u05ea\u05d9.');
        return true;
      }
      // A new, unrelated request is an implicit decision not to add the old
      // song. Drop it silently and continue through the normal agent flow.
      pendingAdditions.delete(pendingChatId);
    }
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

  // Explanations of a recommendation are grounded in the stored result and
  // query, so they should not be turned into a new search or a clarification.
  if (replyContext?.results?.length && isRecommendationReasonRequest(messageText)) {
    const selected = replyContext.results[0];
    const song = selected?.song_id ? stateStore.getSongById(selected.song_id) : null;
    if (song) {
      await sendBotMessage(chat, buildRecommendationReason(song, replyContext.query));
      return true;
    }
  }

  const quotedText = record?.quoted?.text || record?.quotedText || '';
  // A factual clarification may receive the missing title/artist as a reply.
  // Resolve it deterministically before asking the agent again.
  if (pendingClarification?.intent === 'song_metadata') {
    const pendingIdentity = parseSongIdentityText(messageText);
    if (pendingIdentity) {
      await executeAgentAction({
        action: { action: 'get_song_info', song_title: pendingIdentity.song_title, artist: pendingIdentity.artist },
        stateStore, chat, config, record, messageText, replyContext,
        estimateSongDurationsFn, pendingAdditions, pendingClarifications, reviewSongDifficultyFn, unknownSongInfoFn
      });
      return true;
    }
  }
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
      estimateSongDurationsFn,
      pendingAdditions,
      pendingClarifications,
      reviewSongDifficultyFn,
      unknownSongInfoFn,
      polishBanterReplyFn,
      recommendExternalSongsFn,
      composeUnsupportedReplyFn
    });
    return true;
  }

  // External recommendations have a fully deterministic local parser for
  // language, era, genre, and result count. Route them straight to the
  // specialist recommendation call instead of spending a separate model turn
  // merely to classify the request.
  if (isExternalCatalogRecommendationRequest(messageText)) {
    const action = buildExternalRecommendationAction(messageText);
    console.log(`[agent] action=${action.action} local_route=true`);
    await executeAgentAction({
      action,
      stateStore,
      chat,
      config,
      record,
      messageText,
      replyContext,
      estimateSongDurationsFn,
      pendingAdditions,
      pendingClarifications,
      reviewSongDifficultyFn,
      unknownSongInfoFn,
      recommendExternalSongsFn,
      composeUnsupportedReplyFn
    });
    return true;
  }

  // When local parsing cannot confidently split a song reference, use the
  // agent only as an identity resolver. The result still goes through the
  // local catalog resolver and cannot mutate state.
  if (isSongInfoRequest(messageText) && typeof resolveSongReferenceFn === 'function') {
    try {
      const resolvedReference = await resolveSongReferenceFn({
        baseUrl: config.llmBaseUrl,
        apiKey: config.llmApiKey,
        model: config.llmModel,
        messageText,
        quotedText
      });
      if (resolvedReference?.song_title) {
        await executeAgentAction({
          action: { action: 'get_song_info', song_title: resolvedReference.song_title, artist: resolvedReference.artist },
          stateStore, chat, config, record, messageText, replyContext,
          estimateSongDurationsFn, pendingAdditions, pendingClarifications, reviewSongDifficultyFn, unknownSongInfoFn
        });
        return true;
      }
    } catch (error) {
      console.warn(`[agent] song_reference_resolution_failed: ${error.message}`);
    }
    if (/(?:השיר|song|האם\s+)/iu.test(messageText)) {
      await sendBotMessage(chat, 'לא הצלחתי לזהות את השיר. תכתוב את שם השיר והאמן, ואני אבדוק.');
      return true;
    }
  }

  try {
    const agentMessageText = buildAgentMessageText(
      messageText,
      recentMessages,
      quotedText,
      pendingClarification
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
      pendingClarification,
      currentDate: currentDateInIsrael(),
      scheduledRehearsals,
      tools: isSongInfoRequest(messageText) ? READ_ONLY_SONG_TOOLS : undefined,
      executeToolCall: isSongInfoRequest(messageText)
        ? ({ name, arguments: rawArguments }) => executeReadOnlySongTool({ stateStore, name, arguments: rawArguments })
        : undefined
    });

    // Adding a song is a durable mutation. Do not let an LLM turn a metadata
    // question, a bare acknowledgement, or ordinary chat into an insertion.
    // The only implicit continuation allowed is answering our own explicit
    // "who is the performer" clarification.
    if (action.action === 'add_song' && !isAuthorizedAddAction(messageText, quotedText)) {
      console.warn(`[agent] blocked unauthorized add_song message=${JSON.stringify(messageText)}`);
      await sendBotMessage(chat, 'לא הוספתי כלום — לא ביקשת להוסיף שיר.');
      return true;
    }

    // Let the agent explicitly review every durable change before the local
    // executor mutates state. The executor remains authoritative for whether
    // the referenced song actually exists and can be changed.
    const isAddArtistClarificationContinuation =
      action.action === 'add_song' &&
      pendingClarification?.intent === 'add_song' &&
      pendingClarification?.missing === 'artist' &&
      Boolean(String(pendingClarification?.subject || '').trim()) &&
      isArtistReplyToAddClarification(messageText, quotedText);
    if (isMutationAction(action) && typeof reviewActionExecutionFn === 'function' && !isAddArtistClarificationContinuation) {
      const review = await reviewActionExecutionFn({
        baseUrl: config.llmBaseUrl,
        apiKey: config.llmApiKey,
        model: config.llmModel,
        messageText,
        quotedText,
        pendingClarification,
        action
      });
      if (review !== 'execute') {
        console.warn(`[agent] execution_review=${JSON.stringify(review)} action=${action.action}`);
        await sendBotMessage(chat, 'לא ביצעתי שינוי — לא היה לי ברור שזה מה שביקשת.');
        return true;
      }
    }

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
      estimateSongDurationsFn,
      pendingAdditions,
      pendingClarifications,
      reviewSongDifficultyFn,
      unknownSongInfoFn,
      polishBanterReplyFn,
      recommendExternalSongsFn,
      composeUnsupportedReplyFn
    });
  } catch (error) {
    console.error('[agent] failed:', error);
    if (Number(error?.status) === 400 && /json_validate_failed/i.test(String(error?.message || ''))) {
      try {
        const fallbackReply = await plainFallbackReplyFn({
          baseUrl: config.llmBaseUrl,
          apiKey: config.llmApiKey,
          model: config.llmModel,
          messageText,
          quotedText
        });
        if (fallbackReply && fallbackReply !== 'ACTION_UNAVAILABLE') {
          await sendBotMessage(chat, fallbackReply);
          return true;
        }
      } catch (fallbackError) {
        console.error('[agent] plain_fallback_failed:', fallbackError);
      }
    }
    await sendBotMessage(chat, buildAgentFailureReply(error));
  }
  return true;
}

async function bootstrap() {
  const {
    createWhatsAppClient,
    clearStaleSingletonLocks,
    waitForReady,
    findGroupChat,
    messageToRecord,
    readQuotedMessage
  } = require('./whatsapp');
  const { loadEventSchedule, saveEventSchedule, sendDueEventReminders, eventFromWhatsAppMessage, upsertEvent } = require('./event-reminders');
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

  clearStaleSingletonLocks(config.authDir);
  console.log(
    `[config] groups=${JSON.stringify(config.groupNames)} groupIds=${JSON.stringify(config.groupIds)} trigger=${JSON.stringify(config.triggerText)} provider=${config.llmProvider}`
  );
  let shuttingDown = false;
  let clientDestroyed = false;
  let client = null;
  let heartbeatTimer = null;
  let eventReminderTimer = null;
  let eventReminderCheckRunning = false;
  let eventSchedule = await loadEventSchedule(config.eventsFile);

  async function destroyClient(reason) {
    if (clientDestroyed || !client) return;
    clientDestroyed = true;
    console.log(`[shutdown] destroying WhatsApp client (${reason})`);
    // client.destroy() can hang if Chromium's CDP connection is already dead.
    // Left unguarded, that stalls shutdown() until systemd's stop timeout
    // force-kills the whole cgroup, which can leave Chromium's profile lock
    // files behind and make the next launch hang waiting on that lock.
    const DESTROY_TIMEOUT_MS = 10000;
    try {
      await Promise.race([
        client.destroy(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('client.destroy timed out')), DESTROY_TIMEOUT_MS))
      ]);
    } catch (error) {
      console.error('[shutdown] client destroy failed:', error);
      try {
        const browserProcess = client.pupBrowser?.process?.();
        if (browserProcess && browserProcess.exitCode === null) {
          browserProcess.kill('SIGKILL');
        }
      } catch (killError) {
        console.error('[shutdown] force-killing browser process failed:', killError);
      }
    }
  }

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] received ${signal}`);
    clearInterval(heartbeatTimer);
    clearInterval(eventReminderTimer);
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
  const pendingAdditions = new Map();
  const pendingClarifications = new Map();
  const recentMessagesByChat = new Map();
  let readyToProcess = false;
  const processedMessageIds = new Set();
  const heartbeatIntervalMs = 15 * 60 * 1000;
  heartbeatTimer = setInterval(() => {
    const groupLabel = (config.groupNames || []).join(', ') || (config.groupIds || []).join(', ') || '(unknown)';
    console.log(
      `[health] alive groups=${groupLabel} songs=${stateStore.state.songs.length} seen=${stateStore.seenState.seenMessageIds.length}`
    );
  }, heartbeatIntervalMs);
  heartbeatTimer.unref();

  async function checkEventReminders() {
    if (eventReminderCheckRunning || !eventSchedule.group_name || eventSchedule.events.length === 0 || !client) return;
    eventReminderCheckRunning = true;
    try {
      const chat = eventSchedule.group_id ? null : await findGroupChat(client, eventSchedule.group_name);
      const result = await sendDueEventReminders({
        schedule: eventSchedule,
        send: async (text, event) => {
          if (eventSchedule.group_id) {
            await sendBotMessageToId(client, eventSchedule.group_id, text);
          } else {
            await sendBotMessage(chat, text);
          }
          console.log(`[event_reminder] sent id=${event.id} group=${JSON.stringify(eventSchedule.group_name)}`);
        }
      });
      eventSchedule = result.schedule;
      if (result.due.length > 0) {
        await saveEventSchedule(config.eventsFile, eventSchedule);
      }
    } catch (error) {
      console.error(`[event_reminder] check_failed: ${error.message}`);
    } finally {
      eventReminderCheckRunning = false;
    }
  }

  async function syncScheduledEventMessage(message, source) {
    const event = eventFromWhatsAppMessage(message);
    if (!event || !eventSchedule.group_name) return false;
    let chat = null;
    try {
      chat = typeof message?.getChat === 'function' ? await message.getChat() : null;
    } catch (error) {
      console.warn(`[event_sync] chat_lookup_failed: ${error.message}`);
      return false;
    }
    if (!chat?.isGroup || normalizeText(chat.name) !== normalizeText(eventSchedule.group_name)) return false;

    const result = upsertEvent(eventSchedule, event);
    if (!result.changed) return false;
    eventSchedule = result.schedule;
    await saveEventSchedule(config.eventsFile, eventSchedule);
    console.log(`[event_sync] source=${source} id=${event.id} cancelled=${event.cancelled} start=${event.start_at}`);
    return true;
  }

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

  function rememberRecentMessage(record, isBotDirected) {
    const normalizedChatId = String(record?.chatId || '').trim();
    const text = String(record?.text || '').trim();
    if (!isBotDirected || !normalizedChatId || !text) return;
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

    if (/^\/status\b/i.test(String(record?.text || '').trim())) {
      await sendBotMessage(chat, formatGroqStatusReply(getAgentUsageStats()));
      return;
    }

    const commandText = stripWakeWord(record?.text || '', config.triggerText);
    if (/^(?:\u05e1\u05d8\u05d8\u05d5\u05e1|status)$/iu.test(String(commandText || '').trim())) {
      await sendBotMessage(chat, formatGroqStatusReply(getAgentUsageStats()));
      return;
    }

    const recentMessages = buildRecentMessageContext(getRecentMessagesForChat(record.chatId));
    await handleAgentMessage({
      chat,
      stateStore,
      config,
      record,
      recentMessages,
      pendingAdditions,
      pendingClarifications,
      scheduledRehearsals: isScheduleInquiry(record.text)
        ? eventSchedule.events.filter((event) => !event.cancelled)
        : [],
      reviewSongDifficultyFn: interpretSongDifficulty,
      reviewActionExecutionFn: reviewAgentActionExecution,
      resolveSongReferenceFn: resolveSongReference
    });
  }

  async function processMessageObject(message, source) {
    await syncScheduledEventMessage(message, source);
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
      return;
    }
    if (!record.chat && chatId && !String(chatId).endsWith('@g.us')) {
      return;
    }

    const routing = summarizeMessageRouting(record, config);
    if (!routing.inTargetGroup) {
      return;
    }

    stateStore.markSeenMessage(messageId);

    console.log(
      `[message] source=${source} chatId=${chatId} group=${JSON.stringify(routing.chatName)} from=${record.from} text=${JSON.stringify(text)} reason=${routing.handling.reason}`
    );

    if (!readyToProcess) {
      pendingMessages.push(record);
      rememberRecentMessage(record, routing.handling.shouldHandle);
      return;
    }

    await handleLiveMessage(record);
    rememberRecentMessage(record, routing.handling.shouldHandle);
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
    await checkEventReminders();
    eventReminderTimer = setInterval(() => {
      void checkEventReminders();
    }, 60 * 1000);
    eventReminderTimer.unref();
    console.log(`[event_reminder] enabled group=${JSON.stringify(eventSchedule.group_name)} events=${eventSchedule.events.length} time=20:00 two_days_before`);
  }

  const handleIncomingMessage = async (message, source) => {
    try {
      await processMessageObject(message, source);
    } catch (error) {
      console.error('[message] failed:', error);
    }
  };

  function attachMessageListeners(activeClient) {
    activeClient.on('message_create', (message) => {
      if (!message?.fromMe) return;
      void handleIncomingMessage(message, 'message_create');
    });
    activeClient.on('message', (message) => {
      if (message?.fromMe) return;
      void handleIncomingMessage(message, 'message');
    });
    activeClient.on('message_edit', (message) => {
      void syncScheduledEventMessage(message, 'message_edit').catch((error) => {
        console.error(`[event_sync] edit_failed: ${error.message}`);
      });
    });
  }

  const startupTimeoutMs = config.whatsappStartupTimeoutMs;
  const startupAttempts = config.whatsappStartupRetries + 1;
  let lastStartupError = null;
  for (let attempt = 1; attempt <= startupAttempts; attempt += 1) {
    clientDestroyed = false;
    client = createWhatsAppClient({
      headless: config.headless,
      executablePath: config.executablePath,
      authDir: config.authDir
    });
    attachMessageListeners(client);
    const attemptStartedAt = Date.now();
    const readyPromise = waitForReady(client);
    let observedBrowser = null;
    let observedPage = null;
    const attachStartupDiagnostics = () => {
      const browser = client?.pupBrowser;
      const page = client?.pupPage;
      if (browser && browser !== observedBrowser) {
        observedBrowser = browser;
        browser.on('disconnected', () => {
          console.error(`[whatsapp] browser disconnected during startup attempt=${attempt}`);
        });
      }
      if (page && page !== observedPage) {
        observedPage = page;
        page.on('pageerror', (error) => {
          console.error(`[whatsapp] page error during startup attempt=${attempt}:`, error);
        });
        page.on('requestfailed', (request) => {
          console.warn(`[whatsapp] request failed during startup attempt=${attempt} url=${request.url()} error=${request.failure()?.errorText || 'unknown'}`);
        });
        page.on('console', (message) => {
          if (message.type() === 'error' || message.type() === 'warning') {
            console.warn(`[whatsapp] page console ${message.type()} attempt=${attempt}: ${message.text()}`);
          }
        });
      }
      return page?.url?.() || 'unavailable';
    };
    const initializePromise = Promise.resolve().then(() => client.initialize());
    const initializeFailurePromise = initializePromise.then(
      () => new Promise(() => {}),
      (error) => {
        console.error(`[whatsapp] initialize failed attempt=${attempt}:`, error);
        throw error;
      }
    );
    const startupDiagnosticsTimer = setInterval(() => {
      const browserProcess = client?.pupBrowser?.process?.();
      const pageUrl = attachStartupDiagnostics();
      console.warn(
        `[whatsapp] startup_wait attempt=${attempt}/${startupAttempts} elapsed_ms=${Date.now() - attemptStartedAt} browser_pid=${browserProcess?.pid || 'unavailable'} browser_exit=${browserProcess?.exitCode ?? 'running'} page_url=${JSON.stringify(pageUrl)}`
      );
    }, 15000);
    let startupTimer = null;
    console.log(`[whatsapp] starting client attempt=${attempt}/${startupAttempts} timeout_ms=${startupTimeoutMs}`);
    console.log('[whatsapp] initialize called');
    console.log('[whatsapp] waiting for ready');
    try {
      const result = await Promise.race([
        readyPromise.then(() => 'ready'),
        initializeFailurePromise,
        new Promise((resolve) => {
          startupTimer = setTimeout(() => resolve('timeout'), startupTimeoutMs);
        })
      ]);
      if (result === 'timeout') {
        throw new Error(`WhatsApp startup timed out after ${startupTimeoutMs}ms`);
      }
      console.log('[whatsapp] ready');
      await finalizeStartup();
      return;
    } catch (error) {
      lastStartupError = error;
      console.error(`[whatsapp] startup attempt=${attempt}/${startupAttempts} failed:`, error);
      await destroyClient(`startup attempt ${attempt} failure`);
      if (attempt < startupAttempts) {
        clearStaleSingletonLocks(config.authDir);
        console.warn('[whatsapp] retrying startup with a fresh Chromium client');
      }
    } finally {
      clearTimeout(startupTimer);
      clearInterval(startupDiagnosticsTimer);
    }
  }
  throw lastStartupError || new Error('WhatsApp startup failed');
}

module.exports = {
  stripWakeWord,
  shouldHandleMessage,
  isMessageInTargetGroup,
  buildAgentReplyContext,
  buildAgentFailureReply,
  formatGroqStatusReply,
  buildClarifyReply,
  isRecommendationReasonRequest,
  buildRecommendationReason,
  buildRecentMessageContext,
  isScheduleInquiry,
  getScheduleReply,
  isChordsReplyRequest,
  shouldBlockGenericSearchFallback,
  isAuthorizedAddAction,
  extractSongIdentityFromMetadataQuestion,
  formatRequestedSongInfo,
  handleAgentMessage,
  executeAgentAction
};

if (require.main === module) {
  bootstrap().catch((error) => {
    console.error('[fatal]', error);
    process.exit(1);
  });
}
