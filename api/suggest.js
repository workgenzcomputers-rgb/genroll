// POST /api/suggest   { email, message }
// -> { ok: true }
//
// A visitor's suggestion, delivered to the owner's inbox with Reply-To set to
// the sender, so replying from the mail client goes straight back to them. A
// copy is also written to the store, because mail can bounce and a suggestion
// nobody kept is a suggestion nobody reads.
//
// No sign-in: the point is to hear from people who have not signed up yet. That
// makes it an open form, so it is rate limited per address and per IP, the
// fields are length capped, and a hidden field catches the simplest bots.

const crypto = require('crypto');
const L = require('./_lib');

// SUGGEST_TO wins, so the inbox these land in can be changed without
// touching OWNER_EMAIL, which other things may come to rely on.
const TO = process.env.SUGGEST_TO || process.env.OWNER_EMAIL || '';
const MAX = 2000;

function json(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(body);
}

function validEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length < 5 || email.length > 160) return null;
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return null;
  return email;
}

// Header injection is not possible through Resend's JSON API, but a subject
// built from user input still gets a scrub so it cannot carry line breaks.
function subjectFor(email) {
  return ('Genroll suggestion from ' + email).replace(/[\r\n]+/g, ' ').slice(0, 160);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'Method not allowed' });
  }
  if (!L.emailReady || !TO) {
    return json(res, 503, {
      error: 'not_configured',
      message: 'Suggestions are not switched on for this deployment yet.'
    });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  // Hidden field. A person never fills this; a naive bot fills everything.
  // Answer 200 so the bot has nothing to learn from the difference.
  if (String(body.website || '').trim()) return json(res, 200, { ok: true });

  const email = validEmail(body.email);
  if (!email) return json(res, 400, { error: 'bad_email', message: 'Enter the email address you want a reply on.' });

  const message = String(body.message || '').trim();
  if (message.length < 4) return json(res, 400, { error: 'empty', message: 'Write your suggestion first.' });
  if (message.length > MAX) return json(res, 400, { error: 'too_long', message: `Keep it under ${MAX} characters.` });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

  try {
    const perAddress = await L.cmd('SET', `sug:mail:${L.userIdForEmail(email)}`, '1', 'NX', 'EX', '120');
    if (perAddress === null) {
      return json(res, 429, { error: 'too_soon', message: 'That one is in. Give it a couple of minutes before the next.' });
    }
    const perIp = await L.cmd('INCR', `sug:ip:${crypto.createHash('sha256').update(ip).digest('hex').slice(0, 24)}`);
    if (Number(perIp) === 1) await L.cmd('EXPIRE', `sug:ip:${crypto.createHash('sha256').update(ip).digest('hex').slice(0, 24)}`, '3600');
    if (Number(perIp) > 10) {
      return json(res, 429, { error: 'too_many', message: 'That is a lot of suggestions for one hour. Try again later.' });
    }

    const id = 'sg_' + crypto.randomBytes(8).toString('hex');
    const record = { id, email, message, createdAt: Date.now(), ip };
    await L.setJSON(`suggestion:${id}`, record, 365 * 86400);
    await L.cmd('LPUSH', 'suggestions', id);

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM,
        to: [TO],
        // This is the whole point: hitting reply answers the person who wrote in.
        reply_to: [email],
        subject: subjectFor(email),
        text: `${message}\n\n—\nFrom: ${email}\nReply to this mail and it goes back to them.\nRef: ${id}`
      })
    });

    if (!r.ok) {
      // The suggestion is already saved, so this is not a failure for the
      // person who wrote it. Say it landed, and log for the owner.
      const detail = await r.text().catch(() => '');
      console.error('suggestion_mail_failed', id, r.status, detail.slice(0, 300));
      return json(res, 200, { ok: true, mailed: false });
    }

    console.log('SUGGESTION', id, email);
    return json(res, 200, { ok: true, mailed: true });
  } catch (err) {
    console.error('suggest_failed', err.message);
    return json(res, 503, { error: 'store_error', message: 'That did not send. Try again in a moment.' });
  }
};
