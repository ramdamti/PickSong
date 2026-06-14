# PickSong

Small WhatsApp song picker for a band group.

## What it does

- Watches one WhatsApp group in headless mode.
- Extracts song suggestions from mixed Hebrew and English chat.
- Saves extracted songs to `state.json`.
- Replies to the trigger `תביא שיר` with the next unused song.

## Config

Required:

- `GROUP_NAME` - exact WhatsApp group name to watch

Optional:

- `.env` file in the project root is loaded automatically.
- `TRIGGER_TEXT` - defaults to `תביא שיר`
- `HISTORY_MESSAGES` - defaults to `5000`
- `STATE_FILE` - defaults to `state.json`
- `OLLAMA_BASE_URL` - defaults to `http://127.0.0.1:11434`
- `OLLAMA_MODEL` - defaults to `qwen3:1.7b`

## GitHub Actions Deploy

The deploy workflow lives in [.github/workflows/deploy.yml](C:/Projects/PickSong/.github/workflows/deploy.yml).

Required repository secrets:

- `SSH_HOST`
- `SSH_USER`
- `SSH_KEY`
- `DEPLOY_PATH`
- `RESTART_CMD` - optional, for example `pm2 restart picksong`

Notes:

- The workflow pushes the repo to the Oracle VM over SSH.
- It installs production dependencies on the server with `npm install --omit=dev`.
- It runs `RESTART_CMD` only if the secret is set.

## Run

1. Install dependencies.
2. Start Ollama locally.
3. Set `GROUP_NAME`.
4. Run `npm start`.

On first login, the process will print a QR code in the terminal.
