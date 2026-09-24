function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// If the previous process's Chromium was not shut down cleanly (e.g. it was
// still closing when systemd force-killed the service on restart), these
// singleton files survive and make the next Chromium launch hang forever
// waiting on the profile lock, so "waiting for ready" never resolves. They
// only guard against two Chromium instances sharing one profile at the same
// time, so it is safe to clear them before this process launches its own.
function clearStaleSingletonLocks(authDir, clientId = 'picksong') {
  const fs = require('fs');
  const path = require('path');
  const profileDir = path.join(authDir || '.wwebjs_auth', `session-${clientId}`);
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const target = path.join(profileDir, name);
    try {
      fs.lstatSync(target);
    } catch (error) {
      continue;
    }
    try {
      fs.rmSync(target, { force: true });
      console.log(`[whatsapp] removed stale ${name} left over from a previous run`);
    } catch (error) {
      console.warn(`[whatsapp] failed to remove stale ${name}: ${error.message}`);
    }
  }
}

function createWhatsAppClient({ headless, executablePath, authDir, dumpio = false }) {
  const { Client, LocalAuth } = require('whatsapp-web.js');
  const qrcode = require('qrcode-terminal');
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
      dumpio,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-vulkan',
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion'
      ]
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

  client.on('error', (error) => {
    console.error('[whatsapp] client error:', error);
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
    message._data?.from ||
    message._data?.to ||
    message.id?.remote ||
    message.from ||
    '';

  return {
    id: message.id?._serialized || message.id?.id || '',
    text: String(message.body || '').trim(),
    sender: message._data?.notifyName || message.author || message.from || '',
    from: message.from || '',
    fromMe: Boolean(message.fromMe),
    chatId,
    timestamp: message.timestamp || null,
    quoted: {
      hasQuotedMsg: Boolean(message.hasQuotedMsg),
      id: null,
      text: null,
      fromMe: null,
      author: null
    }
  };
}

async function readQuotedMessage(message) {
  const fallbackQuoted = (() => {
    const raw = message?._data?.quotedMsg || message?._data?.quotedMessage || null;
    const rawId =
      raw?.id?._serialized ||
      raw?.id?.id ||
      message?._data?.quotedStanzaID ||
      message?._data?.quotedMsgId ||
      '';
    const rawText =
      raw?.body ||
      raw?.caption ||
      message?._data?.quotedMsg?.body ||
      message?._data?.quotedMsg?.caption ||
      null;
    const rawAuthor =
      raw?.author ||
      raw?.from ||
      message?._data?.quotedParticipant ||
      null;

    if (!rawId && !rawText && !rawAuthor) {
      return null;
    }

    const linkPreview = {
      title: raw?.title || message?._data?.quotedMsg?.title || '',
      description: raw?.description || message?._data?.quotedMsg?.description || '',
      links: raw?.links || message?._data?.quotedMsg?.links || []
    };
    return {
      id: String(rawId || '').trim(),
      text: rawText ? String(rawText).trim() : null,
      fromMe: raw?.fromMe === undefined ? null : Boolean(raw.fromMe),
      author: rawAuthor ? String(rawAuthor).trim() : null,
      ...(linkPreview.title || linkPreview.description || linkPreview.links.length ? { linkPreview } : {})
    };
  })();

  // whatsapp-web.js can report hasQuotedMsg=false for history-sync/message events even while
  // the raw stanza still contains the reply target. Keep that context for follow-up commands.
  if (!message.hasQuotedMsg && !fallbackQuoted) return null;
  if (typeof message.getQuotedMessage !== 'function') return fallbackQuoted;

  try {
    const quoted = await message.getQuotedMessage();
    const linkPreview = {
      title: quoted?.title || quoted?._data?.title || fallbackQuoted?.linkPreview?.title || '',
      description: quoted?.description || quoted?._data?.description || fallbackQuoted?.linkPreview?.description || '',
      links: quoted?.links || quoted?._data?.links || fallbackQuoted?.linkPreview?.links || []
    };
    return {
      id: quoted?.id?._serialized || quoted?.id?.id || fallbackQuoted?.id || '',
      text: quoted?.body
        ? String(quoted.body).trim()
        : quoted?.caption
          ? String(quoted.caption).trim()
          : fallbackQuoted?.text || null,
      fromMe: quoted?.fromMe === undefined ? fallbackQuoted?.fromMe ?? null : Boolean(quoted.fromMe),
      author: quoted?.author || quoted?.from || fallbackQuoted?.author || null,
      ...(linkPreview.title || linkPreview.description || linkPreview.links.length ? { linkPreview } : {})
    };
  } catch (error) {
    return fallbackQuoted;
  }
}

module.exports = {
  createWhatsAppClient,
  clearStaleSingletonLocks,
  waitForReady,
  findGroupChat,
  messageToRecord,
  readQuotedMessage
};
