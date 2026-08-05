// Netlify serverless function — keeps the Groq API key server-side.
// The frontend calls POST /.netlify/functions/strategy-tip with { mode: "weekly" | "backlog" | "studyplan", ... }
// and never sees the key. Same pipeline shape as generate-note.js / ask-doubt.js / assignment-tip.js.
// studyplan mode: the chapter PRIORITY ORDER and day allocation are computed client-side (real data,
// deterministic, free) — this function only turns that already-decided schedule into an encouraging
// day-by-day narrative. The model does not decide what to study, only how to say it.

const { callGroq } = require('./_groq-client');

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try{
    body = JSON.parse(event.body || '{}');
  } catch(e){
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const today = new Date().toISOString().slice(0,10);
  let systemPrompt;

  if(body.mode === 'studyplan'){
    const { days, daysRemaining, subject } = body;
    if(!Array.isArray(days) || !days.length){
      return { statusCode: 400, body: JSON.stringify({ error: 'days is required and must be non-empty for studyplan mode' }) };
    }
    const scheduleText = days.map(d => {
      const items = d.items.map(it => `${it.chapter}${it.subject ? ' (' + it.subject + ')' : ''} — ${it.status === 'weak' ? 'previously got this wrong, needs fixing' : it.status === 'learning' ? 'asked about this but not tested on it yet' : 'not covered yet'}`).join('; ');
      return `Day ${d.day}: ${items}`;
    }).join('\n');
    systemPrompt = `You are Forge, a study-planning assistant for a B.Tech Computer Engineering student.
Today's date is ${today}. ${subject ? `Subject: ${subject}. ` : 'This plan covers multiple subjects with different exam dates. '}${daysRemaining} day(s) remain until the exam(s).

The chapter order and day-by-day allocation below has ALREADY been decided by the app based on the student's
real quiz/doubt history — do not change the order or reassign chapters to different days. Your only job is to
write it up as an encouraging, concrete, easy-to-follow day-by-day plan.

Schedule (already decided, follow it exactly):
${scheduleText}

Respond with ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:
{"plan": "string"}
"plan" must be formatted as one line per day, in this exact style, separated by real newlines, nothing else —
no intro, no summary:
Day <N>: <1-2 sentences: what to study today and why it's prioritized (in plain words, not jargon like
"weak chapter"), plus one concrete study tactic for that day (e.g. practice problems, flashcards, re-reading
notes)>`;
  } else if(body.mode === 'backlog'){
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
    const { ok, status, data } = await callGroq({
      model: 'llama-3.3-70b-versatile',
      max_tokens: body.mode === 'studyplan' ? 900 : 350,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: body.mode === 'studyplan' ? 'Write up my study plan.' : body.mode === 'backlog' ? 'How do I cover this?' : 'What should I focus on this week?' }
      ]
    });

    if(!ok){
      const message = (data && data.error && data.error.message) || 'Groq API error';
      return { statusCode: status, body: JSON.stringify({ error: message }) };
    }

    if(data.usage) console.log('[strategy-tip] tokens:', data.usage);

    const raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    let parsed;
    try{
      parsed = JSON.parse(raw);
    } catch(e){
      return { statusCode: 502, body: JSON.stringify({ error: 'Model did not return valid JSON', raw }) };
    }

    const resultKey = body.mode === 'studyplan' ? 'plan' : 'tip';
    if(!parsed[resultKey]){
      return { statusCode: 200, body: JSON.stringify({ [resultKey]: null, usage: data.usage || null }) };
    }

    parsed.usage = data.usage || null;
    return { statusCode: 200, body: JSON.stringify(parsed) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Groq API: ' + e.message }) };
  }
};
