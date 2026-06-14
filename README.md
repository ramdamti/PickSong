# PickSong

Small WhatsApp song picker for a band group.

## What it does

- Watches one WhatsApp group in headless mode.
- Extracts song suggestions from mixed Hebrew and English chat.
- Saves extracted songs to `state.json`.
- Replies to the trigger `תוסיף` with the next song.
- Supports one-time import from an exported WhatsApp chat `.txt` file.

## Config

Required:

- `GROUP_NAME` - exact WhatsApp group name to watch

Optional:

- `.env` file in the project root is loaded automatically.
- `TRIGGER_TEXT` - defaults to `תוסיף`
- `STATE_FILE` - defaults to `state.json`
- `AUTH_DIR` - defaults to `.wwebjs_auth`
- `LLM_PROVIDER` - `gemini` or `ollama`, defaults to `gemini` when `GEMINI_API_KEY` is set
- `GEMINI_API_KEY` - required when `LLM_PROVIDER=gemini`
- `GEMINI_MODEL` - defaults to `gemini-2.0-flash-lite`
- `OLLAMA_BASE_URL` - defaults to `http://127.0.0.1:11434`
- `OLLAMA_MODEL` - defaults to `qwen3:1.7b`
- `PUPPETEER_EXECUTABLE_PATH` - optional, use this to point to system Chromium

## GitHub Actions Deploy

The deploy workflow lives in [.github/workflows/deploy.yml](C:/Projects/PickSong/.github/workflows/deploy.yml).

Required repository secrets:

- `RESTART_CMD` - optional, for example `systemctl restart picksong`

Notes:

- The workflow runs on a self-hosted GitHub Actions runner on the Oracle VM.
- It installs production dependencies locally with `npm install --omit=dev`.
- It runs `RESTART_CMD` only if the secret is set.
- `RESTART_CMD` should be a simple local command such as `systemctl restart picksong` or `pm2 restart picksong`.

Important:

- Set `STATE_FILE` and `AUTH_DIR` to paths outside the GitHub Actions workspace if you do not want deploys to wipe them.
- A good choice is something like `/home/ubuntu/picksong-data/state.json` and `/home/ubuntu/picksong-data/wwebjs`.

## Run

1. Install dependencies.
2. Set `GROUP_NAME`.
3. Set `LLM_PROVIDER=gemini` and `GEMINI_API_KEY` if you want the lighter cloud model.
4. Run `npm start` for live listening only.

## Import

To import a WhatsApp chat export:

```bash
node src/main.js --import /path/to/chat.txt
```

This reads the exported text file, extracts songs, writes them to `state.json`, and exits.

On first login, the process will print a QR code in the terminal.
