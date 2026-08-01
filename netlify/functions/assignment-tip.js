// Netlify serverless function — keeps the Groq API key server-side.
// The frontend calls POST /.netlify/functions/assignment-tip with { assignments }
// and never sees the key. Same pipeline shape as generate-note.js / ask-doubt.js.

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.GROQ_API_KEY;
  if(!apiKey){
    return { statusCode: 500, body: JSON.stringify({ error: 'GROQ_API_KEY not configured on the server' }) };
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
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 300,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'What should I prioritize?' }
        ]
      })
    });

    const data = await resp.json();

    if(!resp.ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: resp.status, body: JSON.stringify({ error: message }) };
    }

    if(data.usage) console.log('[assignment-tip] tokens:', data.usage);

    const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    let parsed;
    try{
      parsed = JSON.parse(raw);
    } catch(e){
      return { statusCode: 502, body: JSON.stringify({ error: 'Model did not return valid JSON', raw }) };
    }

    if(!parsed.tip){
      return { statusCode: 200, body: JSON.stringify({ tip: null, usage: data.usage || null }) };
    }

    parsed.usage = data.usage || null;
    return { statusCode: 200, body: JSON.stringify(parsed) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Groq API: ' + e.message }) };
  }
};
