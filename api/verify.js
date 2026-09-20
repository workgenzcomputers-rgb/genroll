// POST /api/verify
//   { razorpay_payment_id, razorpay_subscription_id, razorpay_signature }
// -> { valid: true, subscription: {...} }
//
// Confirms the Checkout callback really came from Razorpay.
//
// For SUBSCRIPTIONS the signature is HMAC-SHA256 over
//     razorpay_payment_id + "|" + subscription_id
// signed with your key_secret.
// (Note the order: this is the reverse of the one-time Orders flow, which is
//  order_id + "|" + payment_id. Getting them the wrong way round is the single
//  most common integration bug.)

const crypto = require('crypto');

// Constant-time compare so we do not leak signature bytes via timing.
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

  const keyId  = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !secret) {
    return res.status(503).json({ error: 'payments_not_configured' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const paymentId    = body.razorpay_payment_id;
  const subscription = body.razorpay_subscription_id;
  const signature    = body.razorpay_signature;

  if (!paymentId || !subscription || !signature) {
    return res.status(400).json({
      error: 'missing_fields',
      message: 'razorpay_payment_id, razorpay_subscription_id and razorpay_signature are all required.'
    });
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${paymentId}|${subscription}`)
    .digest('hex');

  if (!safeEqual(expected, signature)) {
    console.warn('signature_mismatch', { subscription, paymentId });
    return res.status(400).json({ valid: false, error: 'invalid_signature' });
  }

  // Signature is good. Re-read the subscription from Razorpay so we trust the
  // server's view of its state, not anything the browser told us.
  try {
    const auth = 'Basic ' + Buffer.from(`${keyId}:${secret}`).toString('base64');
    const r = await fetch(`https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(subscription)}`, {
      headers: { Authorization: auth }
    });
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      console.error('subscription_fetch_failed', r.status, data);
      // The signature was valid, so report success but flag the lookup.
      return res.status(200).json({ valid: true, subscription: null, lookupFailed: true });
    }

    // ---------------------------------------------------------------------
    // TODO (needs a database — see the go-live notes):
    // Persist { subscription.id, subscription.status, notes.tier, notes.customer_email }
    // and grant the plan's monthly allowance. Until then this endpoint only
    // proves the payment is authentic; it does not remember anything.
    // ---------------------------------------------------------------------

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      valid: true,
      subscription: {
        id: data.id,
        status: data.status,
        planId: data.plan_id,
        currentEnd: data.current_end || null,
        tier: (data.notes && data.notes.tier) || null
      }
    });
  } catch (err) {
    console.error('verify_exception', err);
    return res.status(200).json({ valid: true, subscription: null, lookupFailed: true });
  }
};
