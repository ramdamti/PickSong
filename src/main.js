const { loadConfig } = require('./config');
const { createStateStore, loadState, normalizeText } = require('./state');
const { extractSongs } = require('./llm');
const { importChatFile } = require('./import');
const {
  createWhatsAppClient,
  waitForReady,
  findGroupChat,
  messageToRecord,
  readQuotedText,
} = require('./whatsapp');

function firstWord(value) {
  return normalizeText(value).split(' ')[0] || '';
}

const ADD_COMMAND = 'תוסיף';
const RANDOM_COMMAND = 'תביא שיר';

function isRandomSongCommand(text) {
  const normalized = normalizeText(text);
  const trigger = normalizeText(RANDOM_COMMAND);
  return normalized === trigger || normalized.startsWith(`${trigger} `);
}

function isAddSongCommand(text) {
  return firstWord(text) === normalizeText(ADD_COMMAND);
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

async function sendRandomSong({ chat, stateStore }) {
  const nextSong = stateStore.getNextUnusedSong();
  if (!nextSong) {
    await chat.sendMessage('🤖 הוספתי');
    return;
  }

  const replyParts = [nextSong.song_title];
  if (nextSong.artist) replyParts.push(nextSong.artist);
  const reply = `🤖 הבאתי: ${replyParts.join(' - ')}`;

  await chat.sendMessage(reply);
}

async function handleAddSongCommand({ chat, stateStore, config, triggerRecord }) {
  const baseId = String(triggerRecord?.id || `add:${Date.now()}`).trim();
  const quotedText = String(triggerRecord?.quotedText || '').trim();
  const inlineText = stripCommandPrefix(triggerRecord?.text || '', ADD_COMMAND);
  const sourceText = quotedText || inlineText;

  if (!sourceText) {
    await chat.sendMessage('🤖 השיר קיים');
    return;
  }

  const results = await extractSongs({
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
    await chat.sendMessage('הוספתי 🤖');
    return;
  }

  await chat.sendMessage('השיר קיים 🤖');
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
  const liveMessages = [];
  let liveFlushTimer = null;
  let liveFlushInProgress = false;
  let readyToProcess = false;
  let groupChat = null;
  let startupFinished = false;
  const startupTimeoutMs = 300000;
  const processedMessageIds = new Set();

  function markProcessed(messageId) {
    if (!messageId || processedMessageIds.has(messageId)) return false;
    processedMessageIds.add(messageId);
    if (processedMessageIds.size > 5000) {
      processedMessageIds.clear();
    }
    return true;
  }

  async function handleLiveMessage(record) {
    const text = record.text || '';
    const chat = record.chat || groupChat;
    const resolvedChatId = chat?.id?._serialized || record.chatId || '';
    const isGroupMessage = Boolean(chat?.isGroup) || resolvedChatId === groupChat?.id?._serialized;

    if (!groupChat || !isGroupMessage || resolvedChatId !== groupChat.id._serialized) {
      return;
    }

    if (isRandomSongCommand(text)) {
      console.log('[trigger] random song');
      await sendRandomSong({ chat, stateStore });
      return;
    }

    if (isAddSongCommand(text)) {
      console.log('[trigger] add song');
      await handleAddSongCommand({ chat, stateStore, config, triggerRecord: record });
      return;
    }
  }

  async function flushLiveMessages() {
    if (!readyToProcess || liveFlushInProgress || liveMessages.length === 0) return;
    liveFlushInProgress = true;
    const batch = liveMessages.splice(0, liveMessages.length);
    try {
      if (groupChat) {
        const groupBatch = batch.filter((message) => message.chatId === groupChat.id._serialized);
        if (groupBatch.length > 0) {
          await extractAndStoreBatch({
            config,
            stateStore,
            batch: groupBatch,
            contextLabel: 'live'
          });
        }
      }
    } finally {
      liveFlushInProgress = false;
    }
  }

  function scheduleLiveFlush() {
    if (liveFlushTimer) return;
    liveFlushTimer = setTimeout(async () => {
      liveFlushTimer = null;
      await flushLiveMessages();
      if (liveMessages.length > 0) {
        scheduleLiveFlush();
      }
    }, 3000);
  }

  async function finalizeStartup() {
    if (startupFinished) return;
    if (!groupChat) return;

    startupFinished = true;

    console.log('[bootstrap] saving state');
    stateStore.setBootstrapComplete();
    await stateStore.queueSave();
    readyToProcess = true;

    if (pendingMessages.length > 0) {
      for (const message of pendingMessages.splice(0, pendingMessages.length)) {
        await handleLiveMessage(message);
      }
    }

    await flushLiveMessages();

    console.log('[whatsapp] watcher is live');
  }

  async function onReady() {
    try {
      console.log('[whatsapp] ready');
      console.log('[whatsapp] locating target group');
      groupChat = await findGroupChat(client, config.groupName);
      console.log(`[whatsapp] watching group: ${groupChat.name}`);
      await finalizeStartup();
    } catch (error) {
      console.error('[fatal]', error);
      process.exit(1);
    }
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
      if (!chatId && typeof message.getChat === 'function') {
        try {
          const chat = await message.getChat();
          if (chat?.id?._serialized) {
            record.chatId = chat.id._serialized;
            chatId = record.chatId;
            record.chat = chat;
          }
        } catch (error) {
          // Ignore chat lookup failures here; we'll still keep the message record.
        }
      }

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
  readyPromise.then(onReady).catch((error) => {
    console.error('[fatal]', error);
    process.exit(1);
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
      console.warn(`[whatsapp] ready is taking longer than ${startupTimeoutMs}ms; keeping service alive`);
    }
  });
}

bootstrap().catch((error) => {
  console.error('[fatal]', error);
  process.exit(1);
});
