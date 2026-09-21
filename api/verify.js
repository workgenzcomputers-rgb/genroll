// POST /api/verify
//   { razorpay_order_id, razorpay_payment_id, razorpay_signature }
// -> { valid: true, payment: {...} }
//
// Confirms the Checkout callback really came from Razorpay.
//
// For ORDERS the signature is HMAC-SHA256 over
//     razorpay_order_id + "|" + razorpay_payment_id
// signed with your key_secret.
// (Subscriptions use the reverse order — payment_id + "|" + subscription_id.
//  Getting them the wrong way round is the single most common integration bug.)

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

  const orderId   = body.razorpay_order_id;
  const paymentId = body.razorpay_payment_id;
  const signature = body.razorpay_signature;

  if (!orderId || !paymentId || !signature) {
    return res.status(400).json({
      error: 'missing_fields',
      message: 'razorpay_order_id, razorpay_payment_id and razorpay_signature are all required.'
    });
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  if (!safeEqual(expected, signature)) {
    console.warn('signature_mismatch', { orderId, paymentId });
    return res.status(400).json({ valid: false, error: 'invalid_signature' });
  }

  // Signature is good. Re-read the payment from Razorpay so the amount we
  // credit comes from Razorpay's own record, never from the browser.
  try {
    const auth = 'Basic ' + Buffer.from(`${keyId}:${secret}`).toString('base64');
    const r = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: auth }
    });
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      console.error('payment_fetch_failed', r.status, data);
      // The signature was valid, so report success but flag the lookup.
      return res.status(200).json({ valid: true, payment: null, lookupFailed: true });
    }

    // Guard against a signature replayed against a different order.
    if (data.order_id && data.order_id !== orderId) {
      console.warn('order_mismatch', { orderId, actual: data.order_id });
      return res.status(400).json({ valid: false, error: 'order_mismatch' });
    }

    const credits = Math.floor(Number(data.amount || 0) / 100); // 1 credit = Rs.1

    // ---------------------------------------------------------------------
    // TODO (needs a database — see the go-live notes):
    // Persist { payment.id, order_id, amount, notes.customer_email } and add
    // `credits` to that customer's balance, keyed on payment.id so a repeated
    // call cannot credit twice. Until then this endpoint only proves the
    // payment is authentic; it does not remember anything.
    // ---------------------------------------------------------------------

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      valid: true,
      payment: {
        id: data.id,
        orderId: data.order_id,
        status: data.status,        // 'captured' once the money is settled
        amount: data.amount,        // paise
        credits,
        method: data.method || null,
        email: (data.notes && data.notes.customer_email) || data.email || null
      }
    });
  } catch (err) {
    console.error('verify_exception', err);
    return res.status(200).json({ valid: true, payment: null, lookupFailed: true });
  }
};
