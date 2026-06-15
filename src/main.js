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

const ADD_COMMAND = 'תוסיף';
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

function firstWord(value) {
  return normalizeText(value).split(' ')[0] || '';
}

function isRandomSongCommand(text) {
  return SONG_REQUEST_COMMANDS.has(firstWord(text));
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

function isMessageInTargetGroup(record, groupChat) {
  if (!groupChat) return false;
  const resolvedChatId = record?.chat?.id?._serialized || record?.chatId || '';
  return resolvedChatId === groupChat.id._serialized;
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

function parseSongRequest(text) {
  const normalized = normalizeText(text);
  const command = firstWord(normalized);
  if (!SONG_REQUEST_COMMANDS.has(command)) return null;

  const remainder = normalized.replace(new RegExp(`^${command}\\s*`, 'u'), '').trim();
  if (!remainder || remainder === 'שיר' || remainder === 'שירים') {
    return { items: [{ count: 1, language: null }] };
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
    count = capRequestCount(count);

    const language = detectLanguageFilter(segment);
    items.push({ count, language });
  }

  if (items.length === 0) {
    return { items: [{ count: 1, language: null }] };
  }

  return { items };
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
          pickRandomSong(stateStore, (song) => matchesLanguage(song, preferredLanguage), usedKeys) ||
          pickRandomSong(stateStore, (song) => matchesLanguage(song, preferredLanguage === 'he' ? 'en' : 'he'), usedKeys) ||
          pickRandomSong(stateStore, null, usedKeys);
      } else {
        choice = pickRandomSong(stateStore, (song) => matchesLanguage(song, item.language), usedKeys);
      }

      if (!choice) break;
      selected.push(choice);
    }
  }

  return selected;
}

function buildMixedLanguageRequest(count) {
  const cappedCount = capRequestCount(count);
  const heCount = Math.ceil(cappedCount / 2);
  const enCount = Math.floor(cappedCount / 2);
  return [
    { count: heCount, language: 'he' },
    { count: enCount, language: 'en' }
  ];
}

function formatSongLine(song) {
  const title = String(song?.song_title || '').trim();
  const artist = String(song?.artist || '').trim();
  if (title && artist) return `${title} - ${artist}`;
  return title || artist || '';
}

function formatRtlLine(index, song) {
  return `\u200F${index + 1}. ${formatSongLine(song)}`;
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
    await chat.sendMessage('אין עדיין שירים 🤖');
    return;
  }

  await chat.sendMessage(`🤖 הבאתי: ${formatSongLine(nextSong)}`);
}

async function sendSongRequest({ chat, stateStore, text }) {
  const request = parseSongRequest(text);
  if (!request) return false;

  if (request.items.length === 1 && request.items[0].count === 1 && !request.items[0].language) {
    await sendRandomSong({ chat, stateStore });
    return true;
  }

  if (request.items.length === 1 && request.items[0].language === 'mixed') {
    request.items = buildMixedLanguageRequest(request.items[0].count);
  }

  const picked = pickSongsForRequest(stateStore, request.items);
  if (picked.length === 0) {
    await chat.sendMessage('אין עדיין שירים 🤖');
    return true;
  }

  const reply = ['🤖 הבאתי:'];
  picked.forEach((song, index) => {
    reply.push(formatRtlLine(index, song));
  });
  await chat.sendMessage(reply.join('\n'));
  return true;
}

async function handleAddSongCommand({ chat, stateStore, config, triggerRecord }) {
  const baseId = String(triggerRecord?.id || `add:${Date.now()}`).trim();
  const quotedText = String(triggerRecord?.quotedText || '').trim();
  const inlineText = stripCommandPrefix(triggerRecord?.text || '', ADD_COMMAND);
  const sourceText = quotedText || inlineText;

  if (!sourceText) {
    await chat.sendMessage('🤖 השיר קיים כבר');
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
    await chat.sendMessage('🤖 הוספתי');
    return;
  }

  await chat.sendMessage('🤖 השיר קיים כבר');
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
    if (!isMessageInTargetGroup(record, groupChat)) {
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
