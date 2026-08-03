# YouTube Topic Videos + Course-Mode Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add YouTube video discovery per chapter (Courses tab), and a "course" response type to Ask Forge chat that returns main topics + practice questions instead of a normal doubt answer.

**Architecture:** One new Netlify function (`find-videos.js`, Groq picks a search phrase → YouTube Data API v3 search + view-count ranking). `ask-doubt.js` gets a 4th `type: "course"` on its existing classifier. Two frontend surfaces in `student-dashboard.html`: a topic-detail modal in Courses (video picker + existing real chapter data), and a course-mode card in Ask Forge chat (reuses the existing chat-quiz answer flow for practice questions).

**Tech Stack:** Vanilla JS, Netlify Functions (Node, no deps, global `fetch`), Groq (`llama-3.3-70b-versatile`), YouTube Data API v3. No test framework in this repo — verification is via `curl` against `local-server.js` for backend tasks, and browser `javascript_exec`/console checks for frontend tasks, matching how every other feature in this codebase has been verified.

Spec: `docs/superpowers/specs/2026-08-03-youtube-course-mode-design.md`

Before starting: confirm the local dev server is running (`node local-server.js` from the repo root, serves `http://localhost:8888`). All curl verification steps below assume it's up.

---

### Task 1: `find-videos.js` backend function

**Files:**
- Create: `netlify/functions/find-videos.js`
- Modify: `admin-dashboard.html:229-236` (add to `AI_FEATURES` so its Groq token usage shows in the cost panel)

- [ ] **Step 1: Write `find-videos.js`**

```js
// Netlify serverless function — keeps both the Groq and YouTube keys server-side.
// The frontend calls POST /.netlify/functions/find-videos with { subject, chapter }
// and never sees either key. Groq picks a good search phrase for the chapter (chapter
// names like "Trees & Binary Search Trees" don't always make good raw search queries),
// then YouTube search.list finds 5 candidates, then videos.list pulls view counts so
// "best" can mean highest-viewed rather than just YouTube's default relevance order.

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const groqKey = process.env.GROQ_API_KEY;
  const ytKey = process.env.YOUTUBE_API_KEY;
  if(!groqKey || !ytKey){
    return { statusCode: 500, body: JSON.stringify({ videos: [], bestVideoId: null, error: 'API key not configured on the server' }) };
  }

  let subject, chapter;
  try{
    const body = JSON.parse(event.body || '{}');
    subject = (body.subject || '').trim();
    chapter = (body.chapter || '').trim();
  } catch(e){
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }
  if(!subject || !chapter){
    return { statusCode: 400, body: JSON.stringify({ error: 'subject and chapter are required' }) };
  }

  // Default query is a safe fallback if the Groq call below fails for any reason —
  // the feature should still work, just with a slightly worse search phrase.
  let query = `${chapter} ${subject} explained`;
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
    if(phraseData.usage) console.log('[find-videos] groq tokens:', phraseData.usage);
    const text = phraseData.choices && phraseData.choices[0] && phraseData.choices[0].message && phraseData.choices[0].message.content;
    if(text && text.trim()) query = text.trim();
  } catch(e){ /* keep the fallback query built above */ }

  try{
    const searchResp = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=5&q=${encodeURIComponent(query)}&key=${ytKey}`);
    const searchData = await searchResp.json();
    if(!searchResp.ok){
      const message = (searchData && searchData.error && searchData.error.message) || 'YouTube API error';
      return { statusCode: searchResp.status, body: JSON.stringify({ videos: [], bestVideoId: null, error: message }) };
    }
    const items = Array.isArray(searchData.items) ? searchData.items : [];
    if(!items.length){
      return { statusCode: 200, body: JSON.stringify({ videos: [], bestVideoId: null, error: null }) };
    }

    const ids = items.map(it => it.id.videoId).join(',');
    const statsResp = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids}&key=${ytKey}`);
    const statsData = await statsResp.json();
    const viewsById = {};
    (statsData.items || []).forEach(v => { viewsById[v.id] = parseInt(v.statistics.viewCount, 10) || 0; });

    const videos = items.map(it => ({
      videoId: it.id.videoId,
      title: it.snippet.title,
      channelTitle: it.snippet.channelTitle,
      thumbnail: it.snippet.thumbnails.medium ? it.snippet.thumbnails.medium.url : it.snippet.thumbnails.default.url,
      viewCount: viewsById[it.id.videoId] || 0
    }));
    const bestVideoId = videos.reduce((best, v) => v.viewCount > best.viewCount ? v : best, videos[0]).videoId;

    return { statusCode: 200, body: JSON.stringify({ videos, bestVideoId, error: null }) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ videos: [], bestVideoId: null, error: 'Failed to reach YouTube API: ' + e.message }) };
  }
};
```

- [ ] **Step 2: Verify it works — happy path**

Run:
```bash
curl -s -X POST http://localhost:8888/.netlify/functions/find-videos \
  -H "content-type: application/json" \
  -d '{"subject":"Data Structures and Algorithms","chapter":"Trees & Binary Search Trees"}'
```
Expected: JSON with `"videos"` as a 5-item array, each item has `videoId`, `title`, `channelTitle`, `thumbnail`, `viewCount` (a number > 0), and `"bestVideoId"` matching the `videoId` of whichever item has the highest `viewCount`, `"error": null`.

- [ ] **Step 3: Verify error handling — missing fields**

Run:
```bash
curl -s -X POST http://localhost:8888/.netlify/functions/find-videos \
  -H "content-type: application/json" -d '{}'
```
Expected: `{"error":"subject and chapter are required"}` with a 400 status.

- [ ] **Step 4: Add to admin cost tracking**

Find in `admin-dashboard.html`:
```js
const AI_FEATURES = [
  { key:'ask-doubt', label:'Ask Forge (Doubts)' },
  { key:'generate-note', label:'Notes Generated' },
  { key:'assignment-tip', label:'Assignment Priority' },
  { key:'strategy-tip', label:'Strategy Tips' },
  { key:'grade-answer', label:'Quiz Grading' },
  { key:'viva-turn', label:'Viva Prep' }
];
```
Replace with:
```js
const AI_FEATURES = [
  { key:'ask-doubt', label:'Ask Forge (Doubts)' },
  { key:'generate-note', label:'Notes Generated' },
  { key:'assignment-tip', label:'Assignment Priority' },
  { key:'strategy-tip', label:'Strategy Tips' },
  { key:'grade-answer', label:'Quiz Grading' },
  { key:'viva-turn', label:'Viva Prep' },
  { key:'find-videos', label:'Video Finder' }
];
```

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/find-videos.js admin-dashboard.html
git commit -m "Add find-videos.js: Groq-phrased YouTube search ranked by view count"
```

---

### Task 2: `ask-doubt.js` — course-mode 4th type

**Files:**
- Modify: `netlify/functions/ask-doubt.js:91-127` (classification rule, response schema, null-fallback)
- Modify: `netlify/functions/ask-doubt.js:173-184` (server-side validation of the new fields)

- [ ] **Step 1: Add the 4th classification rule**

Find:
```js
Every question is one of three types — pick whichever fits best:
- "concept": a definition, theory, or "what/why/how does X work" question.
- "numerical": a question that involves a calculation, formula, or worked math/logic problem
  (e.g. normalization steps, K-map, Boolean algebra simplification, complexity computation).
- "code": a question about syntax, an algorithm's implementation, or "how do I write/code X".
```
Replace with:
```js
Every question is one of four types — pick whichever fits best:
- "concept": a definition, theory, or "what/why/how does X work" question.
- "numerical": a question that involves a calculation, formula, or worked math/logic problem
  (e.g. normalization steps, K-map, Boolean algebra simplification, complexity computation).
- "code": a question about syntax, an algorithm's implementation, or "how do I write/code X".
- "course": the student wants to learn or study a whole subject/topic broadly, not resolve one
  specific doubt — e.g. "teach me DBMS", "give me a course on trees", "help me learn OOP",
  "overview of digital electronics".
```

- [ ] **Step 2: Extend the response schema**

Find:
```js
Given a student's doubt/question, respond with ONLY valid JSON, no markdown fences, no commentary, in
exactly this shape:
{"subject": "string", "chapter": "string", "type": "concept" | "numerical" | "code", "explanation": "string", "simpleExplanation": "string",
 "keyConcept": "string|null", "example": "string|null",
 "formula": "string|null", "steps": "string[]|null", "workedExample": "string|null",
 "codeSnippet": "string|null", "codeLanguage": "string|null", "commonMistake": "string|null"}
- "subject" must be one of the 6 subject names above (pick the closest match).
- "chapter" must be copied EXACTLY (character-for-character) from that subject's chapter list above —
  do not paraphrase or shorten it.
- "explanation": a clear, complete answer to the question, for every type.
```
Replace with:
```js
Given a student's doubt/question, respond with ONLY valid JSON, no markdown fences, no commentary, in
exactly this shape:
{"subject": "string", "chapter": "string|null", "type": "concept" | "numerical" | "code" | "course", "explanation": "string", "simpleExplanation": "string",
 "keyConcept": "string|null", "example": "string|null",
 "formula": "string|null", "steps": "string[]|null", "workedExample": "string|null",
 "codeSnippet": "string|null", "codeLanguage": "string|null", "commonMistake": "string|null",
 "mainTopics": [{"chapter": "string", "why": "string"}]|null, "practiceQuestions": "string[]|null"}
- "subject" must be one of the 6 subject names above (pick the closest match).
- "chapter" must be copied EXACTLY (character-for-character) from that subject's chapter list above —
  do not paraphrase or shorten it. For "course" type, set "chapter" to null — a whole-course
  request doesn't belong to one chapter.
- "explanation": a clear, complete answer to the question, for every type. For "course" type, one
  short sentence introducing the course (e.g. "Here's your course overview for Database Management System.").
```

- [ ] **Step 3: Add the course-type fill-in rule**

Find:
```js
- Only fill in the fields for the chosen "type", set every other type's fields to null:
  - "concept": fill "keyConcept" (the one core idea to remember) and "example" (a real-life analogy).
  - "numerical": fill "formula" (the formula/rule used, if any), "steps" (array of short ordered steps),
    and "workedExample" (a fully worked example with numbers).
  - "code": fill "codeSnippet" (the actual code), "codeLanguage" (e.g. "c", "python", "sql"), and
    "commonMistake" (a mistake students typically make with this).
```
Replace with:
```js
- Only fill in the fields for the chosen "type", set every other type's fields to null:
  - "concept": fill "keyConcept" (the one core idea to remember) and "example" (a real-life analogy).
  - "numerical": fill "formula" (the formula/rule used, if any), "steps" (array of short ordered steps),
    and "workedExample" (a fully worked example with numbers).
  - "code": fill "codeSnippet" (the actual code), "codeLanguage" (e.g. "c", "python", "sql"), and
    "commonMistake" (a mistake students typically make with this).
  - "course": fill "mainTopics" (5-8 entries, "chapter" copied EXACTLY from that subject's chapter
    list, ordered by importance, "why" a one-line reason it matters) and "practiceQuestions"
    (3-5 short-answer questions covering those topics).
```

- [ ] **Step 4: Extend the empty-response fallback**

Find:
```js
If the question is unrelated to college coursework, or you are not confident in a grounded answer,
respond with:
{"subject": null, "chapter": null, "type": null, "explanation": null, "simpleExplanation": null, "keyConcept": null, "example": null,
 "formula": null, "steps": null, "workedExample": null, "codeSnippet": null, "codeLanguage": null, "commonMistake": null}`;
```
Replace with:
```js
If the question is unrelated to college coursework, or you are not confident in a grounded answer,
respond with:
{"subject": null, "chapter": null, "type": null, "explanation": null, "simpleExplanation": null, "keyConcept": null, "example": null,
 "formula": null, "steps": null, "workedExample": null, "codeSnippet": null, "codeLanguage": null, "commonMistake": null,
 "mainTopics": null, "practiceQuestions": null}`;
```

- [ ] **Step 5: Server-side validation for the new fields**

Find:
```js
    if(parsed.subject) parsed.subject = normalizeSubject(parsed.subject);
    // Don't trust the chapter name blindly — only keep it if it's an exact match for the
    // subject it claims to belong to, otherwise the frontend falls back to keyword matching.
    const validChapters = COURSE_CHAPTERS[parsed.subject] || [];
    if(!validChapters.includes(parsed.chapter)) parsed.chapter = null;

    if(!parsed.explanation){
      return { statusCode: 200, body: JSON.stringify({
        subject: null, chapter: null, type: null, explanation: null, simpleExplanation: null, keyConcept: null, example: null,
        formula: null, steps: null, workedExample: null, codeSnippet: null, codeLanguage: null, commonMistake: null
      }) };
    }
```
Replace with:
```js
    if(parsed.subject) parsed.subject = normalizeSubject(parsed.subject);
    // Don't trust the chapter name blindly — only keep it if it's an exact match for the
    // subject it claims to belong to, otherwise the frontend falls back to keyword matching.
    const validChapters = COURSE_CHAPTERS[parsed.subject] || [];
    if(!validChapters.includes(parsed.chapter)) parsed.chapter = null;

    // Same defense-in-depth for course-mode's topic list — drop any entry whose chapter name
    // isn't an exact match, same rule as the single "chapter" field above.
    if(parsed.type === 'course' && Array.isArray(parsed.mainTopics)){
      parsed.mainTopics = parsed.mainTopics
        .filter(t => t && typeof t.chapter === 'string' && validChapters.includes(t.chapter) && typeof t.why === 'string')
        .slice(0, 8);
    } else {
      parsed.mainTopics = null;
    }
    if(parsed.type === 'course' && Array.isArray(parsed.practiceQuestions)){
      parsed.practiceQuestions = parsed.practiceQuestions.filter(q => typeof q === 'string' && q.trim()).slice(0, 5);
    } else {
      parsed.practiceQuestions = null;
    }

    if(!parsed.explanation){
      return { statusCode: 200, body: JSON.stringify({
        subject: null, chapter: null, type: null, explanation: null, simpleExplanation: null, keyConcept: null, example: null,
        formula: null, steps: null, workedExample: null, codeSnippet: null, codeLanguage: null, commonMistake: null,
        mainTopics: null, practiceQuestions: null
      }) };
    }
```

- [ ] **Step 6: Verify — course-mode request**

Run:
```bash
curl -s -X POST http://localhost:8888/.netlify/functions/ask-doubt \
  -H "content-type: application/json" \
  -d '{"question":"give me a course on database management system","tier":"tier1","history":[]}'
```
Expected: `"type":"course"`, `"chapter":null`, `"mainTopics"` is an array of 5-8 objects each with `chapter` (a real DBMS chapter name, e.g. `"Normalization (1NF–BCNF)"`) and `why`, `"practiceQuestions"` is an array of 3-5 strings, `"explanation"` is a short non-null string.

- [ ] **Step 7: Verify — normal doubt still works (no regression)**

Run:
```bash
curl -s -X POST http://localhost:8888/.netlify/functions/ask-doubt \
  -H "content-type: application/json" \
  -d '{"question":"what is a stack in data structures","tier":"tier1","history":[]}'
```
Expected: `"type":"concept"`, `"mainTopics":null`, `"practiceQuestions":null`, `"keyConcept"` and `"example"` filled — unchanged from before this task.

- [ ] **Step 8: Commit**

```bash
git add netlify/functions/ask-doubt.js
git commit -m "Add course-mode 4th type to ask-doubt.js classifier"
```

---

### Task 3: Courses tab — per-chapter topic modal

**Files:**
- Modify: `student-dashboard.html:3990-4004` (`initCourseChapters` — wire click handler + data attributes)
- Modify: `student-dashboard.html:7186-7188` (add modal markup before the "MORE BOTTOM SHEET" comment)
- Modify: `student-dashboard.html` CSS block near `.more-sheet-backdrop` (~line 1926) — add `.topic-modal` styles
- Modify: `student-dashboard.html` near `logTopicActivity` (~line 4852) — add `openTopicModal()` + supporting functions

- [ ] **Step 1: Add data attributes + click handler to chapter rows**

Find (in `initCourseChapters`):
```js
function initCourseChapters(){
  document.querySelectorAll('.course-chapters').forEach(container=>{
    const data = COURSE_CHAPTERS[container.dataset.chapters];
    if(!data) return;
    container.innerHTML = data.chapters.map((name, idx)=>{
      const num = idx + 1;
      const status = num < data.current ? 'done' : num === data.current ? 'current' : '';
      const check = status === 'done' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>' : '';
      return `<div class="chapter-row ${status}"><span class="chapter-num">${num}</span><span class="chapter-check">${check}</span><span class="chapter-name">${name}</span></div>`;
    }).join('');
  });
  document.querySelectorAll('.course-row').forEach(row=>{
    row.addEventListener('click', ()=> row.closest('.course').classList.toggle('expanded'));
  });
}
```
Replace with:
```js
function initCourseChapters(){
  const subjectOf = container => container.dataset.chapters;
  document.querySelectorAll('.course-chapters').forEach(container=>{
    const data = COURSE_CHAPTERS[subjectOf(container)];
    if(!data) return;
    container.innerHTML = data.chapters.map((name, idx)=>{
      const num = idx + 1;
      const status = num < data.current ? 'done' : num === data.current ? 'current' : '';
      const check = status === 'done' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>' : '';
      return `<div class="chapter-row ${status}" data-subject="${escapeHtml(subjectOf(container))}" data-chapter="${escapeHtml(name)}"><span class="chapter-num">${num}</span><span class="chapter-check">${check}</span><span class="chapter-name">${name}</span></div>`;
    }).join('');
    container.querySelectorAll('.chapter-row').forEach(row=>{
      row.addEventListener('click', (e)=>{
        e.stopPropagation(); // don't also toggle the parent .course-row's expand/collapse
        openTopicModal(row.dataset.subject, row.dataset.chapter);
      });
    });
  });
  document.querySelectorAll('.course-row').forEach(row=>{
    row.addEventListener('click', ()=> row.closest('.course').classList.toggle('expanded'));
  });
}
```

- [ ] **Step 2: Add modal markup**

Find:
```html
  <!-- MORE BOTTOM SHEET -->
  <div class="more-sheet-backdrop" id="moreSheetBackdrop"></div>
```
Replace with:
```html
  <!-- TOPIC STUDY MODAL -->
  <div class="topic-modal-backdrop" id="topicModalBackdrop"></div>
  <div class="topic-modal panel" id="topicModal">
    <div class="panel-head">
      <h2 id="topicModalTitle">Chapter</h2>
      <a href="#" id="topicModalClose">✕ Close</a>
    </div>
    <span class="topic-modal-status-chip" id="topicModalStatusChip"></span>
    <div id="topicModalVideos">
      <p class="tt-sub">Loading videos…</p>
    </div>
    <div id="topicModalActivity"></div>
  </div>

  <!-- MORE BOTTOM SHEET -->
  <div class="more-sheet-backdrop" id="moreSheetBackdrop"></div>
```

- [ ] **Step 3: Add CSS**

Find:
```css
  /* ================= "MORE" BOTTOM SHEET ================= */
  .more-sheet-backdrop{
```
Replace with:
```css
  /* ================= TOPIC STUDY MODAL ================= */
  .topic-modal-backdrop{
    position:fixed; inset:0; background:rgba(20,18,15,0.45); z-index:340;
    opacity:0; pointer-events:none; transition:opacity .3s ease;
    -webkit-backdrop-filter:blur(3px); backdrop-filter:blur(3px);
  }
  .topic-modal{
    position:fixed; top:50%; left:50%; transform:translate(-50%,-48%);
    width:min(560px, 92vw); max-height:82dvh; overflow-y:auto;
    z-index:350; opacity:0; pointer-events:none;
    transition:opacity .28s ease, transform .28s cubic-bezier(.22,.9,.3,1);
  }
  body.topic-modal-open .topic-modal-backdrop{ opacity:1; pointer-events:auto; }
  body.topic-modal-open .topic-modal{ opacity:1; pointer-events:auto; transform:translate(-50%,-50%); }
  .topic-modal-status-chip{
    display:inline-block; font-size:11px; font-weight:700; padding:4px 10px; border-radius:100px;
    margin-bottom:14px; text-transform:uppercase;
  }
  .topic-modal-status-chip.strong{ background:var(--green-soft); color:#3F4A1A; }
  .topic-modal-status-chip.weak{ background:var(--pink-soft); color:#9C3A48; }
  .topic-modal-status-chip.learning{ background:var(--blue-soft); }
  .topic-modal-status-chip.upcoming{ background:var(--yellow-soft); }
  .topic-video-grid{ display:grid; grid-template-columns:repeat(auto-fill, minmax(150px,1fr)); gap:10px; margin-bottom:18px; }
  .topic-video-card{ border-radius:10px; overflow:hidden; cursor:pointer; border:2px solid transparent; text-decoration:none; color:inherit; display:block; }
  .topic-video-card.best{ border-color:var(--green); }
  .topic-video-card img{ width:100%; display:block; aspect-ratio:16/9; object-fit:cover; }
  .topic-video-card .tv-title{ font-size:11px; font-weight:600; padding:6px 8px 2px; line-height:1.3; }
  .topic-video-card .tv-meta{ font-size:10px; color:var(--ink-soft); padding:0 8px 8px; }
  .topic-activity-row{ font-size:12px; color:var(--ink-soft); padding:6px 0; border-top:1px solid rgba(36,31,24,0.06); }

  /* ================= "MORE" BOTTOM SHEET ================= */
  .more-sheet-backdrop{
```

- [ ] **Step 4: Add `openTopicModal()` and supporting functions + wire close handlers**

Find:
```js
function logTopicActivity(subject, chapter, source, correct){
```
Insert immediately before it:
```js
/* --- Topic study modal: video picker (find-videos.js) + real existing data for one chapter --- */
function topicVideoCardHtml(video, isBest){
  return `<a class="topic-video-card${isBest ? ' best' : ''}" href="https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}" target="_blank" rel="noopener">
    <img src="${video.thumbnail}" alt="">
    <div class="tv-title">${escapeHtml(video.title)}</div>
    <div class="tv-meta">${escapeHtml(video.channelTitle)}${isBest ? ' · Best pick' : ''}</div>
  </a>`;
}

async function loadTopicVideos(subject, chapter){
  const el = document.getElementById('topicModalVideos');
  el.innerHTML = '<p class="tt-sub">Loading videos…</p>';
  try{
    const resp = await fetch('/.netlify/functions/find-videos', {
      method:'POST', headers:{ 'content-type':'application/json' },
      body: JSON.stringify({ subject, chapter })
    });
    const data = resp.ok ? await resp.json() : null;
    if(!data || data.error || !data.videos.length){
      el.innerHTML = '<p class="tt-sub">Couldn\'t load videos for this topic right now.</p>';
      return;
    }
    el.innerHTML = `<div class="topic-video-grid">${data.videos.map(v => topicVideoCardHtml(v, v.videoId === data.bestVideoId)).join('')}</div>`;
  } catch(e){
    el.innerHTML = '<p class="tt-sub">Couldn\'t load videos for this topic right now.</p>';
  }
}

function openTopicModal(subject, chapter){
  document.getElementById('topicModalTitle').textContent = chapter;
  const status = chapterStatus(subject, chapter, getTopicActivity());
  const chip = document.getElementById('topicModalStatusChip');
  chip.className = 'topic-modal-status-chip ' + status;
  chip.textContent = status;

  const activity = getTopicActivity().filter(e => e.subject === subject && e.chapter === chapter);
  const activityEl = document.getElementById('topicModalActivity');
  activityEl.innerHTML = activity.length
    ? activity.slice(-5).reverse().map(e => `<div class="topic-activity-row">${escapeHtml(e.source)} — ${new Date(e.date).toLocaleDateString()}${e.correct === true ? ' · correct' : e.correct === false ? ' · incorrect' : ''}</div>`).join('')
    : '<div class="topic-activity-row">No activity logged on this chapter yet.</div>';

  document.body.classList.add('topic-modal-open');
  loadTopicVideos(subject, chapter);
}
document.getElementById('topicModalClose').addEventListener('click', (e)=>{ e.preventDefault(); document.body.classList.remove('topic-modal-open'); });
document.getElementById('topicModalBackdrop').addEventListener('click', ()=> document.body.classList.remove('topic-modal-open'));

function logTopicActivity(subject, chapter, source, correct){
```

- [ ] **Step 5: Verify in browser**

With `local-server.js` running and `student-dashboard.html` open:
1. Navigate to the Courses tab, click a course card to expand it, click any chapter row.
2. Expected: modal opens centered with a dim backdrop, title matches the chapter name, a status chip shows (upcoming/learning/weak/strong), "Loading videos…" then a 5-thumbnail grid appears with one marked "· Best pick".
3. Click the ✕ Close or the backdrop — modal closes.
4. Check console for errors:

Run (via `javascript_tool` / browser devtools):
```js
document.querySelectorAll('.chapter-row').length > 0
```
Expected: `true`, and no thrown errors in the console after clicking a row and closing the modal.

- [ ] **Step 6: Commit**

```bash
git add student-dashboard.html
git commit -m "Add per-chapter topic modal to Courses tab (video picker + real chapter data)"
```

---

### Task 4: Ask Forge chat — course-mode card

**Files:**
- Modify: `student-dashboard.html:4264` (`renderAIMessage` — render a distinct card when `entry.type === 'course'`)
- Modify: `student-dashboard.html` near `submitChatQuizAnswer` (~line 4536) — add `startCourseQuizFromCard()` helper

- [ ] **Step 1: Branch course-mode rendering in `renderAIMessage`**

Find:
```js
function renderAIMessage(el, tier, entry, apiFailed, question){
  const badge = tier==='tier2' ? '<span class="tier-badge t2">Tier 2 · Deep</span>' : '<span class="tier-badge t1">Tier 1 · Fast</span>';
  const errorBox = apiFailed ? errorFaceBox(entry ? 'Showing offline content instead.' : 'And no offline match for this either.') : '';
  if(entry){
    const hasSimple = !!entry.simpleExplanation;
    el.querySelector('.ai-card').innerHTML = `
      <div class="ai-card-head"><span class="who">Forge</span>${badge}</div>
      ${errorBox}
      <div class="ai-block"><span class="k">Explanation</span><div class="v" data-role="explanation-text">${escapeHtml(entry.explanation)}</div></div>
      ${typeBlockHtml(entry)}
```
Replace with:
```js
function renderAIMessage(el, tier, entry, apiFailed, question){
  const badge = tier==='tier2' ? '<span class="tier-badge t2">Tier 2 · Deep</span>' : '<span class="tier-badge t1">Tier 1 · Fast</span>';
  const errorBox = apiFailed ? errorFaceBox(entry ? 'Showing offline content instead.' : 'And no offline match for this either.') : '';

  if(entry && entry.type === 'course'){
    el.querySelector('.ai-card').innerHTML = `
      <div class="ai-card-head"><span class="who">Forge</span>${badge}</div>
      ${errorBox}
      <div class="ai-block"><span class="k">${escapeHtml(entry.subject || 'Course Overview')}</span><div class="v">${escapeHtml(entry.explanation)}</div></div>
      <div class="ai-block"><span class="k">Main Topics</span><div class="v"><ol class="ai-steps">${(entry.mainTopics || []).map(t => `<li><b>${escapeHtml(t.chapter)}</b> — ${escapeHtml(t.why)}</li>`).join('')}</ol></div></div>
      <div class="ai-block"><span class="k">Practice Questions</span><div class="v course-quiz-list">${(entry.practiceQuestions || []).map((q, i) => `<button class="note-action-btn btn-pop course-quiz-q" data-subject="${escapeHtml(entry.subject || '')}" data-chapter="${escapeHtml((entry.mainTopics && entry.mainTopics[i % Math.max(entry.mainTopics.length,1)] && entry.mainTopics[i % Math.max(entry.mainTopics.length,1)].chapter) || '')}" data-question="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join('')}</div></div>`;
    el.querySelectorAll('.course-quiz-q').forEach(btn=>{
      btn.addEventListener('click', ()=> startCourseQuizFromCard(btn.dataset.subject, btn.dataset.chapter, btn.dataset.question));
    });
    document.getElementById('chatWindow').scrollTop = document.getElementById('chatWindow').scrollHeight;
    return;
  }

  if(entry){
    const hasSimple = !!entry.simpleExplanation;
    el.querySelector('.ai-card').innerHTML = `
      <div class="ai-card-head"><span class="who">Forge</span>${badge}</div>
      ${errorBox}
      <div class="ai-block"><span class="k">Explanation</span><div class="v" data-role="explanation-text">${escapeHtml(entry.explanation)}</div></div>
      ${typeBlockHtml(entry)}
```
(Everything after this point in the function is unchanged — the existing `if(entry){...}` body continues exactly as before, just now only reached for non-course types.)

- [ ] **Step 2: Add the practice-question tap handler**

Find:
```js
document.getElementById('chatSendBtn').addEventListener('click', sendDoubt);
```
Insert immediately before it:
```js
// Tapping a practice question from a course-mode card seeds the exact same
// awaitingQuizAnswer flow conversational quizzing already uses — no separate
// grading path needed, submitChatQuizAnswer() handles the rest.
function startCourseQuizFromCard(subject, chapter, question){
  appendUserMessage('Quiz me: ' + question, null);
  const thinkingEl = appendThinking('tier1');
  thinkingEl.removeAttribute('id');
  awaitingQuizAnswer = { subject, chapter, question };
  thinkingEl.querySelector('.ai-card').innerHTML = `
    <div class="ai-card-head"><span class="who">Forge</span><span class="tier-badge t1">Tier 1 · Fast</span></div>
    <div class="ai-block"><span class="k">Quiz</span><div class="v">${escapeHtml(question)}</div></div>
    <div class="tt-sub">Type your answer below and send it.</div>`;
  document.getElementById('chatWindow').scrollTop = document.getElementById('chatWindow').scrollHeight;
}

document.getElementById('chatSendBtn').addEventListener('click', sendDoubt);
```

- [ ] **Step 3: Verify — course-mode chat end to end**

With `local-server.js` running and the dashboard open in browser, in Ask Forge chat type: `give me a course on database management system` and send.

Expected:
1. A course-mode card renders: subject name header, intro sentence, a numbered "Main Topics" list (5-8 real DBMS chapter names + why-lines), a "Practice Questions" block with 3-5 clickable question buttons.
2. Click one practice question button.
3. Expected: it appears as a user message ("Quiz me: <question>"), then a Forge "Quiz" bubble repeating that exact question, input box ready.
4. Type any answer and send.
5. Expected: graded feedback renders (✅/🟡/❌) exactly like the existing "Quiz me" flow — confirms `awaitingQuizAnswer` reuse works unchanged.

Check console for errors:
```js
// no output expected — just confirms no exceptions were thrown during the flow above
```

- [ ] **Step 4: Verify — normal doubt still renders unchanged (no regression)**

In the same chat, ask a normal doubt, e.g. `what is normalization in dbms`.
Expected: renders exactly as before this task — Explanation block, Key Concept/Example blocks, Save as Note button. No course-mode card.

- [ ] **Step 5: Commit**

```bash
git add student-dashboard.html
git commit -m "Add course-mode card to Ask Forge chat, reusing chat-quiz flow for practice questions"
```

---

## Self-review notes

- **Spec coverage:** find-videos.js (Task 1) covers spec's "Architecture" section for the backend function including the Groq-phrase → search.list → videos.list → best-by-viewcount pipeline and the missing-key error path. Task 2 covers the 4th classifier type, schema, and server-side validation exactly as specced. Task 3 covers the Courses topic view (video picker + existing chapter data, external link only, no embedded player, no localStorage caching — matches "Out of scope"). Task 4 covers course-mode chat rendering and the practice-question → chat-quiz reuse.
- **No embedded player / no localStorage caching**: confirmed neither task adds either — Task 3 Step 4 always calls `loadTopicVideos` fresh on open, links use `target="_blank"` rather than an embed.
- **Type consistency:** `find-videos.js` response shape (`{videos, bestVideoId, error}`) is used identically in Task 3 Step 4 (`loadTopicVideos`). `awaitingQuizAnswer = {subject, chapter, question}` in Task 4 Step 2 matches the exact shape `startChatQuiz()` and `submitChatQuizAnswer()` already use — no new fields invented.
