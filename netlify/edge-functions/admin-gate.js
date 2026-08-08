// Real, edge-enforced admin gate. Replaces the netlify.toml `Basic-Auth` header
// directive, which silently no-ops on this site's plan (that feature is Pro-plan-only --
// on free/starter plans Netlify ignores it with no error, so the "edge auth" it looked
// like was configured never actually ran; confirmed live by reaching admin-dashboard.html
// with zero credential prompt). Edge Functions run on every plan, so this actually gates
// the paths declared for it in netlify.toml before the static file or function is served.
// Credentials come from ADMIN_USER/ADMIN_PASS env vars, not hardcoded --
// comparison is done on SHA-256 digests of fixed length so the byte-wise
// check below can't leak timing information about the secret's length or content.
async function sha256(text){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return new Uint8Array(buf);
}
function timingSafeEqual(a, b){
  if (a.length !== b.length) return false; // both are 32-byte SHA-256 digests, always equal length
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export default async (request, context) => {
  const user = Netlify.env.get('ADMIN_USER');
  const pass = Netlify.env.get('ADMIN_PASS');
  const auth = request.headers.get('authorization') || '';
  const expected = 'Basic ' + btoa(`${user}:${pass}`);
  const [gotHash, expHash] = await Promise.all([sha256(auth), sha256(expected)]);
  if (timingSafeEqual(gotHash, expHash)) {
    return context.next();
  }
  return new Response('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Forge Admin"' }
  });
};
