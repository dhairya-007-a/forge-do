// Shared Groq caller for all Netlify functions. Filename starts with `_` so
// Netlify's function router ignores it (no exports.handler here).
// Tries GROQ_API_KEY, then GROQ_API_KEY_2, then GROQ_API_KEY_3, in that fixed
// order, advancing to the next key ONLY on a rate-limit/quota-shaped failure —
// any other error (bad request, server error, network failure) returns immediately.

async function callGroq(payload){
  const keys = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3]
    .filter(Boolean);
  let last = null;
  for(const key of keys){
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    if(resp.ok) return { ok: true, status: resp.status, data };
    const isRateLimit = resp.status === 429 ||
      /rate.?limit|quota/i.test((data && data.error && data.error.message) || '');
    last = { ok: false, status: resp.status, data };
    if(!isRateLimit) return last; // real error — don't waste retries on other keys
  }
  return last || { ok: false, status: 500, data: { error: { message: 'No Groq API key configured' } } };
}

module.exports = { callGroq };
