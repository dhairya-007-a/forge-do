# Migrate from Netlify to Vercel

Date: 2026-08-06
Status: Approved, pending implementation plan

## Problem

This project has been built entirely on Netlify's platform conventions: `netlify.toml`,
`netlify/functions/*.js` using Netlify's Lambda-style handler signature
(`exports.handler = async (event) => { return {statusCode, body} }`), `@netlify/blobs`
for the real-accounts and rate-limiting storage layer, and Netlify's header-based
Basic-Auth for admin protection. The user has decided to deploy on Vercel instead.
None of the Netlify-specific pieces are Vercel-compatible as-is — this requires a real
rewrite of the server-side layer, not a config change.

## Scope decisions (from brainstorming)

1. **Storage: Upstash Redis (`@upstash/redis`), installed via the Vercel Marketplace.**
   `@vercel/kv` — the product the user and Claude initially assumed existed — was
   confirmed **sunset** during research (verified against current Vercel docs, not
   assumed from training data). Upstash Redis is the current first-party-integrated
   replacement: same Redis-shaped key-value semantics as `@netlify/blobs`'s
   `get`/`setJSON`/`delete`/`list`, so `_account-store.js` and `_rate-limit.js` port
   with a client swap, not a data-model rewrite.
2. **Function directory: `netlify/functions/*.js` → `api/*.js`**, using Vercel's
   classic Node.js Serverless Function signature
   (`module.exports = (req, res) => {...}`) rather than a framework-specific style
   (no Next.js is being introduced) — closest structural match to the existing
   Netlify handler shape, one file per endpoint, no new framework dependency.
3. **Admin protection: new `middleware.js` at the project root** (Vercel Routing
   Middleware), checking the `Authorization` header before serving
   `admin-dashboard.html` or the 2 admin API routes. This is the direct equivalent of
   the `netlify.toml` Basic-Auth header config, which has no Vercel analog — Vercel
   requires an actual middleware file, not a declarative config toggle. Confirmed via
   the Vercel routing-middleware docs: this is exactly the documented "lightweight
   auth check, defense-in-depth" use case, matching how the Netlify Basic-Auth was
   already being treated (a second layer on top of the existing `ADMIN_API_KEY`
   check, not the sole protection).
4. **Local dev: adopt `vercel dev`, retire `local-server.js`.** The project
   previously avoided `netlify-cli` in favor of a hand-rolled static+function server
   (deliberate choice, "no extra deps"). For Vercel, the user chose the official CLI
   instead — it correctly emulates routing, env vars, and (once linked) the Redis
   connection, which a hand-rolled server would have to reimplement from scratch.
5. **Config: `netlify.toml` → `vercel.json`.**

## Architecture

### New dependencies

- `@upstash/redis` (replaces `@netlify/blobs`)
- Vercel CLI (`vercel`), global or dev dependency, for `vercel dev` / `vercel deploy`

### Directory changes

- `netlify/functions/` → `api/` (all files move, `_`-prefixed helper files keep their
  `_` prefix and stay un-routable the same way — Vercel's file-based routing also
  ignores files/folders starting with `_` under `api/`)
- `netlify.toml` deleted, replaced by `vercel.json`
- `local-server.js` deleted

### Function handler rewrite (mechanical, applies to all 14 functions)

Before (Netlify):
```js
exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const body = JSON.parse(event.body || '{}');
  // ...
  return { statusCode: 200, body: JSON.stringify(result) };
};
```

After (Vercel):
```js
module.exports = async function handler(req, res){
  if(req.method !== 'POST'){
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const body = req.body || {};
  // ...
  return res.status(200).json(result);
};
```

Key differences every function must account for:
- `event.httpMethod` → `req.method`
- `event.body` (Netlify: raw string, needs `JSON.parse`) → `req.body` (Vercel:
  already parsed to an object when `content-type: application/json`, no `JSON.parse`
  needed — but must guard for `req.body` being `undefined`/`null` the same way the
  old code guarded for invalid JSON)
- `event.headers` (Netlify: object, keys may vary) → `req.headers` (Vercel: standard
  Node.js `http.IncomingMessage` headers, lowercase keys)
- Return shape: `{statusCode, body: JSON.stringify(x)}` → `res.status(code).json(x)`
  (no manual `JSON.stringify` — Vercel's `res.json()` handles serialization)

### Storage layer (`_account-store.js`, `_rate-limit.js`)

Before (Netlify Blobs):
```js
const { getStore } = require('@netlify/blobs');
function store(){ return getStore('accounts'); }
await store().get(key, { type: 'json' });
await store().setJSON(key, value);
await store().delete(key);
await store().list({ prefix });
```

After (Upstash Redis):
```js
const { Redis } = require('@upstash/redis');
function store(){ return Redis.fromEnv(); }
await store().get(key); // Upstash auto-deserializes JSON, no { type: 'json' } option needed
await store().set(key, value); // Upstash auto-serializes objects, no separate setJSON
await store().del(key);
await store().keys(prefix + '*'); // Upstash has no direct list({prefix}) equivalent -- use keys() with a glob pattern, then get() each one (same pattern _account-store.js's listAccounts() already uses internally)
```

`checkRateLimit()`'s window/count logic in `_rate-limit.js` stays identical — only the
storage calls change. The existing fail-open behavior (catch storage errors, allow
the request) stays as-is and remains just as important on Vercel as it was for local
Netlify dev, since local `vercel dev` without a linked/pulled Redis env var would hit
the same kind of storage-unavailable case.

### Admin middleware (new file)

```js
// middleware.js (project root)
module.exports = function middleware(request){
  const url = new URL(request.url);
  const protectedPaths = ['/admin-dashboard.html', '/api/list-accounts', '/api/delete-account'];
  if(!protectedPaths.includes(url.pathname)) return; // not a protected path, continue

  const auth = request.headers.get('authorization');
  const expected = 'Basic ' + Buffer.from('forgeadmin:' + process.env.ADMIN_BASIC_AUTH_PASSWORD).toString('base64');
  if(auth !== expected){
    return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Admin"' } });
  }
};

module.exports.config = { matcher: ['/admin-dashboard.html', '/api/list-accounts', '/api/delete-account'] };
```

The Basic-Auth password moves from being committed in `netlify.toml`/hardcoded in
`admin-dashboard.html`'s JS (both already true today, already flagged as a known
weak point) to a real Vercel environment variable (`ADMIN_BASIC_AUTH_PASSWORD`),
which is a genuine improvement over the current committed-plaintext state — the
value stops being in git history going forward (existing leaked values from tonight
stay in history regardless, as already noted).

### Frontend changes

- `index.html`: every `fetch('/.netlify/functions/X', ...)` → `fetch('/api/X', ...)`
  (the `sync-account` auto-sync hook, the `restore-account` onboarding call, every AI
  feature's fetch call — 10+ call sites)
- `admin-dashboard.html`: same rewrite for `list-accounts`/`delete-account`, plus the
  `ADMIN_BASIC_AUTH` JS constant can be removed if the browser reliably reuses its
  cached Basic-Auth credential across same-origin requests after the initial
  middleware challenge (needs live verification post-deploy, same "can't verify
  locally" caveat as the Netlify Basic-Auth attempt had) — until verified, keep
  sending it explicitly as a defensive fallback, same reasoning as before.

### `vercel.json`

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Frame-Options", "value": "SAMEORIGIN" },
        { "key": "X-Content-Type-Options", "value": "nosniff" }
      ]
    }
  ]
}
```
(Direct port of the existing `netlify.toml` security headers — Basic-Auth is no
longer here, it's in `middleware.js` per the scope decision above.)

## Error handling

- Storage failures (Redis unreachable/misconfigured): fail open in `_rate-limit.js`
  (unchanged behavior, just a different underlying client), and surface a real error
  in `_account-store.js`-backed functions (also unchanged — matches existing
  Netlify-era behavior where account operations return a 502 on storage failure
  rather than silently succeeding).
- Middleware failures: if `ADMIN_BASIC_AUTH_PASSWORD` is unset, the middleware must
  fail closed (reject all requests to protected paths) — same fail-closed principle
  already applied to the `ADMIN_API_KEY` check in `list-accounts.js`/`delete-account.js`.

## Out of scope

- No change to the AI functions' business logic, prompts, or the Groq multi-key
  failover system (`_groq-client.js` is pure `fetch()`-based, has no Netlify-specific
  dependency, and needs zero changes).
- No change to `_groq-client.selfcheck.js`/`_account-store.selfcheck.js`/
  `_rate-limit.selfcheck.js`'s testing approach — mocking the storage client stays
  the same pattern, just mocking `@upstash/redis` instead of `@netlify/blobs`.
- Not migrating to Next.js or any framework — staying with plain static HTML + `api/`
  functions, matching the project's existing architecture.
- Not addressing the `ADMIN_API_KEY`/Basic-Auth password already leaked to git
  history from tonight's Netlify work — those stay leaked regardless of platform;
  rotating them again post-migration is a separate, cheap follow-up.
