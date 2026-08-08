# PickSong LLM Agent Migration Plan

## Goal

Migrate PickSong from app-side Hebrew parsing to a single LLM-agent interpretation path, while keeping search, ranking, validation, persistence, and WhatsApp context resolution deterministic in application code.

## Current Codebase Findings

- `src/main.js` currently owns request semantics with hardcoded parsing for count, artist, genre, difficulty, and feel.
- `src/llm.js` is an extraction helper for add-song/import style flows, not an action agent.
- `src/whatsapp.js` reads quoted text, but not enough reply metadata for deterministic result-context resolution.
- `src/state.js` currently normalizes songs into a reduced legacy shape and would drop canonical fields from `state.json` on save.
- `state.json` is already a canonical enriched dataset with `schema_version: 2`, `ai_enrichment.complete: true`, `song_id`, `ai_metadata`, and `band_status`.

## Migration Phases

### Phase 1: Protect the canonical dataset

Files:

- `src/state.js`
- `state.json` as runtime input only

Tasks:

- Preserve top-level canonical fields such as `schema_version` and `ai_enrichment`.
- Preserve full song records including `song_id`, `ai_metadata`, and `band_status`.
- Add startup validation for canonical dataset integrity.
- Add state support for chat-scoped result context and bot message result mappings.

Acceptance criteria:

- Loading and saving state does not drop canonical fields.
- Startup fails with a clear error if `schema_version` is invalid, `ai_enrichment.complete !== true`, or required song fields are missing.
- The current `state.json` round-trips without structural loss.

### Phase 2: Define runtime schemas

Files:

- `src/schemas.js`
- `src/state.js`
- `src/main.js`

Tasks:

- Define schemas for `Song`, `AiMetadata`, `BandStatus`, `SongQuery`, `AgentAction`, `AddSongAction`, `UpdateSongAction`, and `ResultContext`.
- Add reusable validation for persisted records and agent actions.

Acceptance criteria:

- Every agent action is validated before execution.
- Invalid action names, enums, result indexes, and incomplete add-song payloads are rejected deterministically.

### Phase 3: Isolate WhatsApp transport

Files:

- `src/whatsapp.js`
- `src/main.js`
- `src/result-context.js`

Tasks:

- Detect the literal `בוט` trigger and strip it before agent submission.
- Capture reply metadata including quoted message id and whether the quoted message belongs to the bot.
- Resolve context by reply-to-bot-result first, then by per-chat `last_results`, otherwise ask for clarification.

Acceptance criteria:

- Reply messages to bot results are handled without the `בוט` prefix.
- Context stays isolated per chat.
- Missing context produces clarification instead of guesses.

### Phase 4: Replace the current LLM extractor with an action agent

Files:

- `src/llm.js`
- `src/config.js`
- `src/agent.js`

Tasks:

- Replace extraction-only prompting with strict structured actions.
- Add Groq OpenAI-compatible configuration:
  - `GROQ_API_KEY`
  - `GROQ_MODEL`
  - `GROQ_BASE_URL`
- Keep the provider boundary narrow and reusable.

Acceptance criteria:

- The model returns structured actions only.
- The app does not parse freeform LLM prose.
- Requested result counts and references come from agent output, not app-side parsing.

### Phase 5: Implement deterministic repositories and action execution

Files:

- `src/song-repository.js`
- `src/action-executor.js`
- `src/state.js`

Tasks:

- Centralize lookup by `song_id`, normalized title/artist, and result context.
- Implement duplicate detection for canonical add-song.
- Restrict mutable song fields.
- Keep all database/state mutations inside validated executor code.

Acceptance criteria:

- `add_song` inserts one complete canonical record or returns clarification.
- `update_song_feedback` resolves list indexes to stored `song_id` deterministically.

### Phase 6: Implement deterministic local search and ranking

Files:

- `src/song-search.js`
- `src/song-repository.js`

Tasks:

- Implement `searchSongs(query)` with requirements, preferences, exclusions, and limit.
- Weight actual `band_status` above AI metadata.
- Penalize `fit=bad` strongly unless explicitly requested.
- Support local similar-song retrieval from `song_id`.

Acceptance criteria:

- Ranking is deterministic for a fixed dataset and query.
- Actual band feedback overrides AI-estimated suitability.

### Phase 7: Persist result lists and confirmations

Files:

- `src/result-context.js`
- `src/main.js`

Tasks:

- Number every multi-song response.
- Persist `bot_message_id -> results[index, song_id]`.
- Persist per-chat `last_results`.
- Add short confirmation replies for updates.

Acceptance criteria:

- Replying to an old result resolves against that exact stored result set.
- Non-reply references can fall back to the chat's `last_results`.

### Phase 8: Remove legacy parsing

Files:

- `src/main.js`
- `test/main.test.js`
- `test/add-command.test.js`

Tasks:

- Delete legacy count parsing, ordinal parsing, token maps, keyword routing, and parser-driven tests.

Acceptance criteria:

- There is one semantic path:
  - message
  - agent
  - validated action
  - deterministic execution

### Phase 9: Replace tests with migration-relevant coverage

Files:

- `test/state.test.js`
- `test/result-context.test.js`
- `test/agent-actions.test.js`
- `test/song-search.test.js`
- `test/feedback-flow.test.js`

Tasks:

- Add tests for canonical validation, invalid action rejection, deterministic index resolution, reply-context priority, duplicate detection, ranking determinism, and feedback persistence.

Acceptance criteria:

- Tests protect the new architecture instead of enforcing app-side language understanding.

### Phase 10: Manual verification and docs

Files:

- `README.md`
- `.env.example`
- optional migration notes

Tasks:

- Document Groq environment variables and startup behavior.
- Verify key WhatsApp scenarios from the implementation prompt.

Acceptance criteria:

- Local run instructions match the migrated architecture.
- Manual verification covers recommendation, feedback, add-song, corrections, and ambiguous context.

## Implementation Order

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5
6. Phase 6
7. Phase 7
8. Phase 8
9. Phase 9
10. Phase 10

## Immediate Next Step

Start with Phase 1 in `src/state.js` so the app can safely load and save the current canonical `state.json` without losing fields.
