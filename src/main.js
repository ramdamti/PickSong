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

function isTriggerMessage(text, triggerText) {
  return firstWord(text) === normalizeText(triggerText);
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

async function handleTriggerMessage({ chat, stateStore, config, triggerRecord }) {
  const quotedText = String(triggerRecord?.quotedText || '').trim();
  if (quotedText) {
    const baseId = String(triggerRecord?.id || `quoted:${Date.now()}`).trim();
    const results = await extractSongs({
      provider: config.llmProvider,
      ollamaBaseUrl: config.ollamaBaseUrl,
      ollamaModel: config.ollamaModel,
      geminiApiKey: config.geminiApiKey,
      geminiModel: config.geminiModel,
      messages: [
        {
          id: `${baseId}:quoted`,
          text: quotedText,
          sender: triggerRecord?.sender || '',
          from: triggerRecord?.from || '',
          quotedText: null,
          timestamp: triggerRecord?.timestamp || null
        }
      ],
      triggerText: config.triggerText
    });

    let addedCount = 0;
    results.forEach((result, index) => {
      const song = {
        message_id: `${baseId}:quoted:${index}`,
        source_text: result.source_text || quotedText,
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
    });

    if (addedCount > 0) {
      await stateStore.queueSave();
      await chat.sendMessage('הוספתי 🤖');
      return;
    }
  }

  const nextSong = stateStore.getNextUnusedSong();
  if (!nextSong) {
    await chat.sendMessage('הוספתי 🤖');
    return;
  }

  const replyParts = [nextSong.song_title];
  if (nextSong.artist) replyParts.push(nextSong.artist);
  const reply = `הבאתי: 🤖 ${replyParts.join(' - ')}`;

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
  const liveMessages = [];
  let liveFlushTimer = null;
  let liveFlushInProgress = false;
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

  async function handleLiveMessage(record) {
    const text = record.text || '';
    const triggerMatch = isTriggerMessage(text, config.triggerText);

    if (triggerMatch) {
      if (groupChat && !record.chatId && record.fromMe) {
        record.chatId = groupChat.id._serialized;
      }
      if (!groupChat || record.chatId !== groupChat.id._serialized) {
        return;
      }
      console.log('[trigger] matched');
      const chat = record.chat || groupChat;
      await handleTriggerMessage({ chat, stateStore, config, triggerRecord: record });
      return;
    }

    if (!groupChat) return;
    if (!record.chatId && record.fromMe) {
      record.chatId = groupChat.id._serialized;
    }
    if (record.chatId !== groupChat.id._serialized) {
      return;
    }

    liveMessages.push(record);
    scheduleLiveFlush();
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
      await handleLiveMessage(message);
    }
  }

  await flushLiveMessages();

  console.log('[whatsapp] watcher is live');
}

bootstrap().catch((error) => {
  console.error('[fatal]', error);
  process.exit(1);
});
