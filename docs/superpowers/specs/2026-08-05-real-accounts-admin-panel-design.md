# Real student accounts + admin panel

Date: 2026-08-05
Status: Approved, pending implementation plan

## Problem

Forge has no real accounts. `index.html`'s onboarding form writes a `forge-profile`
object (firstName, lastName, email, referral, course, semester, batch, level, college)
straight into `localStorage`, and every stat afterward (quiz scores, study streak,
study hours, chat history) lives under its own `forge-*` localStorage key — all
scoped to that one browser. There is no cross-device identity: opening the site on
a second device starts a completely separate, empty profile.

`admin-dashboard.html` already has its own login gate (client-side email+password
hash check, unrelated to this feature and unchanged by it), but the dashboard it
protects just reads `localStorage` from whichever browser it happens to be opened
in — it cannot show any other student's data, because there is no shared store.

This is the first database this project has ever had. **Netlify Blobs** was chosen
over Supabase/Postgres in an earlier session — built into Netlify, no new signup,
simple key-value store, fits this app's scale.

## Scope decisions (from brainstorming)

1. **Account identity: email only, no password.** The email entered at onboarding
   *is* the account ID. Re-entering the same email on a different device "logs in"
   by restoring that email's data — there is no password check. This is intentionally
   weak (anyone who knows a student's email can see their data) but matches the
   app's existing no-auth feel and needs no login screen, session handling, or
   password storage/hashing for students.
2. **Sync timing: real-time, debounced.** Every `forgeStore.setItem` call queues a
   push to the student's Blob. Debounced ~1s client-side (not truly one network
   call per keystroke) so rapid successive writes (e.g. typing in chat) don't spam
   the sync function, but from the student's perspective their data is always
   current within a second or two — never a manual "save" step, never a
   multi-minute staleness window.
3. **Sync scope: everything.** One Blob per email holds a full snapshot of every
   `forge-*` localStorage key at time of last sync — profile, stats, study log, quiz
   history, chat history, all of it. No curated allow-list to maintain; if a future
   feature adds a new `forge-*` key, it's synced automatically with zero code changes
   to the sync logic.
4. **Restore on claim: full pull.** When `restore-account` finds an existing Blob for
   the submitted email, the browser's `forge-*` keys are overwritten with the Blob's
   data (the freshly-typed onboarding form values are discarded in favor of the
   real historical profile). This is what makes it feel like a real account instead
   of a fresh start each time.
5. **Delete: hard delete, no undo.** Admin's "Terminate" button permanently deletes
   that email's Blob. No soft-delete/disabled state, no recovery. Confirm dialog in
   the UI is the only safety net.
6. **Admin view: summary list only, no per-student drill-down.** The Accounts tab
   shows one row per student (name, email, course/semester/batch, last synced) plus
   the Terminate button. Clicking a row does not open a detailed per-student
   dashboard — that would require repointing the existing stat-rendering functions
   at remote data instead of `localStorage`, which is out of scope for this pass.

## Architecture

### New dependency

`@netlify/blobs` (official Netlify SDK) — not currently installed, needs adding to
`package.json`.

### New Netlify functions (`netlify/functions/`)

**`sync-account.js`**
```
POST { email: string, data: { [forgeKey: string]: string } }
→ 200 { ok: true }
→ 400 if email missing/invalid or data missing
```
Writes/overwrites the Blob at key `account:<lowercased email>` with `{ data, lastSyncedAt: <ISO timestamp> }`.
Called by every device after any local `forge-*` write (debounced).

**`restore-account.js`**
```
POST { email: string }
→ 200 { found: true, data: {...} }   — existing account
→ 200 { found: false }                — no account for this email yet
→ 400 if email missing/invalid
```
Read-only lookup at key `account:<lowercased email>`. Called once, at onboarding
form submit.

**`list-accounts.js`**
```
POST {} (no body needed, but function requires POST per this project's convention)
→ 200 { accounts: [{ email, firstName, lastName, course, semester, batch, lastSyncedAt }, ...] }
```
Lists all `account:*` Blobs, returns only the summary fields (not full stat dumps —
keeps the response light even with many students). Sorted by `lastSyncedAt` descending
(most recently active first).

**`delete-account.js`**
```
POST { email: string }
→ 200 { ok: true }
→ 400 if email missing
```
Hard-deletes the Blob at key `account:<lowercased email>`.

None of these four functions touch Groq — no `_groq-client.js` involvement, no
interaction with the multi-key failover work.

### Frontend changes

**`index.html`:**
- A new small wrapper around `forgeStore.setItem` (call it `syncedSet`) that does
  the existing `forgeStore.setItem(key, value)` AND schedules a debounced (1s)
  call to collect every `forge-*` key currently in localStorage into one object and
  POST it to `sync-account` with the profile's email. All existing call sites that
  currently call `forgeStore.setItem(...)` directly for `forge-*` keys switch to
  `syncedSet(...)` — the localStorage-fallback behavior (in-memory `m` object when
  real localStorage is blocked) stays exactly as-is underneath.
- The onboarding form's submit handler (currently at the code building the `profile`
  object and calling `forgeStore.setItem('forge-onboarded', ...)` /
  `forgeStore.setItem('forge-profile', ...)`) gains a step BEFORE any local writes:
  call `restore-account` with the submitted email.
  - If `found: true`: skip building/saving the freshly-typed `profile` object —
    instead write every key from the response's `data` object into `forgeStore`
    directly (bypassing `syncedSet`'s debounce for this one bulk restore — no need
    to re-sync data that just came from the server), then continue to
    `applyProfile(...)` and the existing splash-sequence transition.
  - If `found: false`: proceed exactly as today (save the submitted profile locally),
    then let the first `syncedSet` call (or an explicit initial `sync-account` call
    right after onboarding completes) create the Blob.

**`admin-dashboard.html`:**
- New "Accounts" nav item/tab, rendered alongside the existing stats view (which
  stays completely unchanged — still reads the local browser's `localStorage` as
  it does today, that view is not being repointed at Blobs in this pass).
- On tab open: POST to `list-accounts`, render a table (Name | Email | Course /
  Sem / Batch | Last synced | [Terminate]).
- "Terminate" button → `confirm()` dialog ("Permanently delete <email>'s account?
  This cannot be undone.") → on confirm, POST to `delete-account`, remove the row
  from the table on success.

## Error handling

- **Student-side (`sync-account`, `restore-account` failures):** fail silently —
  log to `console.warn`, never block the student from using the app or show them
  an error. Sync is best-effort; the app must work identically to today if Blobs
  is unreachable. This matches the existing pattern in `find-videos.js` where a
  Groq failure falls back gracefully instead of erroring out.
  - Specific case: if `restore-account` itself fails (network error, Blobs down),
    treat it the same as `found: false` — proceed with the freshly-typed onboarding
    form data rather than blocking signup entirely.
- **Admin-side (`list-accounts`, `delete-account` failures):** surface a real error
  in the Accounts tab UI (e.g. "Couldn't load accounts — try again") since the admin
  is actively watching this screen and needs to know if something's wrong, unlike
  the student who should never see sync plumbing.

## Out of scope

- No password/login for students (email-as-ID is intentionally the whole auth model).
- No per-student drill-down view in admin (summary list only).
- No soft-delete, no undo, no account recovery after Terminate.
- No rate-limiting on `sync-account`/`restore-account`/`list-accounts`/`delete-account`.
- No changes to `admin-dashboard.html`'s existing login gate (separate, pre-existing,
  unrelated system).
- No changes to the existing single-browser stats view in admin — it keeps reading
  local `localStorage` exactly as today.
