# PickSong — LLM Agent Migration and Song Intelligence Implementation

I want to evolve the existing **PickSong** project into an LLM-driven WhatsApp bot for our band.

The implementation should replace the existing rule-based natural-language interpretation with an LLM Agent, while keeping deterministic application logic for search, ranking, persistence, validation, and database updates.

The bot will primarily receive natural-language requests in **Hebrew**.

---

# 1. Core architectural principles

Before making changes:

1. Analyze the existing codebase, data structures, WhatsApp flow, persistence mechanism, song storage, and any existing OpenAI/LLM integrations.
2. Reuse existing infrastructure where it still makes sense.
3. Preserve existing **product capabilities**, but do not preserve obsolete implementation details or compatibility layers.
4. Prefer a clean migration to the new Agent architecture.
5. Remove legacy natural-language parsing once it has been replaced.
6. Do not keep old and new interpretation mechanisms running in parallel.
7. The local song database is the source of truth.
8. The LLM Agent is the single semantic understanding layer for ALL user requests.
9. The application must not duplicate semantic interpretation with regexes, keyword maps, number parsing, intent-specific phrase handlers, or request heuristics.
10. The LLM must never write directly to the database.

The desired architectural boundary is:

```text
LLM
- understands natural language
- extracts intent
- identifies preferences, constraints, exclusions and feedback
- selects an allowed action/tool

Application
- validates
- resolves WhatsApp context
- resolves song IDs
- searches locally
- ranks songs
- reads/writes data
- maintains state
- persists feedback
- returns deterministic results where possible

Legacy natural-language parsing
- removed
```

---

# 2. Goal

Allow band members to naturally talk to the bot inside the band's WhatsApp group.

Examples:

```text
בוט תן 5 שירי רוק קצביים שמתאימים לזמרת
```

```text
בוט תן משהו קל שעוד לא ניסינו
```

```text
בוט איזה שירים שלא הסתדרו לנו כדאי לנסות שוב?
```

After the bot returns a list:

```text
2 ו-4 לא התאימו לנו
```

```text
1 היה מעולה, 3 קשה מדי
```

```text
השני טוב אבל צריך להוריד טון
```

```text
תביא עוד כמו 4
```

```text
את האחרון כבר ניסינו והוא לא עבד
```

The Agent must understand Hebrew natural language well.

The user should not need to learn command syntax.

---

# 3. Bot trigger

Inside a WhatsApp group, a new standalone request should only be handled by the Agent if it begins with:

```text
בוט
```

Support forms such as:

```text
בוט ...
בוט, ...
בוט: ...
בוט - ...
```

The trigger itself should not be sent to the LLM.

For example:

```text
בוט תן לי שיר רוק קצבי
```

should become:

```text
תן לי שיר רוק קצבי
```

before being sent to the Agent.

## Reply exception

If a user replies directly to a message sent by the bot, the `בוט` trigger is not required.

For example, if the bot previously returned a song list and the user replies:

```text
2 ו-5 לא עבדו לנו
```

the message should be processed by the Agent even though it does not begin with `בוט`.

---

# 4. Numbered result lists

Whenever the bot returns multiple songs, the result should be numbered.

Example:

```text
מצאתי 5 שירים:

1. Zombie – The Cranberries
2. Bring Me To Life – Evanescence
3. What's Up – 4 Non Blondes
4. Dreams – The Cranberries
5. Ironic – Alanis Morissette
```

When the message is successfully sent to WhatsApp, store a mapping between the bot's WhatsApp message ID and the songs shown in that message.

Example:

```json
{
  "bot_message_id": "...",
  "results": [
    { "index": 1, "song_id": "..." },
    { "index": 2, "song_id": "..." },
    { "index": 3, "song_id": "..." }
  ]
}
```

This allows a reply such as:

```text
2 לא עבד
```

to resolve deterministically to the exact song.

---

# 5. `last_results`

In addition to result context by bot message ID, keep the latest result list for each WhatsApp chat/group.

Example conceptual structure:

```text
chatId -> {
  lastResults,
  resultMessages
}
```

This allows:

```text
בוט 2 ו-4 לא הסתדרו
```

without replying directly to the original list.

Resolution priority:

1. If the message is a reply to a bot message with stored result context, use that specific context.
2. Otherwise, use the chat's `last_results`.
3. If there is insufficient context or real ambiguity, do not guess. Ask a short clarification question.

Context must never be global across chats.

Private chats, if supported, should have their own independent context as well.

---

# 6. Reply context

Inspect how the version of `whatsapp-web.js` already used by the project exposes:

- whether a message is a reply
- the quoted/replied message ID
- the quoted message
- whether the quoted message was sent by the bot

Prefer real WhatsApp message metadata over parsing quoted text.

If a reply refers to a stored bot result list, provide the Agent with the structured list context instead of the full WhatsApp conversation history.

Example:

```json
{
  "reply_context": {
    "results": [
      { "index": 1, "song_id": "song-123", "title": "Zombie" },
      { "index": 2, "song_id": "song-456", "title": "Dreams" }
    ]
  }
}
```

Never allow the LLM to invent a `song_id`.

---

# 7. No full database inside the LLM prompt

Do not send the entire song database to the model for each request.

Desired request flow:

```text
User message
↓
LLM Agent
↓
Validated structured intent / tool call
↓
Local search / local data operation
↓
Top results
↓
Optional LLM response formatting
↓
WhatsApp response
```

Create local application tools/functions such as:

```ts
searchSongs({
  genres?,
  feel?,
  difficulty?,
  vocal?,
  vocalRange?,
  language?,
  bandFit?,
  excludePlayed?,
  excludeRejected?,
  similarToSongId?,
  limit?
})
```

The LLM decides what the user means.

The application performs the actual search.

---

# 8. Search should use scoring and ranking

Do not reduce every natural-language request to strict filters.

Example:

```text
בוט תן שיר רוק קצבי, עדיף לזמרת ולא קשה
```

There may be no song satisfying every condition exactly.

The Agent should distinguish between:

- hard requirements
- preferences
- exclusions

Example structured query:

```json
{
  "action": "search_songs",
  "query": {
    "requirements": {
      "genres": ["rock"],
      "feel": ["upbeat"]
    },
    "preferences": {
      "vocal_profile": "female-friendly",
      "difficulty": ["low", "medium"]
    },
    "exclusions": {
      "band_fit": ["bad"]
    },
    "limit": 5
  }
}
```

The exact schema may differ if a cleaner representation fits the codebase.

Implement deterministic local scoring.

Possible scoring factors:

```text
+ genre match
+ feel match
+ difficulty match
+ vocal characteristics match
+ positive band fit
+ not played recently
+ not previously rejected
+ similarity to requested song
```

Songs explicitly marked `bad` by the band should receive a strong penalty unless the user explicitly asks for rejected/problematic songs.

Actual band feedback should outweigh AI assumptions.

---

# 9. Agent actions/tools

Create a small, clean Agent action/tool layer.

At minimum support:

```text
search_songs
add_song
update_song
remove_song
update_song_feedback
get_song_info
find_similar_songs
get_band_good_songs
get_band_bad_songs
get_band_maybe_songs
```

Add more only when clearly useful.

The architecture should support requests such as:

```text
בוט תביא עוד כמו 3
```

```text
בוט איזה שירים הכי הסתדרו לנו?
```

```text
בוט מה ניסינו ולא עבד?
```

```text
בוט למה הורדנו את Zombie?
```

```text
בוט משהו שמתאים לזמרת אבל שהגיטרות קלות
```

```text
בוט משהו עם בס מעניין
```

```text
בוט תן משהו שעוד לא ניסינו
```

---

# 10. Agent owns ALL semantic request understanding

The LLM Agent must be the single source of semantic interpretation for user messages.

Do not implement application-side logic that tries to understand what the user means.

This includes, but is not limited to:

- request intent
- requested number of songs
- whether the user wants one song or a list
- explicit numbers such as `5`
- vague quantities such as `כמה`, `כמה שירים`, `עוד`, `עוד כמה`, `אחד`, `שניים`
- references such as `השני`, `האחרון`, `2 ו-4`, `אלה`, `אותם`
- whether a constraint is required or only preferred
- whether something is an exclusion
- whether the user is asking for recommendations, information, feedback, addition, removal, or modification
- whether the user wants more results similar to a previous result
- interpretation of genre, feel, difficulty, vocalist suitability, instrument difficulty, groove, energy, or band history
- natural-language feedback
- natural-language song addition
- natural-language correction of song metadata

The application should NOT contain semantic helpers such as:

```ts
detectRequestedCount(text)
detectIntent(text)
parseSongNumbers(text)
isRecommendationRequest(text)
isAddSongRequest(text)
extractGenres(text)
extractDifficulty(text)
extractFeel(text)
```

or equivalents based on regex, keywords, phrase dictionaries, or manual heuristics.

The only deterministic parsing allowed before the Agent is transport/protocol-level logic such as:

- detecting the literal `בוט` wake word
- detecting whether the WhatsApp message is a reply
- obtaining the quoted WhatsApp message ID
- loading stored structured context associated with that message

Everything after that is semantic and belongs to the Agent.

## Requested result count

The Agent must explicitly return the requested result count as structured data.

Example:

User:

```text
בוט תן לי 7 שירים קצביים
```

Agent:

```json
{
  "action": "search_songs",
  "query": {
    "feel": ["upbeat"]
  },
  "limit": 7
}
```

User:

```text
בוט תן לי משהו קצבי
```

The Agent may select the application's documented default list size because the user did not specify one.

The application must not inspect the original text to determine the count.

## References to prior results

For messages such as:

```text
השני טוב
```

```text
תביא עוד כמו האחרון
```

```text
2 ו-4 לא התאימו
```

provide the Agent with structured result context:

```json
{
  "results": [
    { "index": 1, "song_id": "song_..." },
    { "index": 2, "song_id": "song_..." },
    { "index": 3, "song_id": "song_..." }
  ]
}
```

The Agent interprets which result index or indexes the user means.

The application then deterministically maps the Agent-returned index to the stored `song_id`.

The application must not understand Hebrew ordinals or list-reference language itself.

---

# 11. Adding songs is an Agent operation

Song addition must be redesigned for the new Agent architecture.

There is no later enrichment process, so a newly added song must become a complete canonical song record as part of the add flow.

Users should be able to add songs naturally, for example:

```text
בוט תוסיף את Zombie של Cranberries
```

```text
בוט תוסיף לנו את Dreams
```

```text
בוט תוסיף את השיר החדש שהצעתי קודם
```

The Agent must determine that the intent is `add_song`.

The Agent should extract/resolve:

- canonical song title
- canonical artist
- language
- genres
- difficulty
- feel
- all required AI metadata fields

Required AI metadata for a newly added song:

```text
original_vocal
vocal_range
vocal_style
singer_fit
vocal_energy
band_energy
crowd_friendly
groove_level
guitar_difficulty
bass_difficulty
drums_difficulty
keys_role
keys_difficulty
bass_interest
```

The application should then:

1. Validate the structured `add_song` payload.
2. Normalize title and artist.
3. Check the local database for an existing canonical duplicate.
4. Generate the stable `song_id`.
5. Initialize `band_status`.
6. Persist the complete canonical record.
7. Return a short confirmation.

The application must NOT run a second enrichment process afterward.

## Add-song structured action

Example:

```json
{
  "action": "add_song",
  "song": {
    "song_title": "Zombie",
    "artist": "The Cranberries",
    "language": "en",
    "genres": ["rock", "alternative rock"],
    "difficulty": "medium",
    "feel": "upbeat",
    "ai_metadata": {
      "original_vocal": "female",
      "vocal_range": "medium-high",
      "vocal_style": ["rock", "powerful"],
      "singer_fit": "great",
      "vocal_energy": "high",
      "band_energy": "high",
      "crowd_friendly": true,
      "groove_level": "medium",
      "guitar_difficulty": "low",
      "bass_difficulty": "low",
      "drums_difficulty": "medium",
      "keys_role": "optional",
      "keys_difficulty": "low",
      "bass_interest": "medium"
    }
  }
}
```

The exact enums must match the canonical dataset schema.

## Song identity uncertainty

If the Agent is not sufficiently confident about the song identity, it must not invent a canonical artist/title.

For example:

```text
בוט תוסיף Dreams
```

may be ambiguous.

The Agent may return:

```json
{
  "action": "clarify",
  "question": "איזה Dreams אתה מתכוון?"
}
```

Do not persist a song until identity is sufficiently resolved.

## Song updates and corrections

Natural-language corrections should also be Agent-controlled.

Examples:

```text
בוט האומן של 2 לא נכון
```

```text
בוט תשנה את השיר הזה ל-medium
```

```text
בוט זה בעצם שיר של Deep Purple
```

The Agent should return a structured `update_song` action.

The application validates and persists it.

No application-side natural-language parsing should be introduced for update requests.

---

# 12. Structured Agent output

Do not parse arbitrary LLM prose with regex.

Use tool/function calling or structured JSON schema.

Example:

```json
{
  "action": "search_songs",
  "query": {
    "genres": ["rock"],
    "feel": ["upbeat"],
    "difficulty": ["low", "medium"],
    "limit": 5
  }
}
```

Feedback example:

```json
{
  "action": "update_song_feedback",
  "updates": [
    {
      "result_index": 2,
      "fit": "bad",
      "issues": ["vocals"]
    }
  ]
}
```

The application must validate every response before execution.

---

# 13. Database safety

The LLM must never write directly to the database.

Required flow:

```text
LLM determines action
↓
Application validates action
↓
Application resolves references/song IDs
↓
Application executes local operation
↓
Application persists
```

Validate:

- action names
- complete canonical schema for `add_song`
- duplicate title/artist before insertion
- allowed mutable fields for `update_song`
- enum values
- song IDs
- result indexes
- issue values
- limits
- query fields
- update fields

If the Agent is not sufficiently certain which song a user refers to, update nothing.

Ask a short clarification question instead.

---

# 14. Band-specific song status

Actual band experience must be stored separately from AI metadata.

Use a structure similar to:

```json
{
  "band_status": {
    "fit": "unknown",
    "issues": [],
    "notes": "",
    "attempts": 0,
    "last_reviewed": null,
    "last_rehearsed": null
  }
}
```

Allowed `fit` values:

```text
unknown
good
maybe
bad
```

Meaning:

```text
unknown = not tried / insufficient information
good    = works well for the band
maybe   = worth another attempt / needs work
bad     = did not work for the band
```

Actual band status always has higher authority than AI-generated assumptions.

---

# 15. Controlled issue values

Prefer normalized issue enums over unrestricted free text.

Initial issue set:

```text
vocals
vocals_too_high
vocals_too_low
guitar
bass
drums
keys
too_hard
too_easy
doesnt_groove
wrong_style
boring
arrangement
```

`notes` may remain free text.

Example:

```json
{
  "fit": "maybe",
  "issues": ["vocals_too_high"],
  "notes": "Try transposing down",
  "attempts": 2
}
```

The LLM may understand Hebrew feedback but must map it into normalized values.

---

# 16. Natural-language feedback

Support free-form feedback.

Examples:

```text
בוט Zombie לא הסתדר לנו
```

Expected interpretation:

```text
fit = bad
```

Example:

```text
בוט Zombie לא עבד, גבוה מדי לזמרת
```

Expected interpretation:

```text
fit = bad
issues = ["vocals_too_high"]
```

Example:

```text
בוט Zombie דווקא היה מעולה
```

Expected interpretation:

```text
fit = good
```

Example:

```text
בוט Zombie אולי שווה עוד ניסיון, צריך להוריד טון
```

Possible interpretation:

```text
fit = maybe
issues = ["vocals"]
notes = "Try transposing down"
```

The LLM interprets; the application validates and writes.

---

# 17. Feedback on numbered lists

When list context exists, support natural Hebrew references such as:

```text
2 ו-4 לא הסתדרו
```

```text
1 מעולה
```

```text
1 ו-3 היו קשים מדי
```

```text
את האחרון לא אהבנו
```

```text
השני טוב אבל צריך להוריד טון
```

```text
הראשון והשני שווים ניסיון נוסף
```

The Agent may return list indexes, ordinals, or structured references.

Before updating the database, the application must resolve them against the correct result context.

Never allow the model to manufacture a song ID.

---

# 18. Confirmation after updates

After updates, return a short confirmation.

Example:

```text
👍 עדכנתי:
• Bring Me To Life — לא הסתדר, שירה
• Dreams — לא הסתדר
```

Or:

```text
👍 Zombie סומן כעובד טוב ללהקה
```

Avoid unnecessary explanations.

The bot should feel lightweight and conversational.

---

# 19. Useful band history

Where practical, maintain:

```text
attempts
last_played
last_rehearsed
last_reviewed
```

This can later influence ranking:

- songs never tried
- songs not played recently
- songs repeatedly failing
- songs that already work well

Do not invent history the system cannot actually know.

---

# 20. AI metadata vs actual band knowledge

Maintain clear separation:

```text
Song metadata
= canonical song information used by the application

AI metadata
= general characteristics estimated by AI

Band status
= actual experience of this band
```

Priority:

```text
Band experience > AI assumptions
```

Example:

AI metadata:

```json
{
  "original_vocal": "female",
  "vocal_range": "medium-high"
}
```

Actual band data:

```json
{
  "band_status": {
    "fit": "bad",
    "issues": ["vocals_too_high"]
  }
}
```

Search/ranking must trust the band's actual experience.

Do not create an AI field such as:

```text
good_for_our_singer = true
```

as part of generic enrichment.

The AI may describe the song.

Actual suitability for this band should come from band feedback.

---

# 21. Canonical pre-enriched song dataset

The song dataset supplied with this task is already fully enriched.

Do NOT implement or run a batch enrichment process for the existing dataset.

Do NOT create `enrich-songs`, enrichment retries, enrichment schema migrations, or a runtime compatibility layer for partially enriched legacy records.

The supplied canonical dataset contains:

- a stable `song_id` for every song
- canonical title and artist
- `genres`
- `difficulty`
- `feel`
- complete `ai_metadata`
- initialized `band_status`

The dataset-level flag:

```json
{
  "ai_enrichment": {
    "complete": true
  }
}
```

means the initial dataset is ready for runtime use.

The application should validate this canonical schema on startup and fail clearly if the file is malformed rather than silently trying to enrich or repair it.

## AI metadata available for every song

```text
original_vocal
vocal_range
vocal_style
singer_fit
vocal_energy
band_energy
crowd_friendly
groove_level
guitar_difficulty
bass_difficulty
drums_difficulty
keys_role
keys_difficulty
bass_interest
```

These are AI-estimated musical characteristics.

Actual band experience in `band_status` always overrides AI metadata.

## Future songs

There is no separate enrichment pipeline for future songs.

A song added through the bot must be created as a complete canonical record in the same Agent interaction.

`add_song` is therefore responsible for returning all metadata required by the canonical schema.

If song identity or required metadata cannot be resolved confidently enough, the Agent should ask for clarification instead of inserting a partial legacy record.

Do not introduce a second-stage enrichment workflow.

---

# 22. LLM provider

Initial provider:

```text
Groq
```

Initial model:

```text
openai/gpt-oss-20b
```

using Groq's OpenAI-compatible API.

Suggested environment variables:

```env
GROQ_API_KEY=...
GROQ_MODEL=openai/gpt-oss-20b
GROQ_BASE_URL=https://api.groq.com/openai/v1
```

Never hardcode API keys.

If the project already has an OpenAI client/wrapper, make provider/model/base URL configurable rather than creating unnecessary duplicate abstractions.

Keep the Agent provider-independent where practical.

---

# 23. Remove legacy natural-language interpretation

This change is intended to replace the existing rule-based / hardcoded natural-language understanding.

Do not keep the old parser in parallel for backwards compatibility.

Identify and remove obsolete logic such as:

- requested-count parsing
- ordinal / result-number semantic parsing
- intent detection
- add-song phrase parsing
- update-song phrase parsing
- hardcoded keywords
- regex-based intent detection
- genre keyword maps
- difficulty keyword maps
- feel/mood keyword maps
- Hebrew phrase matching
- command-specific parsing
- special-case natural-language handlers
- manually coded filter combinations
- fallback parsing paths that are replaced by the Agent

Do not implement:

```text
old parser
↓
if not recognized
↓
LLM fallback
```

The desired flow is:

```text
Natural-language request
↓
LLM Agent
↓
Validated structured action/query
↓
Application logic
```

There should be one natural-language interpretation path.

---

# 24. Keep deterministic logic outside the LLM

Do not move business logic into the model.

Keep deterministic application code for:

- `בוט` trigger detection
- reply/message context resolution
- result index resolution
- song ID resolution
- database access
- local search
- ranking/scoring
- validation
- persistence
- feedback updates
- list context
- safety checks

The LLM interprets.

The application executes.

---

# 25. Remove obsolete commands and syntax when no longer useful

If old explicit commands exist only because natural-language understanding was previously limited, remove them unless they still have a clear UX benefit.

Examples might include legacy commands such as:

```text
/rock
/easy
/upbeat
```

Do not preserve obsolete syntax merely because it existed before.

Natural-language phrases such as:

```text
קצבי
שקט
קל
רוק
מתאים לזמרת
```

should be understood by the LLM rather than hardcoded phrase maps.

---

# 26. Clean data migration instead of runtime compatibility

Existing useful song data must not be lost.

However, do not keep duplicate old/new representations forever just to support old code.

If the current data shape needs to change:

```text
old data
↓
one-time migration
↓
new canonical schema
```

After migration, runtime code should use the canonical structure only.

Avoid widespread patterns such as:

```ts
song.newField ?? song.oldField ?? song.olderField
```

If legacy data needs conversion, migrate it once.

This project does not require indefinite runtime backwards compatibility.

---

# 27. Remove compatibility/dead code

Actively remove code that becomes obsolete after the Agent migration:

- unused parser functions
- obsolete regexes
- keyword dictionaries
- compatibility adapters
- old request routers
- deprecated filter transformers
- fields used only by deleted parsing logic
- unused constants
- unused config
- unused imports
- obsolete tests

The migration is not complete if old parsing code remains in the repository but is simply bypassed.

---

# 28. Testing strategy

Replace old parser-specific tests with tests around the new architecture.

Test:

1. Agent output matches allowed schemas.
2. `add_song` creates a complete canonical record in one operation.
3. duplicate detection prevents adding an existing canonical song.
4. application code does not parse requested count from natural-language text.
5. application code does not parse Hebrew ordinal/reference semantics.
6. requested result count comes from the Agent action.
7. ambiguous song addition produces clarification instead of insertion.
- Invalid Agent output is rejected.
- Search queries execute deterministically.
- Result-list indexes returned by the Agent resolve correctly.
- Reply context takes priority over `last_results`.
- `last_results` remains isolated per chat.
- Ambiguous references do not modify data.
- Feedback updates correctly modify `band_status`.
- Local ranking behaves deterministically for a given `SongQuery`.
- The canonical pre-enriched dataset validates successfully.
- Obsolete parser paths are no longer used.

A small number of integration tests may send realistic Hebrew phrases through the Agent abstraction.

Do not duplicate language-understanding rules in application tests.

---

# 29. Conversation memory

Do not introduce full persistent LLM conversation memory unless clearly necessary.

Most state should remain local and deterministic:

- `last_results`
- result lists by bot message ID
- song IDs
- band feedback
- song metadata
- AI enrichment metadata

Send only the context necessary for the current action.

Goals:

- minimize tokens
- reduce hallucinations
- remain within free API limits
- make behavior predictable
- simplify debugging

---

# 30. Persistence

Important result context should survive restart if this integrates cleanly with the existing project.

If the project already uses something like:

```text
state.json
```

prefer extending that mechanism.

Do not introduce a database server solely for this feature.

Stored result contexts may have a TTL or cleanup policy so they do not accumulate forever.

---

# 31. Core UX

The desired UX is:

### New request

```text
בוט ...
```

### Reply to bot result

Natural language, without `בוט`.

Example:

```text
2 ו-4 לא התאימו
```

### No Reply, but referring to latest result

```text
בוט 1 דווקא היה מעולה
```

Use the latest result list for that chat.

### Ambiguous reference

Ask one short clarification.

Do not silently guess.

The bot should feel like another participant in the band's WhatsApp group, not like a command-line interface.

---

# 32. Required scenarios

Implement and test flows such as the following.

## Scenario 1 — Song recommendation

User:

```text
בוט תן 5 שירי רוק קצביים שמתאימים לזמרת
```

Flow:

```text
Agent parses request
↓
Application searches/ranks local songs
↓
Bot returns numbered list
↓
Store last_results
↓
Store bot_message_id -> results
```

---

## Scenario 2 — Reply feedback

User replies to that result:

```text
2 ו-4 לא הסתדרו לנו
```

No trigger required.

Resolve against that exact result message.

Update those songs as `bad`.

---

## Scenario 3 — Feedback via last result

User later writes:

```text
בוט 1 דווקא היה מעולה
```

Resolve against current chat `last_results`.

Mark the song `good`.

---

## Scenario 4 — Vocal feedback

User replies:

```text
השני טוב אבל גבוה מדי לזמרת
```

Possible result:

```text
fit = maybe
issues = ["vocals_too_high"]
```

---

## Scenario 5 — Similar song

User:

```text
בוט תביא עוד כמו 3
```

Resolve song 3 from the current relevant list context.

Use its song ID as `similarToSongId`.

Search locally for similar songs.

---

## Scenario 6 — New / easy songs

User:

```text
בוט תן משהו קצבי שלא ניסינו ושלא קשה מדי
```

Agent produces structured requirements/preferences.

Local ranking returns songs.

---

## Scenario 7 — Why songs failed

User:

```text
בוט מה לא עבד לנו בגלל השירה?
```

Query local `band_status` for vocal-related issues.

Do not ask the LLM to guess based on general song knowledge.

---

## Scenario 8 — Explain rejection

User:

```text
בוט למה הורדנו את Zombie?
```

Use stored `band_status.issues` and `band_status.notes`.

Do not invent reasons.

---

## Scenario 9 — Reply to an old result

User replies to an old bot result:

```text
האחרון דווקא היה טוב
```

Resolve "the last one" against that exact old result message.

Do not use current `last_results`.

---

## Scenario 10 — Missing context

User:

```text
בוט 4 היה גרוע
```

but no result context exists.

Do not guess.

Reply briefly:

```text
לאיזו רשימה אתה מתכוון?
```

---

# 33. Migration plan

Use a clean migration process:

1. Analyze the current codebase.
2. Identify current natural-language parsing responsibilities.
3. Separate:
   - responsibilities moving to the LLM
   - deterministic responsibilities remaining in code
4. Define the canonical song schema.
5. Implement any required one-time data migration.
6. Implement the LLM Agent path.
7. Implement structured action validation.
8. Implement WhatsApp trigger and reply context.
9. Implement result context persistence.
10. Implement local search and ranking.
11. Implement feedback handling.
12. Implement AI enrichment.
13. Update callers to the new flow.
14. Remove old natural-language parsing.
15. Remove compatibility code.
16. Remove obsolete tests/config/imports/helpers.
17. Run the full test suite.
18. Manually verify key WhatsApp scenarios.

Do not finish with both architectures active.

---

# 34. Definition of done

The migration is complete only when:

- there is one natural-language interpretation path
- the LLM Agent handles intent extraction
- deterministic operations remain in application code
- old natural-language parsers are deleted
- obsolete keyword/regex logic is deleted
- runtime compatibility with old interpretation logic is removed
- useful legacy data has been migrated into one canonical schema
- old schema adapters are removed after migration
- result context works by reply message ID
- `last_results` works per chat
- feedback updates actual band status
- the supplied pre-enriched canonical dataset is used directly
- band feedback always overrides AI metadata
- tests reflect the new architecture
- dead compatibility code is removed

---

# 35. Implementation requirements

Please:

1. Analyze the existing codebase before editing.
2. Identify the files/modules that should change.
3. Define the new canonical architecture.
4. Define schemas/types for:
   - `Song`
   - `SongQuery`
   - `AgentAction`
   - `AddSongAction`
   - `UpdateSongAction`
   - `BandStatus`
   - `ResultContext`
   - AI enrichment metadata
5. Implement the Groq/OpenAI-compatible Agent integration.
6. Implement the `בוט` trigger.
7. Implement reply-context resolution.
8. Implement `last_results` per WhatsApp chat.
9. Implement local song search.
10. Implement deterministic ranking/scoring.
11. Implement natural-language feedback.
12. Implement validation around all Agent actions.
13. Validate `schema_version`, `ai_enrichment.complete`, and required song fields at startup.
14. Use the supplied AI metadata directly in local ranking.
15. Treat missing optional AI fields on future songs gracefully without an enrichment pipeline.
16. Implement a one-time data migration only if the existing runtime storage requires it.
17. Remove obsolete natural-language parsing.
18. Remove obsolete compatibility logic.
19. Remove obsolete tests/imports/config/helpers.
20. Add useful logging.
21. Add tests for critical flows.
22. Verify the main WhatsApp scenarios manually.

Do not preserve old implementation details just to reduce the diff.

Prefer the clean architecture described above.

---

# 36. Expected final report

At the end of the implementation, provide:

- files created
- files modified
- files deleted
- legacy parser functions removed
- compatibility code removed
- fields migrated
- fields removed
- canonical song schema
- Agent/action schemas
- result-context persistence approach
- local ranking approach
- canonical dataset validation approach
- AI metadata fields used by ranking
- required environment variables
- how to run locally
- how to run tests
- examples of WhatsApp interactions, including recommendation count interpretation, add-song, correction, reply feedback, and ambiguous references
- any assumptions made after inspecting the existing codebase
- any behavior intentionally retained from the legacy implementation and the concrete reason it remains

---

# 37. Priorities

This is an internal bot for a small band.

Prioritize:

1. simple WhatsApp UX
2. natural Hebrew interaction
3. maintainable code
4. clean migration
5. deterministic database operations
6. actual band feedback over AI assumptions
7. low token usage
8. reliability
9. easy debugging
10. easy future extension

Avoid:

- unnecessary infrastructure
- duplicated parsing layers
- permanent backwards-compatibility code
- sending the full song database to the LLM
- letting the model directly mutate data
- over-engineering


---

# Non-negotiable semantic ownership rule

The application must not try to be smart about natural language.

Except for the literal WhatsApp transport rules (`בוט` wake word and reply metadata), all user-language interpretation belongs to the Agent.

This includes:

```text
what the user wants
how many results they want
which previous item they refer to
whether they are adding/updating/removing a song
what musical constraints they expressed
which constraints are mandatory/preferences/exclusions
what feedback means
```

The application receives structured meaning from the Agent and executes it deterministically.

If semantic interpretation exists both in the Agent and in application code, the migration is not complete.
