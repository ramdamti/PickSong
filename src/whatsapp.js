const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function createWhatsAppClient({ headless, executablePath, authDir }) {
  console.log(
    `[whatsapp] puppeteer executable: ${executablePath || '(default chromium)'}`
  );
  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: 'picksong',
      dataPath: authDir || undefined
    }),
    puppeteer: {
      headless,
      executablePath: executablePath || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', (qr) => {
    console.log('[whatsapp] scan this QR code to login');
    qrcode.generate(qr, { small: true });
  });

  client.on('auth_failure', (message) => {
    console.error('[whatsapp] auth failure:', message);
  });

  client.on('authenticated', () => {
    console.log('[whatsapp] authenticated');
  });

  client.on('ready', () => {
    console.log('[whatsapp] ready event observed');
  });

  client.on('loading_screen', (percent, message) => {
    console.log(`[whatsapp] loading screen ${percent}%: ${message}`);
  });

  client.on('change_state', (state) => {
    console.log(`[whatsapp] state: ${state}`);
  });

  client.on('disconnected', (reason) => {
    console.error('[whatsapp] disconnected:', reason);
  });

  return client;
}

async function waitForReady(client) {
  await new Promise((resolve, reject) => {
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onAuthFailure = (message) => {
      cleanup();
      reject(new Error(`WhatsApp auth failure: ${message}`));
    };
    const onDisconnected = (reason) => {
      cleanup();
      reject(new Error(`WhatsApp disconnected before ready: ${reason}`));
    };
    const cleanup = () => {
      client.off('ready', onReady);
      client.off('auth_failure', onAuthFailure);
      client.off('disconnected', onDisconnected);
    };

    client.on('ready', onReady);
    client.on('auth_failure', onAuthFailure);
    client.on('disconnected', onDisconnected);
  });
}

async function findGroupChat(client, groupName) {
  const chats = await client.getChats();
  const targetNormalized = normalizeName(groupName);
  const exactMatch = chats.find((chat) => chat.isGroup && normalizeName(chat.name) === targetNormalized);
  if (exactMatch) return exactMatch;

  const partialMatch = chats.find((chat) => chat.isGroup && normalizeName(chat.name).includes(targetNormalized));
  if (partialMatch) return partialMatch;

  const availableGroups = chats
    .filter((chat) => chat.isGroup)
    .slice(0, 25)
    .map((chat) => chat.name)
    .join(', ');
  throw new Error(`Could not find group "${groupName}". Available groups: ${availableGroups || '(none)'}`);
}

function messageToRecord(message) {
  const chatId =
    (message.fromMe ? message.to : null) ||
    message._data?.to ||
    message.id?.remote ||
    message.from ||
    '';

  return {
    id: message.id?._serialized || message.id?.id || '',
    text: String(message.body || '').trim(),
    sender: message._data?.notifyName || message.author || message.from || '',
    from: message.from || '',
    chatId,
    timestamp: message.timestamp || null
  };
}

async function readQuotedText(message) {
  if (!message.hasQuotedMsg) return null;
  try {
    const quoted = await message.getQuotedMessage();
    return quoted?.body ? String(quoted.body).trim() : null;
  } catch (error) {
    return null;
  }
}

module.exports = {
  createWhatsAppClient,
  waitForReady,
  findGroupChat,
  messageToRecord,
  readQuotedText
};
