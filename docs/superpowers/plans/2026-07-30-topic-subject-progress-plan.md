# Topic/Subject Progress Tracking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fully-fake `COURSE_CHAPTERS[subject].current` / `READINESS_DATA` / `TOPIC_WEAK_OVERRIDE` static stubs with real per-subject, per-chapter progress driven by chat activity (auto), manual mark-as-done/weak clicks, and per-subject quiz scores — surfaced correctly on both the Courses page and the Exam Readiness page.

**Architecture:** Two new localStorage keys (`forge-topic-progress`, `forge-quiz-scores`). `ask-doubt.js` gains a `topic` field in its JSON contract (model picks the closest chapter name from a list sent in the prompt). Frontend records a "touch" on that chapter whenever a chat question resolves to one — live API or offline `QA_BANK` fallback alike. Two existing renderers (Courses page chapter checklist, Exam Readiness topic chips + score bars) get rewired to read the real data instead of the frozen stubs.

**Tech Stack:** Vanilla JS, localStorage, Netlify Functions, OpenRouter API.

**Process note:** Same as the previous plan in this project — no test runner, not a git repo, so verification is manual/curl-based and there are no commit steps.

Reference spec: `docs/superpowers/specs/2026-07-30-topic-subject-progress-design.md`

---

### Task 1: Backend — `ask-doubt.js` returns a `topic` field

**Files:**
- Modify: `netlify/functions/ask-doubt.js` (entire file)

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

// Mirrors index.html's COURSE_CHAPTERS (chapters only — no `current`, that field
// doesn't exist server-side and progress is tracked entirely in the browser).
const SUBJECT_CHAPTERS = {
  'Data Structures and Algorithms': ['Arrays & Complexity Analysis','Stacks','Queues','Linked Lists','Trees & Binary Search Trees','Graphs','Sorting Algorithms','Hashing','Heaps','Dynamic Programming'],
  'Database Management System': ['Introduction to DBMS & File Systems','ER Model & Relational Model','Relational Algebra & SQL Basics','Advanced SQL (Joins, Subqueries, Views)','Normalization (1NF–BCNF)','Transactions & Concurrency Control','Indexing & Query Processing','NoSQL & Modern Databases Intro'],
  'Object Oriented Programming': ['OOP Concepts: Classes & Objects','Constructors & Destructors','Inheritance','Polymorphism (Overloading & Overriding)','Abstract Classes & Interfaces','Exception Handling','File Handling & I/O','Collections & Generics'],
  'Digital Electronics': ['Number Systems & Codes','Boolean Algebra & Logic Gates','Combinational Circuits (Adders, MUX, Decoders)','Karnaugh Maps & Minimization','Sequential Circuits (Flip-Flops, Latches)','Counters & Registers','Memory Devices (RAM/ROM)','A/D and D/A Converters Intro'],
  'Discrete Mathematics': ['Set Theory & Relations','Propositional & Predicate Logic','Functions','Combinatorics (Permutations & Combinations)','Graph Theory Basics','Trees (Graph-Theoretic)','Recurrence Relations','Group Theory & Algebraic Structures Intro'],
  'Business Ethics and IPR': ['Introduction to Business Ethics','Corporate Social Responsibility','Ethical Decision-Making Frameworks','Introduction to IP: Patents, Copyrights, Trademarks','Patent Filing Process','Copyright & Trade Secrets','IPR in the IT & Software Industry','Case Studies & Emerging Issues']
};

const CHAPTER_LIST_TEXT = Object.entries(SUBJECT_CHAPTERS)
  .map(([subject, chapters]) => `${subject}:\n${chapters.map(c => `  - ${c}`).join('\n')}`)
  .join('\n\n');

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

Each subject has this exact chapter list. When you answer, also identify which ONE chapter the question is
about, from the chosen subject's list below — use the exact chapter name string, character for character:

${CHAPTER_LIST_TEXT}

Given a student's doubt/question, respond with ONLY valid JSON, no markdown fences, no commentary, in
exactly this shape:
{"subject": "string", "topic": "string", "explanation": "string", "keyConcept": "string", "example": "string"}
- "subject" must be one of the 6 subject names above (pick the closest match).
- "topic" must be the exact chapter name string from that subject's list above, or null if the question
  doesn't clearly map to one specific chapter (e.g. a general/administrative question).
- "explanation": a clear, simple answer to the question.
- "keyConcept": the one core idea the student should remember.
- "example": a concrete real-life analogy or worked example.
If the question is unrelated to college coursework, or you are not confident in a grounded answer,
respond with:
{"subject": null, "topic": null, "explanation": null, "keyConcept": null, "example": null}`;

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
      return { statusCode: 200, body: JSON.stringify({ subject: null, topic: null, explanation: null, keyConcept: null, example: null }) };
    }

    return { statusCode: 200, body: JSON.stringify(parsed) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach OpenRouter API: ' + e.message }) };
  }
};
```

- [ ] **Step 2: Verify syntax**

Run: `node --check "netlify/functions/ask-doubt.js"` — expected: no output (valid).

---

### Task 2: Offline fallback (`QA_BANK`) gains real subject/topic tags

**Files:**
- Modify: `index.html` (the `QA_BANK` array)

- [ ] **Step 1: Add `subject`/`topic` to each entry**

Find:

```js
const QA_BANK = [
  {
    keywords:['stack','push','pop'],
    explanation:'A stack is a linear data structure that follows Last-In-First-Out (LIFO) order — the last element added is the first one removed.',
    keyConcept:'Only two core operations: push (add to top) and pop (remove from top). No random access to middle elements.',
    example:'Browser back-button history: each page you visit is pushed on; hitting "back" pops the most recent one off.'
  },
  {
    keywords:['queue','enqueue','dequeue'],
    explanation:'A queue is a linear data structure that follows First-In-First-Out (FIFO) order — the first element added is the first one removed.',
    keyConcept:'Two ends matter: enqueue adds at the rear, dequeue removes from the front.',
    example:'A printer queue: the first document sent prints first, even if more documents get added after it.'
  },
  {
    keywords:['binary search tree','bst','binary tree'],
    explanation:'A Binary Search Tree (BST) is a tree where each node has at most two children, and for every node, left-subtree values are smaller and right-subtree values are larger.',
    keyConcept:'This ordering lets search, insert, and delete run in O(log n) on a balanced tree, versus O(n) for an unsorted list.',
    example:'Looking up a word in a sorted dictionary by repeatedly halving the search range mirrors how BST search narrows down a value.'
  },
  {
    keywords:['linked list'],
    explanation:'A linked list is a sequence of nodes where each node holds a value and a pointer to the next node, rather than sitting in contiguous memory like an array.',
    keyConcept:'Insertion/deletion at a known position is O(1) since no shifting is needed — the trade-off is no O(1) random access by index.',
    example:'A treasure hunt where each clue tells you where to find the next clue, instead of having a numbered map of every location upfront.'
  }
];
```

Replace with:

```js
const QA_BANK = [
  {
    keywords:['stack','push','pop'],
    subject:'Data Structures and Algorithms',
    topic:'Stacks',
    explanation:'A stack is a linear data structure that follows Last-In-First-Out (LIFO) order — the last element added is the first one removed.',
    keyConcept:'Only two core operations: push (add to top) and pop (remove from top). No random access to middle elements.',
    example:'Browser back-button history: each page you visit is pushed on; hitting "back" pops the most recent one off.'
  },
  {
    keywords:['queue','enqueue','dequeue'],
    subject:'Data Structures and Algorithms',
    topic:'Queues',
    explanation:'A queue is a linear data structure that follows First-In-First-Out (FIFO) order — the first element added is the first one removed.',
    keyConcept:'Two ends matter: enqueue adds at the rear, dequeue removes from the front.',
    example:'A printer queue: the first document sent prints first, even if more documents get added after it.'
  },
  {
    keywords:['binary search tree','bst','binary tree'],
    subject:'Data Structures and Algorithms',
    topic:'Trees & Binary Search Trees',
    explanation:'A Binary Search Tree (BST) is a tree where each node has at most two children, and for every node, left-subtree values are smaller and right-subtree values are larger.',
    keyConcept:'This ordering lets search, insert, and delete run in O(log n) on a balanced tree, versus O(n) for an unsorted list.',
    example:'Looking up a word in a sorted dictionary by repeatedly halving the search range mirrors how BST search narrows down a value.'
  },
  {
    keywords:['linked list'],
    subject:'Data Structures and Algorithms',
    topic:'Linked Lists',
    explanation:'A linked list is a sequence of nodes where each node holds a value and a pointer to the next node, rather than sitting in contiguous memory like an array.',
    keyConcept:'Insertion/deletion at a known position is O(1) since no shifting is needed — the trade-off is no O(1) random access by index.',
    example:'A treasure hunt where each clue tells you where to find the next clue, instead of having a numbered map of every location upfront.'
  }
];
```

- [ ] **Step 2: Verify** — no standalone check; exercised in Task 11.

---

### Task 3: Remove the dead `current` field from `COURSE_CHAPTERS`

**Files:**
- Modify: `index.html` (the `COURSE_CHAPTERS` const)

- [ ] **Step 1: Strip `current:1,` from every entry**

Find:

```js
const COURSE_CHAPTERS = {
  'Data Structures and Algorithms': { current:1, chapters:['Arrays & Complexity Analysis','Stacks','Queues','Linked Lists','Trees & Binary Search Trees','Graphs','Sorting Algorithms','Hashing','Heaps','Dynamic Programming'] },
  'Database Management System': { current:1, chapters:['Introduction to DBMS & File Systems','ER Model & Relational Model','Relational Algebra & SQL Basics','Advanced SQL (Joins, Subqueries, Views)','Normalization (1NF–BCNF)','Transactions & Concurrency Control','Indexing & Query Processing','NoSQL & Modern Databases Intro'] },
  'Object Oriented Programming': { current:1, chapters:['OOP Concepts: Classes & Objects','Constructors & Destructors','Inheritance','Polymorphism (Overloading & Overriding)','Abstract Classes & Interfaces','Exception Handling','File Handling & I/O','Collections & Generics'] },
  'Digital Electronics': { current:1, chapters:['Number Systems & Codes','Boolean Algebra & Logic Gates','Combinational Circuits (Adders, MUX, Decoders)','Karnaugh Maps & Minimization','Sequential Circuits (Flip-Flops, Latches)','Counters & Registers','Memory Devices (RAM/ROM)','A/D and D/A Converters Intro'] },
  'Discrete Mathematics': { current:1, chapters:['Set Theory & Relations','Propositional & Predicate Logic','Functions','Combinatorics (Permutations & Combinations)','Graph Theory Basics','Trees (Graph-Theoretic)','Recurrence Relations','Group Theory & Algebraic Structures Intro'] },
  'Business Ethics and IPR': { current:1, chapters:['Introduction to Business Ethics','Corporate Social Responsibility','Ethical Decision-Making Frameworks','Introduction to IP: Patents, Copyrights, Trademarks','Patent Filing Process','Copyright & Trade Secrets','IPR in the IT & Software Industry','Case Studies & Emerging Issues'] }
};
```

Replace with:

```js
const COURSE_CHAPTERS = {
  'Data Structures and Algorithms': { chapters:['Arrays & Complexity Analysis','Stacks','Queues','Linked Lists','Trees & Binary Search Trees','Graphs','Sorting Algorithms','Hashing','Heaps','Dynamic Programming'] },
  'Database Management System': { chapters:['Introduction to DBMS & File Systems','ER Model & Relational Model','Relational Algebra & SQL Basics','Advanced SQL (Joins, Subqueries, Views)','Normalization (1NF–BCNF)','Transactions & Concurrency Control','Indexing & Query Processing','NoSQL & Modern Databases Intro'] },
  'Object Oriented Programming': { chapters:['OOP Concepts: Classes & Objects','Constructors & Destructors','Inheritance','Polymorphism (Overloading & Overriding)','Abstract Classes & Interfaces','Exception Handling','File Handling & I/O','Collections & Generics'] },
  'Digital Electronics': { chapters:['Number Systems & Codes','Boolean Algebra & Logic Gates','Combinational Circuits (Adders, MUX, Decoders)','Karnaugh Maps & Minimization','Sequential Circuits (Flip-Flops, Latches)','Counters & Registers','Memory Devices (RAM/ROM)','A/D and D/A Converters Intro'] },
  'Discrete Mathematics': { chapters:['Set Theory & Relations','Propositional & Predicate Logic','Functions','Combinatorics (Permutations & Combinations)','Graph Theory Basics','Trees (Graph-Theoretic)','Recurrence Relations','Group Theory & Algebraic Structures Intro'] },
  'Business Ethics and IPR': { chapters:['Introduction to Business Ethics','Corporate Social Responsibility','Ethical Decision-Making Frameworks','Introduction to IP: Patents, Copyrights, Trademarks','Patent Filing Process','Copyright & Trade Secrets','IPR in the IT & Software Industry','Case Studies & Emerging Issues'] }
};
```

- [ ] **Step 2: Verify** — this intentionally breaks `initCourseChapters` and `renderTopicPattern`'s references to `data.current` until Tasks 6 and 7 fix them. No standalone check here; full verification happens in Task 11.

---

### Task 4: New progress-tracking helper functions

**Files:**
- Modify: `index.html` — insert right after the `COURSE_CHAPTERS` const (from Task 3), before `initCourseChapters`

- [ ] **Step 1: Add helpers**

Find (the `COURSE_CHAPTERS` closing brace from Task 3, immediately followed by `initCourseChapters`):

```js
  'Business Ethics and IPR': { chapters:['Introduction to Business Ethics','Corporate Social Responsibility','Ethical Decision-Making Frameworks','Introduction to IP: Patents, Copyrights, Trademarks','Patent Filing Process','Copyright & Trade Secrets','IPR in the IT & Software Industry','Case Studies & Emerging Issues'] }
};
function initCourseChapters(){
```

Replace with:

```js
  'Business Ethics and IPR': { chapters:['Introduction to Business Ethics','Corporate Social Responsibility','Ethical Decision-Making Frameworks','Introduction to IP: Patents, Copyrights, Trademarks','Patent Filing Process','Copyright & Trade Secrets','IPR in the IT & Software Industry','Case Studies & Emerging Issues'] }
};

/* ---------- TOPIC / SUBJECT PROGRESS (real, chat + manual + quiz driven) ---------- */
function getTopicProgress(){ return lsGet('forge-topic-progress', {}); }
function saveTopicProgress(data){ lsSet('forge-topic-progress', data); }
function subjectProgress(subject){
  const all = getTopicProgress();
  return all[subject] || { touched: [], done: [], weak: [], everWeak: [], lastActivity: null };
}

function touchChapter(subject, topicName){
  if(!subject || !topicName) return;
  const course = COURSE_CHAPTERS[subject];
  if(!course) return;
  let idx = course.chapters.indexOf(topicName);
  if(idx === -1) idx = course.chapters.findIndex(c => c.toLowerCase() === topicName.toLowerCase());
  if(idx === -1) return;
  const num = idx + 1;
  const all = getTopicProgress();
  const prog = all[subject] || { touched: [], done: [], weak: [], everWeak: [], lastActivity: null };
  if(!prog.touched.includes(num)) prog.touched.push(num);
  prog.lastActivity = new Date().toISOString();
  all[subject] = prog;
  saveTopicProgress(all);
}

function chapterStatus(subject, num){
  const prog = subjectProgress(subject);
  if(prog.weak.includes(num)) return 'weak';
  if(prog.done.includes(num)) return 'strong';
  if(prog.touched.includes(num)) return 'learning';
  return 'upcoming';
}

function cycleChapterStatus(subject, num){
  const all = getTopicProgress();
  const prog = all[subject] || { touched: [], done: [], weak: [], everWeak: [], lastActivity: null };
  const isDone = prog.done.includes(num);
  const isWeak = prog.weak.includes(num);
  if(!isDone && !isWeak){
    prog.done.push(num);
  } else if(isDone){
    prog.done = prog.done.filter(n => n !== num);
    prog.weak.push(num);
    if(!prog.everWeak.includes(num)) prog.everWeak.push(num);
  } else if(isWeak){
    prog.weak = prog.weak.filter(n => n !== num);
  }
  all[subject] = prog;
  saveTopicProgress(all);
}

function getQuizScores(){ return lsGet('forge-quiz-scores', {}); }
function saveQuizScores(data){ lsSet('forge-quiz-scores', data); }
function bumpQuizScore(subject, correct, total){
  const scores = getQuizScores();
  const existing = scores[subject] || { correct: 0, total: 0 };
  existing.correct += correct;
  existing.total += total;
  scores[subject] = existing;
  saveQuizScores(scores);
}

function computeReadiness(subject){
  const course = COURSE_CHAPTERS[subject];
  const total = course ? course.chapters.length : 0;
  const prog = subjectProgress(subject);
  const touchedOrDone = new Set([...prog.touched, ...prog.done]);
  const topicCoverage = total ? Math.round(touchedOrDone.size / total * 100) : 0;
  const weakTopic = prog.everWeak.length === 0 ? 100 : Math.round((prog.everWeak.length - prog.weak.length) / prog.everWeak.length * 100);
  const scores = getQuizScores()[subject];
  const mockScores = scores && scores.total ? Math.round(scores.correct / scores.total * 100) : 0;
  let recency = 0;
  if(prog.lastActivity){
    const days = (Date.now() - new Date(prog.lastActivity).getTime()) / 86400000;
    recency = Math.max(0, Math.round(100 - (days / 14 * 100)));
  }
  const overall = Math.round((topicCoverage + weakTopic + mockScores + recency) / 4);
  return { overall, topicCoverage, weakTopic, mockScores, recency };
}

function initCourseChapters(){
```

- [ ] **Step 2: Verify syntax**

Run the script-extraction check (see Task 11, Step 1) after all tasks, or spot-check now with:
```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
scripts.forEach((s,i)=>{ try { new Function(s); } catch(e){ console.log('Script '+i+' ERROR:', e.message); } });
console.log('checked', scripts.length, 'scripts');
"
```
Expected: `checked 2 scripts`, no ERROR lines. (This will still show nothing wrong even though `initCourseChapters`/`renderTopicPattern` reference removed fields — those are runtime logic issues, not syntax errors, fixed in Tasks 6-7.)

---

### Task 5: Rewrite `initCourseChapters` (Courses page) to use real data

**Files:**
- Modify: `index.html` (the `initCourseChapters` function, now directly after Task 4's helpers)

- [ ] **Step 1: Replace the function**

Find:

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
initCourseChapters();
```

Replace with:

```js
function initCourseChapters(){
  document.querySelectorAll('.course-chapters').forEach(container=>{
    const subject = container.dataset.chapters;
    const data = COURSE_CHAPTERS[subject];
    if(!data) return;
    container.innerHTML = data.chapters.map((name, idx)=>{
      const num = idx + 1;
      const realStatus = chapterStatus(subject, num);
      const status = realStatus === 'strong' ? 'done' : (realStatus === 'learning' || realStatus === 'weak') ? 'current' : '';
      const check = status === 'done' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>' : '';
      return `<div class="chapter-row ${status}"><span class="chapter-num">${num}</span><span class="chapter-check">${check}</span><span class="chapter-name">${name}</span></div>`;
    }).join('');
  });
  document.querySelectorAll('.course-row').forEach(row=>{
    row.addEventListener('click', ()=> row.closest('.course').classList.toggle('expanded'));
  });
}
initCourseChapters();
```

- [ ] **Step 2: Verify** — full check happens in Task 11 (browser check across both Courses and Exam Readiness).

---

### Task 6: Rewrite Exam Readiness (`READINESS_DATA`, `TOPIC_WEAK_OVERRIDE`, `readinessVerdictText`, `renderTopicPattern`, `renderReadiness`)

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Replace the whole block**

Find:

```js
/* ---------- EXAM READINESS ---------- */
const READINESS_DATA = {
  'Data Structures and Algorithms': { overall:0, topicCoverage:0, weakTopic:0, mockScores:0, recency:0 },
  'Database Management System':     { overall:0, topicCoverage:0, weakTopic:0, mockScores:0, recency:0 },
  'Object Oriented Programming':    { overall:0, topicCoverage:0, weakTopic:0, mockScores:0, recency:0 },
  'Digital Electronics':            { overall:0, topicCoverage:0, weakTopic:0, mockScores:0, recency:0 },
  'Discrete Mathematics':           { overall:0, topicCoverage:0, weakTopic:0, mockScores:0, recency:0 },
  'Business Ethics and IPR':        { overall:0, topicCoverage:0, weakTopic:0, mockScores:0, recency:0 }
};
const BAR_LABELS = [
  ['topicCoverage','Topic Coverage'],
  ['weakTopic','Weak-Topic Resolution'],
  ['mockScores','Mock Scores'],
  ['recency','Recency']
];

/* --- Topic pattern (reuses COURSE_CHAPTERS; flags a few as repeatedly-weak) --- */
const TOPIC_WEAK_OVERRIDE = {};

function readinessVerdictText(subject){
  const d = READINESS_DATA[subject];
  const weakCount = (TOPIC_WEAK_OVERRIDE[subject] || []).length;
  if(d.topicCoverage === 0 && d.mockScores === 0) return `No activity logged yet for ${subject} — this fills in as you study, take quizzes, and log mock scores.`;
  if(d.overall >= 80) return `Strong position for ${subject} — keep light review on ${weakCount} flagged topic${weakCount===1?'':'s'} and you're set.`;
  if(d.overall >= 55) return `On track for ${subject}, but ${weakCount} topic${weakCount===1?'':'s'} still need focused practice before the exam.`;
  return `${subject} needs attention — ${weakCount} weak topic${weakCount===1?'':'s'} and low mock coverage. Prioritize this subject this week.`;
}

function renderTopicPattern(subject){
  const list = document.getElementById('topicPatternList');
  const data = COURSE_CHAPTERS[subject];
  list.innerHTML = '';
  if(!data) return;
  const weakSet = new Set(TOPIC_WEAK_OVERRIDE[subject] || []);
  data.chapters.forEach((name, idx)=>{
    const num = idx + 1;
    let status;
    if(weakSet.has(num)) status = 'weak';
    else if(num < data.current) status = 'strong';
    else if(num === data.current) status = 'learning';
    else status = 'upcoming';
    const chip = document.createElement('div');
    chip.className = 'topic-chip ' + status;
    chip.innerHTML = `<span class="dot"></span>${name}`;
    list.appendChild(chip);
  });
}

function renderReadiness(subject){
  const d = READINESS_DATA[subject];
  document.getElementById('readinessSubject').textContent = subject;
  document.getElementById('readinessPct').textContent = d.overall + '%';
  document.getElementById('readinessVerdict').textContent = readinessVerdictText(subject);
  const ring = document.getElementById('readinessRing');
  const deg = (d.overall/100*360).toFixed(1);
  requestAnimationFrame(()=>{
    ring.style.background = `conic-gradient(var(--blue) ${deg}deg, var(--cream-2) ${deg}deg 360deg)`;
  });

  const barsWrap = document.getElementById('readinessBars');
  barsWrap.innerHTML = '';
  BAR_LABELS.forEach(([key,label])=>{
    const val = d[key];
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <div class="bar-row-head"><span class="name">${label}</span><span class="value">${val}%</span></div>
      <div class="bar-track"><div class="bar-fill"></div></div>`;
    barsWrap.appendChild(row);
    row.addEventListener('mousemove', (e)=> showTip(e, `<b>${val}%</b> — ${label}`));
    row.addEventListener('mouseleave', hideTip);
    requestAnimationFrame(()=>{ row.querySelector('.bar-fill').style.width = val + '%'; });
  });

  renderTopicPattern(subject);
}
document.getElementById('examSelect').addEventListener('change', (e)=> renderReadiness(e.target.value));
renderReadiness('Data Structures and Algorithms');
```

Replace with:

```js
/* ---------- EXAM READINESS (real, via computeReadiness from forge-topic-progress) ---------- */
const BAR_LABELS = [
  ['topicCoverage','Topic Coverage'],
  ['weakTopic','Weak-Topic Resolution'],
  ['mockScores','Mock Scores'],
  ['recency','Recency']
];

function readinessVerdictText(subject){
  const d = computeReadiness(subject);
  const weakCount = subjectProgress(subject).weak.length;
  if(d.topicCoverage === 0 && d.mockScores === 0) return `No activity logged yet for ${subject} — this fills in as you study, take quizzes, and log mock scores.`;
  if(d.overall >= 80) return `Strong position for ${subject} — keep light review on ${weakCount} flagged topic${weakCount===1?'':'s'} and you're set.`;
  if(d.overall >= 55) return `On track for ${subject}, but ${weakCount} topic${weakCount===1?'':'s'} still need focused practice before the exam.`;
  return `${subject} needs attention — ${weakCount} weak topic${weakCount===1?'':'s'} and low mock coverage. Prioritize this subject this week.`;
}

function renderTopicPattern(subject){
  const list = document.getElementById('topicPatternList');
  const data = COURSE_CHAPTERS[subject];
  list.innerHTML = '';
  if(!data) return;
  data.chapters.forEach((name, idx)=>{
    const num = idx + 1;
    const status = chapterStatus(subject, num);
    const chip = document.createElement('div');
    chip.className = 'topic-chip ' + status;
    chip.innerHTML = `<span class="dot"></span>${name}`;
    chip.addEventListener('click', ()=>{
      cycleChapterStatus(subject, num);
      renderReadiness(subject);
      initCourseChapters();
    });
    list.appendChild(chip);
  });
}

function renderReadiness(subject){
  const d = computeReadiness(subject);
  document.getElementById('readinessSubject').textContent = subject;
  document.getElementById('readinessPct').textContent = d.overall + '%';
  document.getElementById('readinessVerdict').textContent = readinessVerdictText(subject);
  const ring = document.getElementById('readinessRing');
  const deg = (d.overall/100*360).toFixed(1);
  requestAnimationFrame(()=>{
    ring.style.background = `conic-gradient(var(--blue) ${deg}deg, var(--cream-2) ${deg}deg 360deg)`;
  });

  const barsWrap = document.getElementById('readinessBars');
  barsWrap.innerHTML = '';
  BAR_LABELS.forEach(([key,label])=>{
    const val = d[key];
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <div class="bar-row-head"><span class="name">${label}</span><span class="value">${val}%</span></div>
      <div class="bar-track"><div class="bar-fill"></div></div>`;
    barsWrap.appendChild(row);
    row.addEventListener('mousemove', (e)=> showTip(e, `<b>${val}%</b> — ${label}`));
    row.addEventListener('mouseleave', hideTip);
    requestAnimationFrame(()=>{ row.querySelector('.bar-fill').style.width = val + '%'; });
  });

  renderTopicPattern(subject);
}
document.getElementById('examSelect').addEventListener('change', (e)=> renderReadiness(e.target.value));
renderReadiness('Data Structures and Algorithms');
```

- [ ] **Step 2: Verify** — full check happens in Task 11.

---

### Task 7: CSS — clickable topic chips + "strong" background

**Files:**
- Modify: `index.html` (the `.topic-chip` rule block)

- [ ] **Step 1: Add `cursor:pointer` and a `strong` background**

Find:

```css
  .topic-pattern-list{ display:flex; flex-wrap:wrap; gap:8px; }
  .topic-chip{
    display:flex; align-items:center; gap:7px; font-size:12px; font-weight:600; padding:7px 13px;
    border-radius:100px; background:var(--cream-2);
  }
  .topic-chip .dot{ width:8px; height:8px; border-radius:50%; flex-shrink:0; }
  .topic-chip.strong .dot{ background:var(--green); }
  .topic-chip.learning{ background:var(--blue-soft); }
  .topic-chip.learning .dot{ background:var(--blue); }
  .topic-chip.weak{ background:var(--pink-soft); }
  .topic-chip.weak .dot{ background:var(--pink); }
  .topic-chip.upcoming{ opacity:.55; }
  .topic-chip.upcoming .dot{ background:var(--ink-soft); }
```

Replace with:

```css
  .topic-pattern-list{ display:flex; flex-wrap:wrap; gap:8px; }
  .topic-chip{
    display:flex; align-items:center; gap:7px; font-size:12px; font-weight:600; padding:7px 13px;
    border-radius:100px; background:var(--cream-2); cursor:pointer; user-select:none;
  }
  .topic-chip .dot{ width:8px; height:8px; border-radius:50%; flex-shrink:0; }
  .topic-chip.strong{ background:var(--green-soft); }
  .topic-chip.strong .dot{ background:var(--green); }
  .topic-chip.learning{ background:var(--blue-soft); }
  .topic-chip.learning .dot{ background:var(--blue); }
  .topic-chip.weak{ background:var(--pink-soft); }
  .topic-chip.weak .dot{ background:var(--pink); }
  .topic-chip.upcoming{ opacity:.55; }
  .topic-chip.upcoming .dot{ background:var(--ink-soft); }
```

- [ ] **Step 2: Verify** — visual confirmation in Task 11.

---

### Task 8: `sendDoubt` records chat activity into topic progress

**Files:**
- Modify: `index.html` (the `sendDoubt` function)

- [ ] **Step 1: Add `touchChapter` call and persist `topic` in `aiData`**

Find:

```js
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

Replace with:

```js
  if(!entry) entry = findAnswer(text);
  if(entry) logDoubtHistory(text, entry.subject);
  if(entry) touchChapter(entry.subject, entry.topic);

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
      ? { subject: entry.subject, topic: entry.topic || null, explanation: entry.explanation, keyConcept: entry.keyConcept, example: entry.example, tier, apiFailed }
      : { subject: null, topic: null, explanation: null, keyConcept: null, example: null, tier, apiFailed }
  });
  saveChatMessages(afterAiMessages);
}
```

Note: `renderStoredMessage` (added in the previous chat-memory feature) reconstructs `entry` from `msg.aiData` on page-load restore, but must NOT call `touchChapter` again — a chapter is touched once, at the moment the message was originally sent, not every time the page reloads and replays history. No change needed to `renderStoredMessage` since it never calls `touchChapter` — just confirm it doesn't, in Step 2 below.

- [ ] **Step 2: Verify `renderStoredMessage` doesn't call `touchChapter`**

Run:
```bash
grep -n "touchChapter" "index.html"
```
Expected: exactly one match, inside `sendDoubt` (the line just added in Step 1). If `renderStoredMessage` shows up too, something is wrong — it shouldn't.

---

### Task 9: Per-subject MCQ quiz scores

**Files:**
- Modify: `index.html` (the `showMcqScore` function)

- [ ] **Step 1: Add `bumpQuizScore` call**

Find:

```js
  bumpStat('quizzes', 1);
  bumpStat('mcqCorrect', mcqCorrectCount);
  bumpStat('mcqTotal', mcqPool.length);
  renderActivityStats();
}
```

Replace with:

```js
  bumpStat('quizzes', 1);
  bumpStat('mcqCorrect', mcqCorrectCount);
  bumpStat('mcqTotal', mcqPool.length);
  bumpQuizScore(quizSubject(), mcqCorrectCount, mcqPool.length);
  renderActivityStats();
}
```

- [ ] **Step 2: Verify** — full check happens in Task 11.

---

### Task 10: Sync `index.html` → `student-dashboard.html`

**Files:**
- Modify: `student-dashboard.html`

- [ ] **Step 1: Copy the file**

```bash
cp "index.html" "student-dashboard.html"
```

- [ ] **Step 2: Verify identical**

```bash
diff "index.html" "student-dashboard.html"
```
Expected: no output.

---

### Task 11: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Syntax check both inline scripts**

```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
scripts.forEach((s,i)=>{ try { new Function(s); } catch(e){ console.log('Script '+i+' ERROR:', e.message); } });
console.log('checked', scripts.length, 'scripts');
"
```
Expected: `checked 2 scripts`, no `ERROR` lines.

- [ ] **Step 2: Confirm no duplicate function definitions**

```bash
for fn in getTopicProgress saveTopicProgress subjectProgress touchChapter chapterStatus cycleChapterStatus getQuizScores saveQuizScores bumpQuizScore computeReadiness readinessVerdictText renderTopicPattern renderReadiness initCourseChapters; do
  n=$(grep -c "^function $fn(" index.html)
  echo "$fn: $n"
done
```
Expected: every count is `1`.

- [ ] **Step 3: Confirm the dev server is running and hits the backend correctly**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8888/
```
Expected: `200`. If not running: `netlify dev --port 8888` from the project root.

```bash
curl -s -X POST http://localhost:8888/.netlify/functions/ask-doubt \
  -H "content-type: application/json" \
  -d '{"question":"how does a hash table resolve collisions","tier":"tier1","history":[]}'
```
Expected: a response whose `"topic"` field is exactly `"Hashing"` (a real `COURSE_CHAPTERS` DSA chapter name) — confirms the model is using the injected chapter list correctly. (If this 400s/500s on credits again, that's the known OpenRouter balance issue, not a code problem — fall back to Step 5's offline check instead.)

- [ ] **Step 4: Browser check — chat drives topic progress**

1. In Ask Forge, ask a DSA question that clearly maps to one chapter (e.g. "explain how a hash table works").
2. Open the Exam Readiness view for "Data Structures and Algorithms" — confirm the "Hashing" chip shows `learning` status (blue), and Topic Coverage % is above 0.
3. Click that chip once — confirm it turns `strong`/green (done) and Topic Coverage increases.
4. Click again — confirm it turns `weak`/pink.
5. Click a third time — confirm it returns to `learning` (blue), not `upcoming` — because `touched` (from chat) persists even when manual overrides are cleared.
6. Open the Courses view, expand "Data Structures and Algorithms" — confirm "Hashing" shows the matching done/current styling consistent with what Exam Readiness showed before your 3 clicks (i.e. re-check after step 3's "done" click specifically, since Task 6's chip handler also calls `initCourseChapters()` to keep both views in sync).

- [ ] **Step 5: Browser check — offline fallback still updates progress**

1. Stop the dev server.
2. Ask "what is a stack" in chat — confirm the offline fallback still answers.
3. Reload, check Exam Readiness for DSA — confirm "Stacks" (chapter 2) shows `learning` status even though the API was down for that question.

- [ ] **Step 6: Browser check — per-subject quiz scores**

1. Restart the dev server if stopped.
2. Take an MCQ quiz for one subject, finish it.
3. Check that subject's Exam Readiness — confirm Mock Scores % matches the quiz result (e.g. 8/10 correct → 80%).

- [ ] **Step 7: Recency formula sanity check**

In devtools console:
```js
JSON.parse(localStorage.getItem('forge-topic-progress'))
```
Confirm `lastActivity` for the subject you tested is a recent ISO timestamp, and that subject's Recency bar on Exam Readiness reads close to 100%.
