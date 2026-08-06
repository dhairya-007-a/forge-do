// Shared per-IP rate limiter backed by Upstash Redis. Filename starts with `_` so
// Vercel's file-based routing ignores it under api/. Generous by design (30
// requests/hour per IP, combined across every AI/YouTube-calling function) --
// meant to stop a runaway bot or script from draining the Groq/YouTube quota, not
// to throttle real student usage.
const { Redis } = require('@upstash/redis');

const LIMIT = 30;
const WINDOW_MS = 60 * 60 * 1000;

function store(){
  return Redis.fromEnv();
}

function clientIp(req){
  const headers = req.headers || {};
  const fwd = headers['x-forwarded-for'];
  if(fwd) return (Array.isArray(fwd) ? fwd[0] : fwd).split(',')[0].trim();
  return 'unknown';
}

// Returns { allowed: boolean, remaining: number }. Increments the counter as a
// side effect on every call (whether allowed or not) -- callers should call this
// once per request, before doing any real work.
//
// Fails OPEN (allowed: true) if the Redis store itself is unreachable or
// misconfigured -- e.g. no database linked/pulled, which is the case for `vercel
// dev` before `vercel env pull` has been run. Rate limiting is a cost/abuse guard,
// not a security boundary; a broken limiter should never be able to take the whole
// app down for every real student.
async function checkRateLimit(req){
  const ip = clientIp(req);
  const key = 'ip:' + ip;
  const now = Date.now();
  try{
    const record = await store().get(key);
    if(!record || now - record.windowStart > WINDOW_MS){
      await store().set(key, { count: 1, windowStart: now });
      return { allowed: true, remaining: LIMIT - 1 };
    }
    if(record.count >= LIMIT){
      return { allowed: false, remaining: 0 };
    }
    await store().set(key, { count: record.count + 1, windowStart: record.windowStart });
    return { allowed: true, remaining: LIMIT - record.count - 1 };
  } catch(e){
    console.warn('[rate-limit] store unreachable, failing open:', e.message);
    return { allowed: true, remaining: LIMIT };
  }
}

module.exports = { checkRateLimit, clientIp, LIMIT, WINDOW_MS };
