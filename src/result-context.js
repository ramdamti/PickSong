const { validateResultContext } = require('./schemas');

function buildResultContext({ chatId, botMessageId, songs, createdAt = new Date().toISOString() }) {
  const results = Array.isArray(songs)
    ? songs.map((song, index) => ({
        index: index + 1,
        song_id: String(song?.song_id || '').trim(),
        title: song?.song_title ? String(song.song_title).trim() : null,
        artist: song?.artist ? String(song.artist).trim() : null
      }))
    : [];

  return validateResultContext({
    chat_id: chatId || null,
    bot_message_id: botMessageId || null,
    created_at: createdAt,
    results
  });
}

function persistResultContext(stateStore, { chatId, botMessageId, songs, createdAt }) {
  const context = buildResultContext({ chatId, botMessageId, songs, createdAt });
  if (chatId) {
    stateStore.setLastResults(chatId, context);
  }
  if (chatId && botMessageId) {
    stateStore.storeResultMessage(chatId, botMessageId, context);
  }
  return context;
}

function resolveActiveResultContext(stateStore, record) {
  const quotedMessageId = String(record?.quoted?.id || '').trim();
  if (quotedMessageId) {
    const quotedContext = stateStore.getResultMessage(quotedMessageId);
    if (quotedContext) {
      return {
        source: 'reply',
        context: quotedContext
      };
    }
  }

  const chatId = String(record?.chatId || '').trim();
  if (chatId) {
    const lastResults = stateStore.getLastResults(chatId);
    if (lastResults) {
      return {
        source: 'last_results',
        context: lastResults
      };
    }
  }

  return {
    source: 'none',
    context: null
  };
}

function findSongIdsByIndexes(resultContext, requestedIndexes) {
  const context = validateResultContext(resultContext);
  const indexSet = new Set(
    (Array.isArray(requestedIndexes) ? requestedIndexes : [])
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0)
  );

  return context.results.filter((entry) => indexSet.has(entry.index));
}

module.exports = {
  buildResultContext,
  persistResultContext,
  resolveActiveResultContext,
  findSongIdsByIndexes
};
