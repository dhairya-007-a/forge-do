// Netlify serverless function — keeps the Groq API key server-side.
// The frontend calls POST /.netlify/functions/ask-doubt with { question, tier, history, attachment }
// and never sees the key. Same pipeline shape as generate-note.js: capture input ->
// build prompt -> call Groq -> parse -> return structured JSON for the UI to render.
// attachment (optional): { name, type, dataUrl } — an image the model reads directly.
// TEMP: using Groq (llama-3.3-70b) for testing. No vision support on this model —
// attachments will be ignored server-side until swapped for a vision-capable Groq model.

const { callGroq } = require('./_groq-client');

const MODEL_BY_TIER = {
  tier1: 'llama-3.3-70b-versatile',
  tier2: 'llama-3.3-70b-versatile'
};

// The model doesn't always follow the exact subject naming in the prompt (it sometimes
// reverts to the official long-form course names). Normalize to the short names used
// everywhere else in the app (COURSE_CHAPTERS, CHAPTER_KEYWORDS, MCQ_QUESTIONS, the
// subject dropdown) so subject-string matching downstream — e.g. the readiness engine's
// chapter lookup — doesn't silently fail on a naming mismatch.
const SUBJECT_ALIASES = {
  'Introduction to Data Structures and Algorithms': 'Data Structures and Algorithms',
  'Introduction to Database Management System': 'Database Management System',
  'Introduction to Object Oriented Programming': 'Object Oriented Programming',
  'Business Ethics and Intellectual Property Rights': 'Business Ethics and IPR'
};
function normalizeSubject(subject){
  return SUBJECT_ALIASES[subject] || subject;
}

// Mirrors COURSE_CHAPTERS in index.html — kept in sync manually since this is a
// static site with no shared module system. Used to (a) tell the model the real chapter names
// per subject so it can classify a doubt directly, and (b) validate its answer server-side
// rather than trusting it blindly (the model doesn't always follow instructions exactly).
const COURSE_CHAPTERS = {
  'Data Structures and Algorithms': ['Arrays & Complexity Analysis','Stacks','Queues','Linked Lists','Trees & Binary Search Trees','Graphs','Sorting Algorithms','Hashing','Heaps','Dynamic Programming'],
  'Database Management System': ['Introduction to DBMS & File Systems','ER Model & Relational Model','Relational Algebra & SQL Basics','Advanced SQL (Joins, Subqueries, Views)','Normalization (1NF–BCNF)','Transactions & Concurrency Control','Indexing & Query Processing','NoSQL & Modern Databases Intro'],
  'Object Oriented Programming': ['OOP Concepts: Classes & Objects','Constructors & Destructors','Inheritance','Polymorphism (Overloading & Overriding)','Abstract Classes & Interfaces','Exception Handling','File Handling & I/O','Collections & Generics'],
  'Digital Electronics': ['Number Systems & Codes','Boolean Algebra & Logic Gates','Combinational Circuits (Adders, MUX, Decoders)','Karnaugh Maps & Minimization','Sequential Circuits (Flip-Flops, Latches)','Counters & Registers','Memory Devices (RAM/ROM)','A/D and D/A Converters Intro'],
  'Discrete Mathematics': ['Set Theory & Relations','Propositional & Predicate Logic','Functions','Combinatorics (Permutations & Combinations)','Graph Theory Basics','Trees (Graph-Theoretic)','Recurrence Relations','Group Theory & Algebraic Structures Intro'],
  'Business Ethics and IPR': ['Introduction to Business Ethics','Corporate Social Responsibility','Ethical Decision-Making Frameworks','Introduction to IP: Patents, Copyrights, Trademarks','Patent Filing Process','Copyright & Trade Secrets','IPR in the IT & Software Industry','Case Studies & Emerging Issues']
};
function chapterListText(){
  return Object.entries(COURSE_CHAPTERS).map(([subject, chapters]) => `${subject}: ${chapters.join(', ')}`).join('\n');
}

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let question, tier, history, attachment;
  try{
    const body = JSON.parse(event.body || '{}');
    question = (body.question || '').trim();
    tier = MODEL_BY_TIER[body.tier] ? body.tier : 'tier1';
    history = Array.isArray(body.history) ? body.history : [];
    attachment = (body.attachment && typeof body.attachment.dataUrl === 'string') ? body.attachment : null;
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
Subjects this semester: Data Structures and Algorithms, Database Management System,
Object Oriented Programming, Digital Electronics, Discrete Mathematics, Business Ethics and IPR.

Explain concepts in simple, everyday language. Use real-life analogies and examples wherever possible
(relate the concept to something from daily life). Avoid dense textbook jargon unless the technical term
itself needs to be taught.

If the student's message refers back to something earlier in the conversation (e.g. "that", "the one I just
asked about", "explain it more"), resolve the reference using the conversation history provided, and answer
about that specific thing rather than asking for clarification.

If an image or file is attached, read its actual content (handwritten/printed notes, a textbook page, a
diagram, a PDF) and ground your answer in what it actually shows — quote or describe the relevant part of it
rather than answering generically.

Every question is one of four types — pick whichever fits best:
- "concept": a definition, theory, or "what/why/how does X work" question.
- "numerical": a question that involves a calculation, formula, or worked math/logic problem
  (e.g. normalization steps, K-map, Boolean algebra simplification, complexity computation).
- "code": a question about syntax, an algorithm's implementation, or "how do I write/code X".
- "course": the student wants to learn or study a whole subject/topic broadly, not resolve one
  specific doubt — e.g. "teach me DBMS", "give me a course on trees", "help me learn OOP",
  "overview of digital electronics".

Each subject has these chapters — once you've picked the subject, also pick exactly ONE chapter from
that subject's list that this question belongs to:
${chapterListText()}

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
- "simpleExplanation": a genuinely simpler restatement, for every type. Hard requirements:
  - Maximum 2 sentences, and it must be shorter than "explanation".
  - Zero technical/subject jargon — not even terms already used in "explanation" (no "dependency",
    "polymorphism", "normalize", etc.) — replace every such term with plain words.
  - Lead with a comparison to something ordinary and non-technical (a kitchen, a queue at a shop, a game,
    a family, traffic) instead of restating a formal definition — do not just reword the same definition.
  - Write it as if explaining out loud to a 10-year-old who has never heard of this subject before.
- Only fill in the fields for the chosen "type", set every other type's fields to null:
  - "concept": fill "keyConcept" (the one core idea to remember) and "example" (a real-life analogy).
  - "numerical": fill "formula" (the formula/rule used, if any), "steps" (array of short ordered steps),
    and "workedExample" (a fully worked example with numbers).
  - "code": fill "codeSnippet" (the actual code), "codeLanguage" (e.g. "c", "python", "sql"), and
    "commonMistake" (a mistake students typically make with this).
  - "course": fill "mainTopics" (5-8 entries, "chapter" copied EXACTLY from that subject's chapter
    list, ordered by importance, "why" a one-line reason it matters) and "practiceQuestions"
    (3-5 short-answer questions covering those topics).
If the question is unrelated to college coursework, or you are not confident in a grounded answer,
respond with:
{"subject": null, "chapter": null, "type": null, "explanation": null, "simpleExplanation": null, "keyConcept": null, "example": null,
 "formula": null, "steps": null, "workedExample": null, "codeSnippet": null, "codeLanguage": null, "commonMistake": null,
 "mainTopics": null, "practiceQuestions": null}`;

  const userContent = [{ type: 'text', text: question }];
  if(attachment){
    if(attachment.type && attachment.type.startsWith('image/')){
      userContent.push({ type: 'image_url', image_url: { url: attachment.dataUrl } });
    } else {
      userContent.push({ type: 'file', file: { filename: attachment.name || 'attachment', file_data: attachment.dataUrl } });
    }
  }

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

    if(data.usage) console.log('[ask-doubt] tokens:', data.usage);

    const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    let parsed;
    try{
      parsed = JSON.parse(raw);
    } catch(e){
      return { statusCode: 502, body: JSON.stringify({ error: 'Model did not return valid JSON', raw }) };
    }
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
      if(!parsed.mainTopics.length) parsed.mainTopics = null;
    } else {
      parsed.mainTopics = null;
    }
    if(parsed.type === 'course' && Array.isArray(parsed.practiceQuestions)){
      parsed.practiceQuestions = parsed.practiceQuestions.filter(q => typeof q === 'string' && q.trim()).slice(0, 5);
      if(!parsed.practiceQuestions.length) parsed.practiceQuestions = null;
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

    parsed.usage = data.usage || null;
    return { statusCode: 200, body: JSON.stringify(parsed) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Groq API: ' + e.message }) };
  }
};
