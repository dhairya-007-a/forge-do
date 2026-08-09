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
- **Site:** `forge-do` on Netlify (site ID `d0082c3f-5b9b-4ad8-b0c4-64756085fa4b`), free/dev-team plan (**not** Pro — matters, see gotchas below).
- **Supabase project:** ref `mbpsusjemlgzrjocstea`, region `ap-south-1`.

## Timeline (most recent first)

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
- `ADMIN_API_KEY` and the Basic-Auth password are both necessarily present in `admin-dashboard.html`'s plain JS (needed so the page's own fetch calls can auto-send them). Same threat model as any client-embedded secret on a static site — anyone with access to the deployed page's source can read them. Acceptable for now given this is a small personal/student project, not handling sensitive data at scale.
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
