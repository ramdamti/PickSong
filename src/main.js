const { loadConfig } = require('./config');
const { createStateStore, loadState, normalizeText } = require('./state');
const { extractSongsViaOllama } = require('./llm');
const { importChatFile } = require('./import');
const {
  createWhatsAppClient,
  waitForReady,
  findGroupChat,
  messageToRecord,
  readQuotedText,
} = require('./whatsapp');

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
  const results = await extractSongsViaOllama({
    baseUrl: config.ollamaBaseUrl,
    model: config.ollamaModel,
    messages: payload,
    triggerText: config.triggerText
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
}

async function bootstrap() {
  const args = process.argv.slice(2);
  const importIndex = args.indexOf('--import');
  const importFile = importIndex >= 0 ? args[importIndex + 1] : null;
  const config = loadConfig(process.env, { requireGroupName: !importFile });
  const loadedState = await loadState(config.stateFile);
  const stateStore = createStateStore(config.stateFile, loadedState);

  if (importFile) {
    await importChatFile({
      filePath: importFile,
      config,
      stateStore,
      batchSize: 20
    });
    await stateStore.queueSave();
    return;
  }

  if (!config.groupName) {
    throw new Error('GROUP_NAME is required for live listening');
  }

  const client = createWhatsAppClient({
    headless: config.headless,
    executablePath: config.executablePath,
    authDir: config.authDir
  });

  const pendingMessages = [];
  let readyToProcess = false;
  let groupChat = null;
  const startupTimeoutMs = 120000;
  const processedMessageIds = new Set();

  function markProcessed(messageId) {
    if (!messageId || processedMessageIds.has(messageId)) return false;
    processedMessageIds.add(messageId);
    if (processedMessageIds.size > 5000) {
      processedMessageIds.clear();
    }
    return true;
  }

  const handleIncomingMessage = async (message) => {
    try {
      const messageId = message.id?._serialized || message.id?.id || '';
      if (!markProcessed(messageId)) return;

      const text = String(message.body || '').trim();
      if (!text) return;

      const record = messageToRecord(message);
      record.quotedText = await readQuotedText(message);
      const chat = typeof message.getChat === 'function' ? await message.getChat() : null;
      const chatId = chat?.id?._serialized || record.chatId;
      record.chatId = chatId;

      console.log(
        `[message] fromMe=${Boolean(message.fromMe)} chatId=${chatId} from=${record.from} text=${JSON.stringify(text)}`
      );

      if (message.fromMe && normalizeText(text) !== normalizeText(config.triggerText)) return;

      if (!readyToProcess) {
        pendingMessages.push(record);
        return;
      }

      if (!groupChat) return;
      if (chatId !== groupChat.id._serialized) return;

      if (normalizeText(text) === normalizeText(config.triggerText)) {
        console.log('[trigger] matched');
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
  };

  client.on('message', handleIncomingMessage);
  client.on('message_create', handleIncomingMessage);

  console.log('[whatsapp] starting client');
  const readyPromise = waitForReady(client);
  client.initialize();
  console.log('[whatsapp] initialize called');

  await Promise.race([
    readyPromise,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`WhatsApp startup timed out after ${startupTimeoutMs}ms`));
      }, startupTimeoutMs);
    })
  ]);

  console.log('[whatsapp] connected');

  console.log('[whatsapp] locating target group');
  groupChat = await findGroupChat(client, config.groupName);
  console.log(`[whatsapp] watching group: ${groupChat.name}`);

  console.log('[bootstrap] saving state');
  stateStore.setBootstrapComplete();
  await stateStore.queueSave();
  readyToProcess = true;

  if (pendingMessages.length > 0) {
    for (const message of pendingMessages.splice(0, pendingMessages.length)) {
      if (message.chatId !== groupChat.id._serialized) continue;
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
