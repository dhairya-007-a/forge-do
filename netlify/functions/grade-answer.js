// Netlify serverless function — keeps the OpenRouter API key server-side.
// The frontend calls POST /.netlify/functions/grade-answer with { subject, question, answer }
// and never sees the key. Used by the Short Answer / Long Answer quiz tabs to grade a
// student's written answer against the question, the way the MCQ tab already grades
// multiple-choice answers instantly.

const MODEL_BY_TIER = {
  tier1: 'x-ai/grok-4.3',
  tier2: 'x-ai/grok-4.5'
};

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if(!apiKey){
    return { statusCode: 500, body: JSON.stringify({ error: 'OPENROUTER_API_KEY not configured on the server' }) };
  }

  let subject, question, answer;
  try{
    const body = JSON.parse(event.body || '{}');
    subject = (body.subject || '').trim();
    question = (body.question || '').trim();
    answer = (body.answer || '').trim();
  } catch(e){
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if(!question || !answer){
    return { statusCode: 400, body: JSON.stringify({ error: 'question and answer are required' }) };
  }

  const systemPrompt = `You are Forge, grading a B.Tech Computer Engineering (Semester 3) student's written answer.
Subject: ${subject || 'general coursework'}.

Given the question and the student's answer, judge it on its own academic merit — do not require exact
wording, just correct understanding. A one-sentence answer to a one-sentence question can be fully correct.

Respond with ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:
{"verdict": "correct" | "partial" | "incorrect", "feedback": "string"}
- "verdict": "correct" if the answer is academically right, "partial" if it's on the right track but
  missing something important or slightly wrong, "incorrect" if it misunderstands the concept.
- "feedback": 1-3 sentences. If correct, briefly confirm why. If partial or incorrect, say specifically
  what's missing or wrong, and give the key point the answer should have included — be direct and useful,
  not just "that's wrong."`;

  try{
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL_BY_TIER.tier1,
        max_tokens: 350,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Question: ${question}\n\nStudent's answer: ${answer}` }
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

    if(!parsed.verdict || !parsed.feedback){
      return { statusCode: 502, body: JSON.stringify({ error: 'Model returned an incomplete grading result' }) };
    }

    return { statusCode: 200, body: JSON.stringify(parsed) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach OpenRouter API: ' + e.message }) };
  }
};
