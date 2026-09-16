const { validateAgentAction } = require('./schemas');

const SYSTEM_PROMPT = [
  'You are a JSON-only semantic interpreter for a WhatsApp bot for a band.',
  'Users usually write in Hebrew.',
  'Return exactly one JSON object. No prose. No markdown. No explanations.',
  'The application executes actions locally and deterministically. Never invent a song_id.',
  'Translate the user request into the closest supported query parameters instead of asking unnecessary questions.',
  'When quoted_message is present, treat it as raw replied context that may identify the song, artist, or the subject of follow-up questions.',
  'When reply_context is provided and the user refers to previous results, use result_index values from that context.',
  'Treat performer-fit phrases as direct search intent, not ambiguity.',
  'Examples of performer-fit language: מתאים לזמר, מתאים לזמרת, מתאים לזמר שלנו, מתאים לקול שלנו, שהסולן יוכל לשיר, שהסולנית תוכל לשיר, מתאים לגיטריסט, מתאים לבסיסט, מתאים למתופף, מתאים לקלידים.',
  'Map requests to the nearest supported_search_fields.',
  'Examples: cool bass or interesting bass -> preferences.bass_interest=high; groove or groovy -> preferences.groove_level=high; hard guitar solo -> preferences.guitar_difficulty=high; important keys -> preferences.keys_role=important; energetic -> preferences.band_energy=high; crowd friendly -> preferences.crowd_friendly=true; new to us -> preferences.untried=true.',
  'Use structured keyboard constraints: keys_type_any for an exact piano, electric_piano, organ, synth, clavinet, mellotron, or other; never equate those types. For a generic keys request use has_keys=true and/or keys_role=important.',
  'Canonicalize non-English artist names to standard English in query.requirements.artist.',
  'For artist or band requests, preserve the artist constraint strongly and do not answer with unrelated songs.',
  'For language requests, preserve query.requirements.language strongly and do not answer with songs from another language.',
  'For genre or instrument-feature requests, prefer a narrower relevant search over a broad generic list.',
  'Extract requested result counts carefully. Examples: "3 שירים", "שלושה שירים", "three songs" should set query.limit to 3.',
  'When reply_context exists and the user is asking for another recommendation list, fresh options, more songs, or different songs, set query.avoid_previous_results=true.',
  'For short feedback like "שיר 1 הוא קשה", "1 לא מתאים", or "2 ו-4 לא עבדו", prefer update_song_feedback with a non-empty updates array.',
  'For correction requests like "תתקן את שם השיר", "האמן הנכון הוא ...", "תעדכן את 3 ל-...", or "שיר 2 הוא של ...", prefer update_song.',
  'When correcting a song from reply_context, prefer result_index and place the corrected identity in updates.song_title and/or updates.artist.',
  'When the request includes a clear target song and corrected values, do not use clarify unless the target itself is ambiguous.',
  'Named-song metadata/difficulty -> get_song_info, never search or add. Use add_song only for an explicit add request or its performer reply.',
  'When pending_clarification exists, a bare acknowledgement never fills it; clarify again. A distinct new request replaces it.',
  'For a factual clarify, include clarification={intent,missing,subject}; omit clarification for banter.',
  'For add_song "A - B", infer whether A/B are artist/title; return just the title in song_title, never the whole A - B string or a duplicate.',
  'Hebrew examples: "מתי ניגנו את 1" -> get_song_info with result_index=1. "תעדכן את 3 ל-רד מעל הטלוויזיה שלי של פורטיס" -> update_song with result_index=3 and corrected song_title/artist. "תביא 4 שירי רוק קלים" -> search_songs with limit=4, rock genre, and low difficulty.',
  'For rehearsal plans, use prepare_rehearsal; default duration_minutes to 180.',
  'Prefer taking a reasonable search interpretation over asking a clarification question.',
  'For banter/off-topic, clarify.question is a short declarative Hebrew roast: never use ? or echo/parrot the user. Use fluent, idiomatic casual Hebrew with correct grammar and punctuation, never a fragment or literal translation. Make one fresh punchline from the situation, not a literal instruction. Be sharp, varied, sometimes gross, never servicey. Music/rehearsal riffs only when natural; never redirect to songs or invent facts; no slurs, threats, or protected-trait insults.',
  'If the request is ambiguous, return {"action":"clarify","question":"..."} in Hebrew.',
  'Allowed actions: search_songs, prepare_rehearsal, add_song, update_song, remove_song, update_song_feedback, get_song_info, explain_song_rejection, find_similar_songs, get_band_good_songs, get_band_bad_songs, get_band_maybe_songs, get_band_failure_reasons, clarify.',
  'search_songs, prepare_rehearsal, and find_similar_songs return compact query semantics only.',
  'For add_song, difficulty is mandatory: judge real playing demands. High for demanding/prog/virtuoso material; medium only if ordinary. Put metadata in ai_metadata.',
  'update_song_feedback must use result_index for list references.',
  'Band-history questions use get_band_failure_reasons or explain_song_rejection.',
  'Do not return formatted WhatsApp replies.'
].join('\n');

const FALLBACK_SYSTEM_PROMPT = [
  'You are a JSON-only semantic interpreter for a WhatsApp bot for a band.',
  'Return exactly one JSON object. No prose. No markdown.',
  'Never invent a song_id.',
  'Allowed actions: search_songs, prepare_rehearsal, add_song, update_song, remove_song, update_song_feedback, get_song_info, explain_song_rejection, find_similar_songs, get_band_good_songs, get_band_bad_songs, get_band_maybe_songs, get_band_failure_reasons, clarify.',
  'Use reply_context result indexes when relevant.',
  'If the user asks for songs by an artist, preserve the artist strongly.',
  'If the user asks for a list of songs, use search_songs.',
  'For an explicit add request, return add_song with non-empty song.song_title and song.artist. Difficulty is mandatory: high for demanding/prog/virtuoso material. Resolve known "A - B" title/artist pairs in either order; never leave the entire phrase as the title or ask again when one side is clearly the artist.',
  'Never return add_song for a question about song metadata, a bare acknowledgement, or normal conversation.',
  'For banter/off-topic, clarify.question is a declarative Hebrew roast, never a question or an echo of the user. Use fluent, idiomatic casual Hebrew with correct grammar; create one fresh punchline from the situation rather than repeating the instruction. Music/rehearsal references only when natural.',
  'If the request is ambiguous, return {"action":"clarify","question":"..."} in Hebrew.',
  'Return only valid JSON.'
].join('\n');

const ADDITION_CONFIRMATION_SYSTEM_PROMPT = [
  'You classify a reply to a pending song-addition confirmation.',
  'Choose exactly one decision: positive, negative, or unclear.',
  'Interpret natural Hebrew or English meaning, not fixed keywords. A negative reply declines the add; a positive reply approves it.',
  'No prose or extra words.'
].join('\n');

const SONG_DIFFICULTY_SYSTEM_PROMPT = [
  'You assess a song\'s real band performance difficulty from its title, artist, and known arrangement.',
  'Return only one lowercase word: low, medium, high, or unknown.',
  'Judge the hardest meaningful band parts. Technical, progressive, virtuoso, or demanding instrumental material is high.',
  'Do not default to medium when the song is known.'
].join('\n');

const ACTION_EXECUTION_REVIEW_SYSTEM_PROMPT = [
  'You review whether a proposed mutation by a WhatsApp band bot faithfully follows the user message and its context.',
  'Return exactly one lowercase word: execute or clarify.',
  'Use execute only when the proposed add, update, remove, or feedback action is directly requested and its target is supported by the message or quoted context.',
  'Use clarify for a metadata question, a bare acknowledgement, banter, an uncertain target, or any action that goes beyond what the user asked.',
  'Never infer permission to add, edit, or remove a song.'
].join('\n');

const PLAIN_FALLBACK_SYSTEM_PROMPT = [
  'You are the fallback conversational voice of a Hebrew WhatsApp band bot after structured JSON failed.',
  'Decide semantically whether the user requires a song-library action (add, search, update, remove, feedback, rehearsal, song metadata). If so, return exactly ACTION_UNAVAILABLE.',
  'Otherwise return one short, varied, dry, sarcastic Hebrew reply. Use fluent, idiomatic casual Hebrew with correct grammar. Make one specific punchline from the situation; do not echo the wording, issue a literal command, or ask a question. Be sharp and human, never warm or servicey; no slurs, threats, or protected-trait insults.',
  'Return only the reply text, with no label or markdown.'
].join('\n');

const BANTER_POLISH_SYSTEM_PROMPT = [
  'You are the final Hebrew copy editor for a sarcastic WhatsApp band bot.',
  'Rewrite the draft reply as one short, sharp, natural Hebrew line that responds to the user message.',
  'Fix all grammar, gender, agreement, word order, and punctuation. Preserve the intended bite, but make a real punchline rather than a literal command or paraphrase.',
  'Never ask a question, explain yourself, mention songs unless natural, invent facts, or use slurs, threats, or protected-trait insults.',
  'Return only the final reply text, with no label or markdown.'
].join('\n');

const UNKNOWN_SONG_INFO_SYSTEM_PROMPT = [
  'You answer a narrow factual question about a song that is not in the local band catalog.',
  'Answer only the requested property in short Hebrew, based on your knowledge. If unsure, say that briefly.',
  'Do not claim to have browsed the web, accessed the catalog, or verified a source.',
  'Do not suggest adding the song and do not use markdown.'
].join('\n');

const SONG_REFERENCE_RESOLUTION_SYSTEM_PROMPT = [
  'Extract the referenced song title and artist from a user question about a song.',
  'Return exactly one line in this format: title<TAB>artist. Use an empty artist field when unknown.',
  'Do not answer the question, add songs, or use markdown. If no specific song is identifiable, return exactly UNKNOWN.'
].join('\n');

const SUPPORTED_SEARCH_FIELDS = {
  requirements: ['artist', 'language', 'genres', 'feel', 'difficulty', 'keys_type_any', 'has_keys', 'excludeRejected', 'excludePlayed'],
  preferences: ['genres', 'feel', 'difficulty', 'original_vocal', 'singer_fit', 'vocal_range', 'vocal_energy', 'band_energy', 'groove_level', 'guitar_difficulty', 'bass_difficulty', 'drums_difficulty', 'keys_difficulty', 'keys_role', 'keys_type_any', 'bass_interest', 'crowd_friendly', 'untried'],
  exclusions: ['keys_type_any'],
  enums: {
    language: ['he', 'en'],
    difficulty: ['low', 'medium', 'high'],
    feel: ['upbeat', 'calm', 'ballad'],
    keys_type_any: ['piano', 'electric_piano', 'organ', 'synth', 'clavinet', 'mellotron', 'other']
  }
};

const MAX_CONCURRENT_AGENT_CALLS = 2;
const DEFAULT_MAX_COMPLETION_TOKENS = 800;
const DEFAULT_MAX_RETRIES = 0;

let activeAgentCalls = 0;
const pendingAgentCalls = [];
const usageMetrics = {
  minuteWindowStartedAt: 0,
  minuteCalls: 0,
  dayStamp: '',
  dayCalls: 0,
  minuteInputTokens: 0,
  minuteOutputTokens: 0,
  minuteCachedTokens: 0,
  dayInputTokens: 0,
  dayOutputTokens: 0,
  dayCachedTokens: 0,
  rateLimitResponses: 0
};

function resetUsageWindows(now = new Date()) {
  const minuteBucket = Math.floor(now.getTime() / 60000);
  if (usageMetrics.minuteWindowStartedAt !== minuteBucket) {
    usageMetrics.minuteWindowStartedAt = minuteBucket;
    usageMetrics.minuteCalls = 0;
    usageMetrics.minuteInputTokens = 0;
    usageMetrics.minuteOutputTokens = 0;
    usageMetrics.minuteCachedTokens = 0;
  }

  const dayStamp = now.toISOString().slice(0, 10);
  if (usageMetrics.dayStamp !== dayStamp) {
    usageMetrics.dayStamp = dayStamp;
    usageMetrics.dayCalls = 0;
    usageMetrics.dayInputTokens = 0;
    usageMetrics.dayOutputTokens = 0;
    usageMetrics.dayCachedTokens = 0;
    usageMetrics.rateLimitResponses = 0;
  }
}

function getAgentUsageStats() {
  resetUsageWindows(new Date());
  return { ...usageMetrics, queueDepth: pendingAgentCalls.length, activeCalls: activeAgentCalls };
}

function recordUsage({ promptTokens = 0, completionTokens = 0, cachedTokens = 0, rateLimited = false } = {}) {
  resetUsageWindows(new Date());
  if (rateLimited) {
    usageMetrics.rateLimitResponses += 1;
    return;
  }

  usageMetrics.minuteCalls += 1;
  usageMetrics.dayCalls += 1;
  usageMetrics.minuteInputTokens += promptTokens;
  usageMetrics.dayInputTokens += promptTokens;
  usageMetrics.minuteOutputTokens += completionTokens;
  usageMetrics.dayOutputTokens += completionTokens;
  usageMetrics.minuteCachedTokens += cachedTokens;
  usageMetrics.dayCachedTokens += cachedTokens;
}

function runWithAgentConcurrencyLimit(task) {
  return new Promise((resolve, reject) => {
    const start = () => {
      activeAgentCalls += 1;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          activeAgentCalls -= 1;
          const next = pendingAgentCalls.shift();
          if (next) next();
        });
    };

    if (activeAgentCalls < MAX_CONCURRENT_AGENT_CALLS) {
      start();
      return;
    }

    pendingAgentCalls.push(start);
  });
}

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

function buildAgentPrompt({ messageText, quotedText, replyContext, recentMessages, currentDate, pendingClarification }) {
  return JSON.stringify({
    supported_search_fields: SUPPORTED_SEARCH_FIELDS,
    current_date: currentDate,
    user_message: messageText,
    quoted_message: quotedText ? String(quotedText).trim() : null,
    recent_messages: Array.isArray(recentMessages) ? recentMessages : [],
    reply_context: replyContext || null,
    pending_clarification: pendingClarification || null
  });
}

function buildFallbackAgentPrompt({ messageText, quotedText, replyContext, currentDate, pendingClarification }) {
  return JSON.stringify({
    current_date: currentDate,
    user_message: messageText,
    quoted_message: quotedText ? String(quotedText).trim() : null,
    reply_context: replyContext || null,
    pending_clarification: pendingClarification || null
  });
}

function isJsonValidateFailedError(error) {
  const message = String(error?.message || '');
  return Number(error?.status) === 400 && /json_validate_failed/i.test(message);
}

function isAgentActionValidationError(error) {
  const message = String(error?.message || '');
  return /^(?:agent_action|song|query|updates)\b/i.test(message) &&
    /(?:must be|required|unsupported)/i.test(message);
}

function buildRecoveryClarification(messageText) {
  const source = String(messageText || '').trim()
    .replace(/^(?:בוט\s*[:,\-]?\s*)?/iu, '')
    .trim();
  const addMatch = source.match(/^(?:תוסיף|תוסיפי|להוסיף|add)\s+(.+)$/iu);

  if (addMatch) {
    const requestedSong = String(addMatch[1] || '').trim();
    if (requestedSong) {
      return {
        action: 'clarify',
        question: `מי המבצע של "${requestedSong}"?`
      };
    }
  }

  return {
    action: 'clarify',
    question: 'לא הצלחתי להבין את הבקשה. אפשר לנסח אותה שוב בקצרה?'
  };
}

function buildRateLimitError(response, bodyText) {
  const retryAfterHeader = response.headers.get('retry-after');
  const retryAfterMs = retryAfterHeader ? Number.parseFloat(retryAfterHeader) * 1000 : null;
  const error = new Error(`LLM request failed: ${response.status} ${response.statusText} ${bodyText}`);
  error.status = response.status;
  error.retryAfterMs = Number.isFinite(retryAfterMs) ? retryAfterMs : null;
  error.rateLimited = response.status === 429;
  return error;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callOpenAiCompatibleChat({
  baseUrl,
  apiKey,
  model,
  prompt,
  systemPrompt = SYSTEM_PROMPT,
  requestFn = fetch,
  maxCompletionTokens = DEFAULT_MAX_COMPLETION_TOKENS,
  responseFormat = 'json_object',
  tools,
  messages
}) {
  const endpoint = `${String(baseUrl || '').replace(/\/$/, '')}/chat/completions`;
  const startedAt = Date.now();
  const response = await requestFn(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      ...(responseFormat === 'json_object' && !Array.isArray(tools) ? { response_format: { type: 'json_object' } } : {}),
      ...(Array.isArray(tools) ? { tools, tool_choice: 'auto' } : {}),
      max_completion_tokens: maxCompletionTokens,
      messages: Array.isArray(messages) && messages.length > 0
        ? messages
        : [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt }
          ]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 429) {
      recordUsage({ rateLimited: true });
    }
    throw buildRateLimitError(response, body);
  }

  const data = await response.json();
  const message = data?.choices?.[0]?.message || {};
  const content = message.content || '';
  const parsed = Array.isArray(tools) && Array.isArray(message.tool_calls) && message.tool_calls.length > 0
    ? {
        tool_calls: message.tool_calls.map((call) => ({
          id: String(call?.id || ''),
          name: String(call?.function?.name || ''),
          arguments: String(call?.function?.arguments || '{}')
        }))
      }
    : responseFormat === 'json_object'
      ? extractJsonBlock(content)
      : { text: String(content || '').trim() };
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Could not parse agent JSON response: ${content}`);
  }

  const usage = data?.usage || {};
  const promptTokens = Number.isFinite(Number(usage.prompt_tokens)) ? Number(usage.prompt_tokens) : 0;
  const completionTokens = Number.isFinite(Number(usage.completion_tokens)) ? Number(usage.completion_tokens) : 0;
  const cachedTokens = Number.isFinite(Number(usage?.prompt_tokens_details?.cached_tokens))
    ? Number(usage.prompt_tokens_details.cached_tokens)
    : 0;
  const latencyMs = Date.now() - startedAt;

  recordUsage({ promptTokens, completionTokens, cachedTokens });

  return {
    parsed,
    content: String(content || '').trim(),
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    usage: {
      promptTokens,
      completionTokens,
      cachedTokens,
      totalTokens: Number.isFinite(Number(usage.total_tokens)) ? Number(usage.total_tokens) : promptTokens + completionTokens,
      latencyMs
    }
  };
}

function estimateActionName(parsedAction) {
  return typeof parsedAction?.action === 'string' ? parsedAction.action : 'unknown';
}

function inferRequestedLimit(messageText) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return null;

  const digitMatch = source.match(/(?:^|\s)(\d{1,2})\s+שירים?(?:\s|$)|שירים?\s+(\d{1,2})(?:\s|$)/iu);
  if (digitMatch) {
    const parsed = Number.parseInt(digitMatch[1] || digitMatch[2], 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }

  const hebrewWordLimits = [
    { limit: 1, values: ['אחד', 'אחת'] },
    { limit: 2, values: ['שניים', 'שני', 'שתיים', 'שתי'] },
    { limit: 3, values: ['שלושה', 'שלוש'] },
    { limit: 4, values: ['ארבעה', 'ארבע'] },
    { limit: 5, values: ['חמישה', 'חמש'] },
    { limit: 6, values: ['שישה', 'שש'] },
    { limit: 7, values: ['שבעה', 'שבע'] },
    { limit: 8, values: ['שמונה'] },
    { limit: 9, values: ['תשעה', 'תשע'] },
    { limit: 10, values: ['עשרה', 'עשר'] }
  ];

  for (const candidate of hebrewWordLimits) {
    for (const value of candidate.values) {
      if (
        source.includes(`${value} שירים`) ||
        source.includes(`${value} שיר`) ||
        source.includes(`שירים ${value}`) ||
        source.includes(`שיר ${value}`)
      ) {
        return candidate.limit;
      }
    }
  }

  const englishDigitMatch = source.match(/(?:^|\s)(\d{1,2})\s+songs?\b|songs?\s+(\d{1,2})(?:\s|$)/i);
  if (englishDigitMatch) {
    const parsed = Number.parseInt(englishDigitMatch[1] || englishDigitMatch[2], 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }

  if (/(\s|^)שיר(\s|$)/iu.test(source) && !/שירים/iu.test(source)) {
    return 1;
  }

  if (/(\s|^)song(\s|$)/i.test(source) && !/songs/i.test(source)) {
    return 1;
  }

  return null;
}

function inferRequestedLanguage(messageText) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return null;

  if (/(?:בעברית|עברית|שירים עבריים|שיר עברי|hebrew)/iu.test(source)) {
    return 'he';
  }

  if (/(?:באנגלית|אנגלית|שירים באנגלית|שיר באנגלית|english)/iu.test(source)) {
    return 'en';
  }

  return null;
}

async function interpretAdditionConfirmation({
  baseUrl,
  apiKey,
  model,
  messageText,
  pendingSong,
  requestFn
}) {
  const prompt = JSON.stringify({
    pending_addition: {
      song_title: pendingSong?.song_title || null,
      artist: pendingSong?.artist || null,
      difficulty: pendingSong?.difficulty || null
    },
    user_reply: String(messageText || '').trim()
  });
  const { parsed } = await runWithAgentConcurrencyLimit(() => callOpenAiCompatibleChat({
    baseUrl,
    apiKey,
    model,
    prompt,
    systemPrompt: `${ADDITION_CONFIRMATION_SYSTEM_PROMPT}\nReturn only one lowercase word: positive, negative, or unclear.`,
    requestFn,
    maxCompletionTokens: 256,
    responseFormat: 'text'
  }));
  const decision = String(parsed?.text || '').trim().toLowerCase();
  return ['positive', 'negative', 'unclear'].includes(decision) ? decision : 'unclear';
}

async function interpretSongDifficulty({ baseUrl, apiKey, model, song, requestFn }) {
  const prompt = JSON.stringify({
    song_title: song?.song_title || null,
    artist: song?.artist || null,
    current_difficulty: song?.difficulty || null,
    ai_metadata: song?.ai_metadata || null
  });
  const { parsed } = await runWithAgentConcurrencyLimit(() => callOpenAiCompatibleChat({
    baseUrl,
    apiKey,
    model,
    prompt,
    systemPrompt: SONG_DIFFICULTY_SYSTEM_PROMPT,
    requestFn,
    // Reasoning-capable models may spend the first tokens internally and emit
    // an empty visible response with a tiny cap. Leave enough room to return
    // the final one-word assessment.
    maxCompletionTokens: 512,
    responseFormat: 'text'
  }));
  const rawDifficulty = String(parsed?.text || '').trim().toLowerCase();
  const match = rawDifficulty.match(/(?:^|[^a-z])(low|medium|high)(?:$|[^a-z])/i);
  if (!match) {
    console.warn(`[agent] difficulty_review_unrecognized=${JSON.stringify(rawDifficulty)}`);
    return null;
  }
  return match[1].toLowerCase();
}

async function reviewAgentActionExecution({
  baseUrl,
  apiKey,
  model,
  messageText,
  quotedText,
  pendingClarification,
  action,
  requestFn
}) {
  const prompt = JSON.stringify({
    user_message: String(messageText || '').trim(),
    quoted_message: String(quotedText || '').trim() || null,
    pending_clarification: pendingClarification || null,
    proposed_action: action || null
  });
  const { parsed } = await runWithAgentConcurrencyLimit(() => callOpenAiCompatibleChat({
    baseUrl,
    apiKey,
    model,
    prompt,
    systemPrompt: ACTION_EXECUTION_REVIEW_SYSTEM_PROMPT,
    requestFn,
    maxCompletionTokens: 256,
    responseFormat: 'text'
  }));
  return /^execute\b/i.test(String(parsed?.text || '').trim()) ? 'execute' : 'clarify';
}

async function interpretPlainFallbackReply({ baseUrl, apiKey, model, messageText, quotedText, requestFn }) {
  const prompt = JSON.stringify({
    user_message: String(messageText || '').trim(),
    quoted_message: String(quotedText || '').trim() || null
  });
  const { parsed } = await runWithAgentConcurrencyLimit(() => callOpenAiCompatibleChat({
    baseUrl,
    apiKey,
    model,
    prompt,
    systemPrompt: PLAIN_FALLBACK_SYSTEM_PROMPT,
    requestFn,
    maxCompletionTokens: 512,
    responseFormat: 'text'
  }));
  const reply = String(parsed?.text || '').trim();
  return reply || null;
}

async function polishBanterReply({ baseUrl, apiKey, model, messageText, draftReply, requestFn }) {
  const prompt = JSON.stringify({
    user_message: String(messageText || '').trim(),
    draft_reply: String(draftReply || '').trim()
  });
  const { parsed } = await runWithAgentConcurrencyLimit(() => callOpenAiCompatibleChat({
    baseUrl, apiKey, model, prompt, systemPrompt: BANTER_POLISH_SYSTEM_PROMPT,
    requestFn, maxCompletionTokens: 160, responseFormat: 'text'
  }));
  const reply = String(parsed?.text || '').trim();
  return reply && reply !== 'ACTION_UNAVAILABLE' ? reply : null;
}

async function interpretUnknownSongInfo({ baseUrl, apiKey, model, songTitle, artist, question, catalogSong, requestFn }) {
  const prompt = JSON.stringify({
    song_title: String(songTitle || '').trim(),
    artist: String(artist || '').trim() || null,
    user_question: String(question || '').trim(),
    local_catalog_data: catalogSong || null
  });
  const { parsed } = await runWithAgentConcurrencyLimit(() => callOpenAiCompatibleChat({
    baseUrl, apiKey, model, prompt, systemPrompt: UNKNOWN_SONG_INFO_SYSTEM_PROMPT,
    requestFn, maxCompletionTokens: 256, responseFormat: 'text'
  }));
  return String(parsed?.text || '').trim() || null;
}

async function resolveSongReference({ baseUrl, apiKey, model, messageText, quotedText, requestFn }) {
  const prompt = JSON.stringify({ user_question: String(messageText || '').trim(), quoted_message: String(quotedText || '').trim() || null });
  const { parsed } = await runWithAgentConcurrencyLimit(() => callOpenAiCompatibleChat({
    baseUrl, apiKey, model, prompt, systemPrompt: SONG_REFERENCE_RESOLUTION_SYSTEM_PROMPT,
    requestFn, maxCompletionTokens: 256, responseFormat: 'text'
  }));
  const line = String(parsed?.text || '').trim();
  if (!line || line.toUpperCase() === 'UNKNOWN') return null;
  const parts = line.split(/\t|\s*\|\s*|\r?\n/u);
  const [rawTitle, rawArtist = ''] = parts;
  const songTitle = String(rawTitle || '').trim();
  const artist = String(rawArtist || '').trim();
  return songTitle ? { song_title: songTitle, artist: artist || null } : null;
}

function isRehearsalPlanRequest(messageText) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return false;

  return /(?:חזרה|לחזרה|rehearsal|setlist)/iu.test(source)
    && /(?:תכין|תכיני|רשימת|רשימה|הקרובה|הבאה|prepare|plan)/iu.test(source);
}

function inferRequestedDurationMinutes(messageText) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return null;

  const hourDigitMatch = source.match(/(\d{1,2})\s*ש(?:עה|עות)/iu);
  if (hourDigitMatch) {
    const hours = Number.parseInt(hourDigitMatch[1], 10);
    if (Number.isInteger(hours) && hours > 0) {
      return hours * 60;
    }
  }

  const minuteDigitMatch = source.match(/(\d{2,3})\s*דק(?:ה|ות)?/iu);
  if (minuteDigitMatch) {
    const minutes = Number.parseInt(minuteDigitMatch[1], 10);
    if (Number.isInteger(minutes) && minutes > 0) {
      return minutes;
    }
  }

  if (/(?:שעתיים|two hours)/iu.test(source)) return 120;
  if (/(?:שעה וחצי|hour and a half)/iu.test(source)) return 90;
  if (/(?:שעה אחת|one hour)/iu.test(source)) return 60;
  if (/(?:שלוש שעות|three hours)/iu.test(source)) return 180;
  if (/(?:ארבע שעות|four hours)/iu.test(source)) return 240;

  return null;
}

function inferRequestedGenres(messageText) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return [];

  const genrePatterns = [
    { genre: 'blues', patterns: [/(?:בלוז|blues)/iu] },
    { genre: 'rock', patterns: [/(?:רוק|rock)/iu] },
    { genre: 'funk', patterns: [/(?:פאנק|funk)/iu] },
    { genre: 'jazz', patterns: [/(?:ג'?אז|jazz)/iu] },
    { genre: 'metal', patterns: [/(?:מטאל|metal)/iu] },
    { genre: 'pop', patterns: [/(?:פופ|pop)/iu] },
    { genre: 'ballad', patterns: [/(?:בלדה|ballad)/iu] }
  ];

  return genrePatterns
    .filter((entry) => entry.patterns.some((pattern) => pattern.test(source)))
    .map((entry) => entry.genre);
}

function inferInstrumentDifficultyPreferences(messageText) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return {};

  const difficulty =
    /(?:קשה|קשים|קשות|קשוח|קשוחה|מאתגר|מאתגרת|מסובך|מסובכת|hard|challenging)/iu.test(source)
      ? 'high'
      : /(?:^|\s)(?:קל|קלה|קלים|קלות|פשוט|פשוטה|easy)(?:\s|$)/iu.test(source)
        ? 'low'
        : null;

  if (!difficulty) return {};

  const preferences = {};
  if (/(?:תיפוף|תופים|מתופף|drums?|drumming)/iu.test(source)) {
    preferences.drums_difficulty = difficulty;
  }
  if (/(?:גיטרה|גיטר[היסטס]?|guitar)/iu.test(source)) {
    preferences.guitar_difficulty = difficulty;
  }
  if (/(?:בס|בסיסט|bass)/iu.test(source)) {
    preferences.bass_difficulty = difficulty;
  }
  if (/(?:קלידים|פסנתר|keys|keyboard|piano)/iu.test(source)) {
    preferences.keys_difficulty = difficulty;
  }

  return preferences;
}

function inferPerformerFitPreferences(messageText) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return {};

  const preferences = {};

  if (/(?:זמרת|סולנית|female vocal|female singer)/iu.test(source)) {
    preferences.original_vocal = 'female';
    preferences.singer_fit = 'great';
  } else if (/(?:זמר|סולן|male vocal|male singer)/iu.test(source)) {
    preferences.original_vocal = 'male';
    preferences.singer_fit = 'great';
  }

  if (/(?:מתאים לקול שלנו|שיתאים לנו לשיר|שנוכל לשיר|singable|easy to sing)/iu.test(source)) {
    preferences.singer_fit = preferences.singer_fit || 'great';
  }

  return preferences;
}

// Override the earlier helper so keyboard semantics stay with the agent.
function inferInstrumentDifficultyPreferences(messageText) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return {};

  const difficulty =
    /(?:×§×©×”|×§×©×™×|×§×©×•×ª|×§×©×•×—|×§×©×•×—×”|×ž××ª×’×¨|×ž××ª×’×¨×ª|×ž×¡×•×‘×š|×ž×¡×•×‘×›×ª|hard|challenging)/iu.test(source)
      ? 'high'
      : /(?:^|\s)(?:×§×œ|×§×œ×”|×§×œ×™×|×§×œ×•×ª|×¤×©×•×˜|×¤×©×•×˜×”|easy)(?:\s|$)/iu.test(source)
        ? 'low'
        : null;

  if (!difficulty) return {};

  const preferences = {};
  if (/(?:×ª×™×¤×•×£|×ª×•×¤×™×|×ž×ª×•×¤×£|drums?|drumming)/iu.test(source)) {
    preferences.drums_difficulty = difficulty;
  }
  if (/(?:×’×™×˜×¨×”|×’×™×˜×¨[×”×™×¡×˜×¡]?|guitar)/iu.test(source)) {
    preferences.guitar_difficulty = difficulty;
  }
  if (/(?:×‘×¡|×‘×¡×™×¡×˜|bass)/iu.test(source)) {
    preferences.bass_difficulty = difficulty;
  }

  return preferences;
}

const ARTIST_ALIAS_MAP = new Map([
  ['פינק פלויד', 'Pink Floyd'],
  ['פינקפלויד', 'Pink Floyd'],
  ['הביטלס', 'The Beatles'],
  ['ביטלס', 'The Beatles'],
  ['לד זפלין', 'Led Zeppelin'],
  ['דיפ פרפל', 'Deep Purple'],
  ['קווין', 'Queen'],
  ['פורינר', 'Foreigner'],
  ['אבבא', 'ABBA']
]);

function canonicalizeRequestedArtistName(value) {
  const artist = String(value || '').trim();
  if (!artist) return null;
  return ARTIST_ALIAS_MAP.get(artist) || artist;
}

function cleanInferredArtistName(value) {
  return String(value || '')
    .replace(/^(?:של|by)\s+/iu, '')
    .replace(/\s+(?:בעברית|עברית|באנגלית|אנגלית|hebrew|english)\b.*$/iu, '')
    .replace(/\s+(?:עם|לזמר(?:ת)?|ללהקה)\b.*$/iu, '')
    .trim();
}

function inferRequestedArtist(messageText) {
  const source = String(messageText || '').trim();
  if (!source) return null;

  const patterns = [
    /^של\s+(.+)$/iu,
    /(?:^|\s)שירים?\s+של\s+(.+)$/iu,
    /(?:^|\s)תביא\s+שירים?\s+של\s+(.+)$/iu,
    /(?:^|\s)songs?\s+by\s+(.+)$/i,
    /(?:^|\s)play\s+songs?\s+by\s+(.+)$/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match) continue;
    const artist = canonicalizeRequestedArtistName(cleanInferredArtistName(match[1]));
    if (artist) return artist;
  }

  return null;
}

function messageContainsHebrew(value) {
  return /[\u0590-\u05FF]/u.test(String(value || ''));
}

function shouldOverrideArtistRequirement({ messageText, inferredArtist, existingArtist }) {
  if (!inferredArtist) return false;
  if (!existingArtist) return true;
  if (!messageContainsHebrew(messageText)) return false;

  const normalizedExistingArtist = String(existingArtist || '').trim();
  if (!normalizedExistingArtist) return true;
  if (normalizedExistingArtist === inferredArtist) return false;

  const canonicalInferredArtist = canonicalizeRequestedArtistName(inferredArtist);
  if (normalizedExistingArtist === canonicalInferredArtist) {
    return false;
  }

  return true;
}

function getExplicitAddCandidate(messageText) {
  const source = String(messageText || '').trim();
  if (!source) return null;

  const cleaned = source
    .replace(/^(?:בוט\s*[:,\-]?\s*)?/iu, '')
    .trim();

  const addMatch = cleaned.match(/^(?:תוסיף|תוסיפי|להוסיף|add)\s+(.+)$/iu);
  if (!addMatch) return null;

  const candidate = String(addMatch[1] || '').trim();
  return candidate || null;
}

function getDashedAddParts(messageText) {
  const candidate = getExplicitAddCandidate(messageText);
  const match = String(candidate || '').match(/^(.+?)\s*[-–—]\s*(.+)$/u);
  if (!match) return null;

  const left = String(match[1] || '').trim();
  const right = String(match[2] || '').trim();
  return left && right ? { left, right } : null;
}

function sameSongIdentityPart(left, right) {
  return String(left || '').trim().normalize('NFKC').toLocaleLowerCase() ===
    String(right || '').trim().normalize('NFKC').toLocaleLowerCase();
}

function inferAddSongPayload(messageText) {
  const candidate = getExplicitAddCandidate(messageText);
  if (!candidate) return null;

  let songTitle = '';
  let artist = '';
  const hebrewSeparator = candidate.lastIndexOf(' של ');
  if (hebrewSeparator > 0) {
    songTitle = candidate.slice(0, hebrewSeparator).trim();
    artist = candidate.slice(hebrewSeparator + ' של '.length).trim();
  } else {
    const englishSplit = candidate.match(/^(.*?)\s+by\s+(.+)$/i);
    if (englishSplit) {
      songTitle = englishSplit[1].trim();
      artist = englishSplit[2].trim();
    }
  }

  // A title-only request still helps repair a malformed LLM response that already supplied the artist.
  // Do not create a title-only song: schema validation will instead prompt for the missing artist.
  if (!songTitle) {
    songTitle = candidate;
  }
  if (!songTitle) return null;

  return {
    song_title: songTitle,
    artist: artist || null,
    confidence: 0.5
  };
}

function inferUnambiguousAddSongPayload(messageText) {
  const candidate = getExplicitAddCandidate(messageText);
  if (!candidate) return null;

  const hebrewSeparator = candidate.lastIndexOf(' של ');
  if (hebrewSeparator > 0) {
    const songTitle = candidate.slice(0, hebrewSeparator).trim();
    const artist = candidate.slice(hebrewSeparator + ' של '.length).trim();
    return songTitle && artist ? { song_title: songTitle, artist, confidence: 0.5 } : null;
  }

  const bySplit = candidate.match(/^(.*?)\s+by\s+(.+)$/i);
  if (!bySplit) return null;
  const songTitle = bySplit[1].trim();
  const artist = bySplit[2].trim();
  return songTitle && artist ? { song_title: songTitle, artist, confidence: 0.5 } : null;
}

function inferAddSongFromArtistReply(messageText, quotedText) {
  const artist = String(messageText || '').trim();
  const quoted = String(quotedText || '').trim();
  if (!artist || artist.length > 120 || !quoted) return null;

  const titleMatch = quoted.match(/(?:מי המבצע של|who (?:is the )?(?:artist|performer) (?:for|of))\s*["“]?(.+?)["”?؟]/iu);
  const songTitle = String(titleMatch?.[1] || '').trim();
  if (!songTitle) return null;

  // A recovery question can quote the original "title - artist" text. Once
  // the user supplies an artist that equals either side, the title is no
  // longer ambiguous; never persist the complete dashed phrase as its title.
  const dashedMatch = songTitle.match(/^(.+?)\s*[-–—]\s*(.+)$/u);
  if (dashedMatch) {
    const left = String(dashedMatch[1] || '').trim();
    const right = String(dashedMatch[2] || '').trim();
    if (sameSongIdentityPart(artist, left)) {
      return { song_title: right, artist, confidence: 0.5 };
    }
    if (sameSongIdentityPart(artist, right)) {
      return { song_title: left, artist, confidence: 0.5 };
    }
  }

  return { song_title: songTitle, artist, confidence: 0.5 };
}

function shouldAvoidPreviousResults(messageText, replyContext) {
  if (!replyContext?.results?.length) return false;
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return false;

  return /(?:עוד|אחר(?:ים|ות)?|שונ(?:ים|ות)?|חדשים|חדש|נוספ(?:ים|ות)?|במקום|לא אלה|משהו אחר)/iu.test(source);
}

function isReplacementRequest(messageText, replyContext) {
  if (!replyContext?.results?.length) return false;
  const source = String(messageText || '').trim();
  if (!source) return false;
  return /(?:תחליף|תחליפי|להחליף|אחרים במקום|במקום\s+\d|replace)/iu.test(source);
}

function inferFeedbackIssue(messageText) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return [];

  if (/(?:קשה מדי|הוא קשה|היא קשה|קשה|מסובך|מסובכת|מסובכים|גבוה מדי|נמוך מדי)/iu.test(source)) {
    return ['too_hard'];
  }
  if (/(?:קל מדי|קל|פשוט מדי|פשוטה מדי)/iu.test(source)) {
    return ['too_easy'];
  }
  if (/(?:לא גרובי|לא יושב|לא זורם|לא עובד|לא עבד|לא מתאימ(?:ה|ים)|לא לנו)/iu.test(source)) {
    return ['doesnt_groove'];
  }
  return [];
}

function inferFeedbackFit(messageText) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return null;

  if (/(?:לא עובד|לא עבד|לא מתאים|לא מתאימה|קשה מדי|קל מדי|תסיר|להסיר|לא לנו)/iu.test(source)) {
    return 'bad';
  }
  return null;
}

function inferResultIndexesFromMessage(messageText) {
  const source = String(messageText || '').trim();
  if (!source) return [];

  const matches = Array.from(source.matchAll(/(?:שיר\s*)?(\d{1,2})(?!\d)/giu));
  return Array.from(
    new Set(
      matches
        .map((match) => Number.parseInt(match[1], 10))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
}

function inferPositiveFeedbackFit(messageText) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return null;

  if (/(?:היה כיף|כיף לנגן|כיף לשיר|הלך טוב|הלכה טוב|עבד טוב|עבדה טוב|מעולה|מצוין|אהבנו|אהבנו אותו|זרם טוב|ישב טוב)/iu.test(source)) {
    return 'good';
  }

  return null;
}

function inferFitFromIssues(issues) {
  if (!Array.isArray(issues) || issues.length === 0) {
    return null;
  }

  if (issues.some((issue) => issue === 'too_hard' || issue === 'doesnt_groove')) {
    return 'bad';
  }
  if (issues.some((issue) => issue === 'too_easy')) {
    return 'maybe';
  }

  return null;
}

function isComfortPositiveFeedback(messageText) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return false;

  return /(?:קל לנו|קל לנו לנגן|קל לשיר|יושב לנו טוב|זורם לנו)/iu.test(source);
}

function inferHeuristicFeedbackFit(messageText, issues) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return inferFitFromIssues(issues);

  if (isComfortPositiveFeedback(messageText)) {
    return 'good';
  }

  if (/(?:קל מדי|יותר מדי קל|פשוט מדי|פשוטה מדי)/iu.test(source)) {
    return 'maybe';
  }

  if (/(?:לא עובד|לא עבד|לא מתאים|לא מתאימה|לא לנו|קשה מדי|קשה לנו|תסיר|להסיר)/iu.test(source)) {
    return 'bad';
  }

  return inferFitFromIssues(issues);
}

function inferFeedbackIssue(messageText) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return [];

  if (/(?:קשה מדי|הוא קשה|היא קשה|קשה|מאתגר|מאתגרת|מאתגרים|challenging|מסובך|מסובכת|מסובכים|גבוה מדי|נמוך מדי)/iu.test(source)) {
    return ['too_hard'];
  }
  if (/(?:קל מדי|קל|פשוט מדי|פשוטה מדי)/iu.test(source)) {
    return ['too_easy'];
  }
  if (/(?:לא גרובי|לא יושב|לא זורם|לא עובד|לא עבד|לא מתאים(?:ה|ים)?|לא לנו)/iu.test(source)) {
    return ['doesnt_groove'];
  }
  return [];
}

function inferPositiveFeedbackFit(messageText) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return null;

  if (/(?:היה כיף|כיף לנגן|כיף לשיר|נהניתי|נהנינו|נהנו|נהנו לנגן|הלך טוב|הלכה טוב|עבד טוב|עבדה טוב|מעולה|מצוין|אהבנו|אהבנו אותו|זרם טוב|ישב טוב)/iu.test(source)) {
    return 'good';
  }

  return null;
}

function hasDifficultyFeedback(messageText) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return false;

  return /(?:קשה מדי|קשה לנו|הוא קשה|היא קשה|קשה|מאתגר|מאתגרת|מאתגרים|challenging|מסובך|מסובכת|מסובכים)/iu.test(source);
}

function isComfortPositiveFeedback(messageText) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return false;

  return /(?:קל לנו|קל לנו לנגן|קל לשיר|יושב לנו טוב|זורם לנו)/iu.test(source);
}

function inferHeuristicFeedbackFit(messageText, issues) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return inferFitFromIssues(issues);

  const positiveFit = inferPositiveFeedbackFit(messageText);
  if (positiveFit && hasDifficultyFeedback(messageText)) {
    return 'maybe';
  }

  if (isComfortPositiveFeedback(messageText)) {
    return 'good';
  }

  if (/(?:קל מדי|יותר מדי קל|פשוט מדי|פשוטה מדי)/iu.test(source)) {
    return 'maybe';
  }

  if (/(?:לא עובד|לא עבד|לא מתאים|לא מתאימה|לא לנו|קשה מדי|קשה לנו|תסיר|להסיר)/iu.test(source)) {
    return 'bad';
  }

  if (positiveFit) {
    return positiveFit;
  }

  return inferFitFromIssues(issues);
}

function inferPositiveFeedbackFit(messageText) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return null;

  if (/(?:היה כיף|כיף לנגן|כיף לשיר|נהניתי|נהנינו|נהנו|נהנו לנגן|הלך טוב|הלכה טוב|עבד טוב|עבדה טוב|(?:^|\s)עבד(?:\s|$)|מעולה|מצוין|אהבנו|אהבנו אותו|זרם טוב|ישב טוב)/iu.test(source)) {
    return 'good';
  }

  return null;
}

function inferHeuristicFeedbackFit(messageText, issues) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return inferFitFromIssues(issues);

  const positiveFit = inferPositiveFeedbackFit(messageText);
  if (positiveFit && hasDifficultyFeedback(messageText)) {
    return 'maybe';
  }

  if (isComfortPositiveFeedback(messageText)) {
    return 'good';
  }

  if (/(?:קל מדי|יותר מדי קל|פשוט מדי|פשוטה מדי)/iu.test(source)) {
    return 'maybe';
  }

  if (/(?:לא עובד|לא עבד|לא מתאים|לא מתאימה|לא לנו|קשה מדי|קשה לנו|תסיר|להסיר)/iu.test(source)) {
    return 'bad';
  }

  if (positiveFit) {
    return positiveFit;
  }

  return inferFitFromIssues(issues);
}

function normalizeFeedbackUpdates(action, messageText) {
  if (Array.isArray(action.updates) && action.updates.length > 0) {
    const fallbackIndexes = inferResultIndexesFromMessage(messageText);
    return action.updates.map((entry, index) => {
      const item = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
      const parsedEntryIndex = Number.parseInt(item.result_index, 10);
      const fallbackResultIndex = fallbackIndexes[index] || fallbackIndexes[0] || null;
      const resultIndex =
        Number.isInteger(parsedEntryIndex) && parsedEntryIndex > 0
          ? parsedEntryIndex
          : fallbackResultIndex;
      const rawIssues = Array.isArray(item.issues) && item.issues.length > 0 ? item.issues : inferFeedbackIssue(messageText);
      const issues =
        isComfortPositiveFeedback(messageText) && rawIssues.includes('too_easy')
          ? rawIssues.filter((issue) => issue !== 'too_easy')
          : rawIssues;
      const fit =
        inferHeuristicFeedbackFit(messageText, issues) ||
        item.fit ||
        inferPositiveFeedbackFit(messageText) ||
        inferFeedbackFit(messageText) ||
        inferFitFromIssues(issues);
      const notes =
        item.notes === undefined || item.notes === null || String(item.notes).trim() === ''
          ? String(messageText || '').trim()
          : String(item.notes);

      return {
        ...item,
        result_index: resultIndex,
        fit,
        issues,
        notes
      };
    }).filter((entry) => Number.isInteger(entry.result_index) && entry.result_index > 0);
  }

  const explicitResultIndex = Number.parseInt(action.result_index, 10);
  const resultIndexes =
    Number.isInteger(explicitResultIndex) && explicitResultIndex > 0
      ? [explicitResultIndex]
      : inferResultIndexesFromMessage(messageText);
  if (!resultIndexes.length) {
    return [];
  }

  const rawTopLevelIssues = Array.isArray(action.issues) ? action.issues : inferFeedbackIssue(messageText);
  const topLevelIssues =
    isComfortPositiveFeedback(messageText) && rawTopLevelIssues.includes('too_easy')
      ? rawTopLevelIssues.filter((issue) => issue !== 'too_easy')
      : rawTopLevelIssues;
  const topLevelFit =
    inferHeuristicFeedbackFit(messageText, topLevelIssues) ||
    action.fit ||
    inferPositiveFeedbackFit(messageText) ||
    inferFeedbackFit(messageText) ||
    inferFitFromIssues(topLevelIssues);
  const topLevelNotes =
    action.notes === undefined || action.notes === null || String(action.notes).trim() === ''
      ? String(messageText || '').trim()
      : String(action.notes);

  return resultIndexes.map((resultIndex) => ({
    result_index: resultIndex,
    fit: topLevelFit,
    issues: topLevelIssues,
    notes: topLevelNotes
  }));
}

function inferCorrectionUpdates(messageText, replyContext) {
  const source = String(messageText || '').trim();
  if (!source) return {};

  let corrected = source
    .replace(/^(?:בוט\s*[:,\-]?\s*)?/iu, '')
    .replace(/^(?:תתקן|תקן|תעדכן|עדכן|שנה)\s+(?:את\s+)?\d+\s+(?:ל|ל-)\s*/iu, '')
    .replace(/^(?:האמן\s+של\s+\d+\s+הוא)\s+/iu, '')
    .trim();

  if (!corrected) return {};

  const resultIndexes = inferResultIndexesFromMessage(messageText);
  const referenceEntry =
    resultIndexes.length > 0 && Array.isArray(replyContext?.results)
      ? replyContext.results.find((entry) => entry?.index === resultIndexes[0])
      : null;

  if (/^(?:the|a|an)\s+/i.test(corrected) && !/\s+של\s+/u.test(corrected)) {
    return { artist: corrected };
  }

  const artistSeparator = ' של ';
  const lastArtistSeparatorIndex = corrected.lastIndexOf(artistSeparator);
  if (lastArtistSeparatorIndex > 0) {
    return {
      song_title: corrected.slice(0, lastArtistSeparatorIndex).trim(),
      artist: corrected.slice(lastArtistSeparatorIndex + artistSeparator.length).trim()
    };
  }

  if (referenceEntry?.artist && referenceEntry?.title) {
    const normalizedCorrected = corrected.toLowerCase();
    const normalizedArtist = String(referenceEntry.artist || '').trim().toLowerCase();
    const normalizedTitle = String(referenceEntry.title || '').trim().toLowerCase();
    if (normalizedArtist && normalizedCorrected === normalizedArtist) {
      return { artist: corrected };
    }
    if (!normalizedArtist || normalizedCorrected !== normalizedTitle) {
      return { song_title: corrected };
    }
  }

  return { song_title: corrected };
}

function normalizeUpdateSongAction(action, messageText, replyContext) {
  const normalized = { ...action };
  const updates =
    action.updates && typeof action.updates === 'object' && !Array.isArray(action.updates)
      ? { ...action.updates }
      : {};

  if (updates.song_title || updates.artist || updates.language || updates.genres || updates.difficulty || updates.feel || 'chords_url' in updates) {
    normalized.updates = updates;
    return normalized;
  }

  if (typeof action.song_title === 'string' && action.song_title.trim() && !updates.song_title) {
    updates.song_title = action.song_title.trim();
  }
  if (typeof action.artist === 'string' && action.artist.trim() && !updates.artist) {
    updates.artist = action.artist.trim();
  }

  Object.assign(updates, inferCorrectionUpdates(messageText, replyContext), updates);
  normalized.updates = updates;
  return normalized;
}

function normalizeAgentAction(action, { messageText, replyContext, quotedText }) {
  if (!action || typeof action !== 'object') return action;
  const artistReplyAdd = inferAddSongFromArtistReply(messageText, quotedText);
  if (artistReplyAdd) {
    return { action: 'add_song', song: artistReplyAdd };
  }
  const rehearsalRequest = isRehearsalPlanRequest(messageText);
  const inferredDurationMinutes = inferRequestedDurationMinutes(messageText);
  if (action.action === 'update_song_feedback') {
    return {
      ...action,
      updates: normalizeFeedbackUpdates(action, messageText)
    };
  }

  if (action.action === 'update_song') {
    return normalizeUpdateSongAction(action, messageText, replyContext);
  }

  if (action.action === 'add_song') {
    const inferredAddSong = inferAddSongPayload(messageText);
    if (!inferredAddSong) {
      return action;
    }

    const song = action.song && typeof action.song === 'object' && !Array.isArray(action.song)
      ? { ...action.song }
      : {};
    const dashedParts = getDashedAddParts(messageText);
    const dashedInput = Boolean(dashedParts);
    const unambiguousIdentity = inferUnambiguousAddSongPayload(messageText);
    const titleFromModel = typeof song.song_title === 'string' ? song.song_title.trim() : '';
    const artistFromModel = typeof song.artist === 'string' ? song.artist.trim() : '';
    const duplicateDashedIdentity = dashedInput && titleFromModel && artistFromModel &&
      sameSongIdentityPart(titleFromModel, artistFromModel);
    // The model may correctly recognize the artist but leave the original whole
    // "artist - title" phrase in song_title. Once it identifies either side, the
    // split is unambiguous; support both orders without making a blanket guess.
    const titleFromDashedArtistMatch = dashedParts && artistFromModel
      ? (sameSongIdentityPart(artistFromModel, dashedParts.left)
          ? dashedParts.right
          : (sameSongIdentityPart(artistFromModel, dashedParts.right) ? dashedParts.left : null))
      : null;

    return {
      ...action,
      song: {
        ...inferredAddSong,
        ...song,
        song_title: unambiguousIdentity?.song_title || titleFromDashedArtistMatch || (titleFromModel
          ? song.song_title.trim()
          : inferredAddSong.song_title),
        artist: unambiguousIdentity?.artist || (!duplicateDashedIdentity && artistFromModel
          ? song.artist.trim()
          : inferredAddSong.artist)
      }
    };
  }

  if (action.action === 'clarify') {
    if (rehearsalRequest) {
      return {
        action: 'prepare_rehearsal',
        query: {},
        duration_minutes: inferredDurationMinutes || 180
      };
    }

    const inferredAddSong = inferAddSongPayload(messageText);
    if (inferredAddSong) {
      return {
        action: 'add_song',
        song: inferredAddSong
      };
    }

    const replacementIndexes = inferResultIndexesFromMessage(messageText);
    if (isReplacementRequest(messageText, replyContext) && replacementIndexes.length > 0) {
      return {
        action: 'search_songs',
        query: {
          replace_result_indexes: replacementIndexes,
          avoid_previous_results: true,
          limit: replacementIndexes.length
        }
      };
    }
  }

  if (action.action !== 'search_songs' && action.action !== 'find_similar_songs' && action.action !== 'prepare_rehearsal') {
    return action;
  }

  const query =
    action.query && typeof action.query === 'object' && !Array.isArray(action.query)
      ? { ...action.query }
      : {};
  const requirements =
    query.requirements && typeof query.requirements === 'object' && !Array.isArray(query.requirements)
      ? { ...query.requirements }
      : {};
  const preferences =
    query.preferences && typeof query.preferences === 'object' && !Array.isArray(query.preferences)
      ? { ...query.preferences }
      : {};

  if (action.action !== 'prepare_rehearsal' && !Number.isInteger(Number.parseInt(query.limit, 10))) {
    const inferredLimit = inferRequestedLimit(messageText);
    if (inferredLimit) {
      query.limit = inferredLimit;
    }
  }

  if (action.action === 'search_songs' && shouldAvoidPreviousResults(messageText, replyContext)) {
    query.avoid_previous_results = true;
  }

  if (action.action === 'search_songs') {
    const replacementIndexes = inferResultIndexesFromMessage(messageText);
    if (isReplacementRequest(messageText, replyContext) && replacementIndexes.length > 0) {
      query.replace_result_indexes = replacementIndexes;
      query.avoid_previous_results = true;
      if (!Number.isInteger(Number.parseInt(query.limit, 10))) {
        query.limit = replacementIndexes.length;
      }
    }
  }

  if (!requirements.language) {
    const inferredLanguage = inferRequestedLanguage(messageText);
    if (inferredLanguage) {
      requirements.language = inferredLanguage;
    }
  }

  const inferredArtist = inferRequestedArtist(messageText);
  if (shouldOverrideArtistRequirement({
    messageText,
    inferredArtist,
    existingArtist: requirements.artist
  })) {
    requirements.artist = inferredArtist;
  }

  if ((!Array.isArray(requirements.genres) || requirements.genres.length === 0)) {
    const inferredGenres = inferRequestedGenres(messageText);
    if (inferredGenres.length > 0) {
      requirements.genres = inferredGenres;
    }
  }

  Object.assign(
    preferences,
    inferInstrumentDifficultyPreferences(messageText),
    inferPerformerFitPreferences(messageText),
    preferences
  );

  const normalizedAction = {
    ...action,
    query: {
      ...query,
      requirements,
      preferences
    }
  };

  if (rehearsalRequest && (action.action === 'search_songs' || action.action === 'prepare_rehearsal')) {
    return {
      action: 'prepare_rehearsal',
      query: normalizedAction.query,
      duration_minutes: inferredDurationMinutes || Number.parseInt(action.duration_minutes, 10) || 180
    };
  }

  if (action.action === 'prepare_rehearsal') {
    return {
      ...normalizedAction,
      duration_minutes: inferredDurationMinutes || Number.parseInt(action.duration_minutes, 10) || 180
    };
  }

  return normalizedAction;
}

// Final override with Unicode escapes so Hebrew instrument parsing stays stable for drums/guitar/bass only.
function inferInstrumentDifficultyPreferences(messageText) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return {};

  const difficulty =
    /(?:\u05e7\u05e9\u05d4|\u05e7\u05e9\u05d9\u05dd|\u05e7\u05e9\u05d5\u05ea|\u05e7\u05e9\u05d5\u05d7|\u05e7\u05e9\u05d5\u05d7\u05d4|\u05de\u05d0\u05ea\u05d2\u05e8|\u05de\u05d0\u05ea\u05d2\u05e8\u05ea|\u05de\u05e1\u05d5\u05d1\u05da|\u05de\u05e1\u05d5\u05d1\u05db\u05ea|hard|challenging)/iu.test(source)
      ? 'high'
      : /(?:^|\s)(?:\u05e7\u05dc|\u05e7\u05dc\u05d4|\u05e7\u05dc\u05d9\u05dd|\u05e7\u05dc\u05d5\u05ea|\u05e4\u05e9\u05d5\u05d8|\u05e4\u05e9\u05d5\u05d8\u05d4|easy)(?:\s|$)/iu.test(source)
        ? 'low'
        : null;

  if (!difficulty) return {};

  const preferences = {};
  if (/(?:\u05ea\u05d9\u05e4\u05d5\u05e3|\u05ea\u05d5\u05e4\u05d9\u05dd|\u05de\u05ea\u05d5\u05e4\u05e3|drums?|drumming)/iu.test(source)) {
    preferences.drums_difficulty = difficulty;
  }
  if (/(?:\u05d2\u05d9\u05d8\u05e8\u05d4|\u05d2\u05d9\u05d8\u05e8[\u05d4\u05d9\u05e1\u05d8\u05e1]?|guitar)/iu.test(source)) {
    preferences.guitar_difficulty = difficulty;
  }
  if (/(?:\u05d1\u05e1|\u05d1\u05e1\u05d9\u05e1\u05d8|bass)/iu.test(source)) {
    preferences.bass_difficulty = difficulty;
  }

  return preferences;
}

// Final override for feedback phrases so Hebrew negative rehearsal language stays stable.
function inferFeedbackIssue(messageText) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return [];

  if (/(?:\u05e7\u05e9\u05d4 \u05de\u05d3\u05d9|\u05d4\u05d5\u05d0 \u05e7\u05e9\u05d4|\u05d4\u05d9\u05d0 \u05e7\u05e9\u05d4|\u05e7\u05e9\u05d4|\u05de\u05d0\u05ea\u05d2\u05e8|\u05de\u05d0\u05ea\u05d2\u05e8\u05ea|\u05de\u05d0\u05ea\u05d2\u05e8\u05d9\u05dd|challenging|\u05de\u05e1\u05d5\u05d1\u05da|\u05de\u05e1\u05d5\u05d1\u05db\u05ea|\u05de\u05e1\u05d5\u05d1\u05db\u05d9\u05dd|\u05d2\u05d1\u05d5\u05d4 \u05de\u05d3\u05d9|\u05e0\u05de\u05d5\u05da \u05de\u05d3\u05d9)/iu.test(source)) {
    return ['too_hard'];
  }
  if (/(?:\u05e7\u05dc \u05de\u05d3\u05d9|\u05e7\u05dc|\u05e4\u05e9\u05d5\u05d8 \u05de\u05d3\u05d9|\u05e4\u05e9\u05d5\u05d8\u05d4 \u05de\u05d3\u05d9)/iu.test(source)) {
    return ['too_easy'];
  }
  if (/(?:\u05dc\u05d0 \u05d2\u05e8\u05d5\u05d1\u05d9|\u05dc\u05d0 \u05d9\u05d5\u05e9\u05d1|\u05dc\u05d0 \u05d6\u05d5\u05e8\u05dd|\u05dc\u05d0 \u05e2\u05d5\u05d1\u05d3|\u05dc\u05d0 \u05e2\u05d1\u05d3|\u05dc\u05d0 \u05d4\u05dc\u05da(?: \u05dc\u05e0\u05d5)?|\u05dc\u05d0 \u05d4\u05dc\u05db\u05d4(?: \u05dc\u05e0\u05d5)?|\u05dc\u05d0 \u05de\u05ea\u05d0\u05d9\u05dd(?:\u05d4|\u05d9\u05dd)?|\u05dc\u05d0 \u05dc\u05e0\u05d5)/iu.test(source)) {
    return ['doesnt_groove'];
  }
  return [];
}

function inferFeedbackFit(messageText) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return null;

  if (/(?:\u05dc\u05d0 \u05e2\u05d5\u05d1\u05d3|\u05dc\u05d0 \u05e2\u05d1\u05d3|\u05dc\u05d0 \u05d4\u05dc\u05da(?: \u05dc\u05e0\u05d5)?|\u05dc\u05d0 \u05d4\u05dc\u05db\u05d4(?: \u05dc\u05e0\u05d5)?|\u05dc\u05d0 \u05de\u05ea\u05d0\u05d9\u05dd|\u05dc\u05d0 \u05de\u05ea\u05d0\u05d9\u05de\u05d4|\u05e7\u05e9\u05d4 \u05de\u05d3\u05d9|\u05e7\u05dc \u05de\u05d3\u05d9|\u05ea\u05e1\u05d9\u05e8|\u05dc\u05d4\u05e1\u05d9\u05e8|\u05dc\u05d0 \u05dc\u05e0\u05d5)/iu.test(source)) {
    return 'bad';
  }
  return null;
}

function inferHeuristicFeedbackFit(messageText, issues) {
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return inferFitFromIssues(issues);

  const positiveFit = inferPositiveFeedbackFit(messageText);
  if (positiveFit && hasDifficultyFeedback(messageText)) {
    return 'maybe';
  }

  if (isComfortPositiveFeedback(messageText)) {
    return 'good';
  }

  if (/(?:\u05e7\u05dc \u05de\u05d3\u05d9|\u05d9\u05d5\u05ea\u05e8 \u05de\u05d3\u05d9 \u05e7\u05dc|\u05e4\u05e9\u05d5\u05d8 \u05de\u05d3\u05d9|\u05e4\u05e9\u05d5\u05d8\u05d4 \u05de\u05d3\u05d9)/iu.test(source)) {
    return 'maybe';
  }

  if (/(?:\u05dc\u05d0 \u05e2\u05d5\u05d1\u05d3|\u05dc\u05d0 \u05e2\u05d1\u05d3|\u05dc\u05d0 \u05d4\u05dc\u05da(?: \u05dc\u05e0\u05d5)?|\u05dc\u05d0 \u05d4\u05dc\u05db\u05d4(?: \u05dc\u05e0\u05d5)?|\u05dc\u05d0 \u05de\u05ea\u05d0\u05d9\u05dd|\u05dc\u05d0 \u05de\u05ea\u05d0\u05d9\u05de\u05d4|\u05dc\u05d0 \u05dc\u05e0\u05d5|\u05e7\u05e9\u05d4 \u05de\u05d3\u05d9|\u05e7\u05e9\u05d4 \u05dc\u05e0\u05d5|\u05ea\u05e1\u05d9\u05e8|\u05dc\u05d4\u05e1\u05d9\u05e8)/iu.test(source)) {
    return 'bad';
  }

  if (positiveFit) {
    return positiveFit;
  }

  return inferFitFromIssues(issues);
}

async function interpretMessage({
  provider,
  baseUrl,
  apiKey,
  model,
  messageText,
  quotedText,
  replyContext,
  recentMessages,
  pendingClarification,
  currentDate,
  requestFn,
  maxRetries = DEFAULT_MAX_RETRIES
}) {
  const selectedProvider = String(provider || '').trim().toLowerCase();
  if (!model) {
    throw new Error('LLM model is required');
  }

  if (selectedProvider !== 'groq' && selectedProvider !== 'openai_compatible') {
    throw new Error(`Unsupported LLM_PROVIDER value: ${provider}`);
  }

  if (!baseUrl) {
    throw new Error('LLM base URL is required');
  }

  const prompt = buildAgentPrompt({ messageText, quotedText, replyContext, recentMessages, currentDate, pendingClarification });
  const fallbackPrompt = buildFallbackAgentPrompt({ messageText, quotedText, replyContext, currentDate, pendingClarification });

  return runWithAgentConcurrencyLimit(async () => {
    let attempt = 0;
    let usedJsonValidateFallback = false;
    // Retry only before any deterministic mutation happens. The mutation executes after this function returns.
    while (true) {
      try {
        const { parsed, usage } = await callOpenAiCompatibleChat({
          baseUrl,
          apiKey,
          model,
          prompt: usedJsonValidateFallback ? fallbackPrompt : prompt,
          systemPrompt: usedJsonValidateFallback ? FALLBACK_SYSTEM_PROMPT : SYSTEM_PROMPT,
          requestFn
        });
        const action = validateAgentAction(
          normalizeAgentAction(parsed, { messageText, replyContext, quotedText })
        );
        console.log(
          `[agent] action=${estimateActionName(action)} input=${usage.promptTokens} cached=${usage.cachedTokens} output=${usage.completionTokens} total=${usage.totalTokens} latency=${usage.latencyMs}ms`
        );
        return action;
      } catch (error) {
        if ((isJsonValidateFailedError(error) || isAgentActionValidationError(error)) && !usedJsonValidateFallback) {
          usedJsonValidateFallback = true;
          console.warn(
            `[agent] retrying with compact fallback prompt after ${
              isJsonValidateFailedError(error) ? 'json_validate_failed' : 'action_validation_failed'
            }`
          );
          continue;
        }

        if (isAgentActionValidationError(error)) {
          console.warn(`[agent] returning recovery clarification after action_validation_failed: ${error.message}`);
          return buildRecoveryClarification(messageText);
        }

        if (!error?.rateLimited || attempt >= maxRetries) {
          throw error;
        }

        attempt += 1;
        const retryDelayMs = error.retryAfterMs ?? 1000 * attempt;
        console.warn(`[agent] rate_limited retry_in=${retryDelayMs}ms attempt=${attempt}`);
        await sleep(retryDelayMs);
      }
    }
  });
}

async function interpretMessageWithTools({
  provider,
  baseUrl,
  apiKey,
  model,
  messageText,
  quotedText,
  replyContext,
  recentMessages,
  pendingClarification,
  currentDate,
  tools,
  executeToolCall,
  requestFn
}) {
  // Tool use is an enhancement, not a new dependency. If the configured
  // OpenAI-compatible provider does not support it, retain the proven JSON
  // interpreter and its recovery behavior.
  const useTools = Array.isArray(tools) && tools.length > 0 && typeof executeToolCall === 'function';
  const selectedProvider = String(provider || '').trim().toLowerCase();
  if (!useTools || (selectedProvider !== 'groq' && selectedProvider !== 'openai_compatible')) {
    return interpretMessage({ provider, baseUrl, apiKey, model, messageText, quotedText, replyContext, recentMessages, pendingClarification, currentDate, requestFn });
  }

  const prompt = buildAgentPrompt({ messageText, quotedText, replyContext, recentMessages, currentDate, pendingClarification });
  const messages = [
    {
      role: 'system',
      content: `${SYSTEM_PROMPT}\nYou may call the supplied local read-only tools before deciding. For a named-song metadata question, call lookup_song first. For catalog recommendations, call search_catalog first. Tool results are authoritative: never claim a song exists when lookup_song returns not_found, and never turn a lookup into an add.`
    },
    { role: 'user', content: prompt }
  ];

  try {
    return await runWithAgentConcurrencyLimit(async () => {
      for (let turn = 0; turn < 4; turn += 1) {
        const result = await callOpenAiCompatibleChat({
          baseUrl,
          apiKey,
          model,
          prompt: '',
          messages,
          tools,
          responseFormat: 'text',
          requestFn
        });
        if (result.toolCalls.length === 0) {
          const parsed = extractJsonBlock(result.content);
          const action = validateAgentAction(normalizeAgentAction(parsed, { messageText, replyContext, quotedText }));
          console.log(`[agent] action=${estimateActionName(action)} tools=${turn} input=${result.usage.promptTokens} cached=${result.usage.cachedTokens} output=${result.usage.completionTokens} total=${result.usage.totalTokens} latency=${result.usage.latencyMs}ms`);
          return action;
        }

        messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });
        for (const call of result.toolCalls) {
          const toolResult = await executeToolCall({
            id: String(call?.id || ''),
            name: String(call?.function?.name || ''),
            arguments: String(call?.function?.arguments || '{}')
          });
          messages.push({ role: 'tool', tool_call_id: String(call?.id || ''), content: JSON.stringify(toolResult) });
        }
      }
      throw new Error('Agent exceeded the maximum number of tool calls');
    });
  } catch (error) {
    console.warn(`[agent] tool_loop_fallback: ${error.message}`);
    return interpretMessage({ provider, baseUrl, apiKey, model, messageText, quotedText, replyContext, recentMessages, pendingClarification, currentDate, requestFn });
  }
}

module.exports = {
  SYSTEM_PROMPT,
  FALLBACK_SYSTEM_PROMPT,
  ADDITION_CONFIRMATION_SYSTEM_PROMPT,
  SONG_DIFFICULTY_SYSTEM_PROMPT,
  PLAIN_FALLBACK_SYSTEM_PROMPT,
  BANTER_POLISH_SYSTEM_PROMPT,
  UNKNOWN_SONG_INFO_SYSTEM_PROMPT,
  SONG_REFERENCE_RESOLUTION_SYSTEM_PROMPT,
  MAX_CONCURRENT_AGENT_CALLS,
  DEFAULT_MAX_COMPLETION_TOKENS,
  extractJsonBlock,
  buildAgentPrompt,
  buildFallbackAgentPrompt,
  interpretMessage,
  interpretMessageWithTools,
  interpretAdditionConfirmation,
  interpretSongDifficulty,
  reviewAgentActionExecution,
  interpretPlainFallbackReply,
  polishBanterReply,
  interpretUnknownSongInfo,
  resolveSongReference,
  callOpenAiCompatibleChat,
  getAgentUsageStats
};
