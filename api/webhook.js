// POST /api/webhook  — Razorpay server-to-server events.
//
// This is what actually keeps the credit ledger correct. The Checkout callback
// can be lost (user closes the tab, phone dies, network drops) — the webhook
// cannot. Treat the webhook as the source of truth and /api/verify as the fast
// path that makes the UI feel instant.
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
const L = require('./_lib');

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

  const type  = event.event || 'unknown';
  const pay   = event.payload && event.payload.payment && event.payload.payment.entity;
  const order = event.payload && event.payload.order && event.payload.order.entity;

  // 1 credit = Rs.1. Always derive this from Razorpay's amount, never from
  // anything the browser sent.
  const credits = pay ? Math.floor(Number(pay.amount || 0) / 100) : 0;

  // Everything below is logging only. Wire these branches to your database
  // when you add one — the comments say exactly what each event should do.
  switch (type) {
    case 'payment.captured': {
      // Money is settled. This is the reliable credit: the browser may be long
      // gone. addCredits is keyed on the payment id, so a retried webhook — or
      // /api/verify having already run — cannot double-count.
      const userId = pay && pay.notes && pay.notes.user_id;
      console.log('payment.captured', pay && pay.id, pay && pay.order_id, credits, userId || '(no user)');
      if (L.authReady && userId && credits > 0) {
        try {
          const out = await L.addCredits(userId, credits, pay.id);
          console.log(out.added ? 'credited' : 'already_credited', userId, credits, '->', out.balance);
        } catch (err) {
          // Do not 5xx: Razorpay would retry forever. Log loudly instead so
          // the payment can be settled by hand.
          console.error('CREDIT_FAILED_NEEDS_MANUAL_FIX', pay.id, userId, credits, err.message);
        }
      } else if (credits > 0 && !userId) {
        console.error('CREDIT_ORPHANED_NO_USER_ID', pay && pay.id, credits);
      }
      break;
    }

    case 'payment.authorized':
      // Authorised but not yet captured. With auto-capture on (the default for
      // Checkout) this is followed by payment.captured — do not credit here.
      console.log('payment.authorized', pay && pay.id, pay && pay.order_id);
      break;

    case 'payment.failed':
      // Nothing was charged. Log it so failures are visible; credit nothing.
      console.log('payment.failed', pay && pay.id, pay && pay.error_description);
      break;

    case 'order.paid':
      // The order is fully paid. Redundant with payment.captured — kept for
      // reconciliation only. Do not credit here as well, or you double-count.
      console.log('order.paid', order && order.id, order && order.amount_paid);
      break;

    case 'refund.created':
    case 'refund.processed':
      // Deduct the refunded credits from the balance.
      console.log(type, event.payload && event.payload.refund && event.payload.refund.entity);
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
