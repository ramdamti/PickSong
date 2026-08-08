const { validateAgentAction } = require('./schemas');

const SYSTEM_PROMPT = [
  'You are a JSON-only semantic interpreter for a WhatsApp bot for a band.',
  'Users usually write in Hebrew.',
  'Return exactly one JSON object. No prose. No markdown. No explanations.',
  'The application executes actions locally and deterministically.',
  'Never invent a song_id.',
  'When reply_context is provided and the user refers to previous results, use result_index values from that context.',
  'Treat performer-fit phrases as direct search intent, not ambiguity.',
  'Examples of performer-fit language: מתאים לזמר, מתאים לזמרת, מתאים לזמר שלנו, מתאים לקול שלנו, שהסולן יוכל לשיר, שהסולנית תוכל לשיר, מתאים לגיטריסט, מתאים לבסיסט, מתאים למתופף, מתאים לקלידים.',
  'Map those phrases into compact search query preferences or requirements when possible.',
  'When users ask for songs by an artist or band and write the name in Hebrew or another non-English script, prefer the standard English canonical artist/band name in query.requirements.artist whenever you know it.',
  'Extract requested result counts carefully. Examples: "3 שירים", "שלושה שירים", "three songs" should set query.limit to 3.',
  'When reply_context exists and the user is asking for another recommendation list, fresh options, more songs, or different songs, set query.avoid_previous_results=true.',
  'For short feedback like "שיר 1 הוא קשה", "1 לא מתאים", or "2 ו-4 לא עבדו", prefer update_song_feedback with a non-empty updates array.',
  'Prefer taking a reasonable search interpretation over asking a clarification question.',
  'For vague recommendation requests, default to search_songs with broad query semantics.',
  'Use clarify only when execution would be unsafe or impossible without missing identity: for example ambiguous remove/update target, missing song identity for destructive actions, or missing reference for result-index feedback.',
  'If the request is ambiguous, return {"action":"clarify","question":"..."} in Hebrew.',
  'Allowed actions: search_songs, add_song, update_song, remove_song, update_song_feedback, get_song_info, explain_song_rejection, find_similar_songs, get_band_good_songs, get_band_bad_songs, get_band_maybe_songs, get_band_failure_reasons, clarify.',
  'search_songs and find_similar_songs return compact query semantics only.',
  'add_song must return a complete canonical song payload when identity is sufficiently clear.',
  'update_song_feedback must use result_index for list references.',
  'Band-history questions use get_band_failure_reasons or explain_song_rejection.',
  'Do not return formatted WhatsApp replies.'
].join('\n');

const MAX_CONCURRENT_AGENT_CALLS = 2;
const DEFAULT_MAX_COMPLETION_TOKENS = 800;
const DEFAULT_MAX_RETRIES = 1;

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

function buildAgentPrompt({ messageText, replyContext, currentDate }) {
  return JSON.stringify(
    {
      current_date: currentDate,
      user_message: messageText,
      reply_context: replyContext || null
    },
    null,
    2
  );
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
  requestFn = fetch,
  maxCompletionTokens = DEFAULT_MAX_COMPLETION_TOKENS
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
      response_format: { type: 'json_object' },
      max_completion_tokens: maxCompletionTokens,
      messages: [
        {
          role: 'system',
          content: SYSTEM_PROMPT
        },
        {
          role: 'user',
          content: prompt
        }
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
  const content = data?.choices?.[0]?.message?.content || '';
  const parsed = extractJsonBlock(content);
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

function shouldAvoidPreviousResults(messageText, replyContext) {
  if (!replyContext?.results?.length) return false;
  const source = String(messageText || '').trim().toLowerCase();
  if (!source) return false;

  return /(?:עוד|אחר(?:ים|ות)?|שונ(?:ים|ות)?|חדשים|חדש|נוספ(?:ים|ות)?|במקום|לא אלה|משהו אחר)/iu.test(source);
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

function normalizeAgentAction(action, { messageText, replyContext }) {
  if (!action || typeof action !== 'object') return action;
  if (action.action === 'update_song_feedback') {
    return {
      ...action,
      updates: normalizeFeedbackUpdates(action, messageText)
    };
  }

  if (action.action !== 'search_songs' && action.action !== 'find_similar_songs') {
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

  if (!Number.isInteger(Number.parseInt(query.limit, 10))) {
    const inferredLimit = inferRequestedLimit(messageText);
    if (inferredLimit) {
      query.limit = inferredLimit;
    }
  }

  if (action.action === 'search_songs' && shouldAvoidPreviousResults(messageText, replyContext)) {
    query.avoid_previous_results = true;
  }

  if (!requirements.language) {
    const inferredLanguage = inferRequestedLanguage(messageText);
    if (inferredLanguage) {
      requirements.language = inferredLanguage;
    }
  }

  if (!requirements.artist) {
    const inferredArtist = inferRequestedArtist(messageText);
    if (inferredArtist) {
      requirements.artist = inferredArtist;
    }
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

  return {
    ...action,
    query: {
      ...query,
      requirements,
      preferences
    }
  };
}

async function interpretMessage({
  provider,
  baseUrl,
  apiKey,
  model,
  messageText,
  replyContext,
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

  const prompt = buildAgentPrompt({ messageText, replyContext, currentDate });

  return runWithAgentConcurrencyLimit(async () => {
    let attempt = 0;
    // Retry only before any deterministic mutation happens. The mutation executes after this function returns.
    while (true) {
      try {
        const { parsed, usage } = await callOpenAiCompatibleChat({
          baseUrl,
          apiKey,
          model,
          prompt,
          requestFn
        });
        const action = validateAgentAction(
          normalizeAgentAction(parsed, { messageText, replyContext })
        );
        console.log(
          `[agent] action=${estimateActionName(action)} input=${usage.promptTokens} cached=${usage.cachedTokens} output=${usage.completionTokens} total=${usage.totalTokens} latency=${usage.latencyMs}ms`
        );
        return action;
      } catch (error) {
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

module.exports = {
  SYSTEM_PROMPT,
  MAX_CONCURRENT_AGENT_CALLS,
  DEFAULT_MAX_COMPLETION_TOKENS,
  extractJsonBlock,
  buildAgentPrompt,
  interpretMessage,
  callOpenAiCompatibleChat,
  getAgentUsageStats
};
