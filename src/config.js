const path = require('path');
const fs = require('fs');

function readBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseDotEnv(content) {
  const result = {};
  const lines = String(content || '').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) result[key] = value;
  }

  return result;
}

function loadDotEnvFile(envPath = path.resolve('.env')) {
  if (!fs.existsSync(envPath)) return {};
  return parseDotEnv(fs.readFileSync(envPath, 'utf8'));
}

function resolveExecutablePath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const candidates = new Set([raw]);
  if (!raw.includes(path.sep)) {
    candidates.add(path.posix.join('/usr/bin', raw));
    candidates.add(path.posix.join('/snap/bin', raw));
    candidates.add(path.posix.join('/usr/local/bin', raw));
    if (raw === 'chromium') {
      candidates.add('/usr/bin/chromium');
      candidates.add('/usr/bin/chromium-browser');
      candidates.add('/snap/bin/chromium');
    }
    if (raw === 'chromium-browser') {
      candidates.add('/usr/bin/chromium-browser');
      candidates.add('/usr/bin/chromium');
      candidates.add('/snap/bin/chromium');
    }
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return raw;
}

function loadConfig(env = process.env, options = {}) {
  const { requireGroupName = true } = options;
  const fileEnv = loadDotEnvFile();
  const mergedEnv = { ...fileEnv, ...env };
  const groupName = (mergedEnv.GROUP_NAME || '').trim();
  if (requireGroupName && !groupName) {
    throw new Error('GROUP_NAME is required');
  }

  const llmProvider = (mergedEnv.LLM_PROVIDER || 'groq').trim().toLowerCase();
  const groqApiKey = (mergedEnv.GROQ_API_KEY || '').trim();
  const groqModel = (mergedEnv.GROQ_MODEL || 'openai/gpt-oss-20b').trim();
  const groqBaseUrl = (mergedEnv.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').trim().replace(/\/$/, '');
  const openAiCompatibleApiKey = (mergedEnv.OPENAI_COMPATIBLE_API_KEY || '').trim();
  const openAiCompatibleModel = (mergedEnv.OPENAI_COMPATIBLE_MODEL || '').trim();
  const openAiCompatibleBaseUrl = (mergedEnv.OPENAI_COMPATIBLE_BASE_URL || '').trim().replace(/\/$/, '');

  let llmApiKey = '';
  let llmModel = '';
  let llmBaseUrl = '';

  if (llmProvider === 'groq') {
    llmApiKey = groqApiKey;
    llmModel = groqModel;
    llmBaseUrl = groqBaseUrl;
  } else if (llmProvider === 'openai_compatible') {
    llmApiKey = openAiCompatibleApiKey;
    llmModel = openAiCompatibleModel;
    llmBaseUrl = openAiCompatibleBaseUrl;
  }

  return {
    groupName,
    groupId: (mergedEnv.GROUP_ID || '').trim(),
    triggerText: (mergedEnv.TRIGGER_TEXT || '\u05d1\u05d5\u05d8').trim(),
    stateFile: path.resolve(mergedEnv.STATE_FILE || 'state.json'),
    seenFile: path.resolve(mergedEnv.SEEN_FILE || 'seen.json'),
    authDir: path.resolve(mergedEnv.AUTH_DIR || '.wwebjs_auth'),
    discoverChords: readBool(mergedEnv.DISCOVER_CHORDS ?? mergedEnv.discover_chords, true),
    llmProvider,
    llmApiKey,
    llmModel,
    llmBaseUrl,
    groqApiKey,
    groqModel,
    groqBaseUrl,
    openAiCompatibleApiKey,
    openAiCompatibleModel,
    openAiCompatibleBaseUrl,
    executablePath: resolveExecutablePath(mergedEnv.PUPPETEER_EXECUTABLE_PATH || mergedEnv.CHROME_PATH || ''),
    headless: readBool(mergedEnv.HEADLESS, true)
  };
}

module.exports = { loadConfig, loadDotEnvFile, parseDotEnv };
