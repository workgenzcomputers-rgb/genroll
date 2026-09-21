// POST /api/create-order   { amountInr: 100 }
// -> { orderId, amount, currency, credits, keyId }
//
// Creates a Razorpay Order for a one-time credit top-up.
// 1 credit = ₹1, matching what the Credits page tells the customer.
//
// Verified against Razorpay's docs (Sep 2026):
//   endpoint : POST https://api.razorpay.com/v1/orders
//   auth     : HTTP Basic (key_id : key_secret)
//   amount   : integer, in the smallest currency unit — PAISE for INR
//   receipt  : max 40 characters
//
// This is the Orders flow, not Subscriptions. It needs no plan ids and no
// separate recurring-billing activation on the Razorpay account.

// Bounds must match the Credits page (min 10, max 50000). They are enforced
// HERE as well, because anything the browser sends can be forged.
const L = require('./_lib');

const MIN_INR = Number(process.env.RZP_MIN_TOPUP_INR || 10);
const MAX_INR = Number(process.env.RZP_MAX_TOPUP_INR || 50000);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const keyId  = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !secret) {
    return res.status(503).json({
      error: 'payments_not_configured',
      message: 'Razorpay keys are not set on this deployment yet.'
    });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  // Whole rupees only — no fractional top-ups, so credits stay clean integers.
  const amountInr = Math.floor(Number(body.amountInr));
  if (!Number.isFinite(amountInr) || amountInr < MIN_INR || amountInr > MAX_INR) {
    return res.status(400).json({
      error: 'bad_amount',
      message: `amountInr must be a whole number between ${MIN_INR} and ${MAX_INR}.`
    });
  }

  // Stamp the buyer onto the order. This is what lets the webhook credit the
  // right balance later, when there is no browser and no cookie in sight.
  let userId = null;
  if (L.authReady) {
    userId = L.currentUserId(req);
    if (!userId) {
      return res.status(401).json({
        error: 'sign_in_required',
        message: 'Sign in before adding credits, so they land in your account.'
      });
    }
  }

  const payload = {
    amount: amountInr * 100,          // paise
    currency: 'INR',
    receipt: `topup_${Date.now()}`.slice(0, 40),
    notes: {
      credits: String(amountInr),     // 1 credit = ₹1
      source: 'genroll.in',
      // The webhook has no cookie to read, so the buyer is stamped here.
      user_id: userId || '',
      customer_email: String(body.email || '').slice(0, 120)
    }
  };

  try {
    const auth = 'Basic ' + Buffer.from(`${keyId}:${secret}`).toString('base64');
    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify(payload)
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      console.error('razorpay_create_order_failed', r.status, data);
      return res.status(502).json({
        error: 'razorpay_error',
        status: r.status,
        message: (data && data.error && data.error.description) || 'Razorpay rejected the request.'
      });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      orderId: data.id,
      amount: data.amount,            // paise, echo back what Razorpay recorded
      currency: data.currency,
      credits: amountInr,
      keyId                            // publishable key, needed by Checkout
    });
  } catch (err) {
    console.error('create_order_exception', err);
    return res.status(500).json({ error: 'server_error' });
  }
};
