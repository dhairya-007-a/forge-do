// Netlify serverless function — keeps the Groq API key server-side.
// The frontend calls POST /.netlify/functions/strategy-tip with { mode: "weekly" | "backlog", ... }
// and never sees the key. Same pipeline shape as generate-note.js / ask-doubt.js / assignment-tip.js.

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.GROQ_API_KEY;
  if(!apiKey){
    return { statusCode: 500, body: JSON.stringify({ error: 'GROQ_API_KEY not configured on the server' }) };
  }

  let body;
  try{
    body = JSON.parse(event.body || '{}');
  } catch(e){
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const today = new Date().toISOString().slice(0,10);
  let systemPrompt;

  if(body.mode === 'backlog'){
    const { backlogSubject, attempt, examDate } = body;
    if(!backlogSubject || !examDate){
      return { statusCode: 400, body: JSON.stringify({ error: 'backlogSubject and examDate are required for backlog mode' }) };
    }
    systemPrompt = `You are Forge, a study-planning assistant for a B.Tech Computer Engineering student.
Today's date is ${today}. The student has a backlog (reappear/back) in "${backlogSubject}", this is attempt
number ${attempt}, and the exam is on ${examDate}.

Respond with ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:
{"tip": "string"}
The tip should be 3-4 sentences: a concrete, realistic catch-up plan for clearing this specific backlog exam
given how much time is left — what to prioritize studying first (core topics vs full syllabus depending on
days remaining), and one practical study tactic (e.g. past papers, focus areas) specific to this subject.
Be direct and encouraging but honest about the time pressure, not generic advice.`;
  } else {
    const { academic, assignments } = body;
    if(!academic){
      return { statusCode: 400, body: JSON.stringify({ error: 'academic is required for weekly mode' }) };
    }
    const cgpaText = (academic.cgpaHistory || []).map(c => `Sem ${c.semester}: SGPA ${c.sgpa}`).join(', ') || 'none recorded';
    const attendanceText = (academic.attendance || []).map(a => `${a.subject}: ${a.percent}%`).join(', ') || 'none recorded';
    const backlogText = (academic.backlogs || []).map(b => `${b.subject} (attempt ${b.attempt}, exam ${b.examDate})`).join(', ') || 'none';
    const assignmentText = (assignments || []).map(a => `${a.title} (${a.subject || 'no subject'}), due ${a.dueDate}`).join(', ') || 'none';

    systemPrompt = `You are Forge, a study-planning assistant for a B.Tech Computer Engineering student.
Today's date is ${today}. Required attendance cutoff is ${academic.attendanceCutoff}%.
CGPA history: ${cgpaText}
Attendance per subject: ${attendanceText}
Backlog subjects: ${backlogText}
Pending assignments: ${assignmentText}

Respond with ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:
{"tip": "string"}
The tip should be 3-4 sentences giving one clear "what to focus on this week" plan that weighs all of the
above together — backlog exams closest in time and attendance below cutoff are the highest risk and should
usually come first, but weigh them against real assignment deadlines too. Name specific subjects/assignments
from the data given, not generic advice. If everything above is empty/clean, say so and give a light general
tip instead.`;
  }

  try{
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 350,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: body.mode === 'backlog' ? 'How do I cover this?' : 'What should I focus on this week?' }
        ]
      })
    });

    const data = await resp.json();

    if(!resp.ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: resp.status, body: JSON.stringify({ error: message }) };
    }

    if(data.usage) console.log('[strategy-tip] tokens:', data.usage);

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
