# Tool Agent Architecture Proposal

Date: August 11, 2026

## Goal

Improve the agent so it is smarter on ambiguous, contextual, and reply-based requests without giving it direct write access to the dataset.

The current architecture is:

1. user message arrives
2. one prompt is sent to the model
3. model returns one JSON action
4. local code executes that action deterministically

That approach is stable, but it pushes too much interpretation into one model response.

## Recommendation

Move from a single-shot JSON interpreter to a constrained tool-using agent.

Not:

- fully autonomous agent
- direct file editing by the model
- direct model writes into `state.json`

Yes:

- model can inspect local context through narrow tools
- model can take 1-3 small reasoning steps when needed
- app code still owns validation, ranking, persistence, and mutation

## Why This Is Better

Main gains:

- better handling of reply chains
- better handling of `this song`, `that one`, `same style`, `fix this`, `add this`
- less prompt pressure
- less need for brittle regex fallbacks
- fewer cases where the model must guess missing context

Main risks:

- more moving parts
- more token usage if unrestricted
- more latency if too many tool calls are allowed
- more chance of loops unless bounded tightly

## Design Principle

The model should decide intent and ask for context.

The app should:

- validate all inputs
- execute all writes
- enforce limits
- format replies
- remain the source of truth

## Proposed Architecture

### Layer 1: Router

Keep a thin transport/router layer in app code.

Responsibilities:

- target group filtering
- bot self-message filtering
- wake-word handling
- reply metadata extraction
- minimal context packaging

This layer should not try to understand the full request semantics.

### Layer 2: Tool Agent

Replace the current “one JSON action only” interpretation step with a tool agent that can inspect local state through controlled tools.

The model should:

- classify the user intent
- inspect relevant context
- choose a valid next step
- return either a read result or a mutation intent

### Layer 3: Deterministic Executor

Keep mutation execution in local code only.

The model may propose:

- add this song
- update this song
- remove this song
- mark these songs good/bad/maybe

But local code must still:

- validate payloads
- resolve canonical matches
- reject unsafe updates
- persist state

## Tool Categories

### Read Tools

These are the most important first step.

Recommended read tools:

- `get_recent_messages(chat_id, limit)`
- `get_quoted_message(record_id)`
- `get_last_results(chat_id)`
- `get_result_message_context(chat_id, bot_message_id)`
- `search_songs(query)`
- `find_song_candidates(title, artist)`
- `get_song_by_id(song_id)`
- `get_song_details(song_id)`
- `get_band_status(song_id)`
- `get_recent_recommendations(chat_id)`
- `find_similar_songs(reference_song_id, query)`

### Write-Intent Tools

These should not directly mutate state. They should return candidate operations for local execution.

Recommended write-intent tools:

- `propose_add_song(song_identity, enrichment_mode)`
- `propose_update_song(target, updates)`
- `propose_remove_song(target)`
- `propose_feedback_update(updates)`

These tools should produce structured intent objects that app code validates and commits.

### Utility Tools

- `discover_chords(song_identity)`
- `normalize_artist_name(raw_artist)`
- `normalize_song_identity(raw_text)`
- `extract_reply_song_identity(quoted_text)`

These can reduce prompt burden and improve consistency.

## Suggested Tool Flow By Use Case

### 1. Recommendation Request

Example:

`בוט תביא 4 שירי רוק קלים`

Flow:

1. agent inspects message
2. agent calls `search_songs(query)`
3. app returns ranked candidates
4. agent selects final result set or asks clarification if truly necessary
5. app formats numbered reply and persists result context

### 2. Reply To Bot Result

Example:

`מתי ניגנו את 3`

Flow:

1. agent gets quoted result context
2. agent resolves `result_index=3`
3. agent calls `get_song_details(song_id)`
4. app formats info reply

### 3. Reply To Non-Bot Song Line

Example:

quoted text:
`wish you where here - Pink Floyd`

user message:
`בוט תוסיף`

Flow:

1. agent receives `quoted_message`
2. agent calls `extract_reply_song_identity(quoted_text)`
3. agent calls `propose_add_song(song_identity, enrichment_mode="full")`
4. local code validates and persists

### 4. Correction Request

Example:

`בוט תקן את 4 ל רד מעל הטלויזיה שלי של פורטיס`

Flow:

1. agent gets result context
2. agent resolves target by index
3. agent proposes updates
4. app validates allowed fields and writes

### 5. Band Feedback

Example:

`2 ו-4 לא עבדו לנו`

Flow:

1. agent resolves result indexes from result context
2. agent proposes feedback update
3. app applies deterministic band status updates

## What Should Stay Deterministic

These should remain in app code:

- local ranking
- duplicate detection
- result numbering
- state persistence
- schema validation
- allowed field enforcement
- mutation safety rules
- bot reply formatting
- recent recommendation rotation
- startup state validation

## What Can Move To Tools

These are good candidates for tool-assisted reasoning:

- ambiguous song identity resolution
- deciding whether a reply refers to a song, result, or feedback item
- deciding whether `של ...` means artist in the current context
- deciding whether a request is search vs info vs correction vs add
- deciding when a quoted message is the real subject of the request
- add-song enrichment planning

## Migration Plan

### Phase 1

Add read tools only.

Keep the current mutation executor unchanged.

Goal:

- improve context understanding
- reduce prompt hacks
- keep risk low

### Phase 2

Add write-intent tools.

The model proposes structured mutations, but app code still performs:

- validation
- resolution
- persistence

### Phase 3

Reduce prompt-only heuristics.

As tools become reliable, remove brittle fallback logic that exists only because the current model sees too little context.

## Hard Constraints

If this architecture is implemented, keep these rules:

- no direct model writes to `state.json`
- no unbounded multi-step loops
- max tool-call budget per user message
- max one mutation commit per command unless explicitly multi-target
- all write intents must be schema-validated locally
- all user-visible replies are formatted by app code

## Recommended Limits

- max 3 tool calls for normal requests
- max 5 tool calls for complex reply/correction flows
- max 1 LLM round after tool inspection for most requests
- hard timeout per message
- explicit fallback reply on failure

## Best First Version For This Repo

For this codebase, the strongest first version is:

1. keep current `handleAgentMessage()` and executor structure
2. replace single-shot interpretation with a small tool-capable agent layer
3. add these first tools:
   - `get_quoted_message`
   - `get_last_results`
   - `search_songs`
   - `find_song_candidates`
   - `get_song_details`
   - `extract_reply_song_identity`
4. keep add/update/remove/feedback writes deterministic in existing app code

This will improve intelligence without turning the bot into a risky autonomous system.

## Bottom Line

Yes, moving to tools can make the agent smarter.

The right version for PickSong is:

- tool-assisted reasoning
- deterministic local execution
- bounded steps
- no direct dataset writes by the model

That gives you better contextual understanding without giving up control.
