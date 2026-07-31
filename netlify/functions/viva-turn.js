// Netlify serverless function — keeps the OpenRouter API key server-side.
// The frontend calls POST /.netlify/functions/viva-turn with { subject, history }
// and never sees the key. Drives the Viva Prep feature: an AI oral examiner that
// asks a question, grades the student's spoken (transcribed) answer, and asks a
// natural follow-up — one continuous conversation, same pipeline shape as the
// other Forge functions (ask-doubt.js, grade-answer.js).

const MODEL_BY_TIER = {
  tier1: 'x-ai/grok-4.3'
};

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if(!apiKey){
    return { statusCode: 500, body: JSON.stringify({ error: 'OPENROUTER_API_KEY not configured on the server' }) };
  }

  let subject, history;
  try{
    const body = JSON.parse(event.body || '{}');
    subject = (body.subject || '').trim();
    history = Array.isArray(body.history) ? body.history : [];
  } catch(e){
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if(!subject){
    return { statusCode: 400, body: JSON.stringify({ error: 'subject is required' }) };
  }

  // Defensive cap — last 5 exchanges (10 messages) so a long viva session doesn't blow up cost
  const cappedHistory = history
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-10);

  const isOpening = cappedHistory.length === 0;

  const systemPrompt = `You are Forge, acting as a friendly but rigorous oral exam (viva) examiner for a B.Tech
Computer Engineering (Semester 3) student, on the subject: ${subject}.

${isOpening
  ? 'This is the start of the viva. Ask ONE clear opening question on this subject — pick a fundamental, commonly-tested concept.'
  : 'The conversation so far alternates your questions and the student\'s spoken (voice-transcribed) answers. Grade the student\'s most recent answer, then ask ONE natural follow-up question — either digging deeper into the same topic if the answer was weak, or moving to a related concept if it was strong. Speak the way a real examiner would: brief acknowledgment, then the next question. Do not repeat a question already asked in this conversation.'}

Keep your reply to 2-4 sentences total — it will be read aloud by text-to-speech, so it must sound natural
spoken out loud, not like written text (no bullet points, no markdown, no headings).

Respond with ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:
{"reply": "string", "verdict": "correct" | "partial" | "incorrect" | null}
- "reply": what you'd say out loud — the grading remark (if applicable) plus the next question, as one
  natural spoken passage.
- "verdict": grade the previous answer as "correct", "partial", or "incorrect". Use null only for the
  opening question, when there is no previous answer yet to grade.`;

  try{
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL_BY_TIER.tier1,
        max_tokens: 400,
        messages: [
          { role: 'system', content: systemPrompt },
          ...(isOpening ? [{ role: 'user', content: 'Begin the viva.' }] : cappedHistory)
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

    if(!parsed.reply){
      return { statusCode: 502, body: JSON.stringify({ error: 'Model returned an empty reply' }) };
    }

    return { statusCode: 200, body: JSON.stringify(parsed) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach OpenRouter API: ' + e.message }) };
  }
};
