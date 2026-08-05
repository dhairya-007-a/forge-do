// Netlify serverless function — keeps the Groq API key server-side.
// The frontend calls POST /.netlify/functions/generate-note with { topic, tier }
// and never sees the key.

const { callGroq } = require('./_groq-client');

const MODEL_BY_TIER = {
  tier1: 'llama-3.3-70b-versatile',
  tier2: 'llama-3.3-70b-versatile'
};

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
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
Subjects this semester: Data Structures and Algorithms, Database Management System,
Object Oriented Programming, Digital Electronics, Discrete Mathematics, Business Ethics and IPR.

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
    const { ok, status, data } = await callGroq({
      model: MODEL_BY_TIER[tier],
      max_tokens: 700,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: topic }
      ]
    });

    if(!ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: status, body: JSON.stringify({ error: message }) };
    }

    if(data.usage) console.log('[generate-note] tokens:', data.usage);

    const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    let parsed;
    try{
      parsed = JSON.parse(raw);
    } catch(e){
      return { statusCode: 502, body: JSON.stringify({ error: 'Model did not return valid JSON', raw }) };
    }

    if(!parsed.title || !Array.isArray(parsed.sections) || !parsed.sections.length){
      return { statusCode: 200, body: JSON.stringify({ title: null, sections: [], usage: data.usage || null }) };
    }

    parsed.usage = data.usage || null;
    return { statusCode: 200, body: JSON.stringify(parsed) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Groq API: ' + e.message }) };
  }
};
