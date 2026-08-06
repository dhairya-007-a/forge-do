// Netlify serverless function — keeps the Groq API key server-side.
// The frontend calls POST /.netlify/functions/viva-turn with { subject, history, chapters }
// and never sees the key. Drives the Viva Prep feature: an AI oral examiner that
// asks a question, grades the student's spoken (transcribed) answer, and asks a
// natural follow-up — one continuous conversation, same pipeline shape as the
// other Forge functions (ask-doubt.js, grade-answer.js). chapters comes from the
// client's own COURSE_CHAPTERS copy (same pattern as generate-quiz.js) so each
// question can be classified by chapter and logged to forge-topic-activity,
// making Viva Prep count toward Weak-Topic Resolution / Topic Coverage like every
// other activity source instead of being invisible to them.

const { callGroq } = require('./_groq-client');
const { checkRateLimit } = require('./_rate-limit');

const MODEL_BY_TIER = {
  tier1: 'llama-3.3-70b-versatile'
};

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const rl = await checkRateLimit(event);
  if(!rl.allowed){
    return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests — try again later' }) };
  }

  let subject, history, chapters;
  try{
    const body = JSON.parse(event.body || '{}');
    subject = (body.subject || '').trim();
    history = Array.isArray(body.history) ? body.history : [];
    chapters = Array.isArray(body.chapters) ? body.chapters.filter(c => typeof c === 'string' && c.trim()) : [];
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

  const chapterList = chapters.join(', ');

  const systemPrompt = `You are Forge, acting as a friendly but rigorous oral exam (viva) examiner for a B.Tech
Computer Engineering (Semester 3) student, on the subject: ${subject}.
${chapters.length ? `\nThis subject's chapters are: ${chapterList}.\n` : ''}
${isOpening
  ? 'This is the start of the viva. Ask ONE clear opening question on this subject — pick a fundamental, commonly-tested concept.'
  : 'The conversation so far alternates your questions and the student\'s spoken (voice-transcribed) answers. Grade the student\'s most recent answer, then ask ONE natural follow-up question — either digging deeper into the same topic if the answer was weak, or moving to a related concept if it was strong. Speak the way a real examiner would: brief acknowledgment, then the next question. Do not repeat a question already asked in this conversation.'}

Keep your reply to 2-4 sentences total — it will be read aloud by text-to-speech, so it must sound natural
spoken out loud, not like written text (no bullet points, no markdown, no headings).

Respond with ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:
{"reply": "string", "verdict": "correct" | "partial" | "incorrect" | null, "chapter": "string" | null}
- "reply": what you'd say out loud — the grading remark (if applicable) plus the next question, as one
  natural spoken passage.
- "verdict": grade the previous answer as "correct", "partial", or "incorrect". Use null only for the
  opening question, when there is no previous answer yet to grade.
- "chapter": which chapter the question you are asking IN THIS REPLY belongs to${chapters.length ? ' — must be copied EXACTLY (character-for-character) from the chapter list above' : ''}. Use null only if no chapter list was given.`;

  try{
    const { ok, status, data } = await callGroq({
      model: MODEL_BY_TIER.tier1,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        ...(isOpening ? [{ role: 'user', content: 'Begin the viva.' }] : cappedHistory)
      ]
    });

    if(!ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: status, body: JSON.stringify({ error: message }) };
    }

    if(data.usage) console.log('[viva-turn] tokens:', data.usage);

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

    parsed.usage = data.usage || null;
    return { statusCode: 200, body: JSON.stringify(parsed) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Groq API: ' + e.message }) };
  }
};
