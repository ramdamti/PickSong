# PickSong

Small WhatsApp song picker for a band group.

## What it does

- Watches one WhatsApp group in headless mode.
- Extracts song suggestions from mixed Hebrew and English chat.
- Saves extracted songs to `state.json`.
- Saves seen-message cache to `seen.json`.
- Replies to the trigger `תוסיף למאגר` with the next song.

## Config

Required:

- `GROUP_NAME` - exact WhatsApp group name to watch

Optional:

- `.env` file in the project root is loaded automatically.
- `TRIGGER_TEXT` - defaults to `תוסיף למאגר`
- `STATE_FILE` - defaults to `state.json`
- `SEEN_FILE` - defaults to `seen.json`
- `AUTH_DIR` - defaults to `.wwebjs_auth`
- `DISCOVER_CHORDS` - `true` or `false`, defaults to `true`
- `LLM_PROVIDER` - `gemini` or `ollama`, defaults to `gemini` when `GEMINI_API_KEY` is set
- `GEMINI_API_KEY` - required when `LLM_PROVIDER=gemini`
- `GEMINI_MODEL` - defaults to `gemini-2.0-flash-lite`
- `OLLAMA_BASE_URL` - defaults to `http://127.0.0.1:11434`
- `OLLAMA_MODEL` - defaults to `qwen3:1.7b`
- `PUPPETEER_EXECUTABLE_PATH` - optional, use this to point to system Chromium

## GitHub Actions Deploy

The deploy workflow lives in [.github/workflows/deploy.yml](C:/Projects/PickSong/.github/workflows/deploy.yml).

Notes:

- The workflow runs on a self-hosted GitHub Actions runner on the Oracle VM.
- Checkout uses `clean: false` so untracked files such as `.env` are not removed during deploy.
- It installs production dependencies locally with `npm install --omit=dev`.
- It restarts the service with `systemctl --user restart picksong`.
- The runner user must have a user systemd instance available. If deploy fails with `Failed to connect to bus`, run `loginctl enable-linger <runner-user>` once on the server.

Important:

- Set `STATE_FILE`, `SEEN_FILE`, and `AUTH_DIR` to paths outside the GitHub Actions workspace if you do not want deploys to wipe them.
- A good choice is something like `/home/ubuntu/picksong-data/state.json`, `/home/ubuntu/picksong-data/seen.json`, and `/home/ubuntu/picksong-data/wwebjs`.

## Run

1. Install dependencies.
2. Set `GROUP_NAME`.
3. Set `LLM_PROVIDER=gemini` and `GEMINI_API_KEY` if you want the lighter cloud model.
4. Run `npm start` for live listening only.

On first login, the process will print a QR code in the terminal.
