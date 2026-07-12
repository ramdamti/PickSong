# Chords Lookup Improvement — Small V1

## Goal

Improve the existing chord lookup so it finds more valid results without introducing an LLM, crawler framework, host-specific parser system, or complex scoring model.

Keep the current resolver structure and make only focused changes.

---

## Scope

This task is limited to:

1. Better search-query generation
2. Using `source_text` as a fallback
3. Trying both `אקורדים` and `chords`
4. Better validation of returned URLs/pages
5. Better dry-run diagnostics

Do not refactor unrelated WhatsApp, state, song-selection, extraction, or deployment code.

---

## Existing Behavior to Preserve

- Chord lookup remains optional through `DISCOVER_CHORDS`.
- Existing valid `chords_url` values are reused.
- Failed lookup must not block or fail the song reply.
- Successful matches are stored only in the existing `chords_url` field.
- Do not modify `song_title`, `artist`, or `source_text`.
- Do not use an LLM for chord lookup.
- Keep multi-song order unchanged.
- Keep the current public interfaces where possible.

---

## Problem

The current resolver misses songs that can be found manually with searches such as:

```text
"<song title>" אקורדים
"<song title>" "<artist>" אקורדים
"<source_text>" אקורדים
"<song title>" chords
```

Likely causes:

- lookup relies too much on `song_title + artist`;
- `source_text` is not used as a fallback;
- `אקורדים` or `chords` is not always added;
- artist matching is too strict;
- the resolver may stop after one weak query;
- valid results are rejected because metadata is incomplete.

---

## Required Changes

## 1. Build Better Queries

Add or improve a helper such as:

```js
buildChordQueries(song)
```

Return an ordered list of unique queries.

For Hebrew songs:

```text
"<song_title>" "<artist>" אקורדים
"<song_title>" אקורדים
"<source_text>" אקורדים
"<song_title>" "<artist>" chords
"<song_title>" chords
"<source_text>" chords
```

For English songs:

```text
"<song_title>" "<artist>" chords
"<song_title>" chords
"<source_text>" chords
"<song_title>" "<artist>" אקורדים
"<song_title>" אקורדים
"<source_text>" אקורדים
```

Rules:

- Skip title queries when `song_title` is empty.
- Skip artist parts when `artist` is empty.
- Skip source queries when `source_text` is empty.
- Never emit `undefined`, `null`, or empty quoted strings.
- Collapse whitespace.
- Deduplicate identical queries.
- Limit cleaned `source_text` to about 160 characters.
- Remove the add-to-library trigger phrase from `source_text` if the current code exposes it easily.
- Preserve the original source wording otherwise.

Do not generate site-specific queries in this version unless the current resolver already supports them.

---

## 2. Try Queries Sequentially

Use the existing search mechanism.

Try queries in order and stop when a valid result is found.

Do not execute every query when the first or second query already returns a valid page.

For each query:

1. inspect the existing number of search results;
2. validate each result using the existing host and page rules;
3. return the first strong valid match;
4. otherwise continue to the next query.

Keep the current request limits and concurrency behavior unless there is an obvious bug.

---

## 3. Use `source_text` Only as a Search Fallback

`source_text` is useful when extracted title or artist data is wrong.

Use it to search, but do not use it to rewrite song metadata.

Example:

```text
song_title: incorrectly extracted title
artist: incorrectly extracted artist
source_text: רונה קינן - הקול שקורא לי
```

The resolver should still try:

```text
"רונה קינן - הקול שקורא לי" אקורדים
```

The final result must still pass normal URL/page validation.

---

## 4. Relax Artist Validation

Artist matching must not be mandatory when the song title clearly matches.

Use simple rules:

- strong title match + matching artist: accept;
- strong title match + artist missing from page/result: may accept;
- strong title match + minor artist spelling difference: may accept;
- strong title match + clearly different artist: reject;
- weak title match: reject even when artist matches.

Do not add a numeric scoring framework in this version.

Reuse the current normalization and matching helpers where possible.

If needed, add only small helpers for:

- normalized text comparison;
- token overlap;
- checking whether one normalized title contains the other.

---

## 5. Improve Text Normalization

Reuse existing normalization code when available.

At minimum, matching should ignore:

- English case;
- Hebrew niqqud;
- Hebrew and English quotation marks;
- punctuation;
- duplicate whitespace;
- different dash characters.

Do not change stored song values.

Do not add a fuzzy-matching dependency unless one already exists in the project.

---

## 6. Strengthen Existing Result Validation

Keep validation lightweight.

A result may be accepted only when:

- URL parsing succeeds;
- protocol is HTTP or HTTPS;
- host is in the existing allowed-host list;
- URL is not an obvious homepage or search page;
- search-result title, URL, or fetched page data strongly matches the song title;
- there is no clear conflicting artist.

If the current implementation already fetches the candidate page:

- validate the final redirected host;
- reject failed responses;
- use the page title or main heading as extra evidence;
- keep the current timeout behavior.

If the current implementation does not fetch candidate pages, do not build a new generic crawler. Improve validation using the information already available from the current search result.

Do not create host-specific parsers in this version unless the current code already has one and it only needs a small fix.

---

## 7. Keep Acceptance Logic Simple

Use readable boolean rules rather than a weighted score.

Suggested logic:

```js
if (!isAllowedHost(candidate.url)) {
  reject;
}

if (isHomepageOrSearchPage(candidate.url)) {
  reject;
}

if (!isStrongTitleMatch(song.song_title, candidateText)) {
  reject;
}

if (hasClearConflictingArtist(song.artist, candidateText)) {
  reject;
}

accept;
```

`candidateText` can combine the fields already available in the current resolver, such as:

- search-result title;
- search-result snippet;
- URL slug;
- fetched page title, when already available.

A missing artist must not count as a conflict.

---

## 8. Dry-Run Diagnostics

Update `scripts/chords-dry-run.js` to use the same production resolver.

Do not duplicate query or validation logic.

The resolver may optionally accept a debug callback or return a small diagnostics object when dry-run mode is enabled.

Keep diagnostics small:

```js
{
  queriesTried: [],
  resultsChecked: 0,
  acceptedUrl: null,
  lastRejectReason: null
}
```

Dry-run output should show:

```text
Input: Song - Artist
Queries tried:
- "Song" "Artist" chords
- "Song" chords

Results checked: 5
Result: FOUND
URL: https://...
```

Or:

```text
Input: Song - Artist
Queries tried:
- ...
Results checked: 8
Result: NOT FOUND
Last rejection: title did not match
```

Do not add candidate score tables or detailed parser output in this version.

---

## Tests

Add focused tests only for the new behavior.

Cover:

### Query generation

- Hebrew song with artist
- English song with artist
- missing artist
- missing title
- source-text fallback
- duplicate queries
- long source text
- no `undefined` or empty quotes

### Matching

- exact title
- punctuation differences
- Hebrew quotation differences
- page artist missing
- matching title with clearly different artist
- unrelated title with matching artist

### Validation

- allowed host
- disallowed host
- homepage
- search page
- valid song page
- malformed URL

Use the current test setup.

If no test framework exists, add small tests for pure helper functions without introducing a large dependency.

---

## Acceptance Criteria

The implementation is complete when:

1. No LLM is used for chord lookup.
2. Existing valid `chords_url` values are reused.
3. Hebrew queries use `אקורדים`.
4. English queries use `chords`.
5. Both keywords are eventually tried as fallback.
6. `source_text` is used as a fallback query.
7. Queries are deduplicated and contain no empty values.
8. Artist absence no longer rejects a strong title match.
9. A clearly conflicting artist still rejects the result.
10. Disallowed hosts, homepages, and search pages are rejected.
11. Failed lookup still returns the song normally.
12. Successful URLs are stored only in `chords_url`.
13. The dry-run script uses the production resolver.
14. Dry-run output shows queries tried, result count, and the final outcome.
15. No crawler framework, complex scoring model, database, or unrelated refactor is added.

---

## Implementation Instructions for Codex

Before editing:

1. Inspect `src/chords.js`.
2. Inspect how search results are currently obtained.
3. Inspect the existing URL and title validation.
4. Inspect `scripts/chords-dry-run.js`.
5. Identify the current test and lint commands.

Implement the smallest change that satisfies this document.

Prefer editing existing functions over creating a parallel resolver.

After editing:

1. run tests, lint, and syntax checks that already exist;
2. run the dry-run script on representative Hebrew and English songs;
3. report changed files;
4. report commands executed;
5. report examples that improved;
6. report remaining lookup limitations;
7. do not claim a result was tested if it was not.
