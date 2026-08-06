// Netlify serverless function — keeps the Groq API key server-side.
// The frontend calls POST /.netlify/functions/generate-quiz with
// { subject, chapters: [chapterName,...], type: "mcq"|"short"|"long", count }
// and never sees the key. chapters comes from the client's real priority engine
// (computeStudyPriority) — this function does not decide what to quiz on, only
// generates fresh questions for the chapters it's given.

const MODEL = 'llama-3.3-70b-versatile';
const { callGroq } = require('./_groq-client');
const { checkRateLimit } = require('./_rate-limit');

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const rl = await checkRateLimit(event);
  if(!rl.allowed){
    return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests — try again later' }) };
  }

  let subject, chapters, type, count;
  try{
    const body = JSON.parse(event.body || '{}');
    subject = (body.subject || '').trim();
    chapters = Array.isArray(body.chapters) ? body.chapters.filter(c => typeof c === 'string' && c.trim()) : [];
    type = ['mcq', 'short', 'long'].includes(body.type) ? body.type : null;
    count = Math.max(1, Math.min(30, parseInt(body.count, 10) || 5));
  } catch(e){
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if(!subject || !chapters.length || !type){
    return { statusCode: 400, body: JSON.stringify({ error: 'subject, chapters, and type are required' }) };
  }

  const chapterList = chapters.join(', ');
  const shapeByType = {
    mcq: `{"questions": [{"chapter": "string (must be exactly one of the chapters listed above)", "text": "string",
"options": ["string", "string", "string", "string"], "correct": "string (must exactly match one of the 4 options)",
"explanation": "string — why the correct answer is right, shown if the student gets it wrong"}]}`,
    short: `{"questions": [{"chapter": "string (must be exactly one of the chapters listed above)",
"text": "string — a question answerable in one sentence"}]}`,
    long: `{"questions": [{"chapter": "string (must be exactly one of the chapters listed above)",
"text": "string — a question requiring a multi-sentence explained answer"}]}`
  };

  const systemPrompt = `You are Forge, generating exam-style practice questions for a B.Tech Computer Engineering
(Semester 3) student studying ${subject}.

Generate exactly ${count} ${type === 'mcq' ? 'multiple-choice' : type} questions, spread across these chapters
(cycle through them so coverage is even, don't put every question on the first chapter): ${chapterList}.
${type === 'mcq' ? 'Each question needs exactly 4 plausible options with exactly one correct answer — wrong options should be genuinely tempting mistakes, not obviously wrong filler.' : ''}
Questions must be answerable from standard semester-3 course material, not obscure trivia.

Respond with ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:
${shapeByType[type]}`;

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

    if(data.usage) console.log('[generate-quiz] tokens:', data.usage);

    const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    let parsed;
    try{
      parsed = JSON.parse(raw);
    } catch(e){
      return { statusCode: 502, body: JSON.stringify({ error: 'Model did not return valid JSON', raw }) };
    }

    // Match chapter names loosely rather than requiring an exact string match — the model
    // reliably picks the right chapter but doesn't always reproduce it character-for-character
    // (punctuation like "&" vs "and", or truncating "Trees & Binary Search Trees" down to just
    // "Binary Search Trees"). Containment match in either direction, not just normalized
    // equality — an exact-match requirement here was silently dropping single-question requests.
    const normalize = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const normalizedChapters = chapters.map(c => ({ real: c, norm: normalize(c) }));
    const findRealChapter = raw => {
      const n = normalize(raw);
      if(!n) return null;
      const exact = normalizedChapters.find(c => c.norm === n);
      if(exact) return exact.real;
      const contains = normalizedChapters.find(c => c.norm.includes(n) || n.includes(c.norm));
      return contains ? contains.real : null;
    };
    const questions = (Array.isArray(parsed.questions) ? parsed.questions : []).map(q => {
      if(!q || !q.text) return null;
      const realChapter = findRealChapter(q.chapter);
      if(!realChapter) return null;
      if(type === 'mcq' && !(Array.isArray(q.options) && q.options.length === 4 && q.options.includes(q.correct))) return null;
      return Object.assign({}, q, { chapter: realChapter }); // snap back to the exact stored name
    }).filter(Boolean);

    return { statusCode: 200, body: JSON.stringify({ questions, usage: data.usage || null }) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Groq API: ' + e.message }) };
  }
};
