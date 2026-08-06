// Vercel serverless function — keeps the Groq API key server-side.
// The frontend calls POST /api/grade-answer with { subject, question, answer }
// and never sees the key. Used by the Short Answer / Long Answer quiz tabs to grade a
// student's written answer against the question, the way the MCQ tab already grades
// multiple-choice answers instantly.

const { callGroq } = require('./_groq-client');
const { checkRateLimit } = require('./_rate-limit');

const MODEL_BY_TIER = {
  tier1: 'llama-3.3-70b-versatile',
  tier2: 'llama-3.3-70b-versatile'
};

module.exports = async function handler(req, res){
  if(req.method !== 'POST'){
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rl = await checkRateLimit(req);
  if(!rl.allowed){
    return res.status(429).json({ error: 'Too many requests — try again later' });
  }

  const body = req.body || {};
  const subject = (body.subject || '').trim();
  const question = (body.question || '').trim();
  const answer = (body.answer || '').trim();

  if(!question || !answer){
    return res.status(400).json({ error: 'question and answer are required' });
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
    const { ok, status, data } = await callGroq({
      model: MODEL_BY_TIER.tier1,
      max_tokens: 350,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Question: ${question}\n\nStudent's answer: ${answer}` }
      ]
    });

    if(!ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return res.status(status).json({ error: message });
    }

    if(data.usage) console.log('[grade-answer] tokens:', data.usage);

    const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    let parsed;
    try{
      parsed = JSON.parse(raw);
    } catch(e){
      return res.status(502).json({ error: 'Model did not return valid JSON', raw });
    }

    if(!parsed.verdict || !parsed.feedback){
      return res.status(502).json({ error: 'Model returned an incomplete grading result' });
    }

    parsed.usage = data.usage || null;
    return res.status(200).json(parsed);
  } catch(e){
    return res.status(502).json({ error: 'Failed to reach Groq API: ' + e.message });
  }
};
