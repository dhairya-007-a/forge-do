# Netlify-to-Vercel Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move this project's server-side layer off Netlify (functions, storage, admin auth, local dev) onto Vercel, with zero change to AI prompts, business logic, or the Groq multi-key failover system.

**Architecture:** `netlify/functions/*.js` → `api/*.js` with Vercel's Node.js handler signature (`module.exports = async (req, res) => {...}`). `@netlify/blobs` → `@upstash/redis` (Vercel KV is sunset — Upstash is the current Marketplace replacement, same key-value shape). New `middleware.js` replaces Netlify's `netlify.toml` Basic-Auth. `vercel dev` replaces the hand-rolled `local-server.js`.

**Tech Stack:** Node.js (CommonJS), `@upstash/redis`, Vercel CLI, no test framework (plain `node` scripts for logic verification, same pattern as every prior `_*.selfcheck.js` in this repo).

**Spec:** `docs/superpowers/specs/2026-08-06-vercel-migration-design.md` (Approved)

---

## Global Transform Rule (applies to every function in Tasks 4-17)

Every one of the 14 functions currently follows this exact shape:

```js
exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  // ... zero or more further `return { statusCode: N, body: JSON.stringify(X) };` statements ...
};
```

It becomes:

```js
module.exports = async function handler(req, res){
  if(req.method !== 'POST'){
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // ... every `return { statusCode: N, body: JSON.stringify(X) };` becomes `return res.status(N).json(X);`
};
```

Three mechanical replacements per file:
1. `exports.handler = async function(event){` → `module.exports = async function handler(req, res){`
2. Every `event.httpMethod` → `req.method`, every `event.body` → `req.body` (and remove the surrounding `JSON.parse(... || '{}')` — Vercel already parses JSON bodies to an object; guard for `req.body` being falsy instead, e.g. `req.body || {}`), every `event.headers` → `req.headers`
3. Every `return { statusCode: N, body: JSON.stringify(X) };` → `return res.status(N).json(X);` (drop the `JSON.stringify` — `res.json()` serializes)

Nothing else in any function changes — prompts, validation logic, Groq/YouTube calls, all untouched.

---

## Task 1: Add `@upstash/redis`, create `vercel.json`, remove `@netlify/blobs`

**Files:**
- Modify: `package.json`
- Create: `vercel.json`
- Modify: `.gitignore` (add `.vercel`)

- [ ] **Step 1: Install the package and Vercel CLI**

Run: `npm install @upstash/redis && npm uninstall @netlify/blobs && npm install -g vercel`

Expected: `@upstash/redis` added to `dependencies`, `@netlify/blobs` removed, `vercel` CLI available (`vercel --version` prints a version).

- [ ] **Step 2: Create `vercel.json`** with exactly this content:

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

- [ ] **Step 3: Add `.vercel` to `.gitignore`**

Append this line to `.gitignore`:
```
.vercel
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json vercel.json .gitignore
git commit -m "chore: add @upstash/redis, vercel.json; remove @netlify/blobs dependency"
```

---

## Task 2: Rewrite `_account-store.js` for Upstash Redis

**Files:**
- Modify: `netlify/functions/_account-store.js`
- Modify: `netlify/functions/_account-store.selfcheck.js`

- [ ] **Step 1: Replace the entire file content** with:

```js
// Shared Upstash Redis wrapper for the "accounts" namespace. Filename starts with `_`
// so Vercel's file-based routing ignores it under api/ once this file moves there.
// Centralizes the account key naming (account:<lowercased email>) and the shape of
// what gets stored so the 4 thin handler functions (sync/restore/list/delete-account.js)
// don't each reimplement it.
const { Redis } = require('@upstash/redis');

function store(){
  return Redis.fromEnv();
}

function keyFor(email){
  return 'account:' + String(email).trim().toLowerCase();
}

async function getAccount(email){
  const record = await store().get(keyFor(email));
  return record || null;
}

async function setAccount(email, data){
  await store().set(keyFor(email), { data, lastSyncedAt: new Date().toISOString() });
}

async function deleteAccount(email){
  await store().del(keyFor(email));
}

async function listAccounts(){
  const s = store();
  const keys = await s.keys('account:*');
  const accounts = [];
  for(const key of keys){
    const record = await s.get(key);
    if(!record) continue;
    let profile = {};
    try{ profile = record.data && record.data['forge-profile'] ? JSON.parse(record.data['forge-profile']) : {}; }
    catch(e){ /* malformed profile — skip fields, still list the account */ }
    accounts.push({
      email: key.slice('account:'.length),
      firstName: profile.firstName || '',
      lastName: profile.lastName || '',
      course: profile.course || '',
      semester: profile.semester || '',
      batch: profile.batch || '',
      lastSyncedAt: record.lastSyncedAt || null
    });
  }
  accounts.sort((a, b) => (b.lastSyncedAt || '').localeCompare(a.lastSyncedAt || ''));
  return accounts;
}

module.exports = { getAccount, setAccount, deleteAccount, listAccounts, keyFor };
```

Note: Upstash Redis's `get`/`set` auto-serialize/deserialize JSON objects natively — no `{ type: 'json' }` option or separate `setJSON` method needed (that was Blobs-specific).

- [ ] **Step 2: Replace the entire selfcheck file content** with:

```js
// Run: node netlify/functions/_account-store.selfcheck.js
// Mocks @upstash/redis's Redis.fromEnv() with an in-memory Map so this verifies
// _account-store.js's logic (key naming, list filtering/sorting, profile parsing)
// without needing a real Upstash database.
const assert = require('assert');

const redisPath = require.resolve('@upstash/redis');
const mem = new Map();
function makeFakeRedis(){
  return {
    async get(key){ return mem.has(key) ? mem.get(key) : null; },
    async set(key, value){ mem.set(key, value); },
    async del(key){ mem.delete(key); },
    async keys(pattern){
      const prefix = pattern.replace(/\*$/, '');
      return [...mem.keys()].filter(k => k.startsWith(prefix));
    }
  };
}
require.cache[redisPath] = {
  id: redisPath, filename: redisPath, loaded: true,
  exports: { Redis: { fromEnv: () => makeFakeRedis() } }
};

const { getAccount, setAccount, deleteAccount, listAccounts, keyFor } = require('./_account-store');

async function run(){
  // 1. keyFor lowercases and prefixes.
  assert.strictEqual(keyFor('Student@Example.com'), 'account:student@example.com');

  // 2. New account: getAccount returns null before any write.
  assert.strictEqual(await getAccount('a@x.com'), null);

  // 3. setAccount then getAccount round-trips the data.
  await setAccount('a@x.com', { 'forge-profile': JSON.stringify({ firstName: 'Ada', lastName: 'X', course: 'CS', semester: '3', batch: 'D' }) });
  const rec = await getAccount('a@x.com');
  assert.ok(rec, 'record should exist after setAccount');
  assert.ok(rec.lastSyncedAt, 'lastSyncedAt should be set');
  assert.strictEqual(JSON.parse(rec.data['forge-profile']).firstName, 'Ada');

  // 4. listAccounts summarizes the profile fields, doesn't dump raw data.
  await setAccount('b@x.com', { 'forge-profile': JSON.stringify({ firstName: 'Bo', lastName: 'Y', course: 'DSA', semester: '5', batch: 'A' }) });
  const list = await listAccounts();
  assert.strictEqual(list.length, 2);
  const a = list.find(x => x.email === 'a@x.com');
  assert.strictEqual(a.firstName, 'Ada');
  assert.strictEqual(a.course, 'CS');
  assert.strictEqual(typeof a.data, 'undefined', 'list must not include the raw data blob');

  // 5. deleteAccount removes it — getAccount and listAccounts both reflect that.
  await deleteAccount('a@x.com');
  assert.strictEqual(await getAccount('a@x.com'), null);
  const afterDelete = await listAccounts();
  assert.strictEqual(afterDelete.length, 1);
  assert.strictEqual(afterDelete[0].email, 'b@x.com');

  console.log('All _account-store self-checks passed.');
}

run().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Run the self-check**

Run: `node "netlify/functions/_account-store.selfcheck.js"`
Expected: `All _account-store self-checks passed.`

- [ ] **Step 4: Commit**

```bash
git add netlify/functions/_account-store.js netlify/functions/_account-store.selfcheck.js
git commit -m "refactor: _account-store.js uses Upstash Redis instead of Netlify Blobs"
```

---

## Task 3: Rewrite `_rate-limit.js` for Upstash Redis

**Files:**
- Modify: `netlify/functions/_rate-limit.js`
- Modify: `netlify/functions/_rate-limit.selfcheck.js`

- [ ] **Step 1: Replace the entire file content** with:

```js
// Shared per-IP rate limiter backed by Upstash Redis. Filename starts with `_` so
// Vercel's file-based routing ignores it under api/. Generous by design (30
// requests/hour per IP, combined across every AI/YouTube-calling function) --
// meant to stop a runaway bot or script from draining the Groq/YouTube quota, not
// to throttle real student usage.
const { Redis } = require('@upstash/redis');

const LIMIT = 30;
const WINDOW_MS = 60 * 60 * 1000;

function store(){
  return Redis.fromEnv();
}

function clientIp(req){
  const headers = req.headers || {};
  const fwd = headers['x-forwarded-for'];
  if(fwd) return (Array.isArray(fwd) ? fwd[0] : fwd).split(',')[0].trim();
  return 'unknown';
}

// Returns { allowed: boolean, remaining: number }. Increments the counter as a
// side effect on every call (whether allowed or not) -- callers should call this
// once per request, before doing any real work.
//
// Fails OPEN (allowed: true) if the Redis store itself is unreachable or
// misconfigured -- e.g. no database linked/pulled, which is the case for `vercel
// dev` before `vercel env pull` has been run. Rate limiting is a cost/abuse guard,
// not a security boundary; a broken limiter should never be able to take the whole
// app down for every real student.
async function checkRateLimit(req){
  const ip = clientIp(req);
  const key = 'ip:' + ip;
  const now = Date.now();
  try{
    const record = await store().get(key);
    if(!record || now - record.windowStart > WINDOW_MS){
      await store().set(key, { count: 1, windowStart: now });
      return { allowed: true, remaining: LIMIT - 1 };
    }
    if(record.count >= LIMIT){
      return { allowed: false, remaining: 0 };
    }
    await store().set(key, { count: record.count + 1, windowStart: record.windowStart });
    return { allowed: true, remaining: LIMIT - record.count - 1 };
  } catch(e){
    console.warn('[rate-limit] store unreachable, failing open:', e.message);
    return { allowed: true, remaining: LIMIT };
  }
}

module.exports = { checkRateLimit, clientIp, LIMIT, WINDOW_MS };
```

Note: `event.headers['x-nf-client-connection-ip']` was Netlify-specific and is gone —
Vercel's standard client-IP header is `x-forwarded-for`, which this rewrite uses as
the sole source (no Netlify-specific fallback needed anymore). Also note the
parameter is renamed `req` throughout (was `event`) to match every call site's new
Vercel-style handler in Tasks 4-17.

- [ ] **Step 2: Replace the entire selfcheck file content** with:

```js
// Run: node netlify/functions/_rate-limit.selfcheck.js
// Mocks @upstash/redis the same way _account-store.selfcheck.js does.
const assert = require('assert');

const redisPath = require.resolve('@upstash/redis');
const mem = new Map();
function makeFakeRedis(){
  return {
    async get(key){ return mem.has(key) ? mem.get(key) : null; },
    async set(key, value){ mem.set(key, value); },
    async del(key){ mem.delete(key); }
  };
}
require.cache[redisPath] = {
  id: redisPath, filename: redisPath, loaded: true,
  exports: { Redis: { fromEnv: () => makeFakeRedis() } }
};

const { checkRateLimit, clientIp, LIMIT, WINDOW_MS } = require('./_rate-limit');

async function run(){
  const ipA = { headers: { 'x-forwarded-for': '1.1.1.1' } };

  // 1. Exactly LIMIT requests from the same IP are all allowed.
  let lastResult;
  for(let i = 0; i < LIMIT; i++){ lastResult = await checkRateLimit(ipA); }
  assert.strictEqual(lastResult.allowed, true, 'the LIMIT-th request should still be allowed');

  // 2. The (LIMIT+1)-th request from that same IP is blocked.
  const blocked = await checkRateLimit(ipA);
  assert.strictEqual(blocked.allowed, false);
  assert.strictEqual(blocked.remaining, 0);

  // 3. A different IP has its own independent bucket.
  const ipB = { headers: { 'x-forwarded-for': '2.2.2.2' } };
  const rB = await checkRateLimit(ipB);
  assert.strictEqual(rB.allowed, true);

  // 4. Comma-separated x-forwarded-for takes the first address.
  const ipC = { headers: { 'x-forwarded-for': '3.3.3.3, 9.9.9.9' } };
  assert.strictEqual(clientIp(ipC), '3.3.3.3');

  // 5. An expired window resets the counter, even for a previously-blocked IP.
  const key = 'ip:' + clientIp(ipA);
  const record = await mem.get(key);
  mem.set(key, { count: record.count, windowStart: record.windowStart - (WINDOW_MS + 1000) });
  const afterExpiry = await checkRateLimit(ipA);
  assert.strictEqual(afterExpiry.allowed, true, 'window should have reset');

  // 6. If the store itself is unreachable, checkRateLimit fails OPEN rather than throwing.
  require.cache[redisPath].exports.Redis.fromEnv = () => ({
    async get(){ throw new Error('simulated Upstash connection error'); },
    async set(){ throw new Error('should not be reachable'); }
  });
  delete require.cache[require.resolve('./_rate-limit')];
  const { checkRateLimit: checkRateLimitBroken } = require('./_rate-limit');
  const failOpen = await checkRateLimitBroken({ headers: { 'x-forwarded-for': '4.4.4.4' } });
  assert.strictEqual(failOpen.allowed, true, 'must fail open when the store is unreachable');

  console.log('All _rate-limit self-checks passed.');
}

run().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Run the self-check**

Run: `node "netlify/functions/_rate-limit.selfcheck.js"`
Expected: `All _rate-limit self-checks passed.`

- [ ] **Step 4: Commit**

```bash
git add netlify/functions/_rate-limit.js netlify/functions/_rate-limit.selfcheck.js
git commit -m "refactor: _rate-limit.js uses Upstash Redis instead of Netlify Blobs"
```

---

## Task 4: Migrate `ask-doubt.js` to `api/ask-doubt.js`

**Files:**
- Create: `api/ask-doubt.js` (moved + rewritten from `netlify/functions/ask-doubt.js`)
- Delete: `netlify/functions/ask-doubt.js`

- [ ] **Step 1: Read the current file**, then apply the Global Transform Rule from the top of this plan:
  - `exports.handler = async function(event){` → `module.exports = async function handler(req, res){`
  - `if(event.httpMethod !== 'POST'){` → `if(req.method !== 'POST'){`
  - The `try{ const body = JSON.parse(event.body || '{}'); ... } catch(e){ return {...'Invalid request body'...} }` block becomes: `const body = req.body || {};` (no try/catch needed — Vercel either parses valid JSON into `req.body` or the request never reaches your handler with a body-parsing 400; keep the same field-extraction lines below it unchanged, just remove the `JSON.parse`/try-catch wrapper and the now-unreachable "Invalid request body" 400 return)
  - Apply these exact return-statement replacements (in order of appearance):
    - `return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };` → `return res.status(405).json({ error: 'Method not allowed' });`
    - `return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests — try again later' }) };` → `return res.status(429).json({ error: 'Too many requests — try again later' });`
    - `return { statusCode: 400, body: JSON.stringify({ error: 'question is required' }) };` → `return res.status(400).json({ error: 'question is required' });`
    - `return { statusCode: 502, body: JSON.stringify({ error: 'Model did not return valid JSON', raw }) };` → `return res.status(502).json({ error: 'Model did not return valid JSON', raw });`
    - The multi-line `return { statusCode: 200, body: JSON.stringify({ ... null-response object ... }) };` → `return res.status(200).json({ ...same object... });` (keep the object literal exactly as-is, just change the wrapping)
    - `return { statusCode: 200, body: JSON.stringify(parsed) };` → `return res.status(200).json(parsed);`
    - `return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Groq API: ' + e.message }) };` → `return res.status(502).json({ error: 'Failed to reach Groq API: ' + e.message });`
  - `const rl = await checkRateLimit(event);` → `const rl = await checkRateLimit(req);`
  - Every other line (system prompt, `chapterListText()`, `COURSE_CHAPTERS`, the `callGroq(...)` call, attachment handling) stays byte-identical.

- [ ] **Step 2: Save as `api/ask-doubt.js`** (create the `api/` directory if it doesn't exist yet), then delete `netlify/functions/ask-doubt.js`.

- [ ] **Step 3: Logic smoke test with mocked Redis** (no real Upstash database linked yet in this environment):

```bash
node -e "
const redisPath = require.resolve('@upstash/redis');
require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: { Redis: { fromEnv: () => ({ async get(){return null;}, async set(){}, async del(){} }) } } };
const handler = require('./api/ask-doubt.js');
let statusCode, body;
const res = { status(c){ statusCode=c; return this; }, json(b){ body=b; console.log(statusCode, JSON.stringify(b).slice(0,200)); } };
handler({ method:'POST', body: { question:'what is a stack?', tier:'tier1', history:[] } }, res);
"
```
Expected: prints `200` followed by JSON containing `"subject"` (real Groq call — `.env`'s `GROQ_API_KEY` is loaded automatically by plain `node` only if you export it first; if the output shows a Groq auth error instead of a real answer, run `node -e "require('fs').readFileSync('.env','utf8').split(/\r?\n/).forEach(l=>{const m=l.match(/^([A-Z0-9_]+)=(.*)$/); if(m) process.env[m[1]]=m[2];}); require('child_process').execSync('node -e \"...\"', {stdio:'inherit'})"` style env-loading, matching the pattern used throughout this project's other smoke tests).

- [ ] **Step 4: Commit**

```bash
git add api/ask-doubt.js
git rm netlify/functions/ask-doubt.js
git commit -m "refactor: migrate ask-doubt.js to Vercel (api/ask-doubt.js)"
```

---

## Task 5: Migrate `generate-note.js` to `api/generate-note.js`

**Files:**
- Create: `api/generate-note.js`
- Delete: `netlify/functions/generate-note.js`

- [ ] **Step 1: Read the current file**, apply the Global Transform Rule, with these exact return-statement replacements:
  - `return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };` → `return res.status(405).json({ error: 'Method not allowed' });`
  - `return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests — try again later' }) };` → `return res.status(429).json({ error: 'Too many requests — try again later' });`
  - `return { statusCode: 400, body: JSON.stringify({ error: 'topic is required' }) };` → `return res.status(400).json({ error: 'topic is required' });`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Model did not return valid JSON', raw }) };` → `return res.status(502).json({ error: 'Model did not return valid JSON', raw });`
  - `return { statusCode: 200, body: JSON.stringify({ title: null, sections: [], usage: data.usage || null }) };` → `return res.status(200).json({ title: null, sections: [], usage: data.usage || null });`
  - `return { statusCode: 200, body: JSON.stringify(parsed) };` → `return res.status(200).json(parsed);`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Groq API: ' + e.message }) };` → `return res.status(502).json({ error: 'Failed to reach Groq API: ' + e.message });`
  - Same body-parsing simplification as Task 4 (`req.body || {}`, no try/catch, remove the now-unreachable "Invalid request body" 400).

- [ ] **Step 2: Save as `api/generate-note.js`**, delete `netlify/functions/generate-note.js`.

- [ ] **Step 3: Smoke test** (same mocked-Redis pattern as Task 4, adjusted body):

```bash
node -e "
const redisPath = require.resolve('@upstash/redis');
require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: { Redis: { fromEnv: () => ({ async get(){return null;}, async set(){}, async del(){} }) } } };
const handler = require('./api/generate-note.js');
const res = { status(c){ this.c=c; return this; }, json(b){ console.log(this.c, JSON.stringify(b).slice(0,200)); } };
handler({ method:'POST', body: { topic:'Binary Search Trees', tier:'tier1' } }, res);
"
```
Expected: `200` with a body containing `"title"`.

- [ ] **Step 4: Commit**

```bash
git add api/generate-note.js
git rm netlify/functions/generate-note.js
git commit -m "refactor: migrate generate-note.js to Vercel (api/generate-note.js)"
```

---

## Task 6: Migrate `assignment-tip.js` to `api/assignment-tip.js`

**Files:**
- Create: `api/assignment-tip.js`
- Delete: `netlify/functions/assignment-tip.js`

- [ ] **Step 1: Read the current file**, apply the Global Transform Rule, with these exact return-statement replacements:
  - `return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };` → `return res.status(405).json({ error: 'Method not allowed' });`
  - `return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests — try again later' }) };` → `return res.status(429).json({ error: 'Too many requests — try again later' });`
  - `return { statusCode: 400, body: JSON.stringify({ error: 'assignments is required and must be non-empty' }) };` → `return res.status(400).json({ error: 'assignments is required and must be non-empty' });`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Model did not return valid JSON', raw }) };` → `return res.status(502).json({ error: 'Model did not return valid JSON', raw });`
  - `return { statusCode: 200, body: JSON.stringify({ tip: null, usage: data.usage || null }) };` → `return res.status(200).json({ tip: null, usage: data.usage || null });`
  - `return { statusCode: 200, body: JSON.stringify(parsed) };` → `return res.status(200).json(parsed);`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Groq API: ' + e.message }) };` → `return res.status(502).json({ error: 'Failed to reach Groq API: ' + e.message });`
  - Same body-parsing simplification as Task 4.

- [ ] **Step 2: Save as `api/assignment-tip.js`**, delete `netlify/functions/assignment-tip.js`.

- [ ] **Step 3: Smoke test:**

```bash
node -e "
const redisPath = require.resolve('@upstash/redis');
require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: { Redis: { fromEnv: () => ({ async get(){return null;}, async set(){}, async del(){} }) } } };
const handler = require('./api/assignment-tip.js');
const res = { status(c){ this.c=c; return this; }, json(b){ console.log(this.c, JSON.stringify(b).slice(0,200)); } };
handler({ method:'POST', body: { assignments:[{name:'Lab 3', due:'2026-08-10'}] } }, res);
"
```
Expected: `200`.

- [ ] **Step 4: Commit**

```bash
git add api/assignment-tip.js
git rm netlify/functions/assignment-tip.js
git commit -m "refactor: migrate assignment-tip.js to Vercel (api/assignment-tip.js)"
```

---

## Task 7: Migrate `strategy-tip.js` to `api/strategy-tip.js`

**Files:**
- Create: `api/strategy-tip.js`
- Delete: `netlify/functions/strategy-tip.js`

- [ ] **Step 1: Read the current file**, apply the Global Transform Rule, with these exact return-statement replacements:
  - `return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };` → `return res.status(405).json({ error: 'Method not allowed' });`
  - `return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests — try again later' }) };` → `return res.status(429).json({ error: 'Too many requests — try again later' });`
  - `return { statusCode: 400, body: JSON.stringify({ error: 'days is required and must be non-empty for studyplan mode' }) };` → `return res.status(400).json({ error: 'days is required and must be non-empty for studyplan mode' });`
  - `return { statusCode: 400, body: JSON.stringify({ error: 'backlogSubject and examDate are required for backlog mode' }) };` → `return res.status(400).json({ error: 'backlogSubject and examDate are required for backlog mode' });`
  - `return { statusCode: 400, body: JSON.stringify({ error: 'academic is required for weekly mode' }) };` → `return res.status(400).json({ error: 'academic is required for weekly mode' });`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Model did not return valid JSON', raw }) };` → `return res.status(502).json({ error: 'Model did not return valid JSON', raw });`
  - `return { statusCode: 200, body: JSON.stringify({ [resultKey]: null, usage: data.usage || null }) };` → `return res.status(200).json({ [resultKey]: null, usage: data.usage || null });`
  - `return { statusCode: 200, body: JSON.stringify(parsed) };` → `return res.status(200).json(parsed);`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Groq API: ' + e.message }) };` → `return res.status(502).json({ error: 'Failed to reach Groq API: ' + e.message });`
  - Same body-parsing simplification as Task 4. Note this file has no single "field required" 400 at the top level (`backlogSubject`/`academic`/`days` checks are mode-specific, inside `if(body.mode === 'X')` branches) — leave those branch structures untouched, only the return-statement *wrapping* changes.

- [ ] **Step 2: Save as `api/strategy-tip.js`**, delete `netlify/functions/strategy-tip.js`.

- [ ] **Step 3: Smoke test:**

```bash
node -e "
const redisPath = require.resolve('@upstash/redis');
require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: { Redis: { fromEnv: () => ({ async get(){return null;}, async set(){}, async del(){} }) } } };
const handler = require('./api/strategy-tip.js');
const res = { status(c){ this.c=c; return this; }, json(b){ console.log(this.c, JSON.stringify(b).slice(0,200)); } };
handler({ method:'POST', body: { mode:'weekly', academic: { attendanceCutoff: 75, cgpaHistory: [{ semester: 2, sgpa: 8.1 }], attendance: [{ subject: 'DSA', percent: 80 }], backlogs: [] } } }, res);
"
```
Expected: `200`.

- [ ] **Step 4: Commit**

```bash
git add api/strategy-tip.js
git rm netlify/functions/strategy-tip.js
git commit -m "refactor: migrate strategy-tip.js to Vercel (api/strategy-tip.js)"
```

---

## Task 8: Migrate `grade-answer.js` to `api/grade-answer.js`

**Files:**
- Create: `api/grade-answer.js`
- Delete: `netlify/functions/grade-answer.js`

- [ ] **Step 1: Read the current file**, apply the Global Transform Rule, with these exact return-statement replacements:
  - `return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };` → `return res.status(405).json({ error: 'Method not allowed' });`
  - `return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests — try again later' }) };` → `return res.status(429).json({ error: 'Too many requests — try again later' });`
  - `return { statusCode: 400, body: JSON.stringify({ error: 'question and answer are required' }) };` → `return res.status(400).json({ error: 'question and answer are required' });`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Model did not return valid JSON', raw }) };` → `return res.status(502).json({ error: 'Model did not return valid JSON', raw });`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Model returned an incomplete grading result' }) };` → `return res.status(502).json({ error: 'Model returned an incomplete grading result' });`
  - `return { statusCode: 200, body: JSON.stringify(parsed) };` → `return res.status(200).json(parsed);`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Groq API: ' + e.message }) };` → `return res.status(502).json({ error: 'Failed to reach Groq API: ' + e.message });`
  - Same body-parsing simplification as Task 4.

- [ ] **Step 2: Save as `api/grade-answer.js`**, delete `netlify/functions/grade-answer.js`.

- [ ] **Step 3: Smoke test:**

```bash
node -e "
const redisPath = require.resolve('@upstash/redis');
require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: { Redis: { fromEnv: () => ({ async get(){return null;}, async set(){}, async del(){} }) } } };
const handler = require('./api/grade-answer.js');
const res = { status(c){ this.c=c; return this; }, json(b){ console.log(this.c, JSON.stringify(b).slice(0,200)); } };
handler({ method:'POST', body: { subject:'DSA', question:'What is a stack?', answer:'LIFO data structure' } }, res);
"
```
Expected: `200`.

- [ ] **Step 4: Commit**

```bash
git add api/grade-answer.js
git rm netlify/functions/grade-answer.js
git commit -m "refactor: migrate grade-answer.js to Vercel (api/grade-answer.js)"
```

---

## Task 9: Migrate `viva-turn.js` to `api/viva-turn.js`

**Files:**
- Create: `api/viva-turn.js`
- Delete: `netlify/functions/viva-turn.js`

- [ ] **Step 1: Read the current file**, apply the Global Transform Rule, with these exact return-statement replacements:
  - `return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };` → `return res.status(405).json({ error: 'Method not allowed' });`
  - `return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests — try again later' }) };` → `return res.status(429).json({ error: 'Too many requests — try again later' });`
  - `return { statusCode: 400, body: JSON.stringify({ error: 'subject is required' }) };` → `return res.status(400).json({ error: 'subject is required' });`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Model did not return valid JSON', raw }) };` → `return res.status(502).json({ error: 'Model did not return valid JSON', raw });`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Model returned an empty reply' }) };` → `return res.status(502).json({ error: 'Model returned an empty reply' });`
  - `return { statusCode: 200, body: JSON.stringify(parsed) };` → `return res.status(200).json(parsed);`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Groq API: ' + e.message }) };` → `return res.status(502).json({ error: 'Failed to reach Groq API: ' + e.message });`
  - Same body-parsing simplification as Task 4 (this file also reads `body.chapters` — keep that field extraction, just off the plain `req.body || {}` object now).

- [ ] **Step 2: Save as `api/viva-turn.js`**, delete `netlify/functions/viva-turn.js`.

- [ ] **Step 3: Smoke test:**

```bash
node -e "
const redisPath = require.resolve('@upstash/redis');
require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: { Redis: { fromEnv: () => ({ async get(){return null;}, async set(){}, async del(){} }) } } };
const handler = require('./api/viva-turn.js');
const res = { status(c){ this.c=c; return this; }, json(b){ console.log(this.c, JSON.stringify(b).slice(0,200)); } };
handler({ method:'POST', body: { subject:'Data Structures and Algorithms', history:[], chapters:['Stacks','Queues'] } }, res);
"
```
Expected: `200` with a body containing `"chapter"`.

- [ ] **Step 4: Commit**

```bash
git add api/viva-turn.js
git rm netlify/functions/viva-turn.js
git commit -m "refactor: migrate viva-turn.js to Vercel (api/viva-turn.js)"
```

---

## Task 10: Migrate `generate-quiz.js` to `api/generate-quiz.js`

**Files:**
- Create: `api/generate-quiz.js`
- Delete: `netlify/functions/generate-quiz.js`

- [ ] **Step 1: Read the current file**, apply the Global Transform Rule, with these exact return-statement replacements:
  - `return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };` → `return res.status(405).json({ error: 'Method not allowed' });`
  - `return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests — try again later' }) };` → `return res.status(429).json({ error: 'Too many requests — try again later' });`
  - `return { statusCode: 400, body: JSON.stringify({ error: 'subject, chapters, and type are required' }) };` → `return res.status(400).json({ error: 'subject, chapters, and type are required' });`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Model did not return valid JSON', raw }) };` → `return res.status(502).json({ error: 'Model did not return valid JSON', raw });`
  - `return { statusCode: 200, body: JSON.stringify({ questions, usage: data.usage || null }) };` → `return res.status(200).json({ questions, usage: data.usage || null });`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Groq API: ' + e.message }) };` → `return res.status(502).json({ error: 'Failed to reach Groq API: ' + e.message });`
  - Same body-parsing simplification as Task 4.

- [ ] **Step 2: Save as `api/generate-quiz.js`**, delete `netlify/functions/generate-quiz.js`.

- [ ] **Step 3: Smoke test:**

```bash
node -e "
const redisPath = require.resolve('@upstash/redis');
require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: { Redis: { fromEnv: () => ({ async get(){return null;}, async set(){}, async del(){} }) } } };
const handler = require('./api/generate-quiz.js');
const res = { status(c){ this.c=c; return this; }, json(b){ console.log(this.c, JSON.stringify(b).slice(0,200)); } };
handler({ method:'POST', body: { subject:'DSA', chapters:['Trees'], type:'mcq', count:2 } }, res);
"
```
Expected: `200`.

- [ ] **Step 4: Commit**

```bash
git add api/generate-quiz.js
git rm netlify/functions/generate-quiz.js
git commit -m "refactor: migrate generate-quiz.js to Vercel (api/generate-quiz.js)"
```

---

## Task 11: Migrate `grade-brainstorm.js` to `api/grade-brainstorm.js`

**Files:**
- Create: `api/grade-brainstorm.js`
- Delete: `netlify/functions/grade-brainstorm.js`

- [ ] **Step 1: Read the current file**, apply the Global Transform Rule, with these exact return-statement replacements:
  - `return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };` → `return res.status(405).json({ error: 'Method not allowed' });`
  - `return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests — try again later' }) };` → `return res.status(429).json({ error: 'Too many requests — try again later' });`
  - `return { statusCode: 400, body: JSON.stringify({ error: 'topic and ideas are required' }) };` → `return res.status(400).json({ error: 'topic and ideas are required' });`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Model did not return valid JSON', raw }) };` → `return res.status(502).json({ error: 'Model did not return valid JSON', raw });`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Model returned an incomplete grading result' }) };` → `return res.status(502).json({ error: 'Model returned an incomplete grading result' });`
  - `return { statusCode: 200, body: JSON.stringify(parsed) };` → `return res.status(200).json(parsed);`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Groq API: ' + e.message }) };` → `return res.status(502).json({ error: 'Failed to reach Groq API: ' + e.message });`
  - Same body-parsing simplification as Task 4.

- [ ] **Step 2: Save as `api/grade-brainstorm.js`**, delete `netlify/functions/grade-brainstorm.js`.

- [ ] **Step 3: Smoke test:**

```bash
node -e "
const redisPath = require.resolve('@upstash/redis');
require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: { Redis: { fromEnv: () => ({ async get(){return null;}, async set(){}, async del(){} }) } } };
const handler = require('./api/grade-brainstorm.js');
const res = { status(c){ this.c=c; return this; }, json(b){ console.log(this.c, JSON.stringify(b).slice(0,200)); } };
handler({ method:'POST', body: { topic:'DBMS', prompt:'Name normalization forms', ideas:['1NF','2NF'] } }, res);
"
```
Expected: `200`.

- [ ] **Step 4: Commit**

```bash
git add api/grade-brainstorm.js
git rm netlify/functions/grade-brainstorm.js
git commit -m "refactor: migrate grade-brainstorm.js to Vercel (api/grade-brainstorm.js)"
```

---

## Task 12: Migrate `readiness-verdict.js` to `api/readiness-verdict.js`

**Files:**
- Create: `api/readiness-verdict.js`
- Delete: `netlify/functions/readiness-verdict.js`

- [ ] **Step 1: Read the current file**, apply the Global Transform Rule, with these exact return-statement replacements:
  - `return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };` → `return res.status(405).json({ error: 'Method not allowed' });`
  - `return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests — try again later' }) };` → `return res.status(429).json({ error: 'Too many requests — try again later' });`
  - `return { statusCode: 400, body: JSON.stringify({ error: 'subject and diagnostic {correct, total} are required' }) };` → `return res.status(400).json({ error: 'subject and diagnostic {correct, total} are required' });`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Model did not return valid JSON', raw }) };` → `return res.status(502).json({ error: 'Model did not return valid JSON', raw });`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Model returned an incomplete verdict' }) };` → `return res.status(502).json({ error: 'Model returned an incomplete verdict' });`
  - `return { statusCode: 200, body: JSON.stringify(parsed) };` → `return res.status(200).json(parsed);`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Groq API: ' + e.message }) };` → `return res.status(502).json({ error: 'Failed to reach Groq API: ' + e.message });`
  - Same body-parsing simplification as Task 4.

- [ ] **Step 2: Save as `api/readiness-verdict.js`**, delete `netlify/functions/readiness-verdict.js`.

- [ ] **Step 3: Smoke test:**

```bash
node -e "
const redisPath = require.resolve('@upstash/redis');
require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: { Redis: { fromEnv: () => ({ async get(){return null;}, async set(){}, async del(){} }) } } };
const handler = require('./api/readiness-verdict.js');
const res = { status(c){ this.c=c; return this; }, json(b){ console.log(this.c, JSON.stringify(b).slice(0,200)); } };
handler({ method:'POST', body: { subject:'DSA', dataReadiness:{overall:60,topicCoverage:50,weakTopic:0,mockScores:70,recency:80}, diagnostic:{correct:3,total:5,missedChapters:['Trees']} } }, res);
"
```
Expected: `200`.

- [ ] **Step 4: Commit**

```bash
git add api/readiness-verdict.js
git rm netlify/functions/readiness-verdict.js
git commit -m "refactor: migrate readiness-verdict.js to Vercel (api/readiness-verdict.js)"
```

---

## Task 13: Migrate `find-videos.js` to `api/find-videos.js` (special case — soft-fail on Groq failure)

**Files:**
- Create: `api/find-videos.js`
- Delete: `netlify/functions/find-videos.js`

- [ ] **Step 1: Read the current file**, apply the Global Transform Rule, with these exact return-statement replacements:
  - `return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };` → `return res.status(405).json({ error: 'Method not allowed' });`
  - `return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests — try again later' }) };` → `return res.status(429).json({ error: 'Too many requests — try again later' });`
  - `return { statusCode: 500, body: JSON.stringify({ videos: [], bestVideoId: null, error: 'YOUTUBE_API_KEY not configured on the server' }) };` → `return res.status(500).json({ videos: [], bestVideoId: null, error: 'YOUTUBE_API_KEY not configured on the server' });`
  - `return { statusCode: 400, body: JSON.stringify({ error: 'subject and chapter are required' }) };` → `return res.status(400).json({ error: 'subject and chapter are required' });`
  - Both occurrences of `return { statusCode: 200, body: JSON.stringify({ videos: [], bestVideoId: null, error: null, usage: groqUsage }) };` → `return res.status(200).json({ videos: [], bestVideoId: null, error: null, usage: groqUsage });`
  - `return { statusCode: 200, body: JSON.stringify({ videos, bestVideoId, error: null, usage: groqUsage }) };` → `return res.status(200).json({ videos, bestVideoId, error: null, usage: groqUsage });`
  - `return { statusCode: 502, body: JSON.stringify({ videos: [], bestVideoId: null, error: 'Failed to reach YouTube API: ' + e.message }) };` → `return res.status(502).json({ videos: [], bestVideoId: null, error: 'Failed to reach YouTube API: ' + e.message });`
  - Same body-parsing simplification as Task 4. Preserve this file's unique soft-fail structure exactly (the inner try/catch around the Groq call that falls back to a default query string on any failure) — only the outer handler signature and the explicit return statements above change.

- [ ] **Step 2: Save as `api/find-videos.js`**, delete `netlify/functions/find-videos.js`.

- [ ] **Step 3: Smoke test** (requires `YOUTUBE_API_KEY`; if not present in this environment, run the fallback sanity check instead — same as this file's original migration task tonight):

```bash
node -e "
const redisPath = require.resolve('@upstash/redis');
require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: { Redis: { fromEnv: () => ({ async get(){return null;}, async set(){}, async del(){} }) } } };
require('./api/find-videos.js');
console.log('module loads without error');
"
```

- [ ] **Step 4: Commit**

```bash
git add api/find-videos.js
git rm netlify/functions/find-videos.js
git commit -m "refactor: migrate find-videos.js to Vercel (api/find-videos.js)"
```

---

## Task 14: Migrate `sync-account.js` to `api/sync-account.js`

**Files:**
- Create: `api/sync-account.js`
- Delete: `netlify/functions/sync-account.js`

- [ ] **Step 1: Read the current file**, apply the Global Transform Rule (note: this function has no `checkRateLimit` call — leave it that way, per the original spec's decision to scope rate-limiting to the 10 AI/YouTube functions only), with these exact return-statement replacements:
  - `return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };` → `return res.status(405).json({ error: 'Method not allowed' });`
  - `return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };` → this one specifically stays conceptually (guard for `req.body` being missing/malformed), but simplify to: check `if(!req.body){ return res.status(400).json({ error: 'Invalid request body' }); }` right after the method check, replacing the old try/catch JSON.parse block
  - `return { statusCode: 400, body: JSON.stringify({ error: 'a valid email is required' }) };` → `return res.status(400).json({ error: 'a valid email is required' });`
  - `return { statusCode: 400, body: JSON.stringify({ error: 'data is required and must be an object' }) };` → `return res.status(400).json({ error: 'data is required and must be an object' });`
  - `return { statusCode: 200, body: JSON.stringify({ ok: true }) };` → `return res.status(200).json({ ok: true });`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Failed to write account: ' + e.message }) };` → `return res.status(502).json({ error: 'Failed to write account: ' + e.message });`

- [ ] **Step 2: Save as `api/sync-account.js`**, delete `netlify/functions/sync-account.js`.

- [ ] **Step 3: Smoke test with mocked Redis:**

```bash
node -e "
const redisPath = require.resolve('@upstash/redis');
require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: { Redis: { fromEnv: () => ({ async get(){return null;}, async set(){}, async del(){}, async keys(){return [];} }) } } };
const handler = require('./api/sync-account.js');
const res = { status(c){ this.c=c; return this; }, json(b){ console.log(this.c, JSON.stringify(b)); } };
handler({ method:'POST', body: { email:'test@x.com', data:{'forge-profile':'{}'} } }, res);
"
```
Expected: `200 {"ok":true}`

- [ ] **Step 4: Commit**

```bash
git add api/sync-account.js
git rm netlify/functions/sync-account.js
git commit -m "refactor: migrate sync-account.js to Vercel (api/sync-account.js)"
```

---

## Task 15: Migrate `restore-account.js` to `api/restore-account.js`

**Files:**
- Create: `api/restore-account.js`
- Delete: `netlify/functions/restore-account.js`

- [ ] **Step 1: Read the current file**, apply the Global Transform Rule (no rate-limit call, same as Task 14), with these exact return-statement replacements:
  - `return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };` → `return res.status(405).json({ error: 'Method not allowed' });`
  - `return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };` → same simplification as Task 14 Step 1
  - `return { statusCode: 400, body: JSON.stringify({ error: 'a valid email is required' }) };` → `return res.status(400).json({ error: 'a valid email is required' });`
  - `return { statusCode: 200, body: JSON.stringify({ found: false }) };` → `return res.status(200).json({ found: false });`
  - `return { statusCode: 200, body: JSON.stringify({ found: true, data: record.data }) };` → `return res.status(200).json({ found: true, data: record.data });`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Failed to read account: ' + e.message }) };` → `return res.status(502).json({ error: 'Failed to read account: ' + e.message });`

- [ ] **Step 2: Save as `api/restore-account.js`**, delete `netlify/functions/restore-account.js`.

- [ ] **Step 3: Smoke test with mocked Redis — both found and not-found paths:**

```bash
node -e "
const redisPath = require.resolve('@upstash/redis');
const mem = new Map();
require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: { Redis: { fromEnv: () => ({
  async get(k){ return mem.has(k) ? mem.get(k) : null; },
  async set(k,v){ mem.set(k,v); },
  async del(k){ mem.delete(k); },
  async keys(){ return [...mem.keys()]; }
}) } } };
const { setAccount } = require('./netlify/functions/_account-store');
const handler = require('./api/restore-account.js');
const res1 = { status(c){ this.c=c; return this; }, json(b){ console.log('not found:', this.c, JSON.stringify(b)); } };
handler({ method:'POST', body: { email:'new@x.com' } }, res1);
setAccount('existing@x.com', {'forge-profile':'{\"firstName\":\"Ada\"}'}).then(() => {
  const res2 = { status(c){ this.c=c; return this; }, json(b){ console.log('found:', this.c, JSON.stringify(b)); } };
  handler({ method:'POST', body: { email:'existing@x.com' } }, res2);
});
"
```
Expected:
```
not found: 200 {"found":false}
found: 200 {"found":true,"data":{"forge-profile":"{\"firstName\":\"Ada\"}"}}
```

- [ ] **Step 4: Commit**

```bash
git add api/restore-account.js
git rm netlify/functions/restore-account.js
git commit -m "refactor: migrate restore-account.js to Vercel (api/restore-account.js)"
```

---

## Task 16: Migrate `list-accounts.js` to `api/list-accounts.js`

**Files:**
- Create: `api/list-accounts.js`
- Delete: `netlify/functions/list-accounts.js`

- [ ] **Step 1: Read the current file**, apply the Global Transform Rule. This function has its own `x-admin-key` header check — keep that logic exactly as-is (`event.headers` → `req.headers`, same as every other header read), with these exact return-statement replacements:
  - `return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };` → `return res.status(405).json({ error: 'Method not allowed' });`
  - `return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };` → `return res.status(401).json({ error: 'Unauthorized' });`
  - `return { statusCode: 200, body: JSON.stringify({ accounts }) };` → `return res.status(200).json({ accounts });`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Failed to list accounts: ' + e.message }) };` → `return res.status(502).json({ error: 'Failed to list accounts: ' + e.message });`

- [ ] **Step 2: Save as `api/list-accounts.js`**, delete `netlify/functions/list-accounts.js`.

- [ ] **Step 3: Smoke test — auth gate and happy path:**

```bash
node -e "
const redisPath = require.resolve('@upstash/redis');
require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: { Redis: { fromEnv: () => ({ async get(){return null;}, async set(){}, async del(){}, async keys(){return [];} }) } } };
process.env.ADMIN_API_KEY = 'test-secret';
const handler = require('./api/list-accounts.js');
const res1 = { status(c){ this.c=c; return this; }, json(b){ console.log('no key:', this.c, JSON.stringify(b)); } };
handler({ method:'POST', headers:{} }, res1);
const res2 = { status(c){ this.c=c; return this; }, json(b){ console.log('correct key:', this.c, JSON.stringify(b)); } };
handler({ method:'POST', headers:{'x-admin-key':'test-secret'} }, res2);
"
```
Expected:
```
no key: 401 {"error":"Unauthorized"}
correct key: 200 {"accounts":[]}
```

- [ ] **Step 4: Commit**

```bash
git add api/list-accounts.js
git rm netlify/functions/list-accounts.js
git commit -m "refactor: migrate list-accounts.js to Vercel (api/list-accounts.js)"
```

---

## Task 17: Migrate `delete-account.js` to `api/delete-account.js`

**Files:**
- Create: `api/delete-account.js`
- Delete: `netlify/functions/delete-account.js`

- [ ] **Step 1: Read the current file**, apply the Global Transform Rule, same admin-key check preserved as Task 16, with these exact return-statement replacements:
  - `return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };` → `return res.status(405).json({ error: 'Method not allowed' });`
  - `return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };` → `return res.status(401).json({ error: 'Unauthorized' });`
  - `return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };` → same simplification as Task 14 Step 1
  - `return { statusCode: 400, body: JSON.stringify({ error: 'email is required' }) };` → `return res.status(400).json({ error: 'email is required' });`
  - `return { statusCode: 200, body: JSON.stringify({ ok: true }) };` → `return res.status(200).json({ ok: true });`
  - `return { statusCode: 502, body: JSON.stringify({ error: 'Failed to delete account: ' + e.message }) };` → `return res.status(502).json({ error: 'Failed to delete account: ' + e.message });`

- [ ] **Step 2: Save as `api/delete-account.js`**, delete `netlify/functions/delete-account.js`.

- [ ] **Step 3: Smoke test — auth gate blocks unauthorized deletes, authorized delete actually works:**

```bash
node -e "
const redisPath = require.resolve('@upstash/redis');
const mem = new Map();
require.cache[redisPath] = { id: redisPath, filename: redisPath, loaded: true, exports: { Redis: { fromEnv: () => ({
  async get(k){ return mem.has(k) ? mem.get(k) : null; },
  async set(k,v){ mem.set(k,v); },
  async del(k){ mem.delete(k); },
  async keys(){ return [...mem.keys()]; }
}) } } };
process.env.ADMIN_API_KEY = 'test-secret';
const { setAccount, getAccount } = require('./netlify/functions/_account-store');
const handler = require('./api/delete-account.js');
setAccount('gone@x.com', {'forge-profile':'{}'}).then(async () => {
  const res1 = { status(c){ this.c=c; return this; }, json(b){ console.log('no key:', this.c, JSON.stringify(b)); } };
  handler({ method:'POST', headers:{}, body:{email:'gone@x.com'} }, res1);
  console.log('still exists after unauthorized attempt:', await getAccount('gone@x.com') !== null);
  const res2 = { status(c){ this.c=c; return this; }, json(b){ console.log('correct key:', this.c, JSON.stringify(b)); } };
  handler({ method:'POST', headers:{'x-admin-key':'test-secret'}, body:{email:'gone@x.com'} }, res2);
});
"
```
Expected: `no key: 401`, account still exists after that, then `correct key: 200 {"ok":true}`.

- [ ] **Step 4: Commit**

```bash
git add api/delete-account.js
git rm netlify/functions/delete-account.js
git commit -m "refactor: migrate delete-account.js to Vercel (api/delete-account.js)"
```

---

## Task 18: Move `_groq-client.js` and `_groq-client.selfcheck.js` to `api/`

**Files:**
- Create: `api/_groq-client.js`, `api/_groq-client.selfcheck.js`
- Delete: `netlify/functions/_groq-client.js`, `netlify/functions/_groq-client.selfcheck.js`

`_groq-client.js` is pure `fetch()`-based and has zero Netlify-specific code (confirmed in the spec's "Out of scope" section) — this task is a plain file move, no content changes.

- [ ] **Step 1: Move both files** (`git mv` preserves history):

```bash
git mv netlify/functions/_groq-client.js api/_groq-client.js
git mv netlify/functions/_groq-client.selfcheck.js api/_groq-client.selfcheck.js
```

- [ ] **Step 2: Run the self-check from its new location** (it `require`s `./_groq-client` relatively, so this must be run with `api/` as the working context):

Run: `node api/_groq-client.selfcheck.js`
Expected: `All _groq-client self-checks passed.`

- [ ] **Step 3: Commit**

```bash
git add api/_groq-client.js api/_groq-client.selfcheck.js
git commit -m "refactor: move _groq-client.js to api/ (no content changes needed)"
```

---

## Task 19: Create `middleware.js` for admin protection

**Files:**
- Create: `middleware.js` (project root)

- [ ] **Step 1: Write the file** with exactly this content:

```js
// Vercel Routing Middleware — the real, edge-enforced replacement for Netlify's
// netlify.toml Basic-Auth header config (which has no direct Vercel equivalent).
// Runs before admin-dashboard.html or the 2 admin API routes are served, so a
// leaked ADMIN_API_KEY (the app-level check inside list-accounts.js/delete-account.js)
// alone can no longer reach those paths -- this is a second, independent layer,
// not a replacement for that check.
module.exports = function middleware(request){
  const url = new URL(request.url);
  const protectedPaths = ['/admin-dashboard.html', '/api/list-accounts', '/api/delete-account'];
  if(!protectedPaths.includes(url.pathname)) return;

  const password = process.env.ADMIN_BASIC_AUTH_PASSWORD;
  const auth = request.headers.get('authorization');
  // Fail closed if the password isn't configured -- same principle as the
  // ADMIN_API_KEY check's `if(!adminKey || ...)` guard.
  const expected = password ? 'Basic ' + Buffer.from('forgeadmin:' + password).toString('base64') : null;
  if(!expected || auth !== expected){
    return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Admin"' } });
  }
};

module.exports.config = { matcher: ['/admin-dashboard.html', '/api/list-accounts', '/api/delete-account'] };
```

- [ ] **Step 2: Sanity-check the file parses**

Run: `node -e "require('./middleware.js'); console.log('middleware.js loads without error')"`
Expected: `middleware.js loads without error`

- [ ] **Step 3: Commit**

```bash
git add middleware.js
git commit -m "feat: add middleware.js for edge-enforced admin Basic-Auth"
```

Note: this can only be verified as actually enforcing 401s after a real Vercel deploy (Routing Middleware is a platform/edge feature `vercel dev` emulates but a plain unit test cannot) — covered in Task 22.

---

## Task 20: Update `index.html`'s fetch paths from `/.netlify/functions/` to `/api/`

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Find every occurrence and replace the path prefix**

Run: `grep -c "/.netlify/functions/" index.html` first to see the count, then replace every occurrence of the literal string `/.netlify/functions/` with `/api/` throughout the file (this covers the `sync-account` auto-sync hook, the `restore-account` onboarding call, and every AI feature's fetch call — `ask-doubt`, `generate-note`, `assignment-tip`, `strategy-tip`, `grade-answer`, `viva-turn`, `generate-quiz`, `grade-brainstorm`, `readiness-verdict`, `find-videos`). Function names after the prefix stay identical — only the prefix changes, e.g. `fetch('/.netlify/functions/ask-doubt', ...)` → `fetch('/api/ask-doubt', ...)`.

- [ ] **Step 2: Verify no occurrences remain**

Run: `grep -c "/.netlify/functions/" index.html`
Expected: `0`

Run: `grep -c "fetch('/api/" index.html`
Expected: a number matching the count from Step 1 (every replaced occurrence).

- [ ] **Step 3: Sanity-check the file still parses** (extract and check a representative script block, e.g. the forgeStore sync hook)

Run: `node -e "new Function(require('fs').readFileSync('index.html','utf8').match(/<script>\s*\(function\(\)\{[\s\S]*?window\.forgeStore = s;[\s\S]*?\}\)\(\);\s*<\/script>/)[0].replace(/<\/?script>/g,''))"`
Expected: no output, no error.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "refactor: point index.html's fetch calls at /api/ instead of /.netlify/functions/"
```

---

## Task 21: Update `admin-dashboard.html`'s fetch paths and Basic-Auth wiring

**Files:**
- Modify: `admin-dashboard.html`

- [ ] **Step 1: Replace the two fetch path prefixes**

Find and replace:
```js
    const resp = await fetch('/.netlify/functions/list-accounts', {
```
with:
```js
    const resp = await fetch('/api/list-accounts', {
```

And:
```js
    const resp = await fetch('/.netlify/functions/delete-account', {
```
with:
```js
    const resp = await fetch('/api/delete-account', {
```

- [ ] **Step 2: Update the `ADMIN_BASIC_AUTH` constant** to match the new middleware's expected credential format. Find:

```js
const ADMIN_BASIC_AUTH = 'Basic ' + btoa('forgeadmin:gpKbr6fTPiIbPzif');
```

Replace with (same value for now — this must match whatever `ADMIN_BASIC_AUTH_PASSWORD` gets set to in the real Vercel environment, which is a deploy-time step covered in Task 22, not something to hardcode differently here):

```js
const ADMIN_BASIC_AUTH = 'Basic ' + btoa('forgeadmin:gpKbr6fTPiIbPzif'); // must match ADMIN_BASIC_AUTH_PASSWORD set in the Vercel dashboard
```

- [ ] **Step 3: Verify no `/.netlify/functions/` references remain**

Run: `grep -c "/.netlify/functions/" admin-dashboard.html`
Expected: `0`

- [ ] **Step 4: Sanity-check the file still parses**

Run: `node -e "new Function(require('fs').readFileSync('admin-dashboard.html','utf8').match(/\/\* ---------- ACCOUNTS TAB[\s\S]*?<\/script>/)[0].replace('</script>',''))"`
Expected: no output, no error.

- [ ] **Step 5: Commit**

```bash
git add admin-dashboard.html
git commit -m "refactor: point admin-dashboard.html's fetch calls at /api/ instead of /.netlify/functions/"
```

---

## Task 22: Clean up Netlify-specific files, final verification

**Files:**
- Delete: `local-server.js`, `netlify.toml`, `netlify/` (now-empty directory tree)
- Modify: none (verification only otherwise)

- [ ] **Step 1: Confirm `netlify/functions/` only contains files already moved in Tasks 2-3 and 18** (the two `_`-helper files plus their selfchecks should already be in `api/` from Task 18; `_account-store.js`/`_rate-limit.js` and their selfchecks were rewritten in place in Tasks 2-3 but never moved to `api/` yet)

Run: `ls netlify/functions/`
Expected: only `_account-store.js`, `_account-store.selfcheck.js`, `_rate-limit.js`, `_rate-limit.selfcheck.js` remain (everything else was moved to `api/` in Tasks 4-18).

- [ ] **Step 2: Move the remaining 4 files to `api/`**

```bash
git mv netlify/functions/_account-store.js api/_account-store.js
git mv netlify/functions/_account-store.selfcheck.js api/_account-store.selfcheck.js
git mv netlify/functions/_rate-limit.js api/_rate-limit.js
git mv netlify/functions/_rate-limit.selfcheck.js api/_rate-limit.selfcheck.js
```

- [ ] **Step 3: Delete the now-empty `netlify/` tree, `netlify.toml`, and `local-server.js`**

```bash
git rm netlify.toml local-server.js
rm -rf netlify/
```

- [ ] **Step 4: Re-run every self-check from its new location**

Run: `node api/_groq-client.selfcheck.js && node api/_account-store.selfcheck.js && node api/_rate-limit.selfcheck.js`
Expected: all three print their "All ... self-checks passed." lines.

- [ ] **Step 5: Confirm all 14 route functions export a handler correctly from `api/`**

Run: `for f in ask-doubt generate-note assignment-tip strategy-tip grade-answer viva-turn generate-quiz grade-brainstorm readiness-verdict find-videos sync-account restore-account list-accounts delete-account; do node -e "console.log('$f:', typeof require('./api/$f.js'))"; done`
Expected: all fourteen print `<name>: function` (Vercel's `module.exports = async function handler(...)` means `require('./api/X.js')` itself is the function, unlike Netlify's `{ handler }` named export).

- [ ] **Step 6: Confirm no `/.netlify/functions/` references remain anywhere in the repo**

Run: `grep -rl "/.netlify/functions/" . --include="*.html" --include="*.js" 2>/dev/null | grep -v node_modules`
Expected: no output (empty).

- [ ] **Step 7: Link the project and pull env vars** (first real interaction with Vercel — requires the user to be logged in via `vercel login` first, which is an interactive step Claude cannot perform; if not already linked, stop here and report BLOCKED with instructions for the user to run `vercel login` then `vercel link` themselves before this step can complete)

```bash
vercel link
vercel env pull .env.local
```

- [ ] **Step 8: Set up the Upstash Redis integration** (also requires interactive dashboard/CLI auth the user must do — report BLOCKED with instructions if this can't be completed non-interactively)

```bash
vercel integration add upstash
```

This provisions `KV_REST_API_URL`/`KV_REST_API_TOKEN`-style env vars (exact names depend on Upstash's current Marketplace integration output — check `vercel env ls` after this step and adjust `Redis.fromEnv()`'s expected variable names in `_account-store.js`/`_rate-limit.js` if they differ from Upstash's defaults).

- [ ] **Step 9: Set `ADMIN_BASIC_AUTH_PASSWORD` and all other required env vars in the Vercel dashboard or via CLI**

```bash
vercel env add ADMIN_BASIC_AUTH_PASSWORD
vercel env add ADMIN_API_KEY
vercel env add GROQ_API_KEY
vercel env add GROQ_API_KEY_2
vercel env add GROQ_API_KEY_3
vercel env add YOUTUBE_API_KEY
```

(Values: reuse the same values already in `.env` for the Groq/YouTube/ADMIN_API_KEY vars; `ADMIN_BASIC_AUTH_PASSWORD` should be a **freshly rotated** value, not the `gpKbr6fTPiIbPzif` value already leaked to git history from the Netlify attempt.)

- [ ] **Step 10: Run `vercel dev` and do a real end-to-end smoke pass**

Run: `vercel dev` (in the background/separate terminal), then repeat the same manual QA pass already done for the Netlify version tonight: onboarding, Ask Forge, Courses/video finder, Quiz, Notes, Brainstorm, Viva Prep, Readiness, admin login + Basic-Auth 401 check (`curl -I http://localhost:3000/admin-dashboard.html` with no `Authorization` header should return `401`).

- [ ] **Step 11: Update project memory** — mark the Vercel migration done once Steps 1-6 (the fully automatable parts) are complete, and clearly note which of Steps 7-10 still need the user's direct action (Vercel login, Upstash integration, env var values, live smoke pass) — do not claim the migration is "done" if those remain outstanding.
