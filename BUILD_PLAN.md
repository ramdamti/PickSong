# PickSong Build Plan

## Goal

Build a small personal service that watches a WhatsApp band group, learns song suggestions from the chat history plus future messages, and returns `next song` on request.

## Constraints

- Free to run on Oracle Cloud Always Free.
- No database.
- Persist extracted songs to a file so restarts do not lose state.
- Keep the system simple.
- Support mixed Hebrew and English chat.
- Song titles may appear in either Hebrew or English.
- The output should preserve the original language of the suggestion.

## Recommended Approach

Use a single local process on Oracle that does four things:

1. Connects to WhatsApp Web and reads the group chat.
2. Bootstraps an in-memory list of suggested songs from existing history.
3. Keeps listening for new messages and appends future song suggestions.
4. Responds to `next song` by selecting one song from the in-memory list.

Use a small local LLM for semantic extraction rather than keyword rules.

## Proposed Stack

- Oracle Cloud Always Free ARM VM
- Node.js or Python
- WhatsApp Web automation with Playwright or Puppeteer
- Local LLM via Ollama
- Small open-weight multilingual model, starting with Qwen3 1.7B or 4B instruct
- In-memory list for active song suggestions
- Persistent `state.json` file for songs and used flags

## Data Model

Keep the extracted song object minimal.

```json
{
  "message_id": "whatsapp-message-id",
  "source_text": "Possible song suggestion in Hebrew or English",
  "song_title": "Hallelujah",
  "artist": null,
  "language": "en",
  "confidence": 0.91,
  "used": false,
  "created_at": "2026-06-14T00:00:00Z"
}
```

## Extraction Strategy

Use the LLM only for semantic extraction.

Input:
- One chat message, or a small batch of recent messages when bootstrapping history.

Output:
- JSON only.
- `is_song_suggestion`
- `song_title`
- `artist`
- `confidence`
- `needs_review`

Rules:
- Preserve the original title exactly as written.
- Do not translate Hebrew titles into English.
- Do not translate English titles into Hebrew.
- If the message is ambiguous, mark `needs_review: true`.

## Message Flow

### 1. Bootstrap

- Start the watcher.
- Load the WhatsApp group history once.
- Run extraction over older messages.
- Populate the in-memory suggestion list.

### 2. Live Updates

- Watch incoming group messages.
- For each new message, run the extractor.
- If the message is a song suggestion, append it to the list.

### 3. Next Song Command

- Detect the exact command `next song`.
- Pick the next unused suggestion from memory.
- Reply in the group with the chosen song.
- Mark that suggestion as used for the current runtime.

## Selection Logic

Keep the chooser simple.

Recommended order:

1. Prefer unused songs.
2. Skip messages with low confidence unless needed.
3. If multiple suggestions point to the same song, dedupe by normalized title.
4. If the list is empty, reply that no suggestions are available yet.

## Normalization

Use lightweight normalization only for matching.

- Trim whitespace.
- Lowercase English text for comparisons.
- Remove repeated punctuation.
- Keep the original string for display.

Do not force transliteration unless matching becomes a problem.

## Duplicate Handling

Because there is no database, dedupe using:

- WhatsApp message ID
- normalized song title
- optional normalized artist

Persist the full list to `state.json` after each update so restarts keep the current queue and used state.

## Oracle Free Tier Notes

Oracle Cloud Free Tier includes Always Free services, including Arm-based Ampere A1 Compute, and those services are available indefinitely subject to capacity limits.

This is enough for:

- a small local LLM
- a headless browser session
- a simple watcher process

The weakest point is not compute. The weakest point is WhatsApp Web automation reliability.

## Build Phases

### Phase 1: Model and Prompt

- Pick a small multilingual open model.
- Run it locally with Ollama.
- Validate that it can detect Hebrew and English song suggestions.
- Verify JSON output consistency.

### Phase 2: WhatsApp Watcher

- Automate WhatsApp Web login.
- Read the target group chat.
- Capture incoming messages and message IDs.
- Confirm the script can run continuously.

### Phase 3: History Bootstrap

- Read the existing chat history once.
- Extract songs from older messages.
- Populate the in-memory list.

### Phase 4: Live Suggestion Tracking

- Process new messages as they arrive.
- Append new song suggestions to the list.
- Avoid duplicates.

### Phase 5: `next song`

- Add the command handler.
- Return one unused song from memory.
- Test repeat requests and empty state behavior.

### Phase 6: Hardening

- Add retries for browser disconnects.
- Add logging.
- Add `state.json` save and load on startup.
- Write state after each new song suggestion and after each `next song` selection.

## Risks

- WhatsApp Web automation may break when the UI changes.
- A headless session may get logged out and need manual QR re-authentication.
- A very small model may miss some indirect Hebrew suggestions.
- Without persistence, all state is lost on restart.

## Success Criteria

- The service boots on Oracle free tier.
- It extracts songs from Hebrew and English chat.
- It learns from history and future messages.
- Sending `next song` returns a reasonable song suggestion.
- No database is required.

## Nice-To-Have Later

- Optional JSON persistence.
- Manual review queue for low-confidence suggestions.
- Better dedupe and normalization.
- A simple admin command to clear used songs.
