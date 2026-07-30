# Ask Forge Chat: Persistence, Memory, Attachments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "Ask Forge" chat persist across reloads, remember recent conversation context for follow-up questions, show timestamps, and support attaching a reference-only file to a message.

**Architecture:** Everything lives in `index.html`'s existing inline `<script>` (this app has no build step, no modules, no test framework — one big HTML file per page, mirrored between `index.html` and `student-dashboard.html`). New localStorage key `forge-chat-messages` holds the full conversation. Attachment file bytes never touch localStorage — only an in-memory `Map` for the current tab. `netlify/functions/ask-doubt.js` gains a `history` parameter it folds into the OpenRouter request.

**Tech Stack:** Vanilla JS, localStorage, Netlify Functions, OpenRouter API (`x-ai/grok-4.3` / `x-ai/grok-4.5`).

**Process note (deviation from the standard template):** This project has no test runner (no `package.json`, no jest/pytest) and is **not a git repository** (confirmed: `git status` fails, no `.git`). So steps below use **manual verification** (curl against the running `netlify dev` server, or a documented browser check) instead of automated test-first steps, and there are **no commit steps** — each task's changes are just saved directly to the files. If you want git history for this work, `git init` first; not assumed here.

Reference spec: `docs/superpowers/specs/2026-07-30-ai-chat-memory-design.md`

---

### Task 1: Chat persistence + attachment + formatting helpers

**Files:**
- Modify: `index.html:3019` (right after the existing `lsGet`/`lsSet` helpers)

- [ ] **Step 1: Add the new helper functions**

Find this exact block (the generic localStorage helpers):

```js
function lsGet(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch(e){ return fallback; }
}
function lsSet(key, value){ localStorage.setItem(key, JSON.stringify(value)); }
```

Insert immediately after it:

```js
/* ---------- ASK FORGE CHAT: persistence + attachment helpers ---------- */
function getChatMessages(){ return lsGet('forge-chat-messages', []); }
function saveChatMessages(list){ lsSet('forge-chat-messages', list); }

const chatAttachmentBlobs = new Map(); // messageId -> File, session-only, never persisted

function formatMsgTime(iso){
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })
    : d.toLocaleDateString('en-US', { month:'short', day:'numeric' });
}

function formatFileSize(bytes){
  if(bytes < 1024) return bytes + ' B';
  if(bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/(1024*1024)).toFixed(1) + ' MB';
}
```

- [ ] **Step 2: Verify no syntax errors**

Run: `node --check "index.html"` will fail (it's HTML, not JS) — instead extract-check isn't practical here. Just open the file and confirm the block was inserted once, correctly, with no duplicate `lsSet` definitions. This gets fully verified in Task 10's browser check.

---

### Task 2: CSS for attach button, chips, and timestamps

**Files:**
- Modify: `index.html:1332-1334`

- [ ] **Step 1: Add new CSS rules**

Find this exact block:

```css
  .chat-send-btn:hover{ transform:translateY(-2px); }
  .chat-send-btn svg{ width:18px; height:18px; }
  .chat-hint{ font-size:11.5px; color:var(--ink-soft); margin-top:8px; text-align:center; }
```

Replace with:

```css
  .chat-send-btn:hover{ transform:translateY(-2px); }
  .chat-send-btn svg{ width:18px; height:18px; }
  .chat-send-btn.attach-btn{ background:var(--cream-2); color:var(--ink); border:1px solid rgba(36,31,24,0.12); }
  .chat-hint{ font-size:11.5px; color:var(--ink-soft); margin-top:8px; text-align:center; }
  .pending-attach-chip{
    display:flex; align-items:center; gap:8px; padding:8px 12px; margin-top:10px;
    background:var(--cream-2); border-radius:12px; font-size:12.5px; color:var(--ink);
  }
  .pending-attach-chip button{
    background:none; border:none; cursor:pointer; color:var(--ink-soft); font-size:13px; margin-left:auto;
  }
  .msg-user-col, .msg-ai-col{ display:flex; flex-direction:column; gap:4px; }
  .msg-user-col{ align-items:flex-end; }
  .msg-ai-col{ align-items:flex-start; }
  .msg-attachment-chip{
    display:flex; align-items:center; gap:6px; padding:6px 10px;
    background:rgba(0,0,0,0.06); border-radius:10px; font-size:12px;
  }
  .msg-attachment-chip.unavailable{ opacity:.6; font-style:italic; }
  .msg-time{ font-size:10.5px; color:var(--ink-soft); }
```

- [ ] **Step 2: Verify** — visual confirmation happens in Task 10. No standalone check for CSS-only changes.

---

### Task 3: HTML — attach button, hidden file input, pending-attachment chip

**Files:**
- Modify: `index.html:2600-2609`

- [ ] **Step 1: Replace the chat-input-row block**

Find this exact block:

```html
      <div class="chat-input-row" id="chatInputRow">
        <div class="jsfx-input-wrap">
          <svg class="jsfx-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="22" y1="22" x2="16.65" y2="16.65"/></svg>
          <textarea id="chatInput" rows="1" placeholder="Ask a doubt about any of your subjects…"></textarea>
        </div>
        <button class="chat-send-btn" id="chatSendBtn" title="Send">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg>
        </button>
      </div>
      <div class="chat-hint">Simulated demo · answers grounded in curated content only, not a general chatbot</div>
```

Replace with:

```html
      <div class="pending-attach-chip" id="pendingAttachChip" style="display:none;">
        <span id="pendingAttachName"></span>
        <button type="button" id="pendingAttachRemove" title="Remove attachment">✕</button>
      </div>
      <div class="chat-input-row" id="chatInputRow">
        <input type="file" id="chatFileInput" style="display:none;">
        <button class="chat-send-btn attach-btn" id="chatAttachBtn" title="Attach a file" type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <div class="jsfx-input-wrap">
          <svg class="jsfx-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="22" y1="22" x2="16.65" y2="16.65"/></svg>
          <textarea id="chatInput" rows="1" placeholder="Ask a doubt about any of your subjects…"></textarea>
        </div>
        <button class="chat-send-btn" id="chatSendBtn" title="Send">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg>
        </button>
      </div>
      <div class="chat-hint">Simulated demo · answers grounded in curated content only, not a general chatbot</div>
```

- [ ] **Step 2: Verify** — visual confirmation happens in Task 10.

---

### Task 4: Rewire message rendering for timestamps + attachment chips

**Files:**
- Modify: `index.html:3522-3581` (`appendUserMessage`, `appendThinking`, `renderAIMessage`)

- [ ] **Step 1: Replace `appendUserMessage`**

Find:

```js
function appendUserMessage(text){
  const win = document.getElementById('chatWindow');
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `<div class="bubble-user"></div>`;
  el.querySelector('.bubble-user').textContent = text;
  win.appendChild(el);
  win.scrollTop = win.scrollHeight;
}
```

Replace with:

```js
function attachmentChipHtml(attachment, available){
  if(!attachment) return '';
  const label = available
    ? `📎 ${attachment.name} (${formatFileSize(attachment.size)})`
    : `📎 ${attachment.name} — no longer available`;
  return `<div class="msg-attachment-chip${available ? '' : ' unavailable'}">${label}</div>`;
}

function appendUserMessage(text, attachment, timestamp, available){
  if(available === undefined) available = true;
  const win = document.getElementById('chatWindow');
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `
    <div class="msg-user-col">
      <div class="bubble-user"></div>
      ${attachmentChipHtml(attachment, available)}
      <div class="msg-time">${formatMsgTime(timestamp)}</div>
    </div>`;
  el.querySelector('.bubble-user').textContent = text;
  win.appendChild(el);
  win.scrollTop = win.scrollHeight;
}
```

- [ ] **Step 2: Replace `appendThinking`**

Find:

```js
function appendThinking(tier){
  const win = document.getElementById('chatWindow');
  const el = document.createElement('div');
  el.className = 'msg ai';
  el.id = 'thinkingMsg';
  el.innerHTML = `
    <div class="ai-card">
      <div class="ai-card-head">
        <span class="who">Forge</span>
        <span class="tier-badge ${tier==='tier2'?'t2':'t1'}">${tier==='tier2'?'Tier 2 · Deep':'Tier 1 · Fast'}</span>
      </div>
      <div class="thinking-dots"><span></span><span></span><span></span></div>
    </div>`;
  win.appendChild(el);
  win.scrollTop = win.scrollHeight;
  return el;
}
```

Replace with:

```js
function appendThinking(tier){
  const win = document.getElementById('chatWindow');
  const el = document.createElement('div');
  el.className = 'msg ai';
  el.id = 'thinkingMsg';
  el.innerHTML = `
    <div class="msg-ai-col">
      <div class="ai-card">
        <div class="ai-card-head">
          <span class="who">Forge</span>
          <span class="tier-badge ${tier==='tier2'?'t2':'t1'}">${tier==='tier2'?'Tier 2 · Deep':'Tier 1 · Fast'}</span>
        </div>
        <div class="thinking-dots"><span></span><span></span><span></span></div>
      </div>
    </div>`;
  win.appendChild(el);
  win.scrollTop = win.scrollHeight;
  return el;
}
```

- [ ] **Step 3: Replace `renderAIMessage`**

Find:

```js
function renderAIMessage(el, tier, entry, apiFailed, question){
  const badge = tier==='tier2' ? '<span class="tier-badge t2">Tier 2 · Deep</span>' : '<span class="tier-badge t1">Tier 1 · Fast</span>';
  const errorBox = apiFailed ? errorFaceBox(entry ? 'Showing offline content instead.' : 'And no offline match for this either.') : '';
  if(entry){
    el.querySelector('.ai-card').innerHTML = `
      <div class="ai-card-head"><span class="who">Forge</span>${badge}</div>
      ${errorBox}
      <div class="ai-block"><span class="k">Explanation</span><div class="v">${entry.explanation}</div></div>
      <div class="ai-block"><span class="k">Key Concept</span><div class="v">${entry.keyConcept}</div></div>
      <div class="ai-block"><span class="k">Example</span><div class="v">${entry.example}</div></div>
      <div class="notes-card-actions">
        <button class="note-action-btn btn-pop" data-action="save-chat-note">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>
          Save as Note
        </button>
      </div>`;
    const saveBtn = el.querySelector('[data-action="save-chat-note"]');
    saveBtn.addEventListener('click', ()=>{
      saveNoteToLibrary(chatEntryToNote(question || 'Chat answer', entry));
      saveBtn.disabled = true;
      saveBtn.innerHTML = saveBtn.innerHTML.replace('Save as Note','Saved');
      showToast('Saved to My Notes');
    });
  } else {
    el.querySelector('.ai-card').innerHTML = `
      <div class="ai-card-head"><span class="who">Forge</span>${badge}</div>
      ${errorBox}
      <div class="ai-fallback">I don't have reviewer-verified content covering that yet, so I won't guess. Try asking about stacks, queues, linked lists, or binary search trees — or check back once your instructor's material is added.</div>`;
  }
  const win = document.getElementById('chatWindow');
  win.scrollTop = win.scrollHeight;
}
```

Replace with (only the function signature and the timestamp-append block at the end are new; the `entry`/`else` branches are untouched):

```js
function renderAIMessage(el, tier, entry, apiFailed, question, timestamp){
  const badge = tier==='tier2' ? '<span class="tier-badge t2">Tier 2 · Deep</span>' : '<span class="tier-badge t1">Tier 1 · Fast</span>';
  const errorBox = apiFailed ? errorFaceBox(entry ? 'Showing offline content instead.' : 'And no offline match for this either.') : '';
  if(entry){
    el.querySelector('.ai-card').innerHTML = `
      <div class="ai-card-head"><span class="who">Forge</span>${badge}</div>
      ${errorBox}
      <div class="ai-block"><span class="k">Explanation</span><div class="v">${entry.explanation}</div></div>
      <div class="ai-block"><span class="k">Key Concept</span><div class="v">${entry.keyConcept}</div></div>
      <div class="ai-block"><span class="k">Example</span><div class="v">${entry.example}</div></div>
      <div class="notes-card-actions">
        <button class="note-action-btn btn-pop" data-action="save-chat-note">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>
          Save as Note
        </button>
      </div>`;
    const saveBtn = el.querySelector('[data-action="save-chat-note"]');
    saveBtn.addEventListener('click', ()=>{
      saveNoteToLibrary(chatEntryToNote(question || 'Chat answer', entry));
      saveBtn.disabled = true;
      saveBtn.innerHTML = saveBtn.innerHTML.replace('Save as Note','Saved');
      showToast('Saved to My Notes');
    });
  } else {
    el.querySelector('.ai-card').innerHTML = `
      <div class="ai-card-head"><span class="who">Forge</span>${badge}</div>
      ${errorBox}
      <div class="ai-fallback">I don't have reviewer-verified content covering that yet, so I won't guess. Try asking about stacks, queues, linked lists, or binary search trees — or check back once your instructor's material is added.</div>`;
  }
  if(!el.querySelector('.msg-time')){
    const t = document.createElement('div');
    t.className = 'msg-time';
    t.textContent = formatMsgTime(timestamp);
    el.querySelector('.msg-ai-col').appendChild(t);
  }
  const win = document.getElementById('chatWindow');
  win.scrollTop = win.scrollHeight;
}
```

- [ ] **Step 4: Verify** — visual/behavioral confirmation happens in Task 10 (these functions are exercised by `sendDoubt`, updated in Task 7).

---

### Task 5: Restore chat from storage on page load

**Files:**
- Modify: `index.html` — add after the `logDoubtHistory` function (currently at line 3583-3587, right before `async function sendDoubt(){`)

- [ ] **Step 1: Add restore functions**

Find:

```js
function logDoubtHistory(question, subject){
  const history = JSON.parse(localStorage.getItem('forge-doubt-history') || '[]');
  history.push({ question, subject: subject || null, date: new Date().toISOString().slice(0,10) });
  localStorage.setItem('forge-doubt-history', JSON.stringify(history));
}

async function sendDoubt(){
```

Replace with:

```js
function logDoubtHistory(question, subject){
  const history = JSON.parse(localStorage.getItem('forge-doubt-history') || '[]');
  history.push({ question, subject: subject || null, date: new Date().toISOString().slice(0,10) });
  localStorage.setItem('forge-doubt-history', JSON.stringify(history));
}

function renderStoredMessage(msg){
  if(msg.role === 'user'){
    appendUserMessage(msg.text, msg.attachment, msg.timestamp, false);
  } else {
    const tier = (msg.aiData && msg.aiData.tier) || 'tier1';
    const entry = (msg.aiData && msg.aiData.explanation) ? msg.aiData : null;
    const apiFailed = !!(msg.aiData && msg.aiData.apiFailed);
    const el = appendThinking(tier);
    el.removeAttribute('id');
    renderAIMessage(el, tier, entry, apiFailed, msg.text, msg.timestamp);
  }
}

function restoreChatFromStorage(){
  const messages = getChatMessages();
  if(!messages.length) return;
  const win = document.getElementById('chatWindow');
  win.innerHTML = '';
  messages.forEach(renderStoredMessage);
}

async function sendDoubt(){
```

- [ ] **Step 2: Call the restore function once, at chat setup time**

Find (near the bottom of the chat script section):

```js
document.getElementById('chatSendBtn').addEventListener('click', sendDoubt);
document.getElementById('chatInput').addEventListener('keydown', (e)=>{
  if(e.key === 'Enter' && !e.shiftKey){
    e.preventDefault();
    sendDoubt();
  }
});
document.getElementById('chatInput').addEventListener('input', (e)=>{
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 100) + 'px';
});
```

Replace with (adds one line at the end):

```js
document.getElementById('chatSendBtn').addEventListener('click', sendDoubt);
document.getElementById('chatInput').addEventListener('keydown', (e)=>{
  if(e.key === 'Enter' && !e.shiftKey){
    e.preventDefault();
    sendDoubt();
  }
});
document.getElementById('chatInput').addEventListener('input', (e)=>{
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 100) + 'px';
});
restoreChatFromStorage();
```

- [ ] **Step 3: Verify** — full end-to-end check happens in Task 10 (reload test).

---

### Task 6: Wire the attach button

**Files:**
- Modify: `index.html` — add right after the `restoreChatFromStorage();` call added in Task 5, Step 2

- [ ] **Step 1: Add pending-attachment state and event handlers**

Add this new block immediately after `restoreChatFromStorage();`:

```js
let pendingAttachment = null; // File, cleared after each send

document.getElementById('chatAttachBtn').addEventListener('click', ()=>{
  document.getElementById('chatFileInput').click();
});
document.getElementById('chatFileInput').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  pendingAttachment = file;
  document.getElementById('pendingAttachName').textContent = `📎 ${file.name} (${formatFileSize(file.size)})`;
  document.getElementById('pendingAttachChip').style.display = 'flex';
  e.target.value = '';
});
document.getElementById('pendingAttachRemove').addEventListener('click', ()=>{
  pendingAttachment = null;
  document.getElementById('pendingAttachChip').style.display = 'none';
});
```

- [ ] **Step 2: Verify** — behavioral check happens in Task 10 (attach a file, confirm chip appears, confirm ✕ clears it).

---

### Task 7: Rewrite `sendDoubt` — persistence, history, attachment

**Files:**
- Modify: `index.html:3589-3624` (the `sendDoubt` function)

- [ ] **Step 1: Replace `sendDoubt`**

Find the current function:

```js
async function sendDoubt(){
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if(!text) return;
  appendUserMessage(text);
  input.value = '';
  input.style.height = 'auto';

  const tier = classifyTier(text);
  const thinkingEl = appendThinking(tier);

  bumpStat('doubts', 1);
  renderActivityStats();

  let entry = null;
  let apiFailed = false;
  try{
    const resp = await fetch('/.netlify/functions/ask-doubt', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body: JSON.stringify({ question:text, tier })
    });
    if(resp.ok){
      const data = await resp.json();
      if(data && data.explanation) entry = data;
    } else {
      apiFailed = true;
    }
  } catch(e){ apiFailed = true; /* offline, or no Netlify function server (e.g. opened via file://) */ }

  if(!entry) entry = findAnswer(text);
  if(entry) logDoubtHistory(text, entry.subject);

  thinkingEl.removeAttribute('id');
  renderAIMessage(thinkingEl, tier, entry, apiFailed, text);
}
```

Replace with:

```js
function buildHistoryForRequest(){
  const messages = getChatMessages();
  const recent = messages.slice(-6); // last 3 exchanges = 6 messages
  return recent.map(m => {
    let content = m.text;
    if(m.attachment) content += ` [attached: ${m.attachment.name}]`;
    return { role: m.role === 'ai' ? 'assistant' : 'user', content };
  });
}

async function sendDoubt(){
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if(!text) return;

  const history = buildHistoryForRequest();

  const userId = 'm_' + Date.now() + '_u';
  const userTimestamp = new Date().toISOString();
  const attachmentMeta = pendingAttachment
    ? { name: pendingAttachment.name, size: pendingAttachment.size, type: pendingAttachment.type }
    : null;
  if(pendingAttachment) chatAttachmentBlobs.set(userId, pendingAttachment);

  appendUserMessage(text, attachmentMeta, userTimestamp);
  input.value = '';
  input.style.height = 'auto';
  pendingAttachment = null;
  document.getElementById('pendingAttachChip').style.display = 'none';

  const afterUserMessages = getChatMessages();
  afterUserMessages.push({ id: userId, role: 'user', text, timestamp: userTimestamp, attachment: attachmentMeta, aiData: null });
  saveChatMessages(afterUserMessages);

  const tier = classifyTier(text);
  const thinkingEl = appendThinking(tier);

  bumpStat('doubts', 1);
  renderActivityStats();

  let entry = null;
  let apiFailed = false;
  try{
    const resp = await fetch('/.netlify/functions/ask-doubt', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body: JSON.stringify({ question:text, tier, history })
    });
    if(resp.ok){
      const data = await resp.json();
      if(data && data.explanation) entry = data;
    } else {
      apiFailed = true;
    }
  } catch(e){ apiFailed = true; /* offline, or no Netlify function server (e.g. opened via file://) */ }

  if(!entry) entry = findAnswer(text);
  if(entry) logDoubtHistory(text, entry.subject);

  thinkingEl.removeAttribute('id');
  const aiTimestamp = new Date().toISOString();
  renderAIMessage(thinkingEl, tier, entry, apiFailed, text, aiTimestamp);

  const afterAiMessages = getChatMessages();
  afterAiMessages.push({
    id: 'm_' + Date.now() + '_a',
    role: 'ai',
    text,
    timestamp: aiTimestamp,
    attachment: null,
    aiData: entry
      ? { subject: entry.subject, explanation: entry.explanation, keyConcept: entry.keyConcept, example: entry.example, tier, apiFailed }
      : { subject: null, explanation: null, keyConcept: null, example: null, tier, apiFailed }
  });
  saveChatMessages(afterAiMessages);
}
```

- [ ] **Step 2: Verify** — full end-to-end check happens in Task 10.

---

### Task 8: Backend — accept and use conversation history

**Files:**
- Modify: `netlify/functions/ask-doubt.js` (entire file, shown in full below since every line is affected by the diff)

- [ ] **Step 1: Replace the whole file**

```js
// Netlify serverless function — keeps the OpenRouter API key server-side.
// The frontend calls POST /.netlify/functions/ask-doubt with { question, tier, history }
// and never sees the key. Same pipeline shape as generate-note.js: capture input ->
// build prompt -> call Grok -> parse -> return structured JSON for the UI to render.
// TEMP: using OpenRouter (Grok) instead of Anthropic for testing while the Anthropic account has $0 credit.

const MODEL_BY_TIER = {
  tier1: 'x-ai/grok-4.3',
  tier2: 'x-ai/grok-4.5'
};

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if(!apiKey){
    return { statusCode: 500, body: JSON.stringify({ error: 'OPENROUTER_API_KEY not configured on the server' }) };
  }

  let question, tier, history;
  try{
    const body = JSON.parse(event.body || '{}');
    question = (body.question || '').trim();
    tier = MODEL_BY_TIER[body.tier] ? body.tier : 'tier1';
    history = Array.isArray(body.history) ? body.history : [];
  } catch(e){
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if(!question){
    return { statusCode: 400, body: JSON.stringify({ error: 'question is required' }) };
  }

  // Defensive cap regardless of what the frontend sends — last 3 exchanges (6 messages)
  const cappedHistory = history
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-6);

  const systemPrompt = `You are Forge, an academic doubt-solving assistant for a B.Tech Computer Engineering (Semester 3) student.
Subjects this semester: Introduction to Data Structures and Algorithms, Introduction to Database Management System,
Introduction to Object Oriented Programming, Digital Electronics, Discrete Mathematics, Business Ethics and Intellectual Property Rights.

Explain concepts in simple, everyday language. Use real-life analogies and examples wherever possible
(relate the concept to something from daily life). Avoid dense textbook jargon unless the technical term
itself needs to be taught.

If the student's message refers back to something earlier in the conversation (e.g. "that", "the one I just
asked about", "explain it more"), resolve the reference using the conversation history provided, and answer
about that specific thing rather than asking for clarification.

Given a student's doubt/question, respond with ONLY valid JSON, no markdown fences, no commentary, in
exactly this shape:
{"subject": "string", "explanation": "string", "keyConcept": "string", "example": "string"}
- "subject" must be one of the 6 subject names above (pick the closest match).
- "explanation": a clear, simple answer to the question.
- "keyConcept": the one core idea the student should remember.
- "example": a concrete real-life analogy or worked example.
If the question is unrelated to college coursework, or you are not confident in a grounded answer,
respond with:
{"subject": null, "explanation": null, "keyConcept": null, "example": null}`;

  try{
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL_BY_TIER[tier],
        max_tokens: 700,
        messages: [
          { role: 'system', content: systemPrompt },
          ...cappedHistory,
          { role: 'user', content: question }
        ]
      })
    });

    const data = await resp.json();

    if(!resp.ok){
      const message = (data && data.error && data.error.message) || 'OpenRouter API error';
      return { statusCode: resp.status, body: JSON.stringify({ error: message }) };
    }

    const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    let parsed;
    try{
      parsed = JSON.parse(raw);
    } catch(e){
      return { statusCode: 502, body: JSON.stringify({ error: 'Model did not return valid JSON', raw }) };
    }

    if(!parsed.explanation){
      return { statusCode: 200, body: JSON.stringify({ subject: null, explanation: null, keyConcept: null, example: null }) };
    }

    return { statusCode: 200, body: JSON.stringify(parsed) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach OpenRouter API: ' + e.message }) };
  }
};
```

- [ ] **Step 2: Verify the server restarts cleanly and accepts the new field**

The dev server (`netlify dev` on port 8888) needs a restart to pick up the function change — Netlify's dev server does hot-reload functions automatically on file save, but confirm with a direct call:

Run:
```bash
curl -s -X POST http://localhost:8888/.netlify/functions/ask-doubt \
  -H "content-type: application/json" \
  -d '{"question":"what is a stack","tier":"tier1","history":[]}'
```
Expected: a `200` response with `{"subject":...,"explanation":...,"keyConcept":...,"example":...}` (same shape as before — `history:[]` should behave identically to no history).

Run:
```bash
curl -s -X POST http://localhost:8888/.netlify/functions/ask-doubt \
  -H "content-type: application/json" \
  -d '{"question":"give me an example of that","tier":"tier1","history":[{"role":"user","content":"what is a stack"},{"role":"assistant","content":"A stack is a LIFO data structure..."}]}'
```
Expected: a `200` response whose `explanation`/`example` are clearly about stacks (not a generic "I don't understand" or an off-topic answer) — confirms the model is actually using `history` to resolve "that."

---

### Task 9: Sync `index.html` → `student-dashboard.html`

**Files:**
- Modify: `student-dashboard.html` (overwritten from `index.html`)

This project keeps these two files byte-identical on purpose (documented in `PROJECT_STATUS.txt`) — `admin-dashboard.html` is the only genuinely separate page.

- [ ] **Step 1: Copy the file**

Run:
```bash
cp "index.html" "student-dashboard.html"
```

- [ ] **Step 2: Verify they're identical**

Run:
```bash
diff "index.html" "student-dashboard.html"
```
Expected: no output (files identical).

---

### Task 10: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Confirm the dev server is running**

Run:
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8888/
```
Expected: `200`. If not running, start it: `netlify dev --port 8888` from the project root.

- [ ] **Step 2: Browser check — new conversation + attachment**

Open `http://localhost:8888` in a browser, go to the "Ask Forge" tab:
1. Type "what is a stack" and send. Confirm a timestamp appears under both your message and Forge's reply.
2. Click the paperclip button, pick any file. Confirm a pending chip with the filename/size appears above the input.
3. Type "explain that with an attached diagram" and send. Confirm the chip shows on your sent message (📎 filename, size) and the pending chip clears.
4. Ask a follow-up: "give me an example of that." Confirm the answer is clearly about stacks (memory working), not a generic/confused response.

- [ ] **Step 3: Browser check — reload persistence**

5. Reload the page. Confirm all 3 exchanges from Step 2 are still there, in order, with timestamps intact.
6. Confirm the message that had an attachment now shows "📎 filename — no longer available" instead of the file size.

- [ ] **Step 4: Browser check — offline/failure fallback still works**

7. Stop the dev server (`Ctrl+C` in its terminal or kill the process). Ask a new question ("what is a queue"). Confirm the offline fallback still renders (error face + local QA bank answer for queue, since it's in `QA_BANK`), and that this failed exchange also gets a timestamp and persists across a reload once restarted.

- [ ] **Step 5: Confirm `forge-doubt-history` stats are unaffected**

8. In devtools console: `JSON.parse(localStorage.getItem('forge-doubt-history')).length` should have grown by the number of successfully-answered questions asked during this test — confirms the existing stats feature wasn't broken by the rewrite.
