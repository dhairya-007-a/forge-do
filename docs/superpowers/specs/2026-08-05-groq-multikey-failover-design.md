# Multi-key Groq auto-failover

Date: 2026-08-05
Status: Approved, pending implementation plan

## Problem

Every AI feature in Forge calls Groq (`llama-3.3-70b-versatile`) directly via its own
inline `fetch()` in its own Netlify function. Ten functions do this independently:
`ask-doubt.js`, `generate-note.js`, `assignment-tip.js`, `strategy-tip.js`,
`grade-answer.js`, `viva-turn.js`, `generate-quiz.js`, `grade-brainstorm.js`,
`readiness-verdict.js`, `find-videos.js`. A single `GROQ_API_KEY` backs all of them.

Two more keys (`GROQ_API_KEY_2`, `GROQ_API_KEY_3`) were added to `.env` after the
first key's rate limit was hit during testing, but nothing uses them — every request
still only ever tries `GROQ_API_KEY`, so the app breaks the moment that one key is
rate-limited, even with two working spare keys sitting unused.

## Scope decisions (from brainstorming)

1. **Failover triggers only on rate-limit/quota errors** — HTTP 429, or a Groq error
   message containing "rate limit" / "quota" (case-insensitive). Any other failure
   (400 bad request, 500 server error, network failure) returns immediately without
   trying other keys — those aren't fixed by a different key, and silently retrying
   3x on a real bug just triples latency before failing anyway.
2. **Fixed key order: 1 → 2 → 3, always starting from key 1.** Not round-robin. Simple
   and predictable — the app already treats key 1 as primary everywhere; this just
   adds a safety net rather than changing which key is "the" key under normal load.
3. **One shared helper**, not 10 copies of the retry logic. `netlify/functions/_groq-client.js`
   — filename starts with `_` so Netlify's function router ignores it (no `exports.handler`,
   same convention as how this project already keeps `COURSE_CHAPTERS`/`SUBJECT_ALIASES`
   duplicated per-file rather than shared, except here duplication is exactly what
   we're removing since retry logic is meaningfully more complex than a data table).
4. **Return shape mimics `fetch()` + parsed JSON** — `{ok, status, data}` — so each of
   the 10 call sites' existing `if(!resp.ok){...}` / `data.choices[0]...` downstream
   logic needs minimal changes: swap the inline `fetch(...)` + `await resp.json()`
   block for one `await callGroq(payload)` call, keep everything after it as-is.
5. **Missing keys are skipped, not failures.** If only `GROQ_API_KEY` is set (e.g. in
   a future environment without the spares), `callGroq` just tries that one key and
   returns its result — no error about missing `GROQ_API_KEY_2`/`_3`.

## Architecture

### `netlify/functions/_groq-client.js` (new)

```js
async function callGroq(payload){
  const keys = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3]
    .filter(Boolean);
  let last = null;
  for(const key of keys){
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    if(resp.ok) return { ok: true, status: resp.status, data };
    const isRateLimit = resp.status === 429 ||
      /rate.?limit|quota/i.test((data && data.error && data.error.message) || '');
    last = { ok: false, status: resp.status, data };
    if(!isRateLimit) return last; // real error — don't waste retries on other keys
  }
  return last || { ok: false, status: 500, data: { error: { message: 'No Groq API key configured' } } };
}
module.exports = { callGroq };
```

### Call-site migration (all 10 functions, same mechanical change each time)

Before (every function's current pattern, `ask-doubt.js` shown as example):
```js
const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
  method: 'POST',
  headers: { 'authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model, max_tokens, response_format, messages })
});
const data = await resp.json();
if(!resp.ok){
  const message = (data && data.error && data.error.message) || 'Groq API error';
  return { statusCode: resp.status, body: JSON.stringify({ error: message }) };
}
```

After:
```js
const { callGroq } = require('./_groq-client');
const { ok, status, data } = await callGroq({ model, max_tokens, response_format, messages });
if(!ok){
  const message = (data && data.error && data.error.message) || 'Groq API error';
  return { statusCode: status, body: JSON.stringify({ error: message }) };
}
```

Each function keeps its own `apiKey` presence check removed (no longer reads
`process.env.GROQ_API_KEY` directly — `_groq-client.js` owns that now) — but keeps
its own `YOUTUBE_API_KEY`/other env checks untouched where applicable (`find-videos.js`
still checks `YOUTUBE_API_KEY` itself, only its Groq call moves to the shared helper).

## Error handling

- All 3 keys rate-limited → `callGroq` returns the last (key 3's) error response,
  surfaced to the frontend exactly as a single-key rate-limit error is today — no
  new user-facing error state needed.
- Zero keys configured (`.env` misconfigured) → returns a clear "No Groq API key
  configured" error rather than a confusing fetch failure.
- A real bug (malformed request body, etc.) → fails on key 1 immediately, same
  speed as today, no multi-key retry overhead.

## Out of scope

- No proactive key-usage tracking/rotation (e.g. round-robin, least-recently-used).
- No changes to non-Groq API calls (YouTube, ElevenLabs) — this is Groq-only.
- No retry/backoff *within* a single key (e.g. exponential backoff on transient
  network errors) — only cross-key failover on rate-limit-shaped errors.
