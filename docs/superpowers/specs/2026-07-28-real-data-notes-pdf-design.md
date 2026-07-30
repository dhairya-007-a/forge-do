# Forge — Real Data, Notes Sketchnote Style, PDF Export

Status: draft, pending user review
Scope: `index.html` / `student-dashboard.html` (identical single-file prototype, kept in sync)

## 1. Context

Forge is currently a static, no-backend, single-HTML-file prototype (per `Forge_Tech_Spec.txt`,
the real product will eventually have a FastAPI/Postgres backend, but that does not exist yet
in this repo). The dashboard already has a partial real-data layer:

- Quizzes, MCQ accuracy, short-answer count, doubts-asked are already tracked for real via
  `localStorage` (`forge-stat-*` keys, bumped on actual user interaction).
- The 84-day study heatmap is **entirely fake** — a seeded random generator (`mulberry32`) —
  yet "Current Streak", "Longest Streak", "Days Studied", "Total Hours Studied" are all derived
  from that fake data, making them fake too.
- The top-of-dashboard `.stats` row (Active Courses, Assignments Due, Current GPA, Study Streak)
  is static hardcoded HTML with no backing data at all.
- Courses list and Assignment deadlines are static hardcoded HTML (no add/edit UI, no storage).
- Exam History (`EXAM_HISTORY`) is a hardcoded constant array.

A layout bug ("tiles merging") was already root-caused and fixed: CSS grid items had no
`min-width:0`, so real (longer, variable-length) text couldn't shrink and overflowed into
neighboring tiles/panels — invisible with short mock strings, visible with real data. Fix
shipped: `min-width:0` on grid-item classes (`.stat-card`, `.panel`), `overflow-wrap:break-word`
on text leaves, `.stamp` badge now truncates with ellipsis instead of overlapping the icon,
new `@media (max-width:480px)` breakpoint collapsing stat grids to 1 column.

## 2. Real data model (all localStorage, no backend)

New/changed localStorage-backed structures:

- `forge-courses`: `[{id, name, code, colorTag, progress, chapters:[{name,done}]}]`
  - "Add Course" control on the Courses view opens a small inline form (name, code, color tag).
  - Course list section renders from this array (replacing the hardcoded `.course` blocks).
  - Top tile **Active Courses** = `courses.length`.
- `forge-deadlines`: `[{id, title, course, dueDate}]`
  - "Add Deadline" control on the dashboard opens an inline form.
  - Deadlines list renders from this array (replacing the 3 hardcoded `.deadline` divs).
  - Top tile **Assignments Due** = count where `dueDate >= today`.
- `forge-exam-scores`: `[{subject, date, label, score}]`
  - Small "Log a score" control near Exam History (replacing hardcoded `EXAM_HISTORY`).
  - Top tile **Current GPA** = computed from logged scores (simple average mapped to a 4.0
    scale), shows "—" when no scores logged yet.
- `forge-study-log`: `{ "YYYY-MM-DD": minutesStudied }`
  - Every completed Pomodoro **focus** session (`handleSessionComplete` when `pomo.mode==='focus'`
    transitions out) adds its duration to today's entry.
  - `renderHeatmap()` reads the real 84-day window from this log instead of `mulberry32` random
    data. Streak / days-studied / hours-studied math is unchanged — it already derives correctly
    from the `studyData` array, only the data source changes.
  - Top tile **Study Streak** mirrors the same real current-streak value used elsewhere.
- Brand-new user (empty storage) sees honest zeros/"—", not fake placeholder numbers.

No backend, no network calls. Everything survives only in the current browser (acceptable —
user explicitly chose this scope over building a real backend).

## 3. Notes: sketchnote/infographic visual style

Auto-generated notes (Stacks/Queues/Linked List/BST, and any future topic in `NOTES_BANK`) get
restyled from the current plain bullet card to a colorful sketchnote look, inspired by the
reference images the user provided (`notes/*.jpg`): colorful callout boxes per section,
highlighter-marker-style headings, small doodle icons, mind-map-style connective feel where
natural. Implemented with CSS + inline SVG only — no image generation, no external assets,
real text content unchanged. Each `section` in a `NOTES_BANK` entry renders as its own colored
callout box (color cycles through a small fixed palette per section index), the note title
gets a highlighter-underline effect, bullets keep a small doodle-style bullet marker instead of
a plain dot.

This is a visual-only change to `renderNoteResult()` / its CSS — `NOTES_BANK` data structure is
unchanged.

## 4. Photo & drawing attachments on notes

- "Add photo" button on a generated note: file input → `FileReader` → embeds the image inline
  in the note (stored as a data URL in-memory for that note instance; not persisted across
  reloads — out of scope to persist attachments, matches "no backend" scope).
- "Draw" button: opens a small modal with an HTML `<canvas>` freehand pad (pointer events,
  adjustable stroke color/width, clear button, "Insert" button). On insert, the canvas is
  flattened to a PNG data URL and embedded inline in the note, same as an uploaded photo.
- Both attachment types appear in a simple stacked gallery under the note's text sections, and
  are included in the PDF export (section 5).

## 5. PDF export

- New "Download PDF" action alongside the existing Share / Download-as-txt buttons on a
  generated note.
- Approach: **browser print-to-PDF** (chosen over jsPDF to keep the file dependency-free and
  fully offline-capable). Clicking it populates a hidden print-only container with the note's
  title, sketchnote-styled sections, and any attached photos/drawings, then calls
  `window.print()`. A dedicated `@media print` stylesheet hides the app chrome (sidebar, nav,
  everything except the print container) so the browser's print dialog shows a clean one-note
  page; the user picks "Save as PDF" as the destination.
- No new dependency, no network requirement, works identically whether the file is opened via
  `file://` or hosted on Netlify.

## 6. Out of scope (explicitly, per user's chosen scope)

- Any real backend / API / database (Tech Spec's FastAPI+Postgres plan) — localStorage only.
- Persisting photo/drawing attachments across page reloads.
- Admin panel changes.
- Any theme other than the existing default/dark/jarvis themes (sketchnote styling adapts to
  existing CSS variables, doesn't add a 4th theme).

## 7. Files touched

`index.html` and `student-dashboard.html` (kept byte-identical, as they are today) — all changes
are additive within the existing single-file structure: new CSS blocks, new small HTML forms/
containers, new JS functions alongside the existing ones (`renderHeatmap`, `renderNoteResult`,
`generateNotes`, course/deadline/exam-score rendering).
