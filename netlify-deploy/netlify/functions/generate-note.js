// Netlify serverless function — keeps the Anthropic API key server-side.
// The frontend calls POST /.netlify/functions/generate-note with { topic, tier }
// and never sees the key.

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

  let topic, tier;
  try{
    const body = JSON.parse(event.body || '{}');
    topic = (body.topic || '').trim();
    tier = MODEL_BY_TIER[body.tier] ? body.tier : 'tier1';
  } catch(e){
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if(!topic){
    return { statusCode: 400, body: JSON.stringify({ error: 'topic is required' }) };
  }

  const systemPrompt = `You are Forge, a college study-notes generator for a B.Tech Computer Engineering (Semester 3) student.
Subjects this semester: Introduction to Data Structures and Algorithms, Introduction to Database Management System,
Introduction to Object Oriented Programming, Digital Electronics, Discrete Mathematics, Business Ethics and Intellectual Property Rights.

Explain concepts in simple, everyday language. Use real-life analogies wherever possible. Avoid dense
textbook jargon unless the technical term itself needs to be taught.

Given a topic, respond with ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:
{"title": "string", "sections": [{"heading": "string", "bullets": ["string", "string"]}]}
Produce exactly 5 sections, in this order, with these exact heading names, each with 2 bullets:
1. "What it is" — a clear, simple definition plus one sentence of context
2. "Key Concept" — the one core idea/rule the student must remember, in two angles
3. "How It Works" — the mechanism/process itself, one level deeper than Key Concept
4. "Example" — a concrete real-life analogy plus a second worked/technical example
5. "Watch Out For" — two common mistakes, misconceptions, or edge cases students get wrong on this exact topic
Each bullet must be a complete, specific, substantive sentence — not a fragment, not generic filler.
Write enough real content that the note reads as a genuinely useful full page of study material, not a
skeleton outline.
If the topic is unrelated to college coursework or you are not confident enough to teach it accurately,
respond with:
{"title": null, "sections": []}`;

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
        messages: [{ role: 'user', content: topic }]
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

    if(!parsed.title || !Array.isArray(parsed.sections) || !parsed.sections.length){
      return { statusCode: 200, body: JSON.stringify({ title: null, sections: [] }) };
    }

    return { statusCode: 200, body: JSON.stringify(parsed) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Anthropic API: ' + e.message }) };
  }
};
