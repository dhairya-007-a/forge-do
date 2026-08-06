// Netlify serverless function — keeps the Groq API key server-side.
// The frontend calls POST /.netlify/functions/grade-brainstorm with { topic, prompt, ideas }
// and never sees the key. Replaces the old client-side substring-match grading (which only
// scored an idea if it literally contained one of a small fixed seed-word list) with real
// AI judgment — a correct idea phrased differently now actually counts.

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

  let topic, prompt, ideas;
  try{
    const body = JSON.parse(event.body || '{}');
    topic = (body.topic || '').trim();
    prompt = (body.prompt || '').trim();
    ideas = Array.isArray(body.ideas) ? body.ideas.filter(i => typeof i === 'string' && i.trim()).slice(0, 50) : [];
  } catch(e){
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if(!topic || !ideas.length){
    return { statusCode: 400, body: JSON.stringify({ error: 'topic and ideas are required' }) };
  }

  const ideaList = ideas.map((idea, i) => `${i + 1}. ${idea}`).join('\n');
  const systemPrompt = `You are Forge, judging a 60-second brainstorm exercise for a B.Tech Computer Engineering student.
Topic: "${topic}". The prompt they were given: "${prompt}".

The student submitted these ideas (one per line, may include duplicates or junk — judge each on its own merit):
${ideaList}

For each idea, decide if it's a genuinely valid, real-world example that fits the prompt — accept different
phrasing, synonyms, or more specific/creative examples than an obvious textbook answer, as long as it
actually demonstrates the right concept. Reject vague filler, repeats of the topic name itself, or examples
that don't actually fit.

Respond with ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:
{"validCount": number, "feedback": "string"}
- "validCount": how many of the submitted ideas are genuinely valid (0 to ${ideas.length}).
- "feedback": 1-2 encouraging sentences — mention one specific idea they got right (if any) and, if some were
  rejected, briefly say what was missing, without listing every single idea.`;

  try{
    const { ok, status, data } = await callGroq({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Grade my brainstorm.' }
      ]
    });

    if(!ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: status, body: JSON.stringify({ error: message }) };
    }

    if(data.usage) console.log('[grade-brainstorm] tokens:', data.usage);

    const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    let parsed;
    try{
      parsed = JSON.parse(raw);
    } catch(e){
      return { statusCode: 502, body: JSON.stringify({ error: 'Model did not return valid JSON', raw }) };
    }

    if(typeof parsed.validCount !== 'number'){
      return { statusCode: 502, body: JSON.stringify({ error: 'Model returned an incomplete grading result' }) };
    }
    parsed.validCount = Math.max(0, Math.min(ideas.length, Math.round(parsed.validCount)));

    parsed.usage = data.usage || null;
    return { statusCode: 200, body: JSON.stringify(parsed) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Groq API: ' + e.message }) };
  }
};
