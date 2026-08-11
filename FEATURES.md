# PickSong Features

This file lists the current application features in the repository as of August 11, 2026.

## Core Bot Behavior

- WhatsApp bot for one or more configured group chats
- Hebrew-first natural-language interaction
- Single LLM interpretation step followed by deterministic local execution
- Canonical local dataset in `state.json` as the source of truth
- Bot replies are prefixed with `🤖`

## Message Routing

- Handles direct requests that start with the wake word `בוט`
- Supports configurable wake word via `TRIGGER_TEXT`
- Ignores the bot's own outgoing `🤖` messages to prevent loops
- Supports replies to bot result messages without requiring the wake word
- Supports replies to non-bot messages only when the user still writes `בוט ...`
- Uses quoted message text as additional context for agent interpretation
- Keeps the last 3 recent chat messages as lightweight context for the agent

## Song Search And Recommendations

- Free-text song recommendation requests
- Search by artist
- Search by language
- Search by genres
- Search by overall difficulty: `low`, `medium`, `high`
- Search by feel / rhythm mood: `upbeat`, `calm`, `ballad`
- Search by singer fit and vocal-related intent
- Search by groove / energy / crowd-friendly intent
- Search by keyboard presence and keyboard type
- Search by instrument difficulty preferences for guitar, bass, drums, and keys
- Search for a single song or multiple songs
- Automatic extraction of requested list size from Hebrew and English phrasing
- "More like this" / similar-song search from a previous numbered result
- Fresh follow-up search that avoids previously returned songs when appropriate
- Rotation away from recently recommended songs when enough alternatives exist
- Fallback broadening when strict filtered candidates return nothing

## Artist Handling

- Artist requests from explicit phrasing like `שירים של ...`
- Canonical English artist mapping when appropriate
- Strong artist preservation in artist-focused requests
- Fuzzy / tolerant matching in local search for artist-name variations
- Support for Hebrew and English artist names in requests

## Result Context

- Numbered result lists are persisted by bot message id
- Per-chat `last_results` tracking
- Replies to old bot result messages resolve against the original stored result list
- Result indexes can be used in follow-up commands like info, correction, removal, feedback, and similar-song queries

## Song Information And Follow-Ups

- Get detailed info for a song from a previous result list
- Get detailed info for a directly identified song
- Explain why a song was rejected for the band
- Ask for similar songs based on a prior result
- Reply-based chords request on a bot result list

## Chords

- Chords lookup flow for returned songs
- Chords URLs can be discovered and attached to songs
- Replying to a bot song list with a chords request returns the same songs with chord links
- Chords URLs can be persisted back into the local dataset

## Song Library Management

- Add song
- Update song
- Remove song
- Add song from an explicit request like `בוט תוסיף ...`
- Add song from a reply flow like `בוט תוסיף` / `בוט תוסיף למאגר`
- Reply-based add flow can use the replied song line as song identity input
- Add flow still goes through the agent so it can normalize title/artist and enrich metadata
- Update flow supports correcting song title and/or artist
- Remove flow supports identity-based deletion

## Metadata Supported Per Song

- `song_title`
- `artist`
- `language`
- `chords_url`
- `confidence`
- `genres`
- `difficulty`
- `feel`
- `normalized_title`
- `normalized_artist`
- `song_id`
- `ai_metadata`
- `band_status`

## AI Metadata / Enrichment Fields

- Original vocal profile
- Vocal range
- Vocal style tags
- Singer fit
- Vocal energy
- Band energy
- Crowd-friendly signal
- Groove level
- Guitar difficulty
- Bass difficulty
- Drums difficulty
- Keys role
- Keys type
- Keys difficulty
- Bass interest

## Band Evaluation And Feedback

- Update feedback for one or more songs from a previous result list
- Good / maybe / bad band-fit tracking
- Band issues tracking
- Band notes tracking
- Attempt counters
- Last reviewed / rehearsed / played dates
- Positive / negative feedback normalization from short natural-language replies
- "Too hard", "too easy", and other rehearsal-fit heuristics
- Queries for good songs
- Queries for maybe songs
- Queries for bad songs
- Summary of why songs failed for the band

## Hebrew Request Understanding

- Hebrew wake-word flows
- Hebrew quantity phrases
- Hebrew artist phrasing with `של`
- Hebrew difficulty requests
- Hebrew genre requests
- Hebrew feel / rhythm intent
- Hebrew feedback normalization
- Hebrew correction phrasing
- Hebrew follow-up questions on bot result lists

## Agent Safety And Validation

- Agent must return exactly one JSON action
- All agent output is schema-validated locally
- Invalid or partial agent outputs are normalized or rejected
- Explicit add requests can be repaired from message text when the model returns `clarify`
- Explicit add requests can be repaired when the model returns `add_song` with missing identity fields
- Deterministic local execution prevents the model from writing directly to the dataset

## State And Persistence

- Canonical `state.json` persistence
- Seen-message cache via `seen.json`
- Recommendation history persistence
- Result-message persistence
- Chord URL persistence
- Validation of canonical dataset structure on startup
- Startup failure on malformed dataset instead of silent repair

## Operational Features

- Supports `groq` and `openai_compatible` providers
- Prompt caching support for Groq-compatible usage
- Agent token / cache / latency logging
- In-memory minute/day usage counters
- Concurrency limiting for agent calls
- Controlled retry behavior for rate limits
- User-scoped `systemctl --user` deployment flow
- Service-oriented production deployment through GitHub Actions

## Current Practical Rules

- Non-bot replies require `בוט` unless replying to a bot `🤖` message
- Add-song by reply to a normal song line requires `בוט תוסיף`
- Info / follow-up requests without `בוט` are intended for replies to bot `🤖` messages
- The bot uses replied text as context, but authoritative numbered follow-up handling comes from persisted bot result context
