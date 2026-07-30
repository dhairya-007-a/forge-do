# Real Data, Notes Sketchnote Style, PDF Export — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fake/hardcoded dashboard data with real localStorage-backed data, redesign generated Notes to a sketchnote/infographic look, add photo/drawing attachments, and add a PDF export — all inside the existing single-file `index.html` (kept byte-identical to `student-dashboard.html`).

**Architecture:** No backend exists and none is being added (confirmed scope). Everything is vanilla JS in the existing inline `<script>` block (starts at `index.html:2373`), reading/writing `localStorage`. Each dashboard number that is currently fake gets a small data module (seed constant + `get*`/`add*` functions) colocated with the code that already renders it, following the existing `ACTIVITY_SEED` / `getStat`/`bumpStat` pattern already in the file.

**Tech Stack:** Plain HTML/CSS/JS, no build step, no dependencies added. `window.print()` + a `@media print` stylesheet for PDF (no library). `<canvas>` for freehand drawing.

**Testing approach (adapted — no test runner exists in this project):** Pure, DOM-free logic (GPA math, deadline counting, streak math) is verified with a throwaway `node -e` command that inlines the exact function body and asserts on it — this is the closest equivalent to a unit test available without adding build/test tooling to a single static HTML file, which would be scope creep. DOM-rendering and visual changes (course cards, notes styling, PDF print layout, drawing canvas) are verified manually by opening `index.html` in a browser and checking the described behavior — there is no headless browser tool available in this environment. Every task still ends in a commit.

---

## File Structure

Everything lives in `index.html` (`student-dashboard.html` is re-synced from it in the final task). No new files are created except the plan/spec docs already written.

| Region | Responsibility |
|---|---|
| `index.html:2373` (script start) | New: generic `lsGet`/`lsSet` JSON localStorage helpers |
| `index.html` Courses section (~1927, ~2645) | New: `COURSE_SEED`, `getCourses`, `addCourse`, `renderCourseList`, add-course form |
| `index.html` Deadlines section (~2014) | New: `DEADLINE_SEED`, `getDeadlines`, `addDeadline`, `renderDeadlines`, add-deadline form |
| `index.html` Exam History section (~3047) | Changed: `EXAM_HISTORY` seed → `getExamScores`/`addExamScore`, GPA calc |
| `index.html` Pomodoro + Heatmap (~2731, ~3199) | Changed: real study-time logging replaces `mulberry32` random data |
| `index.html` top `.stats` row (~1701-1742) | Changed: 4 tiles get `id`s and are populated by the above |
| `index.html` Notes CSS/JS (~971, ~1236, ~3532) | Changed: sketchnote visual style for `.ai-card`/`.note-*` |
| `index.html` Notes actions (~3541) | New: photo attach, draw-canvas attach, PDF export |

---

### Task 1: Generic localStorage JSON helpers

**Files:**
- Modify: `index.html:2373-2375`

- [ ] **Step 1: Add the helpers**

Current text at `index.html:2373-2375`:
```html
<script>
/* ---------- SPLASH SCREEN ---------- */
document.body.style.overflow = 'hidden';
```

Replace with:
```html
<script>
/* ---------- LOCAL DATA HELPERS ---------- */
function lsGet(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch(e){ return fallback; }
}
function lsSet(key, value){ localStorage.setItem(key, JSON.stringify(value)); }

/* ---------- SPLASH SCREEN ---------- */
document.body.style.overflow = 'hidden';
```

- [ ] **Step 2: Verify with Node**

Run:
```bash
node -e "
function lsSet(k,v){ global.__store = global.__store||{}; global.__store[k]=JSON.stringify(v); }
function lsGet(k,fb){ const raw = (global.__store||{})[k]; try{ return raw?JSON.parse(raw):fb; }catch(e){ return fb; } }
lsSet('x', {a:1});
console.assert(JSON.stringify(lsGet('x', null)) === JSON.stringify({a:1}), 'roundtrip failed');
console.assert(lsGet('missing', 'fallback') === 'fallback', 'fallback failed');
console.log('OK');
"
```
Expected: `OK` printed, no assertion errors.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add localStorage JSON helpers"
```

---

### Task 2: Real Courses data + render + Active Courses tile

**Files:**
- Modify: `index.html:1701-1711` (top stats tile c1)
- Modify: `index.html:1927-1985` (course-list block)
- Modify: `index.html:2645-2666` (COURSE_CHAPTERS / initCourseChapters area)

- [ ] **Step 1: Give the "Active Courses" tile an id**

Current text at `index.html:1702-1711`:
```html
      <div class="stat-card c1 anim anim-d1">
        <div class="stamp">+2 today</div>
        <div class="icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="#9C3A48" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
        </div>
        <div>
          <div class="num">5</div>
          <div class="label">Active Courses</div>
        </div>
      </div>
```

Replace with:
```html
      <div class="stat-card c1 anim anim-d1">
        <div class="icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="#9C3A48" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
        </div>
        <div>
          <div class="num" id="activeCoursesNum">—</div>
          <div class="label">Active Courses</div>
        </div>
      </div>
```
(The `.stamp` "+2 today" badge is removed here — it was a fixed claim with no real data behind it. If you want a real "new this week" badge later, derive it from `course.addedDate`, but that's not in this plan's scope.)

- [ ] **Step 2: Replace the hardcoded course-list block with an empty mount point**

Current text at `index.html:1927-1985`:
```html
      <div class="course-list" id="courseList">

          <div class="course" data-name="data structures cs201 iqbal" data-course="Data Structures">
            <div class="course-row">
              <div class="thumb" style="background:var(--pink);">DS</div>
              <div class="info">
                <div class="top-row"><h3>Data Structures</h3><span class="tag">CS201</span></div>
                <div class="meta">Prof. Iqbal · Chapter 6 of 10</div>
                <div class="progress-track"><div class="progress-fill" data-progress="72" style="background:var(--pink);"></div></div>
              </div>
              <div class="pct">72%</div>
              <svg class="course-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
            </div>
            <div class="course-chapters" data-chapters="Data Structures"></div>
          </div>

          <div class="course" data-name="ux design basics des110 farah" data-course="UX Design Basics">
            <div class="course-row">
              <div class="thumb" style="background:var(--blue);">UX</div>
              <div class="info">
                <div class="top-row"><h3>UX Design Basics</h3><span class="tag">DES110</span></div>
                <div class="meta">Prof. Farah · Chapter 3 of 8</div>
                <div class="progress-track"><div class="progress-fill" data-progress="45" style="background:var(--blue);"></div></div>
              </div>
              <div class="pct">45%</div>
              <svg class="course-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
            </div>
            <div class="course-chapters" data-chapters="UX Design Basics"></div>
          </div>

          <div class="course" data-name="calculus ii mth204 reza" data-course="Calculus II">
            <div class="course-row">
              <div class="thumb" style="background:var(--green);">CL</div>
              <div class="info">
                <div class="top-row"><h3>Calculus II</h3><span class="tag">MTH204</span></div>
                <div class="meta">Prof. Reza · Chapter 9 of 12</div>
                <div class="progress-track"><div class="progress-fill" data-progress="88" style="background:var(--green);"></div></div>
              </div>
              <div class="pct">88%</div>
              <svg class="course-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
            </div>
            <div class="course-chapters" data-chapters="Calculus II"></div>
          </div>

          <div class="course" data-name="microeconomics eco101 nabil" data-course="Microeconomics">
            <div class="course-row">
              <div class="thumb" style="background:var(--yellow);">EC</div>
              <div class="info">
                <div class="top-row"><h3>Microeconomics</h3><span class="tag">ECO101</span></div>
                <div class="meta">Prof. Nabil · Chapter 2 of 9</div>
                <div class="progress-track"><div class="progress-fill" data-progress="24" style="background:var(--yellow);"></div></div>
              </div>
              <div class="pct">24%</div>
              <svg class="course-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
            </div>
            <div class="course-chapters" data-chapters="Microeconomics"></div>
          </div>

        </div>
    </section>
    </div>
```

Replace with:
```html
      <div class="quickadd-row" id="courseAddRow" style="display:none;">
        <input type="text" id="courseNameInput" placeholder="Course name">
        <input type="text" id="courseCodeInput" placeholder="Code (optional)" style="max-width:140px;">
        <input type="number" id="courseProgressInput" placeholder="% done" min="0" max="100" style="max-width:100px;">
        <button class="fc-gen-btn btn-pop" id="courseAddSubmit">Add</button>
      </div>
      <div class="course-list" id="courseList"></div>
    </section>
    </div>
```

- [ ] **Step 3: Add the course data layer and render function**

Current text at `index.html:2645-2666` (the `COURSE_CHAPTERS` block and `initCourseChapters`):
```js
const COURSE_CHAPTERS = {
  'Data Structures': { current:6, chapters:['Arrays & Complexity','Stacks','Queues','Linked Lists','Trees & BSTs','Graphs','Sorting Algorithms','Hashing','Heaps','Dynamic Programming'] },
  'UX Design Basics': { current:3, chapters:['Design Thinking Basics','User Research','Wireframing','Prototyping','Usability Testing','Visual Design Principles','Interaction Patterns','Portfolio Case Study'] },
  'Calculus II': { current:9, chapters:['Limits Review','Techniques of Integration','Applications of Integrals','Sequences','Series Convergence','Power Series','Taylor Series','Parametric Equations','Polar Coordinates','Vectors in 2D/3D','Partial Derivatives Intro','Multiple Integrals Intro'] },
  'Microeconomics': { current:2, chapters:['Intro to Economic Thinking','Supply & Demand','Elasticity','Consumer Theory','Production & Costs','Market Structures','Game Theory Basics','Market Failures','Welfare Economics'] }
};
function initCourseChapters(){
  document.querySelectorAll('.course-chapters').forEach(container=>{
    const data = COURSE_CHAPTERS[container.dataset.chapters];
    if(!data) return;
    container.innerHTML = data.chapters.map((name, idx)=>{
      const num = idx + 1;
      const status = num < data.current ? 'done' : num === data.current ? 'current' : '';
      const check = status === 'done' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"\><\svg>' : '';
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
const COURSE_CHAPTERS = {
  'Data Structures': { current:6, chapters:['Arrays & Complexity','Stacks','Queues','Linked Lists','Trees & BSTs','Graphs','Sorting Algorithms','Hashing','Heaps','Dynamic Programming'] },
  'UX Design Basics': { current:3, chapters:['Design Thinking Basics','User Research','Wireframing','Prototyping','Usability Testing','Visual Design Principles','Interaction Patterns','Portfolio Case Study'] },
  'Calculus II': { current:9, chapters:['Limits Review','Techniques of Integration','Applications of Integrals','Sequences','Series Convergence','Power Series','Taylor Series','Parametric Equations','Polar Coordinates','Vectors in 2D/3D','Partial Derivatives Intro','Multiple Integrals Intro'] },
  'Microeconomics': { current:2, chapters:['Intro to Economic Thinking','Supply & Demand','Elasticity','Consumer Theory','Production & Costs','Market Structures','Game Theory Basics','Market Failures','Welfare Economics'] }
};

const COURSE_SEED = [
  { id:'seed-ds', name:'Data Structures', code:'CS201', professor:'Prof. Iqbal', color:'pink', progress:72 },
  { id:'seed-ux', name:'UX Design Basics', code:'DES110', professor:'Prof. Farah', color:'blue', progress:45 },
  { id:'seed-cl', name:'Calculus II', code:'MTH204', professor:'Prof. Reza', color:'green', progress:88 },
  { id:'seed-ec', name:'Microeconomics', code:'ECO101', professor:'Prof. Nabil', color:'yellow', progress:24 }
];
function getCourses(){
  let courses = lsGet('forge-courses', null);
  if(!courses){ courses = COURSE_SEED.slice(); lsSet('forge-courses', courses); }
  return courses;
}
function addCourse(course){
  const courses = getCourses();
  courses.push(course);
  lsSet('forge-courses', courses);
  return courses;
}
function courseThumbInitials(name){
  return name.trim().split(/\s+/).slice(0,2).map(w=>w[0].toUpperCase()).join('');
}
function renderCourseList(){
  const courses = getCourses();
  const list = document.getElementById('courseList');
  list.innerHTML = courses.map(c=>{
    const chapterData = COURSE_CHAPTERS[c.name];
    const searchKey = [c.name, c.code, c.professor].filter(Boolean).join(' ').toLowerCase();
    const chevron = chapterData ? `<svg class="course-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>` : '';
    const chaptersDiv = chapterData ? `<div class="course-chapters" data-chapters="${c.name}"></div>` : '';
    return `
      <div class="course" data-name="${searchKey}" data-course="${c.name}">
        <div class="course-row">
          <div class="thumb" style="background:var(--${c.color});">${courseThumbInitials(c.name)}</div>
          <div class="info">
            <div class="top-row"><h3>${c.name}</h3>${c.code ? `<span class="tag">${c.code}</span>` : ''}</div>
            <div class="meta">${c.professor || 'Self-tracked'}</div>
            <div class="progress-track"><div class="progress-fill" data-progress="${c.progress}" style="background:var(--${c.color}); width:${c.progress}%;"></div></div>
          </div>
          <div class="pct">${c.progress}%</div>
          ${chevron}
        </div>
        ${chaptersDiv}
      </div>`;
  }).join('');
  document.getElementById('activeCoursesNum').textContent = courses.length;
}
function initCourseChapters(){
  document.querySelectorAll('.course-chapters').forEach(container=>{
    const data = COURSE_CHAPTERS[container.dataset.chapters];
    if(!data) return;
    container.innerHTML = data.chapters.map((name, idx)=>{
      const num = idx + 1;
      const status = num < data.current ? 'done' : num === data.current ? 'current' : '';
      const check = status === 'done' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"\><\svg>' : '';
      return `<div class="chapter-row ${status}"><span class="chapter-num">${num}</span><span class="chapter-check">${check}</span><span class="chapter-name">${name}</span></div>`;
    }).join('');
  });
  document.querySelectorAll('.course-row').forEach(row=>{
    row.addEventListener('click', ()=> row.closest('.course').classList.toggle('expanded'));
  });
}
renderCourseList();
initCourseChapters();
document.getElementById('courseAddSubmit').addEventListener('click', ()=>{
  const name = document.getElementById('courseNameInput').value.trim();
  if(!name){ showToast('Enter a course name first'); return; }
  const code = document.getElementById('courseCodeInput').value.trim();
  let progress = parseInt(document.getElementById('courseProgressInput').value, 10);
  if(isNaN(progress)) progress = 0;
  progress = Math.max(0, Math.min(100, progress));
  const palette = ['pink','blue','green','yellow'];
  const color = palette[getCourses().length % palette.length];
  addCourse({ id:'c-' + Date.now(), name, code, professor:'', color, progress });
  renderCourseList();
  initCourseChapters();
  document.getElementById('courseNameInput').value = '';
  document.getElementById('courseCodeInput').value = '';
  document.getElementById('courseProgressInput').value = '';
  document.getElementById('courseAddRow').style.display = 'none';
  showToast('Course added');
});
```

- [ ] **Step 4: Wire the "See all →" link in the panel head to toggle the add-course row**

Current text at `index.html:1923-1926`:
```html
      <div class="panel-head">
        <h2>My Courses</h2>
        <a href="#" onclick="event.preventDefault(); showToast('That would show your full course list');">See all →</a>
      </div>
```

Replace with:
```html
      <div class="panel-head">
        <h2>My Courses</h2>
        <a href="#" id="courseAddToggle" onclick="event.preventDefault(); const r=document.getElementById('courseAddRow'); r.style.display = r.style.display==='none' ? 'flex' : 'none';">+ Add Course</a>
      </div>
```

- [ ] **Step 5: Add minimal CSS for the quick-add row**

Add this near the end of the existing `<style>` block, immediately before the closing `</style>` at `index.html:1442` (the line right after the new `@media (max-width:480px)` block added in the earlier bug fix):

```css
  .quickadd-row{ display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap; }
  .quickadd-row input{
    flex:1; min-width:120px; border:1px solid rgba(36,31,24,0.12); border-radius:12px;
    padding:10px 12px; font-family:'Inter'; font-size:13px; background:var(--cream-2); color:var(--ink); outline:none;
  }
  .quickadd-row input:focus{ border-color:var(--ink-soft); }
```

- [ ] **Step 6: Manual verification**

Open `index.html` in a browser:
1. Go to the Courses view — confirm the same 4 seed courses appear (Data Structures 72%, UX Design Basics 45%, Calculus II 88%, Microeconomics 24%), still expandable with chapters.
2. Go to the dashboard home — "Active Courses" tile shows `4`.
3. Back on Courses, click "+ Add Course", fill in a name (e.g. "Organic Chemistry") and 30% progress, click Add — confirm a new card appears with no expand chevron (no chapter data for it), and the dashboard's "Active Courses" tile now shows `5`.
4. Refresh the page — confirm the added course persists (it's in `localStorage['forge-courses']`).

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat: real course data with add-course form, wire Active Courses tile"
```

---

### Task 3: Real Deadlines data + render + Assignments Due tile

**Files:**
- Modify: `index.html:1712-1721` (top stats tile c2)
- Modify: `index.html:2010-2035` (deadlines panel block)

- [ ] **Step 1: Give the "Assignments Due" tile an id**

Current text at `index.html:1712-1721`:
```html
      <div class="stat-card c2 anim anim-d2">
        <div class="stamp">Due Fri</div>
        <div class="icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="#423C8C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
        </div>
        <div>
          <div class="num">3</div>
          <div class="label">Assignments Due</div>
        </div>
      </div>
```

Replace with:
```html
      <div class="stat-card c2 anim anim-d2">
        <div class="icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="#423C8C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
        </div>
        <div>
          <div class="num" id="assignmentsDueNum">—</div>
          <div class="label">Assignments Due</div>
        </div>
      </div>
```

- [ ] **Step 2: Replace hardcoded deadlines with a mount point + add-deadline row**

Current text at `index.html:2010-2035`:
```html
    <section class="panel anim anim-d3" style="margin-top:20px;">
      <div class="panel-head">
        <h2>Upcoming Deadlines</h2>
      </div>
      <div class="deadline" onclick="showToast('UX Case Study Draft · due Jul 25')">
        <div class="date-stamp"><b>25</b><span>Jul</span></div>
        <div class="d-info">
          <h4>UX Case Study Draft</h4>
          <p>UX Design Basics</p>
        </div>
      </div>
      <div class="deadline" onclick="showToast('Microeconomics midterm · Jul 27')">
        <div class="date-stamp"><b>27</b><span>Jul</span></div>
        <div class="d-info">
          <h4>Midterm — Microeconomics</h4>
          <p>Online, 90 minutes</p>
        </div>
      </div>
      <div class="deadline" onclick="showToast('Group presentation · Aug 2')">
        <div class="date-stamp"><b>02</b><span>Aug</span></div>
        <div class="d-info">
          <h4>Group Project Presentation</h4>
          <p>Data Structures</p>
        </div>
      </div>
    </section>
```

Replace with:
```html
    <section class="panel anim anim-d3" style="margin-top:20px;">
      <div class="panel-head">
        <h2>Upcoming Deadlines</h2>
        <a href="#" id="deadlineAddToggle" onclick="event.preventDefault(); const r=document.getElementById('deadlineAddRow'); r.style.display = r.style.display==='none' ? 'flex' : 'none';">+ Add</a>
      </div>
      <div class="quickadd-row" id="deadlineAddRow" style="display:none;">
        <input type="text" id="deadlineTitleInput" placeholder="Assignment title">
        <input type="text" id="deadlineCourseInput" placeholder="Course (optional)" style="max-width:160px;">
        <input type="date" id="deadlineDateInput" style="max-width:150px;">
        <button class="fc-gen-btn btn-pop" id="deadlineAddSubmit">Add</button>
      </div>
      <div id="deadlineList"></div>
    </section>
```

- [ ] **Step 3: Add the deadline data layer and render function**

Add this new script section right after the `renderCourseList`/course code block from Task 2 (i.e. immediately after the `document.getElementById('courseAddSubmit').addEventListener(...)` block ends, before `/* ---------- POMODORO ---------- */`):

```js
/* ---------- DEADLINES ---------- */
const DEADLINE_SEED = [
  { id:'d-seed-1', title:'UX Case Study Draft', course:'UX Design Basics', dueDate:'2026-07-25' },
  { id:'d-seed-2', title:'Midterm — Microeconomics', course:'Online, 90 minutes', dueDate:'2026-07-27' },
  { id:'d-seed-3', title:'Group Project Presentation', course:'Data Structures', dueDate:'2026-08-02' }
];
function getDeadlines(){
  let deadlines = lsGet('forge-deadlines', null);
  if(!deadlines){ deadlines = DEADLINE_SEED.slice(); lsSet('forge-deadlines', deadlines); }
  return deadlines;
}
function addDeadline(d){
  const deadlines = getDeadlines();
  deadlines.push(d);
  lsSet('forge-deadlines', deadlines);
  return deadlines;
}
function countUpcomingDeadlines(deadlines, today){
  const t = new Date(today); t.setHours(0,0,0,0);
  return deadlines.filter(d => { const dd = new Date(d.dueDate); dd.setHours(0,0,0,0); return dd.getTime() >= t.getTime(); }).length;
}
function renderDeadlines(){
  const deadlines = [...getDeadlines()].sort((a,b)=> new Date(a.dueDate) - new Date(b.dueDate));
  const list = document.getElementById('deadlineList');
  const MON_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  list.innerHTML = deadlines.map(d=>{
    const dt = new Date(d.dueDate);
    return `
      <div class="deadline" onclick="showToast('${d.title.replace(/'/g,"\\'")} · due ${MON_SHORT[dt.getMonth()]} ${dt.getDate()}')">
        <div class="date-stamp"><b>${String(dt.getDate()).padStart(2,'0')}</b><span>${MON_SHORT[dt.getMonth()]}</span></div>
        <div class="d-info">
          <h4>${d.title}</h4>
          <p>${d.course || ''}</p>
        </div>
      </div>`;
  }).join('');
  document.getElementById('assignmentsDueNum').textContent = countUpcomingDeadlines(getDeadlines(), new Date());
}
renderDeadlines();
document.getElementById('deadlineAddSubmit').addEventListener('click', ()=>{
  const title = document.getElementById('deadlineTitleInput').value.trim();
  const dueDate = document.getElementById('deadlineDateInput').value;
  if(!title || !dueDate){ showToast('Enter a title and due date'); return; }
  const course = document.getElementById('deadlineCourseInput').value.trim();
  addDeadline({ id:'d-' + Date.now(), title, course, dueDate });
  renderDeadlines();
  document.getElementById('deadlineTitleInput').value = '';
  document.getElementById('deadlineCourseInput').value = '';
  document.getElementById('deadlineDateInput').value = '';
  document.getElementById('deadlineAddRow').style.display = 'none';
  showToast('Deadline added');
});
```

- [ ] **Step 4: Verify `countUpcomingDeadlines` with Node**

Run:
```bash
node -e "
function countUpcomingDeadlines(deadlines, today){
  const t = new Date(today); t.setHours(0,0,0,0);
  return deadlines.filter(d => { const dd = new Date(d.dueDate); dd.setHours(0,0,0,0); return dd.getTime() >= t.getTime(); }).length;
}
const deadlines = [{dueDate:'2020-01-01'},{dueDate:'2099-01-01'},{dueDate:'2099-06-01'}];
console.assert(countUpcomingDeadlines(deadlines, new Date('2026-07-28')) === 2, 'expected 2 upcoming');
console.assert(countUpcomingDeadlines(deadlines, new Date('2099-06-01')) === 1, 'expected 1 on exact due date');
console.log('OK');
"
```
Expected: `OK` printed, no assertion errors.

- [ ] **Step 5: Manual verification**

1. Open `index.html`, go to Schedule view — confirm the 3 seed deadlines still render (UX Case Study Draft Jul 25, Midterm Microeconomics Jul 27, Group Project Presentation Aug 2), clicking one still toasts.
2. Dashboard "Assignments Due" tile shows `3` if today's date is before Aug 2 2026 (it is — today is 2026-07-28), or fewer if seed dates have passed.
3. Click "+ Add" next to Upcoming Deadlines, add a future-dated assignment, confirm it appears sorted by date and the tile count increments.
4. Refresh — confirm persistence.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: real deadlines data with add-deadline form, wire Assignments Due tile"
```

---

### Task 4: Real Exam Scores + GPA tile

**Files:**
- Modify: `index.html:1722-1731` (top stats tile c3)
- Modify: `index.html:1912-1917` (Exam History panel head)
- Modify: `index.html:3047-3069` (`EXAM_HISTORY` / `renderExamHistory`)

- [ ] **Step 1: Give the "Current GPA" tile an id**

Current text at `index.html:1722-1731`:
```html
      <div class="stat-card c3 anim anim-d3">
        <div class="stamp">↑ 4%</div>
        <div class="icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="#5F6B2E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3 7h7l-5.5 4.5L18.5 21 12 16.5 5.5 21l2-7.5L2 9h7z"/></svg>
        </div>
        <div>
          <div class="num">3.7</div>
          <div class="label">Current GPA</div>
        </div>
      </div>
```

Replace with:
```html
      <div class="stat-card c3 anim anim-d3">
        <div class="icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="#5F6B2E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3 7h7l-5.5 4.5L18.5 21 12 16.5 5.5 21l2-7.5L2 9h7z"/></svg>
        </div>
        <div>
          <div class="num" id="currentGpaNum">—</div>
          <div class="label">Current GPA</div>
        </div>
      </div>
```

- [ ] **Step 2: Add a "+ Log score" link to the Exam History panel head**

Current text at `index.html:1912-1917`:
```html
    <section class="panel anim">
      <div class="panel-head">
        <h2>Exam History</h2>
      </div>
      <div class="exam-history-list" id="examHistoryList"></div>
    </section>
```

Replace with:
```html
    <section class="panel anim">
      <div class="panel-head">
        <h2>Exam History</h2>
        <a href="#" id="examAddToggle" onclick="event.preventDefault(); const r=document.getElementById('examAddRow'); r.style.display = r.style.display==='none' ? 'flex' : 'none';">+ Log score</a>
      </div>
      <div class="quickadd-row" id="examAddRow" style="display:none;">
        <input type="text" id="examSubjectInput" placeholder="Subject">
        <input type="text" id="examLabelInput" placeholder="e.g. Midterm" style="max-width:140px;">
        <input type="number" id="examScoreInput" placeholder="Score %" min="0" max="100" style="max-width:100px;">
        <input type="date" id="examDateInput" style="max-width:150px;">
        <button class="fc-gen-btn btn-pop" id="examAddSubmit">Add</button>
      </div>
      <div class="exam-history-list" id="examHistoryList"></div>
    </section>
```

- [ ] **Step 3: Replace `EXAM_HISTORY` constant with real storage + GPA calc**

Current text at `index.html:3046-3069`:
```js
/* --- Exam history --- */
const EXAM_HISTORY = [
  { subject:'Data Structures', date:'2026-04-10', label:'Midterm', score:78 },
  { subject:'Calculus II', date:'2026-05-02', label:'Quiz 3', score:91 },
  { subject:'Microeconomics', date:'2026-05-20', label:'Midterm', score:64 },
  { subject:'UX Design Basics', date:'2026-06-15', label:'Studio Review', score:82 },
  { subject:'Data Structures', date:'2026-07-01', label:'Quiz 5', score:85 }
];
function renderExamHistory(){
  const list = document.getElementById('examHistoryList');
  list.innerHTML = '';
  [...EXAM_HISTORY].sort((a,b)=> new Date(b.date) - new Date(a.date)).forEach(exam=>{
    const scoreClass = exam.score >= 80 ? 'good' : exam.score >= 60 ? 'mid' : 'low';
    const d = new Date(exam.date);
    const row = document.createElement('div');
    row.className = 'exam-history-row';
    row.innerHTML = `
      <div class="exam-history-date">${d.toLocaleDateString('en-US', { month:'short', day:'numeric' })}</div>
      <div class="exam-history-body"><h4>${exam.label}</h4><p>${exam.subject}</p></div>
      <div class="exam-history-score ${scoreClass}">${exam.score}%</div>`;
    list.appendChild(row);
  });
}
renderExamHistory();
```

Replace with:
```js
/* --- Exam history --- */
const EXAM_HISTORY_SEED = [
  { subject:'Data Structures', date:'2026-04-10', label:'Midterm', score:78 },
  { subject:'Calculus II', date:'2026-05-02', label:'Quiz 3', score:91 },
  { subject:'Microeconomics', date:'2026-05-20', label:'Midterm', score:64 },
  { subject:'UX Design Basics', date:'2026-06-15', label:'Studio Review', score:82 },
  { subject:'Data Structures', date:'2026-07-01', label:'Quiz 5', score:85 }
];
function getExamScores(){
  let scores = lsGet('forge-exam-scores', null);
  if(!scores){ scores = EXAM_HISTORY_SEED.slice(); lsSet('forge-exam-scores', scores); }
  return scores;
}
function addExamScore(entry){
  const scores = getExamScores();
  scores.push(entry);
  lsSet('forge-exam-scores', scores);
  return scores;
}
function computeGPA(scores){
  if(!scores.length) return null;
  const avgPct = scores.reduce((sum,s)=> sum + s.score, 0) / scores.length;
  return Math.round((avgPct / 100 * 4) * 100) / 100;
}
function renderExamHistory(){
  const scores = getExamScores();
  const list = document.getElementById('examHistoryList');
  list.innerHTML = '';
  [...scores].sort((a,b)=> new Date(b.date) - new Date(a.date)).forEach(exam=>{
    const scoreClass = exam.score >= 80 ? 'good' : exam.score >= 60 ? 'mid' : 'low';
    const d = new Date(exam.date);
    const row = document.createElement('div');
    row.className = 'exam-history-row';
    row.innerHTML = `
      <div class="exam-history-date">${d.toLocaleDateString('en-US', { month:'short', day:'numeric' })}</div>
      <div class="exam-history-body"><h4>${exam.label}</h4><p>${exam.subject}</p></div>
      <div class="exam-history-score ${scoreClass}">${exam.score}%</div>`;
    list.appendChild(row);
  });
  const gpa = computeGPA(scores);
  document.getElementById('currentGpaNum').textContent = gpa === null ? '—' : gpa.toFixed(1);
}
renderExamHistory();
document.getElementById('examAddSubmit').addEventListener('click', ()=>{
  const subject = document.getElementById('examSubjectInput').value.trim();
  const label = document.getElementById('examLabelInput').value.trim() || 'Score';
  const date = document.getElementById('examDateInput').value;
  let score = parseInt(document.getElementById('examScoreInput').value, 10);
  if(!subject || !date || isNaN(score)){ showToast('Enter subject, score and date'); return; }
  score = Math.max(0, Math.min(100, score));
  addExamScore({ subject, date, label, score });
  renderExamHistory();
  document.getElementById('examSubjectInput').value = '';
  document.getElementById('examLabelInput').value = '';
  document.getElementById('examScoreInput').value = '';
  document.getElementById('examDateInput').value = '';
  document.getElementById('examAddRow').style.display = 'none';
  showToast('Score logged');
});
```

- [ ] **Step 4: Verify `computeGPA` with Node**

Run:
```bash
node -e "
function computeGPA(scores){
  if(!scores.length) return null;
  const avgPct = scores.reduce((sum,s)=> sum + s.score, 0) / scores.length;
  return Math.round((avgPct / 100 * 4) * 100) / 100;
}
console.assert(computeGPA([]) === null, 'empty should be null');
console.assert(computeGPA([{score:100}]) === 4, 'perfect score should be 4.0');
console.assert(computeGPA([{score:80},{score:90}]) === 3.4, 'avg 85% should be 3.4');
console.log('OK');
"
```
Expected: `OK` printed, no assertion errors.

- [ ] **Step 5: Manual verification**

1. Open `index.html`, go to dashboard Readiness section — confirm Exam History still lists the 5 seed exams, sorted newest-first.
2. "Current GPA" tile shows a computed value (average of 78,91,64,82,85 = 80% → 3.20).
3. Click "+ Log score", add a new 95% score, confirm GPA tile updates and the new row appears in history.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: real exam scores with GPA calculation, wire Current GPA tile"
```

---

### Task 5: Real study-time logging replaces fake heatmap; Study Streak tile

**Files:**
- Modify: `index.html:1732-1741` (top stats tile c4)
- Modify: `index.html:2731-2744` (`handleSessionComplete`)
- Modify: `index.html:3198-3269` (heatmap data generation + `renderHeatmap`)

- [ ] **Step 1: Give the "Study Streak" tile an id**

Current text at `index.html:1732-1741`:
```html
      <div class="stat-card c4 anim anim-d4">
        <div class="stamp">🔥 streak</div>
        <div class="icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="#6B62C4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/></svg>
        </div>
        <div>
          <div class="num">12 days</div>
          <div class="label">Study Streak</div>
        </div>
      </div>
```

Replace with:
```html
      <div class="stat-card c4 anim anim-d4">
        <div class="icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="#6B62C4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/></svg>
        </div>
        <div>
          <div class="num" id="topStreakNum">—</div>
          <div class="label">Study Streak</div>
        </div>
      </div>
```

- [ ] **Step 2: Log real minutes when a focus session completes**

Current text at `index.html:2731-2744`:
```js
function handleSessionComplete(){
  stopTicking();
  pomo.running = false;
  if(pomo.mode === 'focus'){
    pomo.sessionCount++;
    pomo.mode = (pomo.sessionCount % 4 === 0) ? 'long' : 'short';
    showToast('Focus session complete — time for a break ☕');
  } else {
    pomo.mode = 'focus';
    showToast('Break\'s over — back to focus 🎯');
  }
  pomo.remaining = DURATIONS[pomo.mode];
  renderPomo();
}
```

Replace with:
```js
function todayKey(){ return new Date().toISOString().slice(0,10); }
function logStudyMinutes(minutes){
  const log = lsGet('forge-study-log', {});
  const key = todayKey();
  log[key] = (log[key] || 0) + minutes;
  lsSet('forge-study-log', log);
}
function handleSessionComplete(){
  stopTicking();
  pomo.running = false;
  if(pomo.mode === 'focus'){
    logStudyMinutes(Math.round(DURATIONS.focus / 60));
    if(typeof renderHeatmap === 'function') renderHeatmap();
    pomo.sessionCount++;
    pomo.mode = (pomo.sessionCount % 4 === 0) ? 'long' : 'short';
    showToast('Focus session complete — time for a break ☕');
  } else {
    pomo.mode = 'focus';
    showToast('Break\'s over — back to focus 🎯');
  }
  pomo.remaining = DURATIONS[pomo.mode];
  renderPomo();
}
```
(`DURATIONS.focus` is in seconds — using the configured focus length at the moment the session completes, including any custom duration the user set, matches real elapsed focus time. `renderHeatmap` is defined later in the file but this function only ever runs after a user interaction post-load, so it exists by the time this fires — the `typeof` guard just protects against the (impossible in practice) case of the function running during initial parse.)

- [ ] **Step 3: Replace the random heatmap generator with the real log**

Current text at `index.html:3198-3222`:
```js
/* ---------- STUDY ACTIVITY HEATMAP ---------- */
function mulberry32(seed){
  return function(){
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const HEATMAP_DAYS = 84;
const studyData = [];
for(let i = HEATMAP_DAYS - 1; i >= 0; i--){
  const d = new Date();
  d.setDate(d.getDate() - i);
  let minutes;
  if(i < 12){
    minutes = 25 + Math.floor(rand() * 95);
  } else if(i === 12){
    minutes = 0;
  } else {
    minutes = rand() < 0.35 ? 0 : Math.floor(20 + rand() * 100);
  }
  studyData.push({ date:d, minutes });
}
```

Replace with:
```js
/* ---------- STUDY ACTIVITY HEATMAP ---------- */
const HEATMAP_DAYS = 84;
function buildStudyData(){
  const log = lsGet('forge-study-log', {});
  const data = [];
  for(let i = HEATMAP_DAYS - 1; i >= 0; i--){
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0,10);
    data.push({ date:d, minutes: log[key] || 0 });
  }
  return data;
}
function computeStreakStats(entries){
  let current = 0;
  for(let i = entries.length - 1; i >= 0; i--){
    if(entries[i].minutes > 0) current++; else break;
  }
  let longest = 0, run = 0;
  entries.forEach(e=>{
    if(e.minutes > 0){ run++; longest = Math.max(longest, run); } else { run = 0; }
  });
  const studiedDays = entries.filter(e => e.minutes > 0);
  const totalMinutes = studiedDays.reduce((sum,e)=> sum + e.minutes, 0);
  return { current, longest, daysStudied: studiedDays.length, totalMinutes };
}
```

- [ ] **Step 4: Have `renderHeatmap` read live data and populate the top Study Streak tile**

Current text at `index.html:3234-3270` (function body plus the `renderHeatmap()` call at the end):
```js
function renderHeatmap(){
  const grid = document.getElementById('heatmapGrid');
  grid.innerHTML = '';
  const leadingBlanks = studyData[0].date.getDay();
  for(let i = 0; i < leadingBlanks; i++){
    const blank = document.createElement('div');
    blank.className = 'heatmap-cell';
    blank.style.background = 'transparent';
    blank.style.cursor = 'default';
    grid.appendChild(blank);
  }
  studyData.forEach(entry=>{
    const cell = document.createElement('div');
    cell.className = `heatmap-cell hm-l${levelFor(entry.minutes)}`;
    const label = `${DOW[entry.date.getDay()]}, ${MON[entry.date.getMonth()]} ${entry.date.getDate()}`;
    cell.addEventListener('mousemove', (e)=> showTip(e, `<b>${entry.minutes} min</b><br>${label}`));
    cell.addEventListener('mouseleave', hideTip);
    grid.appendChild(cell);
  });

  const studiedDays = studyData.filter(e => e.minutes > 0);
  const totalMinutes = studiedDays.reduce((sum,e)=> sum + e.minutes, 0);
  document.getElementById('daysStudiedNum').textContent = studiedDays.length;
  document.getElementById('hoursStudiedNum').textContent = (totalMinutes/60).toFixed(1) + 'h';

  let current = 0;
  for(let i = studyData.length - 1; i >= 0; i--){
    if(studyData[i].minutes > 0) current++; else break;
  }
  let longest = 0, run = 0;
  studyData.forEach(e=>{
    if(e.minutes > 0){ run++; longest = Math.max(longest, run); } else { run = 0; }
  });
  document.getElementById('streakCurrentNum').textContent = current + (current===1?' day':' days');
  document.getElementById('streakLongestNum').textContent = longest + (longest===1?' day':' days');
}
renderHeatmap();
```

Replace with:
```js
function renderHeatmap(){
  const studyData = buildStudyData();
  const grid = document.getElementById('heatmapGrid');
  grid.innerHTML = '';
  const leadingBlanks = studyData[0].date.getDay();
  for(let i = 0; i < leadingBlanks; i++){
    const blank = document.createElement('div');
    blank.className = 'heatmap-cell';
    blank.style.background = 'transparent';
    blank.style.cursor = 'default';
    grid.appendChild(blank);
  }
  studyData.forEach(entry=>{
    const cell = document.createElement('div');
    cell.className = `heatmap-cell hm-l${levelFor(entry.minutes)}`;
    const label = `${DOW[entry.date.getDay()]}, ${MON[entry.date.getMonth()]} ${entry.date.getDate()}`;
    cell.addEventListener('mousemove', (e)=> showTip(e, `<b>${entry.minutes} min</b><br>${label}`));
    cell.addEventListener('mouseleave', hideTip);
    grid.appendChild(cell);
  });

  const stats = computeStreakStats(studyData);
  document.getElementById('daysStudiedNum').textContent = stats.daysStudied;
  document.getElementById('hoursStudiedNum').textContent = (stats.totalMinutes/60).toFixed(1) + 'h';
  document.getElementById('streakCurrentNum').textContent = stats.current + (stats.current===1?' day':' days');
  document.getElementById('streakLongestNum').textContent = stats.longest + (stats.longest===1?' day':' days');
  document.getElementById('topStreakNum').textContent = stats.current + (stats.current===1?' day':' days');
}
renderHeatmap();
```

- [ ] **Step 5: Verify `computeStreakStats` with Node**

Run:
```bash
node -e "
function computeStreakStats(entries){
  let current = 0;
  for(let i = entries.length - 1; i >= 0; i--){
    if(entries[i].minutes > 0) current++; else break;
  }
  let longest = 0, run = 0;
  entries.forEach(e=>{
    if(e.minutes > 0){ run++; longest = Math.max(longest, run); } else { run = 0; }
  });
  const studiedDays = entries.filter(e => e.minutes > 0);
  const totalMinutes = studiedDays.reduce((sum,e)=> sum + e.minutes, 0);
  return { current, longest, daysStudied: studiedDays.length, totalMinutes };
}
const entries = [{minutes:0},{minutes:30},{minutes:40},{minutes:0},{minutes:25},{minutes:25}];
const r = computeStreakStats(entries);
console.assert(r.current === 2, 'current streak should be 2, got ' + r.current);
console.assert(r.longest === 2, 'longest streak should be 2, got ' + r.longest);
console.assert(r.daysStudied === 4, 'daysStudied should be 4, got ' + r.daysStudied);
console.assert(r.totalMinutes === 120, 'totalMinutes should be 120, got ' + r.totalMinutes);
console.log('OK');
"
```
Expected: `OK` printed, no assertion errors.

- [ ] **Step 6: Manual verification**

1. Clear `localStorage` for the file (devtools → Application → Local Storage → clear), reload `index.html`. Dashboard "Study Streak" tile and the heatmap/streak numbers on the Readiness page all show 0 / "—" style zeros (no fake data).
2. Go to Study Timer, use "+ Add" / custom duration to set focus length to 1 minute, start it, let it complete. Confirm a toast fires and, back on the dashboard, "Study Streak" tile now shows "1 day" and the heatmap's today-cell is filled in.
3. Confirm `localStorage.getItem('forge-study-log')` (devtools console) now contains today's date key with a positive minute value.

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat: log real study minutes from Pomodoro, replace fake heatmap data, wire Study Streak tile"
```

---

### Task 6: Notes — sketchnote/infographic visual style

**Files:**
- Modify: `index.html:971-982` (`.ai-card` / `.tier-badge` CSS)
- Modify: `index.html:1236-1240` (`.note-title` / `.note-h` / `.note-ul` CSS)
- Modify: `index.html:3532-3555` (`renderNoteResult`)

- [ ] **Step 1: Add sketchnote CSS**

Current text at `index.html:1236-1240`:
```css
  .note-h{ font-family:'Fredoka'; font-size:14.5px; font-weight:600; margin:12px 0 4px; }
  .note-h:first-child{ margin-top:0; }
  .note-ul{ padding-left:18px; font-size:13.5px; line-height:1.6; }
  .note-ul li{ margin-bottom:3px; }
  .note-title{ font-family:'Fredoka'; font-size:16px; font-weight:600; margin-bottom:8px; }
```

Replace with:
```css
  .note-title{
    font-family:'Fredoka'; font-size:20px; font-weight:600; margin-bottom:16px;
    display:inline-block; position:relative; z-index:1;
  }
  .note-title::after{
    content:''; position:absolute; left:-4px; right:-4px; bottom:2px; height:10px;
    background:var(--yellow); opacity:0.6; z-index:-1; transform:skew(-6deg);
  }
  .note-sections{ display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  @media (max-width:600px){ .note-sections{ grid-template-columns:1fr; } }
  .note-box{
    border-radius:16px; padding:14px 16px; border:1.5px solid rgba(36,31,24,0.1);
  }
  .note-box:nth-child(4n+1){ background:var(--pink-soft); }
  .note-box:nth-child(4n+2){ background:var(--green-soft); }
  .note-box:nth-child(4n+3){ background:var(--yellow-soft); }
  .note-box:nth-child(4n+4){ background:var(--blue-soft); }
  .note-h{
    font-family:'Fredoka'; font-size:13.5px; font-weight:600; margin-bottom:8px;
    display:flex; align-items:center; gap:6px;
  }
  .note-h::before{ content:'✎'; font-size:13px; }
  .note-ul{ list-style:none; padding-left:0; font-size:13px; line-height:1.55; }
  .note-ul li{ margin-bottom:6px; padding-left:16px; position:relative; }
  .note-ul li::before{
    content:''; position:absolute; left:0; top:6px; width:7px; height:7px;
    border-radius:50%; border:1.5px solid var(--ink); background:transparent;
  }
```

- [ ] **Step 2: Update `renderNoteResult` to emit the new markup**

Current text at `index.html:3532-3545`:
```js
function renderNoteResult(tier, entry){
  const result = document.getElementById('notesResult');
  const badge = tier==='tier2' ? '<span class="tier-badge t2">Tier 2 · Deep</span>' : '<span class="tier-badge t1">Tier 1 · Fast</span>';
  if(entry){
    result.innerHTML = `
      <div class="ai-card">
        <div class="ai-card-head"><span class="who">Forge</span>${badge}</div>
        <div class="note-title">${entry.title}</div>
        ${entry.sections.map(s => `<div class="note-h">${s.heading}</div><ul class="note-ul">${s.bullets.map(b=>`<li>${b}</li>`).join('')}</ul>`).join('')}
        <div class="notes-card-actions">
```

Replace with:
```js
function renderNoteResult(tier, entry){
  const result = document.getElementById('notesResult');
  const badge = tier==='tier2' ? '<span class="tier-badge t2">Tier 2 · Deep</span>' : '<span class="tier-badge t1">Tier 1 · Fast</span>';
  if(entry){
    result.innerHTML = `
      <div class="ai-card">
        <div class="ai-card-head"><span class="who">Forge</span>${badge}</div>
        <div class="note-title">${entry.title}</div>
        <div class="note-sections">
        ${entry.sections.map(s => `<div class="note-box"><div class="note-h">${s.heading}</div><ul class="note-ul">${s.bullets.map(b=>`<li>${b}</li>`).join('')}</ul></div>`).join('')}
        </div>
        <div class="notes-card-actions">
```

(Everything from `<div class="notes-card-actions">` onward, including the closing tags below it, is unchanged in this task — Task 7 modifies it further.)

- [ ] **Step 3: Manual verification**

1. Open `index.html`, go to Notes, click "Stacks".
2. Confirm the note now renders as colored callout boxes (2-column grid on desktop, 1-column under 600px) — "What it is" pink, "Key Concept" green, "Example" yellow — with a highlighter-style bar behind the title and small circular doodle bullets instead of plain list dots.
3. Try the dark and jarvis themes (theme switcher in sidebar) — confirm the boxes still look reasonable (they use the existing `--pink-soft` etc. tokens, which are already theme-aware).

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "style: sketchnote-style visual redesign for generated notes"
```

---

### Task 7: Photo + drawing attachments on notes

**Files:**
- Modify: `index.html:3535-3555` (notes-card-actions block, continued from Task 6)
- Add CSS near the note styles from Task 6

- [ ] **Step 1: Add attachment CSS**

Add immediately after the `.note-ul li::before{...}` rule added in Task 6:
```css
  .note-attachments{ display:flex; flex-wrap:wrap; gap:10px; margin-top:14px; }
  .note-attachments img{ max-width:160px; max-height:160px; border-radius:12px; border:1.5px solid rgba(36,31,24,0.1); object-fit:cover; }
  .draw-modal-backdrop{
    display:none; position:fixed; inset:0; z-index:500; background:rgba(0,0,0,0.4);
    align-items:center; justify-content:center;
  }
  .draw-modal-backdrop.open{ display:flex; }
  .draw-modal{ background:var(--white); border-radius:20px; padding:20px; box-shadow:var(--shadow); }
  .draw-modal canvas{ border-radius:12px; border:1.5px solid rgba(36,31,24,0.15); background:#fff; touch-action:none; cursor:crosshair; }
  .draw-modal-tools{ display:flex; gap:8px; margin-top:12px; align-items:center; }
  .draw-modal-tools input[type=color]{ width:34px; height:34px; border:none; border-radius:8px; padding:0; background:none; }
```

- [ ] **Step 2: Add the draw modal HTML**

Add this right before the closing `</body>` tag search — insert it immediately after the existing `<div class="toast" id="toast"></div>` line at `index.html:2370` (before the `<script>` at 2373):

```html
<div class="draw-modal-backdrop" id="drawModalBackdrop">
  <div class="draw-modal">
    <canvas id="drawCanvas" width="360" height="280"></canvas>
    <div class="draw-modal-tools">
      <input type="color" id="drawColorInput" value="#262528">
      <button class="fc-gen-btn btn-pop" id="drawClearBtn" type="button">Clear</button>
      <button class="fc-gen-btn btn-pop" id="drawCancelBtn" type="button">Cancel</button>
      <button class="fc-gen-btn btn-pop" id="drawInsertBtn" type="button">Insert</button>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Update the notes-card-actions block to add Photo/Draw buttons and an attachment gallery**

Current text at `index.html:3535-3545` (after Task 6's edit, the tail of `renderNoteResult`):
```js
        <div class="notes-card-actions">
          <button class="note-action-btn btn-pop" data-action="share">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>
            Share
          </button>
          <button class="note-action-btn btn-pop" data-action="download">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>
            Download
          </button>
        </div>
      </div>`;
    result.querySelector('[data-action="share"]').addEventListener('click', ()=> shareNote(entry));
    result.querySelector('[data-action="download"]').addEventListener('click', ()=> downloadNote(entry));
```

Replace with:
```js
        <div class="note-attachments" id="noteAttachments"></div>
        <div class="notes-card-actions">
          <button class="note-action-btn btn-pop" data-action="share">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>
            Share
          </button>
          <button class="note-action-btn btn-pop" data-action="download">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>
            Download
          </button>
          <button class="note-action-btn btn-pop" data-action="photo">📷 Add Photo</button>
          <button class="note-action-btn btn-pop" data-action="draw">✏️ Draw</button>
          <input type="file" id="notePhotoInput" accept="image/*" style="display:none;">
        </div>
      </div>`;
    result.querySelector('[data-action="share"]').addEventListener('click', ()=> shareNote(entry));
    result.querySelector('[data-action="download"]').addEventListener('click', ()=> downloadNote(entry));
    result.querySelector('[data-action="photo"]').addEventListener('click', ()=> document.getElementById('notePhotoInput').click());
    result.querySelector('#notePhotoInput').addEventListener('change', (e)=>{
      const file = e.target.files[0];
      if(!file) return;
      const reader = new FileReader();
      reader.onload = ()=> addNoteAttachment(reader.result);
      reader.readAsDataURL(file);
      e.target.value = '';
    });
    result.querySelector('[data-action="draw"]').addEventListener('click', openDrawModal);
```

- [ ] **Step 4: Add the attachment gallery + drawing modal logic**

Add this new block right after the `generateNotes` function and its event listeners (i.e. right after the existing block ending in `chip.dataset.topic); });` — the last line of the current Notes section — and before `/* ---------- FLASHCARDS ---------- */`:

```js
/* ---------- NOTE ATTACHMENTS (photo + drawing) ---------- */
let currentNoteAttachments = [];
function addNoteAttachment(dataUrl){
  currentNoteAttachments.push(dataUrl);
  renderNoteAttachments();
}
function renderNoteAttachments(){
  const wrap = document.getElementById('noteAttachments');
  if(!wrap) return;
  wrap.innerHTML = currentNoteAttachments.map(src => `<img src="${src}">`).join('');
}

let drawCtx = null, drawing = false;
function openDrawModal(){
  const backdrop = document.getElementById('drawModalBackdrop');
  backdrop.classList.add('open');
  const canvas = document.getElementById('drawCanvas');
  drawCtx = canvas.getContext('2d');
  drawCtx.fillStyle = '#fff';
  drawCtx.fillRect(0, 0, canvas.width, canvas.height);
  drawCtx.lineCap = 'round';
  drawCtx.lineJoin = 'round';
  drawCtx.lineWidth = 3;
}
function closeDrawModal(){
  document.getElementById('drawModalBackdrop').classList.remove('open');
}
(function setupDrawCanvas(){
  const canvas = document.getElementById('drawCanvas');
  const colorInput = document.getElementById('drawColorInput');
  function posFromEvent(e){
    const rect = canvas.getBoundingClientRect();
    const point = e.touches ? e.touches[0] : e;
    return { x: point.clientX - rect.left, y: point.clientY - rect.top };
  }
  function start(e){
    drawing = true;
    const p = posFromEvent(e);
    drawCtx.strokeStyle = colorInput.value;
    drawCtx.beginPath();
    drawCtx.moveTo(p.x, p.y);
  }
  function move(e){
    if(!drawing) return;
    e.preventDefault();
    const p = posFromEvent(e);
    drawCtx.lineTo(p.x, p.y);
    drawCtx.stroke();
  }
  function end(){ drawing = false; }
  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start);
  canvas.addEventListener('touchmove', move);
  canvas.addEventListener('touchend', end);
})();
document.getElementById('drawClearBtn').addEventListener('click', ()=>{
  const canvas = document.getElementById('drawCanvas');
  drawCtx.fillStyle = '#fff';
  drawCtx.fillRect(0, 0, canvas.width, canvas.height);
});
document.getElementById('drawCancelBtn').addEventListener('click', closeDrawModal);
document.getElementById('drawInsertBtn').addEventListener('click', ()=>{
  const canvas = document.getElementById('drawCanvas');
  addNoteAttachment(canvas.toDataURL('image/png'));
  closeDrawModal();
});
```

- [ ] **Step 5: Clear attachments whenever a new note is generated**

Current text at `index.html:3556-3559` (start of `generateNotes`, line numbers approximate — locate by content):
```js
function generateNotes(topic){
  const text = topic.trim();
  if(!text) return;
  const tier = classifyTier(text);
```

Replace with:
```js
function generateNotes(topic){
  const text = topic.trim();
  if(!text) return;
  currentNoteAttachments = [];
  const tier = classifyTier(text);
```

- [ ] **Step 6: Manual verification**

1. Open `index.html`, go to Notes, generate "queues".
2. Click "📷 Add Photo", pick any image from disk — confirm a thumbnail appears in a gallery row under the note sections.
3. Click "✏️ Draw" — confirm a modal opens with a white canvas; draw a scribble with the mouse, change the color swatch, draw more, click "Insert" — confirm the drawing appears as a second thumbnail in the gallery.
4. Generate a different note ("bst") — confirm the attachment gallery is empty again (attachments don't leak between notes).

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat: photo upload and freehand drawing attachments on generated notes"
```

---

### Task 8: PDF export via print

**Files:**
- Modify: `index.html:3541-3545` area (notes-card-actions from Task 7 — add a Download PDF button)
- Add a `@media print` stylesheet block
- Add a hidden print container + `downloadNotePDF` function

- [ ] **Step 1: Add the print-only container**

Add this immediately after the `<div class="toast" id="toast"></div>` line and the draw-modal markup added in Task 7 (still before `<script>` at line ~2373):

```html
<div id="printNoteContainer" class="print-only"></div>
```

- [ ] **Step 2: Add print CSS**

Add this as the very last rule in the `<style>` block, after the `.draw-modal-tools input[type=color]{...}` rule added in Task 7:

```css
  .print-only{ display:none; }
  @media print{
    body *{ visibility:hidden; }
    .print-only, .print-only *{ visibility:visible; }
    .print-only{ display:block; position:absolute; top:0; left:0; width:100%; padding:24px; }
    .print-only .note-title{ font-size:24px; }
    .print-only .note-sections{ grid-template-columns:1fr 1fr; }
    .print-only .note-attachments img{ max-width:220px; max-height:220px; }
  }
```

- [ ] **Step 3: Add the "Download PDF" button and its handler**

Current text at `index.html` (the notes-card-actions block, after Task 7's edit — locate by the `📷 Add Photo` button line):
```js
          <button class="note-action-btn btn-pop" data-action="photo">📷 Add Photo</button>
          <button class="note-action-btn btn-pop" data-action="draw">✏️ Draw</button>
          <input type="file" id="notePhotoInput" accept="image/*" style="display:none;">
        </div>
      </div>`;
    result.querySelector('[data-action="share"]').addEventListener('click', ()=> shareNote(entry));
    result.querySelector('[data-action="download"]').addEventListener('click', ()=> downloadNote(entry));
```

Replace with:
```js
          <button class="note-action-btn btn-pop" data-action="photo">📷 Add Photo</button>
          <button class="note-action-btn btn-pop" data-action="draw">✏️ Draw</button>
          <button class="note-action-btn btn-pop" data-action="pdf">🖨 Download PDF</button>
          <input type="file" id="notePhotoInput" accept="image/*" style="display:none;">
        </div>
      </div>`;
    result.querySelector('[data-action="share"]').addEventListener('click', ()=> shareNote(entry));
    result.querySelector('[data-action="download"]').addEventListener('click', ()=> downloadNote(entry));
    result.querySelector('[data-action="pdf"]').addEventListener('click', ()=> downloadNotePDF(entry));
```

- [ ] **Step 4: Add the `downloadNotePDF` function**

Add this right after the `renderNoteAttachments` function defined in Task 7:

```js
function downloadNotePDF(entry){
  const container = document.getElementById('printNoteContainer');
  container.innerHTML = `
    <div class="note-title">${entry.title}</div>
    <div class="note-sections">
      ${entry.sections.map(s => `<div class="note-box"><div class="note-h">${s.heading}</div><ul class="note-ul">${s.bullets.map(b=>`<li>${b}</li>`).join('')}</ul></div>`).join('')}
    </div>
    <div class="note-attachments">${currentNoteAttachments.map(src => `<img src="${src}">`).join('')}</div>`;
  window.print();
}
```

- [ ] **Step 5: Manual verification**

1. Open `index.html`, go to Notes, generate "linked list", add a photo attachment.
2. Click "🖨 Download PDF" — confirm the browser's print dialog opens.
3. In the print preview, confirm only the note (title, colored section boxes, attached photo) is visible — no sidebar, no nav, no other page chrome.
4. Complete the print flow choosing "Save as PDF" as the destination (or just cancel — the goal of this check is confirming the print-preview content is correct, not necessarily writing a file to disk each time).

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: PDF export for notes via print stylesheet"
```

---

### Task 9: Sync `student-dashboard.html`, final smoke pass

**Files:**
- Modify: `student-dashboard.html` (overwritten from `index.html`)

- [ ] **Step 1: Sync the files**

```bash
cp "index.html" "student-dashboard.html"
diff "index.html" "student-dashboard.html"
```
Expected: `diff` prints nothing (files identical).

- [ ] **Step 2: Full manual smoke pass**

Open `index.html` fresh (clear localStorage first), walk through:
1. Dashboard tiles: Active Courses, Assignments Due, Current GPA, Study Streak all show real computed values (or honest zero/"—" states), no leftover hardcoded numbers.
2. Add a course, add a deadline, log an exam score — each corresponding tile updates immediately.
3. Complete one Pomodoro focus session — Study Streak tile and heatmap update.
4. Resize the browser down to ~360px wide — confirm no tile text overlaps another tile or the icon/stamp badge (bug-fix regression check from earlier in this project).
5. Generate a note, confirm sketchnote styling, attach a photo and a drawing, download as PDF, confirm print preview is clean.

- [ ] **Step 3: Commit**

```bash
git add index.html student-dashboard.html
git commit -m "chore: sync student-dashboard.html with index.html"
```

---

## Plan Self-Review

**Spec coverage:**
- §2 real data (courses/deadlines/exam-scores/study-log/top tiles) → Tasks 2–5. ✓
- §3 sketchnote visual style → Task 6. ✓
- §4 photo & drawing attachments → Task 7. ✓
- §5 PDF export → Task 8. ✓
- §6 out-of-scope items (backend, attachment persistence, admin panel, extra themes) → not built, consistent with spec. ✓
- §7 files touched → `index.html` + synced `student-dashboard.html`, Task 9. ✓

**Type/name consistency check:** `lsGet`/`lsSet` (Task 1) used identically in Tasks 2–5. `computeStreakStats` defined once in Task 5 and used only there (Task 4's GPA calc is a separate, correctly-named `computeGPA`). `renderHeatmap` is called both on load and from `handleSessionComplete` (Task 5) — confirmed it's declared with `function renderHeatmap(){...}` (hoisted), so the earlier call from `handleSessionComplete` (which appears before `renderHeatmap`'s definition in file order) is safe.

**No placeholders:** every step has literal before/after code or an exact manual-check script; no "add validation" or "TBD" steps remain.
