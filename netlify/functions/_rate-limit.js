// Shared per-IP rate limiter backed by Netlify Blobs. Filename starts with `_` so
// Netlify's function router ignores it. Generous by design (30 requests/hour per IP,
// combined across every AI/YouTube-calling function) -- meant to stop a runaway bot
// or script from draining the Groq/YouTube quota, not to throttle real student usage.
const { getStore } = require('@netlify/blobs');

const LIMIT = 30;
const WINDOW_MS = 60 * 60 * 1000;

function store(){
  return getStore('ratelimits');
}

function clientIp(event){
  const headers = event.headers || {};
  const nf = headers['x-nf-client-connection-ip'];
  if(nf) return nf;
  const fwd = headers['x-forwarded-for'];
  if(fwd) return fwd.split(',')[0].trim();
  return 'unknown';
}

// Returns { allowed: boolean, remaining: number }. Increments the counter as a
// side effect on every call (whether allowed or not) -- callers should call this
// once per request, before doing any real work.
//
// Fails OPEN (allowed: true) if the Blobs store itself is unreachable or
// misconfigured -- e.g. no Netlify site linked, which is the case for every
// local run via local-server.js. Rate limiting is a cost/abuse guard, not a
// security boundary; a broken limiter should never be able to take the whole
// app down for every real student. Matches this project's existing pattern
// (see sync-account.js's error-handling note) of infra failures degrading
// gracefully instead of blocking usage.
async function checkRateLimit(event){
  const ip = clientIp(event);
  const key = 'ip:' + ip;
  const now = Date.now();
  try{
    const record = await store().get(key, { type: 'json' });
    if(!record || now - record.windowStart > WINDOW_MS){
      await store().setJSON(key, { count: 1, windowStart: now });
      return { allowed: true, remaining: LIMIT - 1 };
    }
    if(record.count >= LIMIT){
      return { allowed: false, remaining: 0 };
    }
    await store().setJSON(key, { count: record.count + 1, windowStart: record.windowStart });
    return { allowed: true, remaining: LIMIT - record.count - 1 };
  } catch(e){
    console.warn('[rate-limit] store unreachable, failing open:', e.message);
    return { allowed: true, remaining: LIMIT };
  }
}

module.exports = { checkRateLimit, clientIp, LIMIT, WINDOW_MS };
