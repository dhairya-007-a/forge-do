// Netlify serverless function — keeps the Groq API key server-side.
// The frontend calls POST /.netlify/functions/readiness-verdict with
// { subject, dataReadiness: {overall, topicCoverage, weakTopic, mockScores, recency},
//   diagnostic: {correct, total, missedChapters: [chapterName,...]} }
// and never sees the key. Combines the student's real historical activity (readiness engine)
// with a fresh diagnostic quiz just taken into one clear ready/not-ready verdict — this
// function does not decide the numbers, only explains what they mean together.

const { callGroq } = require('./_groq-client');

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let subject, dataReadiness, diagnostic;
  try{
    const body = JSON.parse(event.body || '{}');
    subject = (body.subject || '').trim();
    dataReadiness = body.dataReadiness || {};
    diagnostic = body.diagnostic || {};
  } catch(e){
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if(!subject || typeof diagnostic.correct !== 'number' || typeof diagnostic.total !== 'number'){
    return { statusCode: 400, body: JSON.stringify({ error: 'subject and diagnostic {correct, total} are required' }) };
  }

  const missedText = (diagnostic.missedChapters || []).length ? diagnostic.missedChapters.join(', ') : 'none';
  const diagnosticPct = diagnostic.total ? Math.round(diagnostic.correct / diagnostic.total * 100) : 0;

  const systemPrompt = `You are Forge, giving a B.Tech Computer Engineering student a straight answer to "am I actually
ready for my ${subject} exam?"

Their real historical activity data (from everything they've studied/quizzed/asked on so far):
- Topic Coverage: ${dataReadiness.topicCoverage ?? 0}% of chapters touched
- Weak-Topic Resolution: ${dataReadiness.weakTopic ?? 0}% of previously-wrong chapters since fixed
- Mock/Quiz Scores: ${dataReadiness.mockScores ?? 0}% average accuracy
- Recency: ${dataReadiness.recency ?? 0}% (how recently they've studied this subject)
- Overall data score: ${dataReadiness.overall ?? 0}%

They JUST took a fresh ${diagnostic.total}-question diagnostic quiz right now, scoring ${diagnostic.correct}/${diagnostic.total}
(${diagnosticPct}%). Chapters they got wrong on this diagnostic: ${missedText}.

Weigh the fresh diagnostic quiz result more heavily than the historical data — it's a more current and
direct signal of whether they actually know the material right now.

Respond with ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:
{"verdict": "ready" | "borderline" | "not_ready", "summary": "string"}
- "verdict": "ready" if they'd likely pass comfortably, "borderline" if they'd likely scrape by or the
  result is mixed, "not_ready" if they'd likely struggle.
- "summary": 2-3 direct sentences — give the verdict plainly, name the SPECIFIC chapter(s) that most need
  work (from the diagnostic misses or low coverage, not generic advice), and one concrete next step.`;

  try{
    const { ok, status, data } = await callGroq({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 350,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Am I ready?' }
      ]
    });

    if(!ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: status, body: JSON.stringify({ error: message }) };
    }

    if(data.usage) console.log('[readiness-verdict] tokens:', data.usage);

    const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    let parsed;
    try{
      parsed = JSON.parse(raw);
    } catch(e){
      return { statusCode: 502, body: JSON.stringify({ error: 'Model did not return valid JSON', raw }) };
    }

    if(!['ready', 'borderline', 'not_ready'].includes(parsed.verdict) || !parsed.summary){
      return { statusCode: 502, body: JSON.stringify({ error: 'Model returned an incomplete verdict' }) };
    }

    parsed.usage = data.usage || null;
    return { statusCode: 200, body: JSON.stringify(parsed) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Groq API: ' + e.message }) };
  }
};
