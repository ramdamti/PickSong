const path = require('path');
const fs = require('fs');

function readInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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

function loadConfig(env = process.env) {
  const fileEnv = loadDotEnvFile();
  const mergedEnv = { ...fileEnv, ...env };
  const groupName = (mergedEnv.GROUP_NAME || '').trim();
  if (!groupName) {
    throw new Error('GROUP_NAME is required');
  }

  return {
    groupName,
    triggerText: (mergedEnv.TRIGGER_TEXT || 'תביא שיר').trim(),
    historyMessages: readInt(mergedEnv.HISTORY_MESSAGES, 5000),
    stateFile: path.resolve(mergedEnv.STATE_FILE || 'state.json'),
    ollamaBaseUrl: (mergedEnv.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').trim().replace(/\/$/, ''),
    ollamaModel: (mergedEnv.OLLAMA_MODEL || 'qwen3:1.7b').trim(),
    executablePath: (mergedEnv.PUPPETEER_EXECUTABLE_PATH || mergedEnv.CHROME_PATH || '').trim(),
    historyBatchSize: readInt(mergedEnv.HISTORY_BATCH_SIZE, 25),
    headless: readBool(mergedEnv.HEADLESS, true)
  };
}

module.exports = { loadConfig, loadDotEnvFile, parseDotEnv };
