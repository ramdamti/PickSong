# PickSong

WhatsApp bot for a band group that uses one LLM agent path for Hebrew natural-language requests and keeps search, ranking, validation, persistence, and updates deterministic in local code.

## Current Architecture

Flow:

1. WhatsApp message arrives.
2. Transport layer checks only:
   - target group
   - literal wake word `בוט`
   - reply metadata
3. Structured reply context is loaded from local state when available.
4. The LLM returns one validated action.
5. Local code executes the action deterministically against `state.json`.
6. Results and reply context are persisted locally.

Important boundaries:

- The LLM interprets meaning.
- The application executes.
- The LLM never writes directly to the dataset.
- The local canonical song dataset is the source of truth.

## Supported Behavior

Current runtime supports:

- natural-language recommendations through `בוט ...`
- replying to bot messages without the wake word
- search and ranked recommendations
- add song
- update song
- remove song
- update song feedback
- get song info
- explain why a song failed
- list good / bad / maybe band songs
- band failure summaries
- similar-song requests through result context

Result-list context:

- numbered song lists are persisted by bot message id
- per-chat `last_results` is persisted
- replies to old bot result messages take priority over `last_results`

## State

Primary files:

- `state.json` - canonical dataset and runtime context
- `seen.json` - recent seen-message cache

The runtime expects `state.json` to already be canonical and enriched. On startup it validates:

- `schema_version`
- `ai_enrichment.complete`
- required canonical song fields
- required AI metadata fields
- `band_status`

If the dataset is malformed, startup fails instead of silently repairing it.

## Configuration

Required:

- at least one target group via:
- `GROUP_NAME` - exact WhatsApp group name to watch
- `GROUP_NAMES` - comma-separated WhatsApp group names to watch
- `GROUP_ID` - exact WhatsApp chat id to watch
- `GROUP_IDS` - comma-separated WhatsApp chat ids to watch

Optional:

- `GROUP_ID` / `GROUP_IDS` take priority over group-name matching and avoid group-name lookup issues
- `TRIGGER_TEXT` - defaults to `בוט`
- `STATE_FILE` - defaults to `state.json`
- `SEEN_FILE` - defaults to `seen.json`
- `AUTH_DIR` - defaults to `.wwebjs_auth`
- `DISCOVER_CHORDS` - `true` or `false`, defaults to `true`
- `LLM_PROVIDER` - `groq` or `openai_compatible`, defaults to `groq`
- `GROQ_API_KEY` - required for `LLM_PROVIDER=groq`
- `GROQ_MODEL` - defaults to `openai/gpt-oss-20b`
- `GROQ_BASE_URL` - defaults to `https://api.groq.com/openai/v1`
- `OPENAI_COMPATIBLE_API_KEY` - optional for `LLM_PROVIDER=openai_compatible`
- `OPENAI_COMPATIBLE_MODEL` - required if `LLM_PROVIDER=openai_compatible`
- `OPENAI_COMPATIBLE_BASE_URL` - required if `LLM_PROVIDER=openai_compatible`
- `PUPPETEER_EXECUTABLE_PATH` - optional, use this to point to system Chromium
- `HEADLESS` - defaults to `true`

See [`.env.example`](C:/Projects/PickSong/.env.example:1).

## LLM Efficiency

The runtime is tuned for Groq usage with `openai/gpt-oss-20b` and assumes the Groq docs as verified on August 8, 2026.

Operational rules:

- normal handling performs at most one LLM call per incoming user message
- search, ranking, validation, persistence, and formatting stay deterministic in local code
- the runtime prompt sends only `current_date`, `user_message`, and minimal `reply_context`
- the full song database is never sent to the model
- local formatting and state writes never trigger extra LLM calls

Groq-specific notes:

- `openai/gpt-oss-20b` supports prompt caching
- cached prompt tokens do not count toward Groq rate limits
- caching is prefix-based, so the stable system prompt is intentionally reused
- exact free-tier request and token quotas are account-specific and must be checked in the Groq Limits page for the active organization
- the model call caps output with `max_completion_tokens=800`
- 429 responses are retried once with `retry-after` support before the request is surfaced as a temporary overload

Observability:

- each agent call logs action, prompt tokens, cached tokens, completion tokens, total tokens, and latency
- in-memory counters track minute/day calls, input tokens, output tokens, cached tokens, and rate-limit responses
- agent concurrency is limited to `2` in-flight calls to avoid bursty free-tier throttling

## Run

1. Install dependencies.
2. Set one or more target groups with `GROUP_NAME`, `GROUP_NAMES`, `GROUP_ID`, or `GROUP_IDS`.
3. Set `GROQ_API_KEY`.
4. Adjust `STATE_FILE`, `SEEN_FILE`, and `AUTH_DIR` if you want them outside the workspace.
5. Run `npm start`.

On first login, the process prints a QR code in the terminal.

## Tests

Run:

```powershell
npm test
```

The test suite currently covers:

- canonical state validation and persistence
- agent prompt and action validation
- one-agent-call handling for normal message execution
- compact prompt shaping without dataset leakage
- single-retry behavior for 429 responses
- result-context resolution
- deterministic ranking
- wake-word handling
- action execution for add/update/remove/feedback/history flows

Integration tests against live WhatsApp or a live LLM provider are intentionally deferred at this stage.

## Example Interactions

New request:

```text
בוט תן 5 שירי רוק קצביים שמתאימים לזמרת
```

Reply feedback:

```text
2 ו-4 לא התאימו לנו
```

Similar request:

```text
בוט תביא עוד כמו 3
```

Rejection explanation:

```text
בוט למה הורדנו את Zombie?
```

Metadata correction:

```text
בוט האומן של 2 לא נכון
```

## Deployment Notes

The deploy workflow lives in [.github/workflows/deploy.yml](C:/Projects/PickSong/.github/workflows/deploy.yml).

Notes:

- The workflow runs on a self-hosted GitHub Actions runner on the Oracle VM.
- Checkout uses `clean: false` so untracked files such as `.env` are not removed during deploy.
- It installs production dependencies locally with `npm install --omit=dev`.
- It deploys with `systemctl --user stop picksong`, waits for the WhatsApp Chromium `SingletonLock` to clear, and force-releases the lock holder if needed before starting the service again.

Recommended for persistence outside the workspace:

- `STATE_FILE=/home/ubuntu/picksong-data/state.json`
- `SEEN_FILE=/home/ubuntu/picksong-data/seen.json`
- `AUTH_DIR=/home/ubuntu/picksong-data/wwebjs`

Example multi-group config:

```dotenv
GROUP_NAMES=Band Rehearsal,TestMyBot
GROUP_IDS=120363420724758799@g.us,120363245259281935@g.us
```

## Deferred

Still intentionally deferred as of August 8, 2026:

- integration tests through a live WhatsApp-style flow
- manual live verification of every scenario in the implementation prompt
