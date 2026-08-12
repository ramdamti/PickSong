const ACTION_NAMES = new Set([
  'search_songs',
  'prepare_rehearsal',
  'add_song',
  'update_song',
  'remove_song',
  'update_song_feedback',
  'get_song_info',
  'explain_song_rejection',
  'find_similar_songs',
  'get_band_good_songs',
  'get_band_bad_songs',
  'get_band_maybe_songs',
  'get_band_failure_reasons',
  'clarify'
]);

const DIFFICULTIES = new Set(['low', 'medium', 'high']);
const FEELS = new Set(['upbeat', 'calm', 'ballad']);
const BAND_FITS = new Set(['unknown', 'good', 'maybe', 'bad']);
const KEYS_TYPES = new Set(['piano', 'electric_piano', 'organ', 'synth', 'clavinet', 'mellotron', 'other']);
const ISSUE_VALUES = new Set([
  'vocals',
  'vocals_too_high',
  'vocals_too_low',
  'guitar',
  'bass',
  'drums',
  'keys',
  'too_hard',
  'too_easy',
  'doesnt_groove',
  'wrong_style',
  'boring',
  'arrangement'
]);
const REQUIRED_AI_METADATA_FIELDS = [
  'original_vocal',
  'vocal_range',
  'vocal_style',
  'singer_fit',
  'vocal_energy',
  'band_energy',
  'crowd_friendly',
  'groove_level',
  'guitar_difficulty',
  'bass_difficulty',
  'drums_difficulty',
  'keys_role',
  'keys_type',
  'keys_difficulty',
  'bass_interest'
];
const ALLOWED_UPDATE_FIELDS = new Set([
  'song_title',
  'artist',
  'language',
  'genres',
  'difficulty',
  'feel',
  'duration_seconds',
  'chords_url',
  'ai_metadata',
  'band_status'
]);

function ensureObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function ensureString(value, label, { allowEmpty = false } = {}) {
  const normalized = value === null || value === undefined ? '' : String(value).trim();
  if (!allowEmpty && !normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}

function ensureEnum(value, allowedValues, label, { allowNull = false } = {}) {
  if ((value === null || value === undefined || value === '') && allowNull) {
    return null;
  }
  const normalized = ensureString(value, label).toLowerCase();
  if (!allowedValues.has(normalized)) {
    throw new Error(`${label} must be one of: ${Array.from(allowedValues).join(', ')}`);
  }
  return normalized;
}

function ensureStringArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return Array.from(new Set(value.map((item) => ensureString(item, label)).filter(Boolean)));
}

function ensureEnumArray(value, allowedValues, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return Array.from(new Set(value.map((item) => ensureEnum(item, allowedValues, label)).filter(Boolean)));
}

function ensurePositiveInteger(value, label, { allowNull = false } = {}) {
  if ((value === null || value === undefined || value === '') && allowNull) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function validateAiMetadata(value) {
  const metadata = ensureObject(value, 'ai_metadata');
  for (const field of REQUIRED_AI_METADATA_FIELDS) {
    if (!(field in metadata)) {
      throw new Error(`ai_metadata.${field} is required`);
    }
  }

  return {
    ...metadata,
    original_vocal: ensureString(metadata.original_vocal, 'ai_metadata.original_vocal').toLowerCase(),
    vocal_range: ensureString(metadata.vocal_range, 'ai_metadata.vocal_range').toLowerCase(),
    vocal_style: ensureStringArray(metadata.vocal_style, 'ai_metadata.vocal_style').map((item) => item.toLowerCase()),
    singer_fit: ensureString(metadata.singer_fit, 'ai_metadata.singer_fit').toLowerCase(),
    vocal_energy: ensureString(metadata.vocal_energy, 'ai_metadata.vocal_energy').toLowerCase(),
    band_energy: ensureString(metadata.band_energy, 'ai_metadata.band_energy').toLowerCase(),
    crowd_friendly: Boolean(metadata.crowd_friendly),
    groove_level: ensureString(metadata.groove_level, 'ai_metadata.groove_level').toLowerCase(),
    guitar_difficulty: ensureString(metadata.guitar_difficulty, 'ai_metadata.guitar_difficulty').toLowerCase(),
    bass_difficulty: ensureString(metadata.bass_difficulty, 'ai_metadata.bass_difficulty').toLowerCase(),
    drums_difficulty: ensureString(metadata.drums_difficulty, 'ai_metadata.drums_difficulty').toLowerCase(),
    keys_role: ensureString(metadata.keys_role, 'ai_metadata.keys_role').toLowerCase(),
    keys_type: ensureEnumArray(metadata.keys_type, KEYS_TYPES, 'ai_metadata.keys_type[]'),
    keys_difficulty: ensureString(metadata.keys_difficulty, 'ai_metadata.keys_difficulty').toLowerCase(),
    bass_interest: ensureString(metadata.bass_interest, 'ai_metadata.bass_interest').toLowerCase()
  };
}

function validateSongQuerySection(value, label) {
  if (value === undefined || value === null) return undefined;
  const section = ensureObject(value, label);
  const validated = { ...section };

  if ('keys_type_any' in validated) {
    validated.keys_type_any = ensureEnumArray(validated.keys_type_any, KEYS_TYPES, `${label}.keys_type_any[]`);
  }

  if ('has_keys' in validated && typeof validated.has_keys !== 'boolean') {
    throw new Error(`${label}.has_keys must be a boolean`);
  }

  return validated;
}

function validateBandStatus(value) {
  const status = ensureObject(value, 'band_status');
  const issues = Array.isArray(status.issues) ? status.issues : [];
  return {
    fit: ensureEnum(status.fit, BAND_FITS, 'band_status.fit'),
    issues: Array.from(
      new Set(
        issues.map((item) => ensureEnum(item, ISSUE_VALUES, 'band_status.issues[]'))
      )
    ),
    notes: status.notes === null || status.notes === undefined ? '' : String(status.notes),
    attempts: Number.isInteger(status.attempts) && status.attempts >= 0 ? status.attempts : 0,
    last_reviewed: status.last_reviewed || null,
    last_rehearsed: status.last_rehearsed || null,
    last_played: status.last_played || null
  };
}

function validateResultContext(value) {
  const context = ensureObject(value, 'result_context');
  if (!Array.isArray(context.results)) {
    throw new Error('result_context.results must be an array');
  }

  const validated = {
    bot_message_id: context.bot_message_id ? String(context.bot_message_id).trim() : null,
    chat_id: context.chat_id ? String(context.chat_id).trim() : null,
    created_at: context.created_at || null,
    results: context.results.map((entry, index) => {
      const item = ensureObject(entry, `result_context.results[${index}]`);
      const parsedIndex = Number.parseInt(item.index, 10);
      if (!Number.isInteger(parsedIndex) || parsedIndex <= 0) {
        throw new Error(`result_context.results[${index}].index must be a positive integer`);
      }
      return {
        index: parsedIndex,
        song_id: ensureString(item.song_id, `result_context.results[${index}].song_id`),
        title: item.title === undefined || item.title === null ? null : String(item.title).trim(),
        artist: item.artist === undefined || item.artist === null ? null : String(item.artist).trim()
      };
    })
  };

  if (context.query && typeof context.query === 'object' && !Array.isArray(context.query)) {
    validated.query = validateSongQuery(context.query);
  }

  return validated;
}

function validateSong(value, options = {}) {
  const { requireSongId = true } = options;
  const song = ensureObject(value, 'song');
  return {
    ...song,
    song_id: requireSongId ? ensureString(song.song_id, 'song.song_id') : (song.song_id ? String(song.song_id).trim() : null),
    song_title: ensureString(song.song_title, 'song.song_title'),
    artist: ensureString(song.artist, 'song.artist'),
    genres: ensureStringArray(song.genres, 'song.genres').map((item) => item.toLowerCase()),
    difficulty: ensureEnum(song.difficulty, DIFFICULTIES, 'song.difficulty'),
    feel: ensureEnum(song.feel, FEELS, 'song.feel'),
    duration_seconds: ensurePositiveInteger(song.duration_seconds, 'song.duration_seconds', { allowNull: true }),
    ai_metadata: validateAiMetadata(song.ai_metadata),
    band_status: validateBandStatus(song.band_status)
  };
}

function validateAddSongPayload(value) {
  const song = ensureObject(value, 'song');
  return {
    ...song,
    song_id: song.song_id ? String(song.song_id).trim() : null,
    song_title: ensureString(song.song_title, 'song.song_title'),
    artist: ensureString(song.artist, 'song.artist'),
    language: song.language === undefined || song.language === null || song.language === ''
      ? null
      : ensureString(song.language, 'song.language').toLowerCase(),
    chords_url: song.chords_url === undefined || song.chords_url === null || song.chords_url === ''
      ? null
      : ensureString(song.chords_url, 'song.chords_url'),
    confidence: Number.isFinite(Number(song.confidence)) ? Number(song.confidence) : 0.5,
    genres: Array.isArray(song.genres)
      ? ensureStringArray(song.genres, 'song.genres').map((item) => item.toLowerCase())
      : [],
    difficulty: song.difficulty ? ensureEnum(song.difficulty, DIFFICULTIES, 'song.difficulty') : null,
    feel: song.feel ? ensureEnum(song.feel, FEELS, 'song.feel') : null,
    duration_seconds: ensurePositiveInteger(song.duration_seconds, 'song.duration_seconds', { allowNull: true }),
    ai_metadata: song.ai_metadata ? validateAiMetadata(song.ai_metadata) : undefined,
    band_status: song.band_status ? validateBandStatus(song.band_status) : undefined
  };
}

function validateSongQuery(value) {
  const query = ensureObject(value, 'query');
  const validated = { ...query };
  if ('limit' in query) {
    const limit = Number.parseInt(query.limit, 10);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('query.limit must be a positive integer');
    }
    validated.limit = limit;
  }
  if ('requirements' in query) {
    validated.requirements = validateSongQuerySection(query.requirements, 'query.requirements');
  }
  if ('preferences' in query) {
    validated.preferences = validateSongQuerySection(query.preferences, 'query.preferences');
  }
  if ('exclusions' in query) {
    validated.exclusions = validateSongQuerySection(query.exclusions, 'query.exclusions');
  }
  if ('replace_result_indexes' in query) {
    if (!Array.isArray(query.replace_result_indexes)) {
      throw new Error('query.replace_result_indexes must be an array');
    }
    validated.replace_result_indexes = Array.from(
      new Set(
        query.replace_result_indexes
          .map((value) => Number.parseInt(value, 10))
          .filter((value) => Number.isInteger(value) && value > 0)
      )
    );
  }
  return validated;
}

function validateAgentAction(value) {
  const action = ensureObject(value, 'agent_action');
  const name = ensureEnum(action.action, ACTION_NAMES, 'agent_action.action');
  const validated = { ...action, action: name };

  if (name === 'clarify') {
    validated.question = ensureString(action.question, 'agent_action.question');
    return validated;
  }

  if (name === 'search_songs' || name === 'find_similar_songs' || name === 'prepare_rehearsal') {
    const rawQuery =
      action.query && typeof action.query === 'object' && !Array.isArray(action.query)
        ? action.query
        : {};
    validated.query = validateSongQuery(rawQuery);
    if (name === 'prepare_rehearsal') {
      validated.duration_minutes = ensurePositiveInteger(action.duration_minutes, 'agent_action.duration_minutes', { allowNull: true });
    }
    return validated;
  }

  if (name === 'add_song') {
    validated.song = validateAddSongPayload(action.song || {});
    return validated;
  }

  if (name === 'update_song' || name === 'remove_song' || name === 'get_song_info' || name === 'explain_song_rejection') {
    const hasSongId = Boolean(String(action.song_id || '').trim());
    const hasResultIndex = Number.isInteger(Number.parseInt(action.result_index, 10));
    const hasSongTitle = Boolean(String(action.song_title || '').trim());
    if (!hasSongId && !hasResultIndex && !hasSongTitle) {
      throw new Error('agent_action must include song_id, result_index, or song_title');
    }
    validated.song_id = hasSongId ? ensureString(action.song_id, 'agent_action.song_id') : null;
    validated.result_index = hasResultIndex ? Number.parseInt(action.result_index, 10) : null;
    validated.song_title = hasSongTitle ? ensureString(action.song_title, 'agent_action.song_title') : null;
    validated.artist = action.artist === undefined || action.artist === null ? null : String(action.artist).trim();
    if (name === 'update_song') {
      const updates = ensureObject(action.updates || {}, 'agent_action.updates');
      const invalidFields = Object.keys(updates).filter((field) => !ALLOWED_UPDATE_FIELDS.has(field));
      if (invalidFields.length > 0) {
        throw new Error(`agent_action.updates contains unsupported fields: ${invalidFields.join(', ')}`);
      }

      validated.updates = { ...updates };
      if ('song_title' in validated.updates) {
        validated.updates.song_title = ensureString(validated.updates.song_title, 'agent_action.updates.song_title');
      }
      if ('artist' in validated.updates) {
        validated.updates.artist = ensureString(validated.updates.artist, 'agent_action.updates.artist');
      }
      if ('language' in validated.updates) {
        validated.updates.language = ensureString(validated.updates.language, 'agent_action.updates.language');
      }
      if ('genres' in validated.updates) {
        validated.updates.genres = ensureStringArray(validated.updates.genres, 'agent_action.updates.genres').map((item) => item.toLowerCase());
      }
      if ('difficulty' in validated.updates) {
        validated.updates.difficulty = ensureEnum(validated.updates.difficulty, DIFFICULTIES, 'agent_action.updates.difficulty');
      }
      if ('feel' in validated.updates) {
        validated.updates.feel = ensureEnum(validated.updates.feel, FEELS, 'agent_action.updates.feel');
      }
      if ('duration_seconds' in validated.updates) {
        validated.updates.duration_seconds = ensurePositiveInteger(validated.updates.duration_seconds, 'agent_action.updates.duration_seconds', { allowNull: true });
      }
      if ('chords_url' in validated.updates) {
        validated.updates.chords_url =
          validated.updates.chords_url === null ? null : ensureString(validated.updates.chords_url, 'agent_action.updates.chords_url');
      }
      if ('ai_metadata' in validated.updates) {
        validated.updates.ai_metadata = validateAiMetadata(validated.updates.ai_metadata);
      }
      if ('band_status' in validated.updates) {
        validated.updates.band_status = validateBandStatus(validated.updates.band_status);
      }
    }
    return validated;
  }

  if (name === 'update_song_feedback') {
    if (!Array.isArray(action.updates) || action.updates.length === 0) {
      throw new Error('agent_action.updates must be a non-empty array');
    }
    validated.updates = action.updates.map((entry, index) => {
      const item = ensureObject(entry, `agent_action.updates[${index}]`);
      const resultIndex = Number.parseInt(item.result_index, 10);
      if (!Number.isInteger(resultIndex) || resultIndex <= 0) {
        throw new Error(`agent_action.updates[${index}].result_index must be a positive integer`);
      }
      const issues = Array.isArray(item.issues) ? item.issues : [];
      return {
        result_index: resultIndex,
        fit: ensureEnum(item.fit, BAND_FITS, `agent_action.updates[${index}].fit`, { allowNull: true }),
        issues: Array.from(new Set(issues.map((issue) => ensureEnum(issue, ISSUE_VALUES, `agent_action.updates[${index}].issues[]`)))),
        notes: item.notes === undefined || item.notes === null ? '' : String(item.notes)
      };
    });
    return validated;
  }

  return validated;
}

module.exports = {
  ACTION_NAMES,
  DIFFICULTIES,
  FEELS,
  BAND_FITS,
  KEYS_TYPES,
  ISSUE_VALUES,
  REQUIRED_AI_METADATA_FIELDS,
  ALLOWED_UPDATE_FIELDS,
  validateAiMetadata,
  validateBandStatus,
  validateResultContext,
  validateSong,
  validateAddSongPayload,
  validateSongQuery,
  validateAgentAction
};
