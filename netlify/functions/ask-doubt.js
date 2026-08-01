// Netlify serverless function — keeps the Groq API key server-side.
// The frontend calls POST /.netlify/functions/ask-doubt with { question, tier, history, attachment }
// and never sees the key. Same pipeline shape as generate-note.js: capture input ->
// build prompt -> call Groq -> parse -> return structured JSON for the UI to render.
// attachment (optional): { name, type, dataUrl } — an image the model reads directly.
// TEMP: using Groq (llama-3.3-70b) for testing. No vision support on this model —
// attachments will be ignored server-side until swapped for a vision-capable Groq model.

const MODEL_BY_TIER = {
  tier1: 'llama-3.3-70b-versatile',
  tier2: 'llama-3.3-70b-versatile'
};

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.GROQ_API_KEY;
  if(!apiKey){
    return { statusCode: 500, body: JSON.stringify({ error: 'GROQ_API_KEY not configured on the server' }) };
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
Subjects this semester: Introduction to Data Structures and Algorithms, Introduction to Database Management System,
Introduction to Object Oriented Programming, Digital Electronics, Discrete Mathematics, Business Ethics and Intellectual Property Rights.

Explain concepts in simple, everyday language. Use real-life analogies and examples wherever possible
(relate the concept to something from daily life). Avoid dense textbook jargon unless the technical term
itself needs to be taught.

If the student's message refers back to something earlier in the conversation (e.g. "that", "the one I just
asked about", "explain it more"), resolve the reference using the conversation history provided, and answer
about that specific thing rather than asking for clarification.

If an image or file is attached, read its actual content (handwritten/printed notes, a textbook page, a
diagram, a PDF) and ground your answer in what it actually shows — quote or describe the relevant part of it
rather than answering generically.

Every question is one of three types — pick whichever fits best:
- "concept": a definition, theory, or "what/why/how does X work" question.
- "numerical": a question that involves a calculation, formula, or worked math/logic problem
  (e.g. normalization steps, K-map, Boolean algebra simplification, complexity computation).
- "code": a question about syntax, an algorithm's implementation, or "how do I write/code X".

Given a student's doubt/question, respond with ONLY valid JSON, no markdown fences, no commentary, in
exactly this shape:
{"subject": "string", "type": "concept" | "numerical" | "code", "explanation": "string", "simpleExplanation": "string",
 "keyConcept": "string|null", "example": "string|null",
 "formula": "string|null", "steps": "string[]|null", "workedExample": "string|null",
 "codeSnippet": "string|null", "codeLanguage": "string|null", "commonMistake": "string|null"}
- "subject" must be one of the 6 subject names above (pick the closest match).
- "explanation": a clear, complete answer to the question, for every type.
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
If the question is unrelated to college coursework, or you are not confident in a grounded answer,
respond with:
{"subject": null, "type": null, "explanation": null, "simpleExplanation": null, "keyConcept": null, "example": null,
 "formula": null, "steps": null, "workedExample": null, "codeSnippet": null, "codeLanguage": null, "commonMistake": null}`;

  const userContent = [{ type: 'text', text: question }];
  if(attachment){
    if(attachment.type && attachment.type.startsWith('image/')){
      userContent.push({ type: 'image_url', image_url: { url: attachment.dataUrl } });
    } else {
      userContent.push({ type: 'file', file: { filename: attachment.name || 'attachment', file_data: attachment.dataUrl } });
    }
  }

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

    if(data.usage) console.log('[ask-doubt] tokens:', data.usage);

    const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    let parsed;
    try{
      parsed = JSON.parse(raw);
    } catch(e){
      return { statusCode: 502, body: JSON.stringify({ error: 'Model did not return valid JSON', raw }) };
    }

    if(!parsed.explanation){
      return { statusCode: 200, body: JSON.stringify({
        subject: null, type: null, explanation: null, simpleExplanation: null, keyConcept: null, example: null,
        formula: null, steps: null, workedExample: null, codeSnippet: null, codeLanguage: null, commonMistake: null
      }) };
    }

    parsed.usage = data.usage || null;
    return { statusCode: 200, body: JSON.stringify(parsed) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Groq API: ' + e.message }) };
  }
};
