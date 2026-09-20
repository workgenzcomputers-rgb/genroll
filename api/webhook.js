// POST /api/webhook  — Razorpay server-to-server events.
//
// This is what actually keeps billing state correct. The Checkout callback can
// be lost (user closes the tab, phone dies); webhooks cannot. Renewals every
// month arrive ONLY here — there is no browser involved in a renewal.
//
// Verification: HMAC-SHA256 of the RAW request body, signed with the webhook
// secret you set in the Razorpay dashboard, compared against the
// `x-razorpay-signature` header. The webhook secret is a DIFFERENT value from
// your API key secret.
//
// Body parsing is disabled below because the signature covers the exact bytes
// Razorpay sent — re-serialising a parsed object changes them and every check
// would fail.

const crypto = require('crypto');

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('webhook_secret_missing');
    return res.status(503).json({ error: 'webhook_not_configured' });
  }

  let raw;
  try {
    raw = await readRawBody(req);
  } catch (err) {
    console.error('raw_body_read_failed', err);
    return res.status(400).json({ error: 'bad_body' });
  }

  const signature = req.headers['x-razorpay-signature'];
  if (!signature) return res.status(400).json({ error: 'missing_signature' });

  const expected = crypto.createHmac('sha256', webhookSecret).update(raw).digest('hex');
  if (!safeEqual(expected, signature)) {
    console.warn('webhook_signature_mismatch');
    return res.status(400).json({ error: 'invalid_signature' });
  }

  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'bad_json' });
  }

  const type = event.event || 'unknown';
  const sub  = event.payload && event.payload.subscription && event.payload.subscription.entity;
  const pay  = event.payload && event.payload.payment && event.payload.payment.entity;

  // Everything below is logging only. Wire these branches to your database
  // when you add one — the comments say exactly what each event should do.
  switch (type) {
    case 'subscription.activated':
      // Mandate approved and first charge succeeded -> switch the account on
      // and credit the first month's allowance.
      console.log('subscription.activated', sub && sub.id, sub && sub.notes);
      break;

    case 'subscription.charged':
      // A renewal succeeded. Fires every billing cycle. Reset the monthly
      // allowance pool here — this is the event that matters most.
      console.log('subscription.charged', sub && sub.id, pay && pay.amount);
      break;

    case 'subscription.pending':
      // A debit failed; Razorpay will retry. Warn the customer, keep access.
      console.log('subscription.pending', sub && sub.id);
      break;

    case 'subscription.halted':
      // Retries exhausted. Suspend generation until they pay.
      console.log('subscription.halted', sub && sub.id);
      break;

    case 'subscription.cancelled':
    case 'subscription.completed':
      // Access ends at current_end.
      console.log(type, sub && sub.id);
      break;

    case 'subscription.paused':
    case 'subscription.resumed':
    case 'subscription.updated':
      console.log(type, sub && sub.id);
      break;

    default:
      // Unknown or not-subscribed event types are fine — acknowledge anyway so
      // Razorpay does not retry them forever.
      console.log('webhook_event_ignored', type);
  }

  // Always 2xx once the signature is verified, otherwise Razorpay retries.
  return res.status(200).json({ received: true });
};

// Give us the raw bytes; the signature is computed over them.
module.exports.config = {
  api: { bodyParser: false }
};
