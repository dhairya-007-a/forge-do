# Forge — Project State (internal notes, not part of the app)

Not deployed — see `netlify.toml` redirect blocking `/main.md`. This file is for us (Claude + you) to pick up context fast if a session gets cut off. Update it as we go; don't let it go stale.

## What this project is

Student dashboard app ("Forge") for a B.Tech Computer Engineering student — AI-assisted study tools (doubts, notes, quizzes, viva prep, readiness tracking) plus a parent/admin view. Netlify Functions backend, Groq for AI, Supabase Postgres for accounts.

## Stack

- **Frontend:** static HTML/JS, no framework. `index.html` = student dashboard (real one — do not recreate duplicates). `admin-dashboard.html` = admin/parent view.
- **Backend:** Netlify Functions (`netlify/functions/*.js`), CommonJS. `netlify/edge-functions/` for edge-level gating (Deno runtime).
- **AI:** Groq API, 3-key failover (`_groq-client.js` tries `GROQ_API_KEY` → `_2` → `_3` on rate-limit).
- **Accounts DB:** Supabase Postgres (not Netlify Blobs — migrated off Blobs 2026-08-08, see below).
- **Rate limiting:** `_rate-limit.js`, 30 req/hr/IP, backed by Netlify Blobs (still used for this only).
- **Voice AI:** Gemini Live API (`gemini-3.1-flash-live-preview`) for Viva Prep's opt-in real-time voice mode — see 2026-08-10 entry below. Groq is still used for everything else (text-based grading, notes, doubts, etc.).

## Folder structure (cleaned up 2026-08-09)

```
/
├── index.html              student dashboard (the real one, no dupes)
├── admin-dashboard.html    admin/parent view
├── main.md                 this file
├── logo/                   real, used asset
├── netlify/
│   ├── functions/          live Netlify Functions
│   ├── edge-functions/     admin-gate.js
│   └── selfchecks/         node netlify/selfchecks/*.js to verify
├── docs/
│   ├── superpowers/        formal specs/plans from brainstorming sessions
│   └── scratch-notes/      loose spec .txt/.pdf files that used to clutter root
├── design-refs/            unused-but-kept theme/mockup images (jarvish-theme,
│                            notes, time-table-theme, timer-background) --
│                            not referenced by any code, moved out of the way
├── netlify.toml / package.json / local-server.js / deno.lock
```

Deleted 2026-08-09: `api/` (14-file stale duplicate of `netlify/functions/` from the
paused Vercel migration — never touched after the Supabase rewrite, never wired into
anything live), `vercel.json`, `forge-netlify-deploy.zip`, `blob-background.html`.
`publish = "."` in `netlify.toml` was **not** changed (user declined the `public/`
restructure — bigger risk, touches the live deploy path, skipped for now).
- **Site:** `forge-do` on Netlify (site ID `d0082c3f-5b9b-4ad8-b0c4-64756085fa4b`), free/dev-team plan (**not** Pro — matters, see gotchas below).
- **Supabase project:** ref `mbpsusjemlgzrjocstea`, region `ap-south-1`.

## Timeline (most recent first)

**2026-08-10 — Notification dropdown fixes, real leaderboard, dynamic focus line, Gemini Live voice**
- Fixed notification bell dropdown: z-index too low (bumped 50→9998) and a real hover-jitter bug (`#bellDropdown` is nested inside `#bellBtn`, whose `:hover` had `transform:translateY(-2px)` — since the dropdown is positioned relative to that same button, the panel visibly shifted every time the mouse re-entered the button's area while interacting with the open dropdown). Fixed by giving `#bellBtn` a background-only hover instead of transform.
- Brainstorm leaderboard was 100% local/fake (hardcoded single "You" row). New public `netlify/functions/leaderboard.js` + `_account-store.js`'s `listBrainstormScores()` read every registered account's already-synced `forge-brainstorm-best` from Supabase and return the real top 10 (name + score only, never another student's email).
- Home page's greeting subtitle was static fake copy ("You've got 2 lectures and 1 assignment due today"). Replaced with `renderFocusLine()`, which reuses `computeStudyPriority()` to name a real unstarted/weak chapter.
- Added Gemini Live real-time voice mode to Viva Prep (`netlify/functions/viva-live-token.js` mints ephemeral tokens; browser connects directly to Gemini's WebSocket). Opt-in "Live Voice Mode" button, old simulated TTS/STT flow untouched as fallback. New env var `GEMINI_API_KEY`. See that commit's message for the exact verified model/endpoint/audio-format details (docs summaries got some of this wrong — verified everything empirically against the real API instead).
- Deleted 7 orphaned throwaway Netlify sites from this account (auto-named, all from before `forge-do` existed) at user's request — only `forge-do` plus a few unrelated named ones remain.

**2026-08-08/09 — Supabase migration + admin panel hardening**
- Netlify Blobs' automatic `getStore()` context injection was broken in production (502 on `list-accounts`) even after a fresh prod redeploy — root cause never fully pinned down, so replaced the datastore instead of chasing it further.
- Migrated accounts (`sync-account`/`restore-account`/`list-accounts`/`delete-account`) from Blobs to Supabase Postgres. New `accounts` table, RLS enabled with zero policies (service_role-only, server-side access only). `_account-store.js` rewritten against `@supabase/supabase-js`, same 4-function interface, so the 4 thin handler functions didn't need changes.
- Upgraded `admin-dashboard.html`'s "All Accounts" tab: real stat cards (registered count, synced today/7d, distinct courses), course/semester breakdown, name/email search.
- Found (via live browser check) that the admin page's `netlify.toml` `Basic-Auth` header directive was **silently doing nothing** — it's a Pro-plan-only Netlify feature, this site's on the free plan. Replaced with `netlify/edge-functions/admin-gate.js`, which runs on every plan. Verified live: 401 without creds, 200 with correct ones.
- Security review flagged the edge gate's credentials as hardcoded in source. Fixed: moved to `ADMIN_USER`/`ADMIN_PASS` env vars, constant-time (SHA-256 digest) comparison, rotated the password (old one was already in git history).
- Commits: `012bb0b` (Supabase migration), `63429b1` (edge gate), `18c5c28` (env vars + rotation).

**2026-08-06 — Pre-deploy hardening + bug fixes**
- Removed stale `ui/`/`netlify-deploy/` snapshot folders (would've been web-accessible via `publish = "."`).
- Added per-IP rate limiter.
- Fixed: `weakTopic` showing 100% with zero data, Courses tab chapter list not reading real activity, `JOURNEY_START_DATE` hardcoded per-student, heatmap padding with pre-signup days, Viva Prep not classifying answers by chapter.

**2026-08-05 — Real accounts + admin panel (v1, Blobs-based) + Groq failover**
- First version of accounts/admin panel, built on Netlify Blobs (later replaced, see above).
- Groq multi-key failover shipped and verified across all 10 AI functions.
- Found and fixed: 4 duplicate frontend files with stale content actually being served instead of the real dashboard (`index.html` now correctly = the real app).
- Beta labels added to Brainstorm/Viva Prep.

**2026-08-04 — YouTube course-mode chat**
- `find-videos.js` (English-only filtering), Courses topic modal, course-mode chat card.

## Current env vars on Netlify (`forge-do`, all contexts)

Names only — values live in Netlify's env var UI / were set via CLI, never repeat the actual values in a committed file.

- `GROQ_API_KEY`, `GROQ_API_KEY_2`, `GROQ_API_KEY_3`
- `YOUTUBE_API_KEY`
- `ADMIN_API_KEY` — app-level header check for `list-accounts`/`delete-account` (separate from the edge gate)
- `ADMIN_USER`, `ADMIN_PASS` — edge-function Basic-Auth gate on admin paths (rotated 2026-08-09)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — server-side only, accounts DB

Admin login password (for the browser's Basic-Auth prompt, and for the app-level email/password screen) — ask if you've lost track, don't put the literal value in this file.

## Known accepted risks / tradeoffs (deliberate, not oversights)

- `admin-dashboard.html`'s own client-side login screen (email/password, SHA-256 hash check) is obscurity, not real security — bypassable via devtools. The edge gate (Basic-Auth) is the real barrier; the client-side screen is just UX.
- `ADMIN_API_KEY` and the Basic-Auth password are both necessarily present in `admin-dashboard.html`'s plain JS (needed so the page's own fetch calls can auto-send them). Same threat model as any client-embedded secret on a static site — anyone with access to the deployed page's source can read them. Acceptable for now given this is a small personal/student project, not handling sensitive data at scale. **Tried removing the Basic-Auth one** (2026-08-09), betting on the browser auto-resending its cached credential to fetch() calls under the same origin+realm — broke live, `fetch()` doesn't reliably retry with cached Basic-Auth the way top-level navigation does. Reverted same day. Don't retry this approach without testing it live first.
- `sync-account.js`/`restore-account.js` have no admin-key gate — anyone who knows a real student email can sync/restore that account. Accepted tradeoff matching the "email-only, no password" account model.
- `docs/` folder is inside the published root (`publish = "."` in `netlify.toml`) — same exposure class as the old `ui/`/`netlify-deploy/` folders that got cleaned up. Not yet addressed; worth a redirect rule if `docs/` ever contains anything sensitive (currently just specs/plans, low risk).

## Still pending / not started

- B.Sc(H) AI & DS track (second onboarding program) — blocked on user providing a real subject/chapter list, explicitly declined a placeholder.
- Notes-in-chat (Ask Forge responses rendering as note cards) — not started, needs its own design pass.
- Token-remaining display for Groq keys — needs research, Groq doesn't expose a simple remaining-quota endpoint.

## Gotchas worth remembering

- Supabase **direct** connection host (`db.<ref>.supabase.co:5432`) is IPv6-only — unreachable from this dev machine's network. Always use the **pooler** host (`aws-0-ap-south-1.pooler.supabase.com:6543`, user `postgres.<ref>`) for any one-off `psql`/`pg` scripts.
- Supabase's pooler TLS cert chain roots at a private "Supabase Root 2021 CA," not a public CA — Node's default trust store rejects it (`SELF_SIGNED_CERT_IN_CHAIN`). Don't disable cert verification to work around this; pin the actual chain instead (fetched once via a manual Postgres-SSL-negotiation + `tls.connect`, saved as a `.pem`).
- Netlify's `netlify.toml` `Basic-Auth` header feature is **Pro-plan only** and fails silently (no error, just never gates anything) on lower plans — always verify auth gates live with curl (`-u user:pass`, check for 401 vs 200), don't trust the config alone.
- This site is on `nf_team_dev` (free/dev-team) plan — check before assuming any Pro-only Netlify feature will work.
