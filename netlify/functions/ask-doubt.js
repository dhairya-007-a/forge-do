// Netlify serverless function — keeps the OpenRouter API key server-side.
// The frontend calls POST /.netlify/functions/ask-doubt with { question, tier, history, attachment }
// and never sees the key. Same pipeline shape as generate-note.js: capture input ->
// build prompt -> call Grok -> parse -> return structured JSON for the UI to render.
// attachment (optional): { name, type, dataUrl } — an image or PDF the model reads directly
// (Grok models on OpenRouter support image + file input modalities natively, no OCR library needed).
// TEMP: using OpenRouter (Grok) instead of Anthropic for testing while the Anthropic account has $0 credit.

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

Given a student's doubt/question, respond with ONLY valid JSON, no markdown fences, no commentary, in
exactly this shape:
{"subject": "string", "explanation": "string", "simpleExplanation": "string", "keyConcept": "string", "example": "string"}
- "subject" must be one of the 6 subject names above (pick the closest match).
- "explanation": a clear, complete answer to the question.
- "simpleExplanation": the same answer said much more simply — short sentences, plainest possible words,
  as if explaining to someone with no background in the subject at all.
- "keyConcept": the one core idea the student should remember.
- "example": a concrete real-life analogy or worked example.
If the question is unrelated to college coursework, or you are not confident in a grounded answer,
respond with:
{"subject": null, "explanation": null, "simpleExplanation": null, "keyConcept": null, "example": null}`;

  const userContent = [{ type: 'text', text: question }];
  if(attachment){
    if(attachment.type && attachment.type.startsWith('image/')){
      userContent.push({ type: 'image_url', image_url: { url: attachment.dataUrl } });
    } else {
      userContent.push({ type: 'file', file: { filename: attachment.name || 'attachment', file_data: attachment.dataUrl } });
    }
  }

  try{
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL_BY_TIER[tier],
        max_tokens: 900,
        messages: [
          { role: 'system', content: systemPrompt },
          ...cappedHistory,
          { role: 'user', content: attachment ? userContent : question }
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

    if(!parsed.explanation){
      return { statusCode: 200, body: JSON.stringify({ subject: null, explanation: null, simpleExplanation: null, keyConcept: null, example: null }) };
    }

    return { statusCode: 200, body: JSON.stringify(parsed) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach OpenRouter API: ' + e.message }) };
  }
};
