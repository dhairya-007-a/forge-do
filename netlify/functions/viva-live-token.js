// Netlify serverless function — mints a short-lived Gemini Live API ephemeral token
// so the browser can open a WebSocket directly to Google's Live API for real-time
// voice Viva Prep, without ever seeing GEMINI_API_KEY. Single-use, 1-minute window to
// start the session (Google's default), 30-minute session cap once connected.
const { checkRateLimit } = require('./_rate-limit');

exports.handler = async function(event){
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const rl = await checkRateLimit(event);
  if(!rl.allowed){
    return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests — try again later' }) };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if(!apiKey){
    return { statusCode: 500, body: JSON.stringify({ error: 'Gemini API key not configured' }) };
  }

  const now = Date.now();
  const expireTime = new Date(now + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(now + 60 * 1000).toISOString();

  try{
    const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ uses: 1, expireTime, newSessionExpireTime })
    });
    const data = await resp.json();
    if(!resp.ok){
      return { statusCode: 502, body: JSON.stringify({ error: 'Gemini token mint failed: ' + (data.error?.message || resp.status) }) };
    }
    return { statusCode: 200, body: JSON.stringify({ token: data.name }) };
  } catch(e){
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to mint Gemini token: ' + e.message }) };
  }
};
