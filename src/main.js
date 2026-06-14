const { loadConfig } = require('./config');
const { createStateStore, loadState, normalizeText } = require('./state');
const { extractSongsViaOllama } = require('./llm');
const {
  createWhatsAppClient,
  waitForReady,
  findGroupChat,
  messageToRecord,
  readQuotedText,
  loadRecentMessages
} = require('./whatsapp');

function chunk(array, size) {
  const result = [];
  for (let index = 0; index < array.length; index += size) {
    result.push(array.slice(index, index + size));
  }
  return result;
}

function getMessageId(message) {
  return message.id?._serialized || message.id?.id || '';
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

  const results = await extractSongsViaOllama({
    baseUrl: config.ollamaBaseUrl,
    model: config.ollamaModel,
    messages: payload,
    triggerText: config.triggerText
  });

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

async function handleTriggerMessage({ chat, stateStore }) {
  const nextSong = stateStore.getNextUnusedSong();
  if (!nextSong) {
    await chat.sendMessage('אין עדיין שיר מתאים');
    return;
  }

  const replyParts = [nextSong.song_title];
  if (nextSong.artist) replyParts.push(nextSong.artist);
  const reply = `הבאתי: ${replyParts.join(' - ')}`;

  await chat.sendMessage(reply);
  stateStore.markSongUsed(nextSong.message_id);
  await stateStore.queueSave();
}

async function bootstrap() {
  const config = loadConfig();
  const loadedState = await loadState(config.stateFile);
  const stateStore = createStateStore(config.stateFile, loadedState);
  const client = createWhatsAppClient({
    headless: config.headless,
    executablePath: config.executablePath
  });

  const pendingMessages = [];
  let readyToProcess = false;
  let groupChat = null;

  client.on('message', async (message) => {
    try {
      if (message.fromMe) return;

      const text = String(message.body || '').trim();
      if (!text) return;

      const record = messageToRecord(message);
      record.quotedText = await readQuotedText(message);

      if (!readyToProcess) {
        pendingMessages.push(record);
        return;
      }

      if (!groupChat) return;
      if (record.from !== groupChat.id._serialized) return;

      if (text === config.triggerText) {
        await handleTriggerMessage({ chat: groupChat, stateStore });
        return;
      }

      await extractAndStoreBatch({
        config,
        stateStore,
        batch: [record],
        contextLabel: 'live'
      });
    } catch (error) {
      console.error('[message] failed:', error);
    }
  });

  console.log('[whatsapp] starting client');
  const readyPromise = waitForReady(client);
  client.initialize();
  await readyPromise;
  console.log('[whatsapp] connected');

  groupChat = await findGroupChat(client, config.groupName);
  console.log(`[whatsapp] watching group: ${groupChat.name}`);

  const historyMessages = await loadRecentMessages(groupChat, config.historyMessages);
  console.log(`[history] loaded ${historyMessages.length} messages`);

  const historyRecords = [];
  for (const message of historyMessages) {
    const id = getMessageId(message);
    if (!id || stateStore.hasSeenMessage(id)) continue;
    const record = messageToRecord(message);
    if (!record.text) continue;
    historyRecords.push(record);
  }

  for (const batch of chunk(historyRecords, config.historyBatchSize)) {
    await extractAndStoreBatch({
      config,
      stateStore,
      batch,
      contextLabel: 'history'
    });
  }

  stateStore.setBootstrapComplete();
  await stateStore.queueSave();
  readyToProcess = true;

  if (pendingMessages.length > 0) {
    for (const message of pendingMessages.splice(0, pendingMessages.length)) {
      if (message.from !== groupChat.id._serialized) continue;
      if (message.text === config.triggerText) continue;
      await extractAndStoreBatch({
        config,
        stateStore,
        batch: [message],
        contextLabel: 'pending-live'
      });
    }
  }

  console.log('[whatsapp] watcher is live');
}

bootstrap().catch((error) => {
  console.error('[fatal]', error);
  process.exit(1);
});
