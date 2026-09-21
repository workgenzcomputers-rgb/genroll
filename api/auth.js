// /api/auth?action=…
//
//   google        -> 302 to Google's consent screen
//   email-start   -> POST { email }  sends a one-time sign-in link
//   email-verify  -> GET  ?token=…   signs in and redirects home
//   me            -> GET  the signed-in user and their balance
//   logout        -> POST clears the session
//
// Google's redirect lands on /api/auth-callback, which is a separate file so
// the registered redirect URI stays a clean path with no query string.
//
// Every branch is off until its environment variables exist, so this endpoint
// is safe to deploy before any of it is configured.

const crypto = require('crypto');
const L = require('./_lib');

const SITE = (process.env.SITE_URL || 'https://genroll.in').replace(/\/+$/, '');
const LINK_TTL_MIN = 15;

function json(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(body);
}

async function readBody(req) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  return body || {};
}

// Anyone can type an address into the form, so keep the check strict and the
// length bounded before it reaches the mail provider.
function validEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length < 5 || email.length > 160) return null;
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return null;
  return email;
}

async function sendLink(email, url) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM,
      to: [email],
      subject: 'Your Genroll sign-in link',
      text:
        `Sign in to Genroll Studio:\n\n${url}\n\n` +
        `This link works once and expires in ${LINK_TTL_MIN} minutes. ` +
        `If you did not ask for it, you can ignore this email.`
    })
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    console.error('resend_failed', r.status, detail.slice(0, 300));
    throw new Error('mail_failed');
  }
}

module.exports = async (req, res) => {
  const action = String((req.query && req.query.action) || '');

  // ---- who am I ------------------------------------------------------------
  if (action === 'me') {
    if (!L.authReady) return json(res, 200, { signedIn: false, available: false });
    const id = L.currentUserId(req);
    if (!id) return json(res, 200, { signedIn: false, available: true });
    try {
      const user = await L.getUser(id);
      if (!user) return json(res, 200, { signedIn: false, available: true });
      return json(res, 200, {
        signedIn: true, available: true,
        email: user.email, credits: await L.balanceOf(id)
      });
    } catch {
      return json(res, 503, { signedIn: false, available: false, error: 'store_error' });
    }
  }

  // ---- sign out ------------------------------------------------------------
  if (action === 'logout') {
    L.clearSessionCookie(res);
    return json(res, 200, { signedIn: false });
  }

  // ---- Google --------------------------------------------------------------
  if (action === 'google') {
    if (!L.authReady || !L.googleReady) return json(res, 503, { error: 'google_not_configured' });

    // The state is signed rather than stored, so a callback cannot be forged
    // and no round trip to the store is needed to check it.
    const nonce = crypto.randomBytes(16).toString('base64url');
    const stamp = Date.now().toString(36);
    const value = `${nonce}.${stamp}`;
    const state = `${value}.${L.sign(value)}`;

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
    url.searchParams.set('redirect_uri', `${SITE}/api/auth-callback`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'select_account');

    res.setHeader('Set-Cookie',
      `gr_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 302;
    res.setHeader('Location', url.toString());
    return res.end();
  }

  // ---- email: ask for a link ----------------------------------------------
  if (action === 'email-start') {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(res, 405, { error: 'Method not allowed' }); }
    if (!L.authReady || !L.emailReady) return json(res, 503, { error: 'email_not_configured' });

    const email = validEmail((await readBody(req)).email);
    if (!email) return json(res, 400, { error: 'bad_email' });

    try {
      // One link at a time per address, so the form cannot be used to send
      // someone a stream of mail.
      const throttle = await L.cmd('SET', `mail:${L.userIdForEmail(email)}`, '1', 'NX', 'EX', '60');
      if (throttle === null) return json(res, 429, { error: 'too_soon', message: 'A link was just sent. Check your inbox.' });

      const token = crypto.randomBytes(32).toString('base64url');
      await L.setJSON(`magic:${token}`, { email }, LINK_TTL_MIN * 60);
      await sendLink(email, `${SITE}/api/auth?action=email-verify&token=${token}`);
      return json(res, 200, { sent: true });
    } catch (err) {
      console.error('email_start_failed', err.message);
      return json(res, 502, { error: 'mail_failed', message: 'The sign-in email could not be sent.' });
    }
  }

  // ---- email: follow the link ---------------------------------------------
  if (action === 'email-verify') {
    if (!L.authReady) return json(res, 503, { error: 'auth_not_configured' });
    const token = String((req.query && req.query.token) || '');
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return json(res, 400, { error: 'bad_token' });

    try {
      const record = await L.getJSON(`magic:${token}`);
      // Burn it whether or not it was valid: a link works exactly once.
      await L.cmd('DEL', `magic:${token}`);
      if (!record || !record.email) return json(res, 400, { error: 'link_expired', message: 'That link has expired or was already used.' });

      const user = await L.upsertUser(record.email, 'email');
      L.setSessionCookie(res, user.id);
      res.statusCode = 302;
      res.setHeader('Location', '/?signed-in=1');
      return res.end();
    } catch (err) {
      console.error('email_verify_failed', err.message);
      return json(res, 503, { error: 'store_error' });
    }
  }

  return json(res, 400, { error: 'unknown_action' });
};
