const fs = require('fs/promises');
const path = require('path');
const { normalizeText } = require('./state');
const { extractSongsViaOllama } = require('./llm');

function parseExportMessages(content) {
  const lines = String(content || '').split(/\r?\n/);
  const messages = [];
  let current = null;

  const startPatterns = [
    /^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4},?\s+\d{1,2}:\d{2}(?:\s?[APMapm]{2})?\s+-\s+(.+)$/,
    /^\[\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4},?\s+\d{1,2}:\d{2}(?:\s?[APMapm]{2})?\]\s+(.+)$/
  ];

  function matchStart(line) {
    for (const pattern of startPatterns) {
      const match = line.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  function flush() {
    if (!current) return;
    const text = current.lines.join('\n').trim();
    if (text) {
      messages.push({
        id: `import:${messages.length}`,
        text,
        sender: current.sender,
        from: 'import',
        timestamp: null,
        quotedText: null
      });
    }
    current = null;
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const contentLine = matchStart(line);
    if (contentLine) {
      flush();

      let sender = 'unknown';
      let text = contentLine;

      const colonIndex = contentLine.indexOf(':');
      if (colonIndex > -1) {
        sender = contentLine.slice(0, colonIndex).trim() || sender;
        text = contentLine.slice(colonIndex + 1).trim();
      }

      current = {
        sender,
        lines: [text]
      };
      continue;
    }

    if (current) {
      current.lines.push(line);
    }
  }

  flush();
  return messages;
}

async function importChatFile({
  filePath,
  config,
  stateStore,
  batchSize = 20
}) {
  const absolutePath = path.resolve(filePath);
  const content = await fs.readFile(absolutePath, 'utf8');
  const messages = parseExportMessages(content);
  console.log(`[import] parsed ${messages.length} messages from ${absolutePath}`);

  const batches = [];
  for (let index = 0; index < messages.length; index += batchSize) {
    batches.push(messages.slice(index, index + batchSize));
  }

  let addedCount = 0;
  for (const batch of batches) {
    console.log(`[import] analyzing batch of ${batch.length}`);
    const results = await extractSongsViaOllama({
      baseUrl: config.ollamaBaseUrl,
      model: config.ollamaModel,
      messages: batch,
      triggerText: config.triggerText
    });

    for (const result of results) {
      const original =
        batch.find((message) => message.id === result.message_id) ||
        (result.source_text
          ? batch.find((message) => normalizeText(message.text) === normalizeText(result.source_text))
          : null);

      if (!original || !result.song_title) continue;

      const inserted = stateStore.addSong({
        message_id: original.id,
        source_text: result.source_text || original.text,
        song_title: result.song_title,
        artist: result.artist ?? null,
        language: result.language ?? null,
        confidence: result.confidence ?? 0,
        used: false,
        created_at: new Date().toISOString(),
        normalized_title: normalizeText(result.song_title),
        normalized_artist: normalizeText(result.artist || '')
      });

      if (inserted) {
        addedCount += 1;
        console.log(`[import] added song: ${result.song_title}`);
      }
    }

    for (const message of batch) {
      stateStore.markSeenMessage(message.id);
    }

    await stateStore.queueSave();
  }

  console.log(`[import] completed, added ${addedCount} songs`);
  return { messages: messages.length, addedCount };
}

module.exports = {
  parseExportMessages,
  importChatFile
};
