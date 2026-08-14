# Multi-key Groq Auto-Failover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Groq API call hits a rate-limit/quota error, automatically retry on `GROQ_API_KEY_2` then `GROQ_API_KEY_3` instead of failing the request, via one shared helper used by all 10 Groq-calling Netlify functions.

**Architecture:** New `netlify/functions/_groq-client.js` exports `callGroq(payload)` — loops over configured keys in fixed order (1→2→3), returns on first success or first non-rate-limit failure, only advances to the next key on a 429/rate-limit/quota response. Each of the 10 functions swaps its inline `fetch()` + key-presence-check for one `await callGroq(payload)` call, keeping all downstream logic (`resp.ok` handling, `data.usage` logging, response shaping) unchanged.

**Tech Stack:** Node.js (CommonJS, `require`/`module.exports`), Netlify Functions, native `fetch`, no test framework in this repo (plain `node script.js` verification).

**Spec:** `docs/superpowers/specs/2026-08-05-groq-multikey-failover-design.md` (Approved)

---

## Task 1: Create `_groq-client.js` + self-check

**Files:**
- Create: `netlify/functions/_groq-client.js`
- Create: `netlify/functions/_groq-client.selfcheck.js`

- [ ] **Step 1: Write `_groq-client.js`**

```js
// Shared Groq caller for all Netlify functions. Filename starts with `_` so
// Netlify's function router ignores it (no exports.handler here).
// Tries GROQ_API_KEY, then GROQ_API_KEY_2, then GROQ_API_KEY_3, in that fixed
// order, advancing to the next key ONLY on a rate-limit/quota-shaped failure —
// any other error (bad request, server error, network failure) returns immediately.

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

- [ ] **Step 2: Write the self-check script** (no test framework in this repo — a runnable `node` script mocking `global.fetch`, per the project's "one runnable check for non-trivial logic" convention)

```js
// Run: node netlify/functions/_groq-client.selfcheck.js
// Mocks global.fetch to verify callGroq's failover branching without hitting the real API.
const assert = require('assert');

function mockFetch(sequence){
  let i = 0;
  return async () => {
    const step = sequence[Math.min(i, sequence.length - 1)];
    i++;
    return { ok: step.ok, status: step.status, json: async () => step.body };
  };
}

async function run(){
  // 1. First key succeeds — no failover needed.
  {
    global.fetch = mockFetch([{ ok: true, status: 200, body: { choices: [{ message: { content: 'hi' } }] } }]);
    delete require.cache[require.resolve('./_groq-client')];
    const { callGroq } = require('./_groq-client');
    process.env.GROQ_API_KEY = 'k1'; process.env.GROQ_API_KEY_2 = 'k2'; process.env.GROQ_API_KEY_3 = 'k3';
    const result = await callGroq({ model: 'x' });
    assert.strictEqual(result.ok, true);
  }

  // 2. Key 1 rate-limited (429), key 2 succeeds — failover happens.
  {
    global.fetch = mockFetch([
      { ok: false, status: 429, body: { error: { message: 'rate limit exceeded' } } },
      { ok: true, status: 200, body: { choices: [{ message: { content: 'hi' } }] } }
    ]);
    delete require.cache[require.resolve('./_groq-client')];
    const { callGroq } = require('./_groq-client');
    const result = await callGroq({ model: 'x' });
    assert.strictEqual(result.ok, true);
  }

  // 3. Key 1 returns a real error (400) — must NOT try key 2, returns immediately.
  {
    let calls = 0;
    global.fetch = async () => { calls++; return { ok: false, status: 400, json: async () => ({ error: { message: 'bad request' } }) }; };
    delete require.cache[require.resolve('./_groq-client')];
    const { callGroq } = require('./_groq-client');
    const result = await callGroq({ model: 'x' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 400);
    assert.strictEqual(calls, 1, 'must not retry on a non-rate-limit error');
  }

  // 4. All 3 keys rate-limited — returns key 3's error, tried exactly 3 times.
  {
    let calls = 0;
    global.fetch = async () => { calls++; return { ok: false, status: 429, json: async () => ({ error: { message: 'rate limit' } }) }; };
    delete require.cache[require.resolve('./_groq-client')];
    const { callGroq } = require('./_groq-client');
    const result = await callGroq({ model: 'x' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(calls, 3);
  }

  // 5. No keys configured — clear error, no fetch call.
  {
    delete process.env.GROQ_API_KEY; delete process.env.GROQ_API_KEY_2; delete process.env.GROQ_API_KEY_3;
    let calls = 0;
    global.fetch = async () => { calls++; throw new Error('should not be called'); };
    delete require.cache[require.resolve('./_groq-client')];
    const { callGroq } = require('./_groq-client');
    const result = await callGroq({ model: 'x' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(calls, 0);
    assert.ok(/no groq api key/i.test(result.data.error.message));
  }

  console.log('All _groq-client self-checks passed.');
}

run().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Run the self-check**

Run: `node "netlify/functions/_groq-client.selfcheck.js"`
Expected: `All _groq-client self-checks passed.`

- [ ] **Step 4: Commit**

```bash
git add netlify/functions/_groq-client.js netlify/functions/_groq-client.selfcheck.js
git commit -m "feat: add shared multi-key Groq failover client"
```

---

## Task 2: Migrate `ask-doubt.js`

**Files:**
- Modify: `netlify/functions/ask-doubt.js:1-8` (add require), `:50-53` (remove key check), `:148-172` (swap fetch for callGroq)

- [ ] **Step 1: Add the require** — insert after the top comment block (after line 7, before `const MODEL_BY_TIER`):

```js
const { callGroq } = require('./_groq-client');
```

- [ ] **Step 2: Delete the key-presence check** (lines 50-53):

Before:
```js
  const apiKey = process.env.GROQ_API_KEY;
  if(!apiKey){
    return { statusCode: 500, body: JSON.stringify({ error: 'GROQ_API_KEY not configured on the server' }) };
  }

```
After: (deleted — `_groq-client.js` now owns the "no key" case)

- [ ] **Step 3: Replace the fetch block** (originally lines 148-172, shifts up ~4 lines after Step 2's deletion):

Before:
```js
  try{
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL_BY_TIER[tier],
        max_tokens: 900,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          ...cappedHistory,
          { role: 'user', content: attachment ? userContent : question }
        ]
      })
    });

    const data = await resp.json();

    if(!resp.ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: resp.status, body: JSON.stringify({ error: message }) };
    }
```

After:
```js
  try{
    const { ok, status, data } = await callGroq({
      model: MODEL_BY_TIER[tier],
      max_tokens: 900,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        ...cappedHistory,
        { role: 'user', content: attachment ? userContent : question }
      ]
    });

    if(!ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: status, body: JSON.stringify({ error: message }) };
    }
```

- [ ] **Step 4: Verify the rest of the function is untouched** — everything after this block (`if(data.usage) console.log(...)` and onward) references `data`, which is still in scope from the destructured `callGroq` result — no further edits needed there.

- [ ] **Step 5: Smoke-test with real key**

Run: `node -e "require('./netlify/functions/ask-doubt.js').handler({httpMethod:'POST', body: JSON.stringify({question:'what is a stack?', tier:'tier1', history:[]})}).then(r=>console.log(r.statusCode, r.body.slice(0,200)))"`
Expected: `statusCode` 200, body contains `"subject"` and `"explanation"`.

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/ask-doubt.js
git commit -m "refactor: ask-doubt.js uses shared multi-key Groq client"
```

---

## Task 3: Migrate `generate-note.js`

**Files:**
- Modify: `netlify/functions/generate-note.js:1-10` (add require), `:15-18` (remove key check), `:56-78` (swap fetch for callGroq)

- [ ] **Step 1: Add the require** — insert after line 4 (before `const MODEL_BY_TIER`):

```js
const { callGroq } = require('./_groq-client');
```

- [ ] **Step 2: Delete the key-presence check** (lines 15-18, same shape as Task 2 Step 2 — delete the 4-line `apiKey`/`if(!apiKey)` block).

- [ ] **Step 3: Replace the fetch block**

Before:
```js
  try{
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL_BY_TIER[tier],
        max_tokens: 700,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: topic }
        ]
      })
    });

    const data = await resp.json();

    if(!resp.ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: resp.status, body: JSON.stringify({ error: message }) };
    }
```

After:
```js
  try{
    const { ok, status, data } = await callGroq({
      model: MODEL_BY_TIER[tier],
      max_tokens: 700,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: topic }
      ]
    });

    if(!ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: status, body: JSON.stringify({ error: message }) };
    }
```

- [ ] **Step 4: Smoke-test with real key**

Run: `node -e "require('./netlify/functions/generate-note.js').handler({httpMethod:'POST', body: JSON.stringify({topic:'Binary Search Trees', tier:'tier1'})}).then(r=>console.log(r.statusCode, r.body.slice(0,200)))"`
Expected: `statusCode` 200, body contains `"title"`.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/generate-note.js
git commit -m "refactor: generate-note.js uses shared multi-key Groq client"
```

---

## Task 4: Migrate `strategy-tip.js`

**Files:**
- Modify: `netlify/functions/strategy-tip.js:1-10` (add require), `:13-16` (remove key check), `:96-118` (swap fetch for callGroq)

- [ ] **Step 1: Add the require** — insert after line 7 (before `exports.handler`):

```js
const { callGroq } = require('./_groq-client');
```

- [ ] **Step 2: Delete the key-presence check** (lines 13-16, same 4-line shape).

- [ ] **Step 3: Replace the fetch block**

Before:
```js
  try{
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: body.mode === 'studyplan' ? 900 : 350,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: body.mode === 'studyplan' ? 'Write up my study plan.' : body.mode === 'backlog' ? 'How do I cover this?' : 'What should I focus on this week?' }
        ]
      })
    });

    const data = await resp.json();

    if(!resp.ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: resp.status, body: JSON.stringify({ error: message }) };
    }
```

After:
```js
  try{
    const { ok, status, data } = await callGroq({
      model: 'llama-3.3-70b-versatile',
      max_tokens: body.mode === 'studyplan' ? 900 : 350,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: body.mode === 'studyplan' ? 'Write up my study plan.' : body.mode === 'backlog' ? 'How do I cover this?' : 'What should I focus on this week?' }
      ]
    });

    if(!ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: status, body: JSON.stringify({ error: message }) };
    }
```

- [ ] **Step 4: Smoke-test with real key**

Run: `node -e "require('./netlify/functions/strategy-tip.js').handler({httpMethod:'POST', body: JSON.stringify({mode:'weekly'})}).then(r=>console.log(r.statusCode, r.body.slice(0,200)))"`
Expected: `statusCode` 200.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/strategy-tip.js
git commit -m "refactor: strategy-tip.js uses shared multi-key Groq client"
```

---

## Task 5: Migrate `assignment-tip.js`

**Files:**
- Modify: `netlify/functions/assignment-tip.js:1-12` (add require, remove key check), `:43-65` (swap fetch for callGroq)

- [ ] **Step 1: Add the require** — insert after line 3 (before `exports.handler`):

```js
const { callGroq } = require('./_groq-client');
```

- [ ] **Step 2: Delete the key-presence check** (lines 10-12 in original numbering, same 4-line shape).

- [ ] **Step 3: Replace the fetch block**

Before:
```js
  try{
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 300,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'What should I prioritize?' }
        ]
      })
    });

    const data = await resp.json();

    if(!resp.ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: resp.status, body: JSON.stringify({ error: message }) };
    }
```

After:
```js
  try{
    const { ok, status, data } = await callGroq({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 300,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'What should I prioritize?' }
      ]
    });

    if(!ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: status, body: JSON.stringify({ error: message }) };
    }
```

- [ ] **Step 4: Smoke-test with real key**

Run: `node -e "require('./netlify/functions/assignment-tip.js').handler({httpMethod:'POST', body: JSON.stringify({assignments:[{name:'Lab 3', due:'2026-08-10'}]})}).then(r=>console.log(r.statusCode, r.body.slice(0,200)))"`
Expected: `statusCode` 200.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/assignment-tip.js
git commit -m "refactor: assignment-tip.js uses shared multi-key Groq client"
```

---

## Task 6: Migrate `grade-answer.js`

**Files:**
- Modify: `netlify/functions/grade-answer.js:1-19` (add require, remove key check), `:51-73` (swap fetch for callGroq)

- [ ] **Step 1: Add the require** — insert after line 5 (before `const MODEL_BY_TIER`):

```js
const { callGroq } = require('./_groq-client');
```

- [ ] **Step 2: Delete the key-presence check** (lines 17-19 in original numbering, same 4-line shape).

- [ ] **Step 3: Replace the fetch block**

Before:
```js
  try{
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL_BY_TIER.tier1,
        max_tokens: 350,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Question: ${question}\n\nStudent's answer: ${answer}` }
        ]
      })
    });

    const data = await resp.json();

    if(!resp.ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: resp.status, body: JSON.stringify({ error: message }) };
    }
```

After:
```js
  try{
    const { ok, status, data } = await callGroq({
      model: MODEL_BY_TIER.tier1,
      max_tokens: 350,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Question: ${question}\n\nStudent's answer: ${answer}` }
      ]
    });

    if(!ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: status, body: JSON.stringify({ error: message }) };
    }
```

- [ ] **Step 4: Smoke-test with real key**

Run: `node -e "require('./netlify/functions/grade-answer.js').handler({httpMethod:'POST', body: JSON.stringify({subject:'DSA', question:'What is a stack?', answer:'LIFO data structure'})}).then(r=>console.log(r.statusCode, r.body.slice(0,200)))"`
Expected: `statusCode` 200.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/grade-answer.js
git commit -m "refactor: grade-answer.js uses shared multi-key Groq client"
```

---

## Task 7: Migrate `viva-turn.js`

**Files:**
- Modify: `netlify/functions/viva-turn.js:1-10` (add require, remove key check), `:60-82` (swap fetch for callGroq)

- [ ] **Step 1: Add the require** — insert after line 6 (before `const MODEL_BY_TIER`):

```js
const { callGroq } = require('./_groq-client');
```

- [ ] **Step 2: Delete the key-presence check** (lines 17-19 in original numbering, same 4-line shape).

- [ ] **Step 3: Replace the fetch block**

Before:
```js
  try{
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL_BY_TIER.tier1,
        max_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          ...(isOpening ? [{ role: 'user', content: 'Begin the viva.' }] : cappedHistory)
        ]
      })
    });

    const data = await resp.json();

    if(!resp.ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: resp.status, body: JSON.stringify({ error: message }) };
    }
```

After:
```js
  try{
    const { ok, status, data } = await callGroq({
      model: MODEL_BY_TIER.tier1,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        ...(isOpening ? [{ role: 'user', content: 'Begin the viva.' }] : cappedHistory)
      ]
    });

    if(!ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: status, body: JSON.stringify({ error: message }) };
    }
```

- [ ] **Step 4: Smoke-test with real key**

Run: `node -e "require('./netlify/functions/viva-turn.js').handler({httpMethod:'POST', body: JSON.stringify({subject:'DSA', history:[]})}).then(r=>console.log(r.statusCode, r.body.slice(0,200)))"`
Expected: `statusCode` 200.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/viva-turn.js
git commit -m "refactor: viva-turn.js uses shared multi-key Groq client"
```

---

## Task 8: Migrate `generate-quiz.js`

**Files:**
- Modify: `netlify/functions/generate-quiz.js:1-10` (add require, remove key check), `:58-80` (swap fetch for callGroq)

- [ ] **Step 1: Add the require** — insert after line 8 (before `exports.handler`):

```js
const { callGroq } = require('./_groq-client');
```

- [ ] **Step 2: Delete the key-presence check** (lines 15-17 in original numbering, same 4-line shape).

- [ ] **Step 3: Replace the fetch block**

Before:
```js
  try{
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1600,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Generate the ${count} ${type} questions.` }
        ]
      })
    });

    const data = await resp.json();

    if(!resp.ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: resp.status, body: JSON.stringify({ error: message }) };
    }
```

After:
```js
  try{
    const { ok, status, data } = await callGroq({
      model: MODEL,
      max_tokens: 1600,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Generate the ${count} ${type} questions.` }
      ]
    });

    if(!ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: status, body: JSON.stringify({ error: message }) };
    }
```

- [ ] **Step 4: Smoke-test with real key**

Run: `node -e "require('./netlify/functions/generate-quiz.js').handler({httpMethod:'POST', body: JSON.stringify({subject:'DSA', chapters:['Trees'], type:'mcq', count:2})}).then(r=>console.log(r.statusCode, r.body.slice(0,200)))"`
Expected: `statusCode` 200.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/generate-quiz.js
git commit -m "refactor: generate-quiz.js uses shared multi-key Groq client"
```

---

## Task 9: Migrate `grade-brainstorm.js`

**Files:**
- Modify: `netlify/functions/grade-brainstorm.js:1-14` (add require, remove key check), `:50-72` (swap fetch for callGroq)

- [ ] **Step 1: Add the require** — insert after line 6 (before `exports.handler`):

```js
const { callGroq } = require('./_groq-client');
```

- [ ] **Step 2: Delete the key-presence check** (lines 12-14 in original numbering, same 4-line shape).

- [ ] **Step 3: Replace the fetch block**

Before:
```js
  try{
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Grade my brainstorm.' }
        ]
      })
    });

    const data = await resp.json();

    if(!resp.ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: resp.status, body: JSON.stringify({ error: message }) };
    }
```

After:
```js
  try{
    const { ok, status, data } = await callGroq({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Grade my brainstorm.' }
      ]
    });

    if(!ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: status, body: JSON.stringify({ error: message }) };
    }
```

- [ ] **Step 4: Smoke-test with real key**

Run: `node -e "require('./netlify/functions/grade-brainstorm.js').handler({httpMethod:'POST', body: JSON.stringify({topic:'DBMS', prompt:'Name normalization forms', ideas:['1NF','2NF']})}).then(r=>console.log(r.statusCode, r.body.slice(0,200)))"`
Expected: `statusCode` 200.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/grade-brainstorm.js
git commit -m "refactor: grade-brainstorm.js uses shared multi-key Groq client"
```

---

## Task 10: Migrate `readiness-verdict.js`

**Files:**
- Modify: `netlify/functions/readiness-verdict.js:1-16` (add require, remove key check), `:60-82` (swap fetch for callGroq)

- [ ] **Step 1: Add the require** — insert after line 7 (before `exports.handler`):

```js
const { callGroq } = require('./_groq-client');
```

- [ ] **Step 2: Delete the key-presence check** (lines 14-16 in original numbering, same 4-line shape).

- [ ] **Step 3: Replace the fetch block**

Before:
```js
  try{
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 350,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Am I ready?' }
        ]
      })
    });

    const data = await resp.json();

    if(!resp.ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: resp.status, body: JSON.stringify({ error: message }) };
    }
```

After:
```js
  try{
    const { ok, status, data } = await callGroq({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 350,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Am I ready?' }
      ]
    });

    if(!ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: status, body: JSON.stringify({ error: message }) };
    }
```

- [ ] **Step 4: Smoke-test with real key**

Run: `node -e "require('./netlify/functions/readiness-verdict.js').handler({httpMethod:'POST', body: JSON.stringify({subject:'DSA', dataReadiness:{overall:60,topicCoverage:50,weakTopic:'Trees',mockScores:70,recency:80}, diagnostic:{correct:3,total:5,missedChapters:['Trees']}})}).then(r=>console.log(r.statusCode, r.body.slice(0,200)))"`
Expected: `statusCode` 200.

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/readiness-verdict.js
git commit -m "refactor: readiness-verdict.js uses shared multi-key Groq client"
```

---

## Task 11: Migrate `find-videos.js` (special case — soft-fail, not the uniform pattern)

`find-videos.js` differs from the other 9: it wraps its Groq call in a `try/catch` that swallows *any* failure and falls back to a default search query (`${chapter} ${subject} explained`) rather than returning an error — the feature must keep working with a slightly worse query even if Groq is fully down. It also has no `resp.ok` check today (it reads `phraseData.choices` optimistically). Migrating it to `callGroq` should preserve that soft-fail behavior exactly, while gaining the multi-key retry underneath.

**Files:**
- Modify: `netlify/functions/find-videos.js:8-38` (require, key checks, fetch block)

- [ ] **Step 1: Add the require** — insert after line 6 (before `exports.handler`):

```js
const { callGroq } = require('./_groq-client');
```

- [ ] **Step 2: Update the key-presence check** (lines 13-17) — `_groq-client.js` now owns the Groq key, so this function only needs to guard on `ytKey`:

Before:
```js
  const groqKey = process.env.GROQ_API_KEY;
  const ytKey = process.env.YOUTUBE_API_KEY;
  if(!groqKey || !ytKey){
    return { statusCode: 500, body: JSON.stringify({ videos: [], bestVideoId: null, error: 'API key not configured on the server' }) };
  }
```

After:
```js
  const ytKey = process.env.YOUTUBE_API_KEY;
  if(!ytKey){
    return { statusCode: 500, body: JSON.stringify({ videos: [], bestVideoId: null, error: 'YOUTUBE_API_KEY not configured on the server' }) };
  }
```

- [ ] **Step 3: Replace the Groq fetch block** (lines 35-52 in original numbering)

Before:
```js
  let query = `${chapter} ${subject} explained`;
  let groqUsage = null;
  try{
    const phraseResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'authorization': `Bearer ${groqKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 30,
        messages: [
          { role: 'system', content: 'You write short, effective YouTube search queries for B.Tech Computer Engineering study topics. Respond with ONLY the search query text, nothing else — no quotes, no punctuation, no explanation.' },
          { role: 'user', content: `Topic: "${chapter}" from the subject "${subject}". Write one good YouTube search query for a student who wants to learn this from scratch.` }
        ]
      })
    });
    const phraseData = await phraseResp.json();
    if(phraseData.usage){ console.log('[find-videos] groq tokens:', phraseData.usage); groqUsage = phraseData.usage; }
    const text = phraseData.choices && phraseData.choices[0] && phraseData.choices[0].message && phraseData.choices[0].message.content;
    if(text && text.trim()) query = text.trim();
  } catch(e){ /* keep the fallback query built above */ }
```

After:
```js
  let query = `${chapter} ${subject} explained`;
  let groqUsage = null;
  try{
    const { ok, data: phraseData } = await callGroq({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 30,
      messages: [
        { role: 'system', content: 'You write short, effective YouTube search queries for B.Tech Computer Engineering study topics. Respond with ONLY the search query text, nothing else — no quotes, no punctuation, no explanation.' },
        { role: 'user', content: `Topic: "${chapter}" from the subject "${subject}". Write one good YouTube search query for a student who wants to learn this from scratch.` }
      ]
    });
    if(ok){
      if(phraseData.usage){ console.log('[find-videos] groq tokens:', phraseData.usage); groqUsage = phraseData.usage; }
      const text = phraseData.choices && phraseData.choices[0] && phraseData.choices[0].message && phraseData.choices[0].message.content;
      if(text && text.trim()) query = text.trim();
    }
  } catch(e){ /* keep the fallback query built above */ }
```

- [ ] **Step 4: Smoke-test with real keys** (requires `YOUTUBE_API_KEY` in `.env` — skip if not present and note it in the task result)

Run: `node -e "require('dotenv').config(); require('./netlify/functions/find-videos.js').handler({httpMethod:'POST', body: JSON.stringify({subject:'DSA', chapter:'Binary Search Trees'})}).then(r=>console.log(r.statusCode, r.body.slice(0,200)))"`
Expected: `statusCode` 200, body contains `"videos"`.
(If `dotenv` isn't installed, run via `netlify dev` instead and POST to the local endpoint, since Netlify's local server loads `.env` automatically.)

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/find-videos.js
git commit -m "refactor: find-videos.js uses shared multi-key Groq client"
```

---

## Task 12: Final verification — force real failover end-to-end

**Files:** none (verification only, no code changes)

- [ ] **Step 1: Verify all 10 functions now require `_groq-client`**

Run: `grep -l "require('./_groq-client')" netlify/functions/*.js | wc -l`
Expected: `10`

- [ ] **Step 2: Verify no function still reads `process.env.GROQ_API_KEY` directly**

Run: `grep -l "process.env.GROQ_API_KEY" netlify/functions/*.js`
Expected: only `_groq-client.js` and `_groq-client.selfcheck.js` (via mocked env vars) — no `ask-doubt.js`/`generate-note.js`/etc. in the output.

- [ ] **Step 3: Simulate GROQ_API_KEY being rate-limited by temporarily blanking it**, confirm a real request still succeeds via key 2:

Run: `node -e "process.env.GROQ_API_KEY='gsk_invalid_deliberately_bad_key'; require('./netlify/functions/generate-note.js').handler({httpMethod:'POST', body: JSON.stringify({topic:'Stacks', tier:'tier1'})}).then(r=>console.log(r.statusCode))"`

Note: this only proves failover on an *invalid-key* auth error if Groq returns 401 (not rate-limit-shaped) — that's expected to fail fast on key 1 per the design (real error ≠ rate limit). This step is a sanity check that the code path runs end-to-end without throwing; genuine 429 failover can only be verified by observation next time a key is actually rate-limited (already covered by the self-check's mocked-fetch tests in Task 1).

Expected: no uncaught exception; a `statusCode` printed (401 is fine and correct — confirms real errors don't get masked).

- [ ] **Step 4: Run the self-check one more time** to confirm nothing broke during the 10 migrations:

Run: `node "netlify/functions/_groq-client.selfcheck.js"`
Expected: `All _groq-client self-checks passed.`

- [ ] **Step 5: Update project memory** — mark item 5 (multi-key auto-failover) in `pending_features_2026-08-04.md` as done, same way item youtube-course-chat was marked done inline in that file.
