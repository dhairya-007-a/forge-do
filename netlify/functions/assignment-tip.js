// Netlify serverless function — keeps the OpenRouter API key server-side.
// The frontend calls POST /.netlify/functions/assignment-tip with { assignments }
// and never sees the key. Same pipeline shape as generate-note.js / ask-doubt.js.
// TEMP: using OpenRouter (Grok) instead of Anthropic for testing while the Anthropic account has $0 credit.

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if(!apiKey){
    return { statusCode: 500, body: JSON.stringify({ error: 'OPENROUTER_API_KEY not configured on the server' }) };
  }

  let assignments;
  try{
    const body = JSON.parse(event.body || '{}');
    assignments = Array.isArray(body.assignments) ? body.assignments : [];
  } catch(e){
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if(!assignments.length){
    return { statusCode: 400, body: JSON.stringify({ error: 'assignments is required and must be non-empty' }) };
  }

  const today = new Date().toISOString().slice(0,10);
  const listText = assignments
    .map(a => `- "${a.title}" (${a.subject || 'no subject given'}), due ${a.dueDate}`)
    .join('\n');

  const systemPrompt = `You are Forge, a study-planning assistant for a B.Tech Computer Engineering (Semester 3) student.
Today's date is ${today}. The student has these pending assignments/deadlines:
${listText}

Respond with ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:
{"tip": "string"}
The tip should be 2-3 sentences: name which assignment to prioritize first and why (based on how soon it's
due, not just alphabetically), and one concrete piece of advice for tackling it today. Be direct and specific
to the actual assignments listed, not generic advice.`;

  try{
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'x-ai/grok-4.3',
        max_tokens: 300,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'What should I prioritize?' }
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

    if(!parsed.tip){
      return { statusCode: 200, body: JSON.stringify({ tip: null }) };
    }

    return { statusCode: 200, body: JSON.stringify(parsed) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach OpenRouter API: ' + e.message }) };
  }
};
