# YouTube topic videos + Ask Forge course-mode chat

Date: 2026-08-03
Status: Approved, pending implementation plan

## Problem

Three related asks from the user, all extending the app's existing topic/chapter
granularity ([[COURSE_CHAPTERS]], the readiness engine, study plan) into video
resources and a new chat response type:

1. Find YouTube video(s) for a subject/topic.
2. Clicking a chapter row in the Courses tab opens a focused single-topic study
   view for that chapter, including its video(s).
3. Asking Ask Forge chat for "a course on X" gets a dedicated response — main
   topics + practice questions — not the normal concept/numerical/code answer.

`YOUTUBE_API_KEY` (YouTube Data API v3) added to `.env`, verified live against
`search.list` — real results with thumbnails, e.g. querying "Binary Search Trees
data structures explained" returns Gate Smashers / Apna College / Jenny's
Lectures videos with thumbnail URLs and view-countable video IDs.

## Scope decisions (from brainstorming)

1. **Real API, not a search-link.** A no-key deep-link to YouTube search can't
   return thumbnails, multiple ranked choices, or a "best" pick — the user
   wants all three, so the real Data API is required. Scraping YouTube's
   search page instead of using the API was rejected — fragile, breaks
   silently, against YouTube's ToS.
2. **Search phrase comes from Groq, not the raw chapter name.** Chapter names
   like "Trees & Binary Search Trees" don't always make a good search query.
   The server asks Groq for a short, well-formed search phrase first, then
   calls YouTube search.list with that phrase.
3. **"Best" video = highest view count**, not just YouTube's default
   relevance-sorted position #1. Requires one extra `videos.list` call (1
   quota unit) to pull `statistics.viewCount` for the 5 candidates from
   `search.list` and re-rank.
4. **Course-mode is a 4th type on the existing classifier**, not a new
   endpoint or explicit `/course` command. `ask-doubt.js` already classifies
   every message into concept/numerical/code — course-mode extends that same
   classification (the model already sees subject+chapter list every call).
5. **Practice questions in course-mode reuse the existing chat-quiz flow**
   (`awaitingQuizAnswer` / `submitChatQuizAnswer`, built for conversational
   quizzing) rather than a new inline-grading mechanism.
6. **Courses topic view also surfaces existing real data** for that chapter
   (status chip via `chapterStatus()`, notes/doubts logged on it, mini
   readiness) alongside the video picker — not video-only.

## Architecture

### `netlify/functions/find-videos.js` (new)

Request: `{ subject, chapter }`

1. Ask Groq for a short search phrase for `${chapter} (${subject})` — one
   cheap completion, `max_tokens` small (~30).
2. Call YouTube `search.list` (`part=snippet&type=video&maxResults=5`) with
   that phrase + `YOUTUBE_API_KEY`.
3. Call `videos.list` (`part=statistics`) for the 5 returned video IDs in one
   batched request to get view counts.
4. Sort by view count, return `{ videos: [{videoId, title, channelTitle,
   thumbnail, viewCount}], bestVideoId }` — `videos` stays in the original
   YouTube relevance order for display; `bestVideoId` flags which one to
   highlight as "best."
5. If `YOUTUBE_API_KEY` is missing or the YouTube call fails, return
   `{ videos: [], bestVideoId: null, error }` — frontend shows "couldn't load
   videos" rather than breaking the panel.

### Courses tab — topic study view

Clicking a `.chapter-row` opens a panel (reuse the existing modal/panel
pattern already used elsewhere in the file, not a new component system) for
that single chapter:
- Header: chapter name + existing status chip (`chapterStatus()`).
- Video picker: 5 thumbnails from `find-videos.js`, best one visually marked,
  click opens YouTube (`https://youtube.com/watch?v=<id>`) in a new tab —
  no embedded player, matches ladder rung 1 (don't build a player when a
  link works).
- Existing-data section: any notes/doubts logged against this chapter (from
  `forge-topic-activity`), mini readiness number for just this chapter.
- Videos fetched once per chapter-open and cached in-memory for the session
  (not localStorage — video relevance/view counts go stale, always refetch
  on next visit).

### `ask-doubt.js` — course-mode type

Extend the existing `type` enum from `concept|numerical|code` to also allow
`course`. System prompt gains a 4th classification rule: pick `course` when
the student is asking to learn/study a whole topic broadly rather than
resolve one specific doubt ("teach me X", "course on X", "overview of X",
"help me learn X").

Response shape gains (only filled when `type === "course"`, else `null` like
the other type-specific fields):
```
"mainTopics": [{"chapter": "string (exact chapter name)", "why": "string, one line"}] | null,
"practiceQuestions": ["string", ...] | null
```
`mainTopics` — 5-8 entries, validated server-side against `COURSE_CHAPTERS`
same as the existing single `chapter` field (drop any that don't match
exactly). `practiceQuestions` — 3-5 short-answer questions covering those
topics.

### Chat rendering

Course-mode responses render as a distinct card: ranked topic list (chapter
name + why-line) followed by the practice questions as tappable rows. Tapping
a question calls the same `startChatQuiz()`-style flow already built for
conversational quizzing, seeded with that specific question instead of a
freshly generated one.

## Error handling

- Missing `YOUTUBE_API_KEY` → `find-videos.js` returns a clean error object,
  never throws past the handler (matches every other function's `try/catch`
  → `{statusCode: 502, error}` pattern already used throughout).
- YouTube quota exhausted (403) → same clean error path, frontend shows a
  "try again later" state instead of a broken panel.
- Course-mode `mainTopics`/`practiceQuestions` missing or malformed from the
  model → treat as `type: null` (same fallback the existing classifier
  already uses for ungrounded answers) rather than rendering a broken card.

## Out of scope

- No embedded video player — external link only.
- No caching of video results in localStorage (always fresh per session).
- No changes to the Readiness/Strategy engines from this feature — chapter
  status is read, not written, by the new topic view.
