// /api/auth-callback — where Google sends the browser back.
//
// Registered redirect URI: https://genroll.in/api/auth-callback
//
// The code is exchanged server-side, so the client secret never reaches the
// browser. Only the email claim is used; no Google token is kept.

const L = require('./_lib');

const SITE = (process.env.SITE_URL || 'https://genroll.in').replace(/\/+$/, '');

function bail(res, reason) {
  res.statusCode = 302;
  res.setHeader('Location', `/?sign-in-error=${encodeURIComponent(reason)}`);
  return res.end();
}

module.exports = async (req, res) => {
  if (!L.authReady || !L.googleReady) return bail(res, 'not_configured');

  const q = req.query || {};
  if (q.error) return bail(res, String(q.error).slice(0, 40));

  const code = String(q.code || '');
  const state = String(q.state || '');
  if (!code || !state) return bail(res, 'missing_code');

  // The state must match the cookie set when the flow began AND carry our own
  // signature — one guards against a swapped cookie, the other against a
  // forged link.
  const cookieState = L.parseCookies(req).gr_state || '';
  if (!cookieState || !L.safeEqual(cookieState, state)) return bail(res, 'state_mismatch');

  const parts = state.split('.');
  if (parts.length !== 3 || !L.safeEqual(L.sign(`${parts[0]}.${parts[1]}`), parts[2])) {
    return bail(res, 'bad_state');
  }

  try {
    const token = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${SITE}/api/auth-callback`,
        grant_type: 'authorization_code'
      })
    }).then((r) => r.json());

    if (!token.id_token) {
      console.error('google_token_exchange_failed', token.error, token.error_description);
      return bail(res, 'token_exchange_failed');
    }

    // The id_token came straight from Google's token endpoint over TLS in this
    // very request, so reading the payload is enough; there is no third party
    // in between whose signature we would need to re-check.
    const payload = JSON.parse(Buffer.from(token.id_token.split('.')[1], 'base64url').toString());
    const email = payload && payload.email;
    if (!email) return bail(res, 'no_email');
    if (payload.email_verified === false) return bail(res, 'email_unverified');

    const user = await L.upsertUser(email, 'google');
    L.setSessionCookie(res, user.id);
    res.statusCode = 302;
    res.setHeader('Location', '/?signed-in=1');
    return res.end();
  } catch (err) {
    console.error('google_callback_failed', err.message);
    return bail(res, 'server_error');
  }
};
