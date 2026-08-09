function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => String(item || '').trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

function normalizeScalar(value) {
  return String(value || '').trim().toLowerCase();
}

const ARTIST_ALIAS_MAP = new Map([
  ['פינק פלויד', 'pink floyd'],
  ['פינקפלויד', 'pink floyd'],
  ['הביטלס', 'the beatles'],
  ['ביטלס', 'the beatles'],
  ['ביטלס ', 'the beatles'],
  ['לד זפלין', 'led zeppelin'],
  ['דיפ פרפל', 'deep purple'],
  ['קווין', 'queen'],
  ['פורינר', 'foreigner'],
  ['אבבא', 'abba']
]);

function canonicalizeArtistName(value) {
  const normalized = normalizeScalar(value);
  return ARTIST_ALIAS_MAP.get(normalized) || normalized;
}

function detectScriptLanguage(value) {
  const source = String(value || '').trim();
  if (!source) return null;
  const hasHebrew = /[\u0590-\u05FF]/u.test(source);
  const hasLatin = /[A-Za-z]/.test(source);
  if (hasHebrew && !hasLatin) return 'he';
  if (hasLatin && !hasHebrew) return 'en';
  return null;
}

function songGenres(song) {
  return normalizeList(song?.genres);
}

function songKeysTypes(song) {
  return normalizeList(song?.ai_metadata?.keys_type);
}

function artistMatches(songArtist, requestedArtist, song = null) {
  const songValue = canonicalizeArtistName(songArtist);
  const requestedValue = canonicalizeArtistName(requestedArtist);
  if (!songValue || !requestedValue) return false;
  if (
    songValue === requestedValue ||
    songValue.includes(requestedValue) ||
    requestedValue.includes(songValue)
  ) {
    return true;
  }

  const requestedScript = detectScriptLanguage(requestedArtist);
  if (requestedScript === 'he') {
    const sourceText = normalizeScalar(song?.source_text || song?.sourceText || '');
    if (sourceText && sourceText.includes(normalizeScalar(requestedArtist))) {
      return true;
    }
  }

  return false;
}

function scalarList(value) {
  return Array.isArray(value) ? normalizeList(value) : [normalizeScalar(value)].filter(Boolean);
}

function scoreScalarPreference(songValue, preferredValues, weight) {
  if (preferredValues.length === 0) return 0;
  const normalizedSongValue = normalizeScalar(songValue);
  if (!normalizedSongValue) return 0;
  return preferredValues.includes(normalizedSongValue) ? weight : 0;
}

function scoreArrayMatch(songValues, queryValues, weight) {
  if (queryValues.length === 0) return 0;
  const matches = queryValues.filter((value) =>
    songValues.some((songValue) => songValue === value || songValue.includes(value) || value.includes(songValue))
  );
  return matches.length * weight;
}

function songMatchesHardRequirement(song, requirements = {}) {
  const genres = normalizeList(requirements.genres);
  if (genres.length > 0) {
    const values = songGenres(song);
    const allMatch = genres.every((genre) =>
      values.some((value) => value === genre || value.includes(genre) || genre.includes(value))
    );
    if (!allMatch) return false;
  }

  if (requirements.language) {
    const language = normalizeScalar(song?.language);
    if (language !== normalizeScalar(requirements.language)) return false;
  }

  if (requirements.artist) {
    if (!artistMatches(song.artist, requirements.artist, song)) return false;
  }

  if (requirements.feel) {
    const feels = Array.isArray(requirements.feel) ? normalizeList(requirements.feel) : [normalizeScalar(requirements.feel)].filter(Boolean);
    if (feels.length > 0 && !feels.includes(normalizeScalar(song.feel))) return false;
  }

  if (requirements.difficulty) {
    const difficulties = Array.isArray(requirements.difficulty)
      ? normalizeList(requirements.difficulty)
      : [normalizeScalar(requirements.difficulty)].filter(Boolean);
    if (difficulties.length > 0 && !difficulties.includes(normalizeScalar(song.difficulty))) return false;
  }

  if (requirements.keys_difficulty) {
    const difficulties = Array.isArray(requirements.keys_difficulty)
      ? normalizeList(requirements.keys_difficulty)
      : [normalizeScalar(requirements.keys_difficulty)].filter(Boolean);
    if (difficulties.length > 0 && !difficulties.includes(normalizeScalar(song?.ai_metadata?.keys_difficulty))) return false;
  }

  if (requirements.keys_role) {
    const roles = Array.isArray(requirements.keys_role)
      ? normalizeList(requirements.keys_role)
      : [normalizeScalar(requirements.keys_role)].filter(Boolean);
    if (roles.length > 0 && !roles.includes(normalizeScalar(song?.ai_metadata?.keys_role))) return false;
  }

  const requiredKeysTypes = normalizeList(requirements.keys_type_any);
  if (requiredKeysTypes.length > 0) {
    const values = songKeysTypes(song);
    if (!requiredKeysTypes.some((value) => values.includes(value))) {
      return false;
    }
  }

  if (requirements.has_keys === true && songKeysTypes(song).length === 0) {
    return false;
  }

  if (requirements.excludeRejected && normalizeScalar(song?.band_status?.fit) === 'bad') {
    return false;
  }

  if (requirements.excludePlayed && song?.band_status?.last_played) {
    return false;
  }

  return true;
}

function songMatchesExclusions(song, exclusions = {}) {
  const excludedFits = normalizeList(exclusions.band_fit);
  if (excludedFits.includes(normalizeScalar(song?.band_status?.fit))) return false;

  const excludedGenres = normalizeList(exclusions.genres);
  if (excludedGenres.length > 0) {
    const values = songGenres(song);
    if (excludedGenres.some((genre) => values.some((value) => value === genre || value.includes(genre) || genre.includes(value)))) {
      return false;
    }
  }

  const excludedKeysTypes = normalizeList(exclusions.keys_type_any);
  if (excludedKeysTypes.length > 0) {
    const values = songKeysTypes(song);
    if (excludedKeysTypes.some((value) => values.includes(value))) {
      return false;
    }
  }

  return true;
}

function scoreSong(song, query = {}, options = {}) {
  const requirements = query.requirements || {};
  const preferences = query.preferences || {};
  const exclusions = query.exclusions || {};
  const similarSong = options.similarSong || null;

  if (!songMatchesHardRequirement(song, requirements)) return Number.NEGATIVE_INFINITY;
  if (!songMatchesExclusions(song, exclusions)) return Number.NEGATIVE_INFINITY;

  let score = 0;
  score += scoreArrayMatch(songGenres(song), normalizeList(requirements.genres), 20);
  score += scoreArrayMatch(songGenres(song), normalizeList(preferences.genres), 8);

  const songFeel = normalizeScalar(song.feel);
  const prefFeels = Array.isArray(preferences.feel) ? normalizeList(preferences.feel) : [normalizeScalar(preferences.feel)].filter(Boolean);
  if (prefFeels.includes(songFeel)) score += 10;

  const songDifficulty = normalizeScalar(song.difficulty);
  const prefDifficulties = Array.isArray(preferences.difficulty)
    ? normalizeList(preferences.difficulty)
    : [normalizeScalar(preferences.difficulty)].filter(Boolean);
  if (prefDifficulties.includes(songDifficulty)) score += 8;

  const singerFit = normalizeScalar(song?.ai_metadata?.singer_fit);
  if (preferences.vocal_profile && singerFit.includes(normalizeScalar(preferences.vocal_profile))) {
    score += 8;
  }
  if (preferences.singer_fit && singerFit === normalizeScalar(preferences.singer_fit)) {
    score += 8;
  }
  score += scoreScalarPreference(song?.ai_metadata?.original_vocal, scalarList(preferences.original_vocal), 6);
  score += scoreScalarPreference(song?.ai_metadata?.vocal_range, scalarList(preferences.vocal_range), 6);
  score += scoreScalarPreference(song?.ai_metadata?.vocal_energy, scalarList(preferences.vocal_energy), 4);
  score += scoreScalarPreference(song?.ai_metadata?.band_energy, scalarList(preferences.band_energy), 4);
  score += scoreScalarPreference(song?.ai_metadata?.groove_level, scalarList(preferences.groove_level), 5);
  score += scoreScalarPreference(song?.ai_metadata?.guitar_difficulty, scalarList(preferences.guitar_difficulty), 5);
  score += scoreScalarPreference(song?.ai_metadata?.bass_difficulty, scalarList(preferences.bass_difficulty), 5);
  score += scoreScalarPreference(song?.ai_metadata?.drums_difficulty, scalarList(preferences.drums_difficulty), 5);
  score += scoreScalarPreference(song?.ai_metadata?.keys_difficulty, scalarList(preferences.keys_difficulty), 5);
  score += scoreScalarPreference(song?.ai_metadata?.bass_interest, scalarList(preferences.bass_interest), 6);
  score += scoreScalarPreference(song?.ai_metadata?.keys_role, scalarList(preferences.keys_role), 3);
  score += scoreArrayMatch(songKeysTypes(song), normalizeList(preferences.keys_type_any), 7);
  if (preferences.crowd_friendly === true && song?.ai_metadata?.crowd_friendly === true) score += 5;
  if (preferences.crowd_friendly === false && song?.ai_metadata?.crowd_friendly === false) score += 2;
  if (preferences.untried === true && (song?.band_status?.attempts || 0) === 0) score += 10;

  if ((normalizeList(requirements.keys_type_any).length > 0 || requirements.has_keys === true) && normalizeScalar(song?.ai_metadata?.keys_role) === 'important') {
    score += 3;
  }

  const bandFit = normalizeScalar(song?.band_status?.fit);
  if (bandFit === 'good') score += 25;
  if (bandFit === 'maybe') score += 8;
  if (bandFit === 'bad') score -= 40;

  if (!song?.band_status?.last_played) score += 3;
  if ((song?.band_status?.attempts || 0) === 0) score += 4;
  if ((song?.band_status?.issues || []).length > 0) score -= Math.min(12, song.band_status.issues.length * 3);
  if (song?.band_status?.last_rehearsed) score -= 1;
  if (song?.band_status?.last_played) score -= 2;
  if ((song?.band_status?.attempts || 0) >= 3 && bandFit !== 'good') score -= 6;

  if (similarSong) {
    score += scoreArrayMatch(songGenres(song), songGenres(similarSong), 6);
    if (normalizeScalar(song.feel) && normalizeScalar(song.feel) === normalizeScalar(similarSong.feel)) score += 6;
    if (normalizeScalar(song.difficulty) && normalizeScalar(song.difficulty) === normalizeScalar(similarSong.difficulty)) score += 5;
    if (normalizeScalar(song.artist) && normalizeScalar(song.artist) === normalizeScalar(similarSong.artist)) score += 2;
  }

  return score;
}

function shuffleArray(items, random = Math.random) {
  const copy = Array.isArray(items) ? [...items] : [];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function searchSongs(songs, query = {}, options = {}) {
  const limit = Number.parseInt(query.limit, 10);
  const requestedLimit = Number.isInteger(limit) && limit > 0 ? limit : 5;
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const scored = (Array.isArray(songs) ? songs : [])
    .map((song) => ({ song, score: scoreSong(song, query, options) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => {
      return right.score - left.score;
    });

  const randomized = [];
  for (let index = 0; index < scored.length;) {
    const score = scored[index].score;
    let groupEnd = index + 1;
    while (groupEnd < scored.length && scored[groupEnd].score === score) {
      groupEnd += 1;
    }
    randomized.push(...shuffleArray(scored.slice(index, groupEnd), random));
    index = groupEnd;
  }

  return randomized.slice(0, requestedLimit).map((entry) => entry.song);
}

function countHardFilterMatches(songs, query = {}) {
  const normalizedSongs = Array.isArray(songs) ? songs : [];
  const requirements = query?.requirements || {};
  const exclusions = query?.exclusions || {};
  return normalizedSongs.filter((song) => songMatchesHardRequirement(song, requirements) && songMatchesExclusions(song, exclusions)).length;
}

module.exports = {
  searchSongs,
  scoreSong,
  countHardFilterMatches
};
