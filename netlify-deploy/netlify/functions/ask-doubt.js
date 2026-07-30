// Netlify serverless function — keeps the Anthropic API key server-side.
// The frontend calls POST /.netlify/functions/ask-doubt with { question, tier }
// and never sees the key. Same pipeline shape as generate-note.js: capture input ->
// build prompt -> call Claude -> parse -> return structured JSON for the UI to render.

const MODEL_BY_TIER = {
  tier1: 'claude-haiku-4-5-20251001',
  tier2: 'claude-sonnet-5'
};

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if(!apiKey){
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured on the server' }) };
  }

  let question, tier;
  try{
    const body = JSON.parse(event.body || '{}');
    question = (body.question || '').trim();
    tier = MODEL_BY_TIER[body.tier] ? body.tier : 'tier1';
  } catch(e){
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if(!question){
    return { statusCode: 400, body: JSON.stringify({ error: 'question is required' }) };
  }

  const systemPrompt = `You are Forge, an academic doubt-solving assistant for a B.Tech Computer Engineering (Semester 3) student.
Subjects this semester: Introduction to Data Structures and Algorithms, Introduction to Database Management System,
Introduction to Object Oriented Programming, Digital Electronics, Discrete Mathematics, Business Ethics and Intellectual Property Rights.

Explain concepts in simple, everyday language. Use real-life analogies and examples wherever possible
(relate the concept to something from daily life). Avoid dense textbook jargon unless the technical term
itself needs to be taught.

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
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL_BY_TIER[tier],
        max_tokens: 700,
        system: systemPrompt,
        messages: [{ role: 'user', content: question }]
      })
    });

    const data = await resp.json();

    if(!resp.ok){
      const message = (data && data.error && data.error.message) || 'Anthropic API error';
      return { statusCode: resp.status, body: JSON.stringify({ error: message }) };
    }

    const raw = (data.content && data.content[0] && data.content[0].text) || '';
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
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Anthropic API: ' + e.message }) };
  }
};
