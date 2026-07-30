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
