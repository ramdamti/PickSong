function extractJsonBlock(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    // continue
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    try {
      return JSON.parse(fencedMatch[1].trim());
    } catch (error) {
      // continue
    }
  }

  const firstObject = trimmed.indexOf('{');
  const lastObject = trimmed.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) {
    try {
      return JSON.parse(trimmed.slice(firstObject, lastObject + 1));
    } catch (error) {
      // continue
    }
  }

  return null;
}

function buildPrompt(messages, triggerText) {
  const payload = messages.map((message) => ({
    message_id: message.id,
    sender: message.sender,
    text: message.text,
    quoted_text: message.quotedText || null,
    timestamp: message.timestamp || null
  }));

  return [
    `Trigger text for the bot is: ${triggerText}`,
    'You extract song suggestions from a WhatsApp group for a band.',
    'The chat can contain Hebrew, English, or both.',
    'Return JSON only. No markdown. No explanation.',
    'Preserve the original language and spelling of the song title.',
    'A message is a song suggestion if it proposes a song for rehearsal, even indirectly.',
    'Ignore jokes, off-topic chat, and the trigger message itself.',
    'Output shape:',
    '{ "results": [ { "message_id": "...", "is_song_suggestion": true, "song_title": "...", "artist": null, "language": "he|en|mixed|null", "confidence": 0.0, "needs_review": false, "source_text": "..." } ] }',
    'The message_id in each result must exactly match one of the input message_id values.',
    'If there are no song suggestions, return { "results": [] }.',
    'Messages to analyze:',
    JSON.stringify(payload, null, 2)
  ].join('\n');
}

async function extractSongsViaOllama({
  baseUrl,
  model,
  messages,
  triggerText
}) {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: 'system',
          content: 'You are a strict JSON extraction engine.'
        },
        {
          role: 'user',
          content: buildPrompt(messages, triggerText)
        }
      ],
      options: {
        temperature: 0
      }
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama request failed: ${response.status} ${response.statusText} ${body}`);
  }

  const data = await response.json();
  const content = data?.message?.content || data?.response || '';
  const parsed = extractJsonBlock(content);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Could not parse LLM JSON response: ${content}`);
  }

  const results = Array.isArray(parsed.results) ? parsed.results : [];
  return results
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      message_id: String(item.message_id || '').trim(),
      is_song_suggestion: Boolean(item.is_song_suggestion),
      song_title: item.song_title ? String(item.song_title).trim() : '',
      artist: item.artist === null || item.artist === undefined ? null : String(item.artist).trim(),
      language: item.language ? String(item.language).trim() : null,
      confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 0,
      needs_review: Boolean(item.needs_review),
      source_text: item.source_text ? String(item.source_text).trim() : ''
    }))
    .filter((item) => item.is_song_suggestion && item.song_title);
}

module.exports = { extractSongsViaOllama };
