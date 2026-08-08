// Real, edge-enforced admin gate. Replaces the netlify.toml `Basic-Auth` header
// directive, which silently no-ops on this site's plan (that feature is Pro-plan-only --
// on free/starter plans Netlify ignores it with no error, so the "edge auth" it looked
// like was configured never actually ran; confirmed live by reaching admin-dashboard.html
// with zero credential prompt). Edge Functions run on every plan, so this actually gates
// the paths declared for it in netlify.toml before the static file or function is served.
const USER = 'forgeadmin';
const PASS = 'gpKbr6fTPiIbPzif';

export default async (request, context) => {
  const auth = request.headers.get('authorization') || '';
  const expected = 'Basic ' + btoa(`${USER}:${PASS}`);
  if (auth === expected) {
    return context.next();
  }
  return new Response('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Forge Admin"' }
  });
};
