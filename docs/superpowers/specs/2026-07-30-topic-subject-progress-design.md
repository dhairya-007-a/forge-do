# Topic/subject progress tracking, driven by chat

Date: 2026-07-30
Status: Approved, pending implementation plan

## Problem

The "Exam Readiness" view (`index.html`, `#readiness` view) already exists with
real-looking UI — a readiness ring, 4 score bars (Topic Coverage, Weak-Topic
Resolution, Mock Scores, Recency), and a per-chapter "Topic Pattern" chip list
sourced from `COURSE_CHAPTERS` (a real syllabus: 6 subjects, 8-10 chapters
each). But none of it is real:

- `READINESS_DATA` is a static object with every score hardcoded to `0`.
- `COURSE_CHAPTERS[subject].current` is hardcoded to `1` for every subject —
  never advances regardless of actual study.
- `TOPIC_WEAK_OVERRIDE` is a permanently empty object.

This spec wires it up to real signal: primarily the Ask Forge chat (which
subject/chapter you actually ask about), plus quiz scores and manual
self-marking for what chat alone can't honestly infer (mastery).

## Scope decisions (from brainstorming)

1. **"Done" = auto-touch + manual mark.** Asking about a chapter in chat
   marks it `touched` automatically. Marking it `done`/mastered is always a
   manual click — one question doesn't prove mastery.
2. **Chapter matching is model-based, not keyword-based.** The subject's
   chapter list is sent to the model with the question; it returns the
   closest matching chapter name (or `null`). Local keyword matching against
   chapter titles like "Karnaugh Maps & Minimization" would miss too much
   real phrasing.
3. **Per-subject quiz score tracking is in scope** (currently only tracked
   globally) so the Mock Scores bar can be real. Short-answer/long-answer
   quiz tabs are excluded — no subject tag, no numeric score, pass/fail only.
4. **No retroactive backfill.** Existing chat history has no topic data.
   Progress accumulates from the first chat sent after this ships.
5. **Offline fallback (`QA_BANK`) also gets tagged** with real
   subject/topic so topic progress still updates when the live API is down
   — matches "needs to work properly," not just when the API happens to be
   up.

## Data model

Two new localStorage keys.

`forge-topic-progress` — per-subject chapter tracking, chapter numbers are
1-based (matching the existing `data.current`/`num` convention already used
in `renderTopicPattern`):

```js
{
  "Data Structures and Algorithms": {
    touched: [2, 3],       // chapter numbers ever discussed in chat (auto, cumulative, never cleared)
    done: [1],              // manually marked mastered (toggleable)
    weak: [],                // currently flagged weak (toggleable)
    everWeak: [3],           // ever flagged weak, ever (cumulative, never cleared) — for resolution %
    lastActivity: "2026-07-30T14:00:00.000Z"  // ISO timestamp of most recent chat touch on this subject
  },
  // ... one entry per subject that has ever had activity
}
```

`forge-quiz-scores` — per-subject cumulative MCQ results:

```js
{ "Data Structures and Algorithms": { correct: 8, total: 10 }, ... }
```

## Chat → topic classification (`netlify/functions/ask-doubt.js`)

- The subject's chapter list (from `COURSE_CHAPTERS`, sent alongside the
  request or hardcoded per-subject in the system prompt build) is included
  in the prompt.
- JSON output contract gains one field:
  `{"subject": "...", "topic": "...", "explanation": "...", "keyConcept": "...", "example": "..."}`
  — `topic` is the exact chapter name string from that subject's chapter
  list, or `null` if the question doesn't clearly map to one specific
  chapter.
- Frontend (`sendDoubt`, `index.html`) receives `entry.topic`, looks it up
  by exact string match (then case-insensitive exact match as fallback)
  against `COURSE_CHAPTERS[entry.subject].chapters` to get a chapter number.
  If no match is found either way, the turn is skipped for progress
  purposes (no guessing).
- On a successful match: add the chapter number to that subject's `touched`
  array (dedup) and set `lastActivity` to now, in `forge-topic-progress`.

**Offline fallback:** the 4 hardcoded `QA_BANK` entries (`index.html`) get
explicit `subject: 'Data Structures and Algorithms'` and `topic` fields
matching their real chapters:
- stacks → `'Stacks'` (chapter 2)
- queues → `'Queues'` (chapter 3)
- linked lists → `'Linked Lists'` (chapter 4)
- BSTs → `'Trees & Binary Search Trees'` (chapter 5)

`sendDoubt` applies the same touched-marking logic to fallback answers as to
live API answers.

## A third consumer found during self-review: the Courses page

`index.html` has a second, independent renderer of `COURSE_CHAPTERS`:
`initCourseChapters()` populates `.course-chapters` containers (one per
subject, in the expandable Courses view — `data-chapters="..."` divs around
line 2378-2448) with a chapter checklist using `.chapter-row.done` (green
check) and `.chapter-row.current` (highlighted) CSS classes. Like
`READINESS_DATA`, it's driven entirely by the same hardcoded
`COURSE_CHAPTERS[subject].current: 1` — every subject shows chapter 1 as
"current," nothing ever marked done, for every student, forever.

This gets fixed by the same data this spec introduces:
- `.chapter-row.done` — chapter number is in that subject's `done` array
- `.chapter-row.current` — chapter number is in `touched` but not `done`
- neither class (dimmed, default) — chapter untouched

`initCourseChapters()` is rewritten to read `forge-topic-progress` instead
of `data.current`. There is no third "weak" visual state on this page — it
only distinguishes done/in-progress/not-started, which is all its existing
CSS supports.

Once both this and the Topic Pattern chips (below) derive status from real
data, `COURSE_CHAPTERS[subject].current` is fully unused and is deleted
from every subject's entry.

## Manual status + click interaction (Exam Readiness → Topic Pattern)

Per-chapter status derives in this priority order:
1. `weak` — if the chapter number is in that subject's `weak` array
2. `strong` (done) — if in `done` array
3. `learning` — if in `touched` array (from chat) but not `done`
4. `upcoming` — default, none of the above

Clicking a chapter chip cycles: **default → done → weak → back to
default.** This works even on a never-touched chapter (`upcoming` can be
clicked straight to `done`) — you can self-mark something done without ever
asking chat about it. Cycling to `weak` adds the chapter number to
`everWeak` (if not already present) — that record is permanent and is never
removed by later cycling, since it powers the resolution metric below.
Cycling back to `default` removes the chapter from `done` and `weak`, but
`touched` (from chat) and `everWeak` history are untouched.

## Real readiness score formulas (replaces static `READINESS_DATA`)

Computed fresh on each render via a new `computeReadiness(subject)`
function — `READINESS_DATA` and `TOPIC_WEAK_OVERRIDE` are deleted entirely.

- **Topic Coverage** = `|touched ∪ done| / total chapters * 100`
- **Weak-Topic Resolution** = `100` if `everWeak` is empty; otherwise
  `(everWeak.length - weak.length) / everWeak.length * 100` — rewards
  moving chapters *off* weak status, not just having few currently weak.
- **Mock Scores** = `forge-quiz-scores[subject].correct / .total * 100`,
  or `0` if no quiz data for that subject yet. `showMcqScore()` (the MCQ
  quiz finish handler) is extended to also increment this per-subject
  store, alongside its existing global `bumpStat` calls.
- **Recency** = `100` if `lastActivity` is today, linearly decaying to `0`
  over 14 days of inactivity: `max(0, 100 - (daysSinceActivity / 14 * 100))`.
  `0` if no activity ever recorded.
- **Overall** = simple average of the 4 scores above.

## Edge cases

- Model returns a topic string with no exact or case-insensitive match to
  any real chapter name → skip updating progress for that turn, log
  nothing. Never guess a nearest match.
- `subject: null` (off-topic question, existing behavior) → skips all
  topic-progress logic downstream, unchanged from today.
- `forge-topic-progress` / `forge-quiz-scores` missing or malformed →
  default to empty object per subject, same `lsGet`-with-fallback pattern
  used everywhere else in this codebase.

## Testing plan

1. `curl` the `ask-doubt` function with a DSA question (e.g. "how does a
   hash table resolve collisions") and confirm the response includes a
   `topic` field matching a real `COURSE_CHAPTERS` entry (`'Hashing'`).
2. In-browser: ask a chat question about a specific chapter, navigate to
   Exam Readiness for that subject, confirm the matching chip shows
   `learning` status.
3. Click that chip once → confirm it shows `strong`/done and the Topic
   Coverage bar increases. Click again → confirm `weak` status and that the
   chapter number appears in `everWeak` (check localStorage). Click a third
   time → confirm it returns to `learning` (not `upcoming`, since `touched`
   persists).
4. Finish an MCQ quiz for a subject, confirm that subject's Mock Scores bar
   updates to reflect the real score.
5. Manually edit `lastActivity` in localStorage to an old date, reload,
   confirm Recency bar reflects the decay formula.
6. Kill the dev server (force API failure), ask about "stacks" in chat,
   confirm the offline `QA_BANK` fallback still marks DSA chapter 2 as
   touched.
7. Open the Courses view, expand the subject used in step 2/3, confirm the
   same chapter shows the correct done/current/default styling consistent
   with what Exam Readiness shows.

## Out of scope (explicitly)

- Short-answer/long-answer quiz tabs contributing to Mock Scores.
- Retroactively backfilling topic progress from pre-existing chat history.
- Any change to `generate-note.js` (Notes feature) — this project is
  chat-only, per the original request ("from chat the can know...").
