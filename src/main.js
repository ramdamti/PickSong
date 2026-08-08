const { loadConfig } = require('./config');
const { createStateStore, loadState, loadSeenState, normalizeText } = require('./state');
const { interpretMessage } = require('./llm');
const {
  persistResultContext,
  resolveActiveResultContext,
  findSongIdsByIndexes
} = require('./result-context');
const { searchSongs } = require('./song-search');
const { formatSongsReply } = require('./chords');
const { ALLOWED_UPDATE_FIELDS } = require('./schemas');

const CURRENT_DATE = '2026-08-08';
const MUTABLE_SONG_FIELDS = new Set(ALLOWED_UPDATE_FIELDS);
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
  const configuredGroupId = String(config?.groupId || '').trim();
  const actualChatId = String(chat?.id?._serialized || record?.chatId || '').trim();
  if (configuredGroupId && actualChatId) {
    return configuredGroupId === actualChatId;
  }

  if (!chat) return false;
  const target = normalizeText(config?.groupName || '');
  const actual = normalizeText(chat.name || record?.chat?.name || '');
  return Boolean(target) && actual === target;
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
  const strippedText = stripWakeWord(record?.text || '', triggerText);
  if (strippedText !== null) {
    return {
      shouldHandle: true,
      reason: 'wake_word',
      messageText: strippedText
    };
  }

  if (record?.quoted?.fromMe) {
    return {
      shouldHandle: true,
      reason: 'reply_to_bot',
      messageText: String(record?.text || '').trim()
    };
  }

  return {
    shouldHandle: false,
    reason: 'ignored',
    messageText: null
  };
}

function buildAgentReplyContext(stateStore, record) {
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

function buildChatResponder(message, chatId) {
  return {
    id: { _serialized: chatId || '' },
    isGroup: true,
    name: '',
    async sendMessage(text) {
      if (typeof message.reply === 'function') {
        return message.reply(text);
      }
      throw new Error('Chat responder is unavailable for this message');
    }
  };
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

async function sendSongsReply({ chat, stateStore, chatId, songs }) {
  if (!songs.length) {
    await chat.sendMessage('\u05dc\u05d0 \u05de\u05e6\u05d0\u05ea\u05d9 \u05e9\u05d9\u05e8\u05d9\u05dd \u05de\u05ea\u05d0\u05d9\u05de\u05d9\u05dd.');
    return;
  }

  const sentMessage = await chat.sendMessage(formatSongsReply(songs));
  const botMessageId = extractBotMessageId(sentMessage);
  persistResultContext(stateStore, {
    chatId,
    botMessageId,
    songs,
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

async function executeAgentAction({ action, stateStore, chat, record }) {
  const activeContext = resolveActiveResultContext(stateStore, record);
  const songs = stateStore.getSongs();

  if (action.action === 'clarify') {
    await chat.sendMessage(action.question);
    return;
  }

  if (action.action === 'search_songs') {
    const excludedSongIds =
      action.query?.avoid_previous_results && activeContext.context
        ? new Set(activeContext.context.results.map((entry) => entry.song_id).filter(Boolean))
        : null;
    const afterPreviousFilter = excludedSongIds
      ? songs.filter((song) => !excludedSongIds.has(song.song_id))
      : songs;
    const requestedLimit = Number.parseInt(action.query?.limit, 10);
    const recentRecommendationIds = new Set(
      typeof stateStore.getRecentRecommendations === 'function'
        ? stateStore.getRecentRecommendations(record.chatId)
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
    const matches = searchSongs(candidateSongs, action.query || {});
    await sendSongsReply({ chat, stateStore, chatId: record.chatId, songs: matches });
    return;
  }

  if (action.action === 'find_similar_songs') {
    const referenceIndex = Number.parseInt(action.query?.reference_result_index, 10);
    if (!Number.isInteger(referenceIndex) || !activeContext.context) {
      await chat.sendMessage('\u05dc\u05d0\u05d9\u05d6\u05d5 \u05e8\u05e9\u05d9\u05de\u05d4 \u05d0\u05ea\u05d4 \u05de\u05ea\u05db\u05d5\u05d5\u05df?');
      return;
    }

    const [entry] = findSongIdsByIndexes(activeContext.context, [referenceIndex]);
    const similarSong = entry?.song_id ? stateStore.getSongById(entry.song_id) : null;
    if (!similarSong) {
      await chat.sendMessage('\u05dc\u05d0 \u05de\u05e6\u05d0\u05ea\u05d9 \u05d0\u05ea \u05d4\u05e9\u05d9\u05e8 \u05e9\u05d4\u05ea\u05db\u05d5\u05d5\u05e0\u05ea \u05d0\u05dc\u05d9\u05d5.');
      return;
    }

    const matches = searchSongs(
      songs.filter((song) => song.song_id !== similarSong.song_id),
      { ...action.query, limit: action.query?.limit || 5 },
      { similarSong }
    );
    await sendSongsReply({ chat, stateStore, chatId: record.chatId, songs: matches });
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
      await chat.sendMessage(formatBadSongsSummary(matches));
      return;
    }
    await sendSongsReply({ chat, stateStore, chatId: record.chatId, songs: matches });
    return;
  }

  if (action.action === 'get_band_failure_reasons') {
    const matches = searchSongs(songs, buildBandStatusQuery('bad'));
    await chat.sendMessage(formatBadSongsSummary(matches));
    return;
  }

  if (action.action === 'add_song') {
    const inserted = stateStore.addSong({
      ...action.song,
      message_id: `agent:add:${Date.now()}`,
      source_text: record.text,
      normalized_title: normalizeText(action.song.song_title),
      normalized_artist: normalizeText(action.song.artist),
      created_at: new Date().toISOString()
    });

    if (!inserted) {
      await chat.sendMessage('\u05d4\u05e9\u05d9\u05e8 \u05db\u05d1\u05e8 \u05e7\u05d9\u05d9\u05dd.');
      return;
    }

    await stateStore.queueSave();
    await chat.sendMessage(`\u05d4\u05d5\u05e1\u05e4\u05ea\u05d9: ${action.song.song_title}${action.song.artist ? ` - ${action.song.artist}` : ''}`);
    return;
  }

  if (action.action === 'update_song_feedback') {
    if (!activeContext.context) {
      await chat.sendMessage('\u05dc\u05d0\u05d9\u05d6\u05d5 \u05e8\u05e9\u05d9\u05de\u05d4 \u05d0\u05ea\u05d4 \u05de\u05ea\u05db\u05d5\u05d5\u05df?');
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
    await chat.sendMessage(buildFeedbackConfirmation(updatedSongs));
    return;
  }

  if (action.action === 'get_song_info') {
    const { song, reason } = resolveSongFromAction(stateStore, action, activeContext);
    if (!song) {
      await chat.sendMessage(
        reason === 'ambiguous'
          ? '\u05d9\u05e9 \u05db\u05de\u05d4 \u05e9\u05d9\u05e8\u05d9\u05dd \u05de\u05ea\u05d0\u05d9\u05de\u05d9\u05dd. \u05ea\u05db\u05d5\u05d5\u05df \u05d1\u05e9\u05dd \u05d4\u05d0\u05d5\u05de\u05df \u05d0\u05d5 \u05d1\u05de\u05e1\u05e4\u05e8 \u05de\u05d4\u05e8\u05e9\u05d9\u05de\u05d4.'
          : '\u05dc\u05d0 \u05de\u05e6\u05d0\u05ea\u05d9 \u05d0\u05d9\u05d6\u05d4 \u05e9\u05d9\u05e8 \u05d4\u05ea\u05db\u05d5\u05d5\u05e0\u05ea.'
      );
      return;
    }

    await chat.sendMessage(formatSongInfo(song));
    return;
  }

  if (action.action === 'explain_song_rejection') {
    const { song, reason } = resolveSongFromAction(stateStore, action, activeContext);
    if (!song) {
      await chat.sendMessage(
        reason === 'ambiguous'
          ? '\u05d9\u05e9 \u05db\u05de\u05d4 \u05e9\u05d9\u05e8\u05d9\u05dd \u05de\u05ea\u05d0\u05d9\u05de\u05d9\u05dd. \u05ea\u05db\u05d5\u05d5\u05df \u05d1\u05e9\u05dd \u05d4\u05d0\u05d5\u05de\u05df \u05d0\u05d5 \u05d1\u05de\u05e1\u05e4\u05e8 \u05de\u05d4\u05e8\u05e9\u05d9\u05de\u05d4.'
          : '\u05dc\u05d0 \u05de\u05e6\u05d0\u05ea\u05d9 \u05d0\u05d9\u05d6\u05d4 \u05e9\u05d9\u05e8 \u05d4\u05ea\u05db\u05d5\u05d5\u05e0\u05ea.'
      );
      return;
    }

    await chat.sendMessage(explainSongStatus(song));
    return;
  }

  if (action.action === 'remove_song') {
    const { song, reason } = resolveSongFromAction(stateStore, action, activeContext);
    if (!song) {
      await chat.sendMessage(
        reason === 'ambiguous'
          ? '\u05d9\u05e9 \u05db\u05de\u05d4 \u05e9\u05d9\u05e8\u05d9\u05dd \u05de\u05ea\u05d0\u05d9\u05de\u05d9\u05dd. \u05ea\u05db\u05d5\u05d5\u05df \u05d1\u05e9\u05dd \u05d4\u05d0\u05d5\u05de\u05df \u05d0\u05d5 \u05d1\u05de\u05e1\u05e4\u05e8 \u05de\u05d4\u05e8\u05e9\u05d9\u05de\u05d4.'
          : '\u05dc\u05d0 \u05de\u05e6\u05d0\u05ea\u05d9 \u05d0\u05d9\u05d6\u05d4 \u05e9\u05d9\u05e8 \u05dc\u05d4\u05e1\u05d9\u05e8.'
      );
      return;
    }

    stateStore.removeSongById(song.song_id);
    await stateStore.queueSave();
    await chat.sendMessage(`\u05d4\u05e1\u05e8\u05ea\u05d9: ${song.song_title}${song.artist ? ` - ${song.artist}` : ''}`);
    return;
  }

  if (action.action === 'update_song') {
    const { song, reason } = resolveSongFromAction(stateStore, action, activeContext);
    if (!song) {
      await chat.sendMessage(
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
    await chat.sendMessage(`\u05e2\u05d3\u05db\u05e0\u05ea\u05d9: ${updated.song_title}${updated.artist ? ` - ${updated.artist}` : ''}`);
    return;
  }

  throw new Error(`Unhandled agent action: ${action.action}`);
}

async function handleAgentMessage({ chat, stateStore, config, record, interpretMessageFn = interpretMessage }) {
  const handling = shouldHandleMessage(record, config.triggerText);
  if (!handling.shouldHandle) return false;

  const replyContext = buildAgentReplyContext(stateStore, record);
  const messageText = handling.messageText;
  if (!messageText) {
    await chat.sendMessage('\u05de\u05d4 \u05dc\u05d7\u05e4\u05e9?');
    return true;
  }

  try {
    const action = await interpretMessageFn({
      provider: config.llmProvider,
      baseUrl: config.llmBaseUrl,
      apiKey: config.llmApiKey,
      model: config.llmModel,
      messageText,
      replyContext,
      currentDate: CURRENT_DATE
    });

    await executeAgentAction({ action, stateStore, chat, record });
  } catch (error) {
    console.error('[agent] failed:', error);
    await chat.sendMessage('\u05d9\u05e9 \u05dc\u05d9 \u05e2\u05db\u05e9\u05d9\u05d5 \u05e2\u05d5\u05de\u05e1 \u05e7\u05d8\u05df. \u05e0\u05e1\u05d5 \u05e9\u05d5\u05d1 \u05e2\u05d5\u05d3 \u05e8\u05d2\u05e2.');
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

  if (!config.groupName) {
    throw new Error('GROUP_NAME is required for live listening');
  }

  const client = createWhatsAppClient({
    headless: config.headless,
    executablePath: config.executablePath,
    authDir: config.authDir
  });
  console.log(
    `[config] group=${JSON.stringify(config.groupName)} trigger=${JSON.stringify(config.triggerText)} provider=${config.llmProvider}`
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
  let readyToProcess = false;
  const startupTimeoutMs = 60000;
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
    const chat = record.chat;
    if (!isMessageInTargetGroup(record, config, chat)) {
      return;
    }

    await handleAgentMessage({ chat, stateStore, config, record });
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
        `[message] ignored group_mismatch source=${source} chatId=${chatId} actualGroup=${JSON.stringify(routing.chatName)} targetGroup=${JSON.stringify(config.groupName)} text=${JSON.stringify(text)}`
      );
      return;
    }

    stateStore.markSeenMessage(messageId);

    console.log(
      `[message] source=${source} chatId=${chatId} group=${JSON.stringify(routing.chatName)} from=${record.from} text=${JSON.stringify(text)} reason=${routing.handling.reason}`
    );

    if (!readyToProcess) {
      pendingMessages.push(record);
      return;
    }

    await handleLiveMessage(record);
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
      await processMessageObject(message, 'event');
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
  stripWakeWord,
  shouldHandleMessage,
  buildAgentReplyContext,
  handleAgentMessage,
  executeAgentAction
};

if (require.main === module) {
  bootstrap().catch((error) => {
    console.error('[fatal]', error);
    process.exit(1);
  });
}
