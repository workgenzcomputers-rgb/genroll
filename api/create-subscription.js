// POST /api/create-subscription   { tier: "starter" | "creator" | "studio", email?, name?, contact? }
// -> { subscriptionId, keyId, shortUrl }
//
// Calls Razorpay's REST API directly with fetch — no npm dependency, so this
// repo needs no package.json and no build step.
//
// Docs: POST https://api.razorpay.com/v1/subscriptions
//       auth = HTTP Basic (key_id : key_secret)

const PLAN_ENV = {
  starter: 'RZP_PLAN_STARTER',
  creator: 'RZP_PLAN_CREATOR',
  studio:  'RZP_PLAN_STUDIO'
};

// How many billing cycles the mandate covers. Razorpay requires total_count on
// every subscription. 60 monthly cycles = 5 years; the customer can cancel any
// time, and you can raise this once you have confirmed the cap Razorpay applies
// to your account for monthly plans.
const TOTAL_COUNT = Number(process.env.RZP_TOTAL_COUNT || 60);

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

  // Vercel's Node runtime parses JSON bodies for us, but be tolerant.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const tier = String(body.tier || '').toLowerCase();
  if (!PLAN_ENV[tier]) {
    return res.status(400).json({
      error: 'unknown_tier',
      message: 'tier must be one of: starter, creator, studio'
    });
  }

  const planId = process.env[PLAN_ENV[tier]];
  if (!planId) {
    return res.status(503).json({
      error: 'plan_not_configured',
      message: `${PLAN_ENV[tier]} is not set on this deployment.`
    });
  }

  const payload = {
    plan_id: planId,
    total_count: TOTAL_COUNT,
    quantity: 1,
    // 1 = Razorpay emails/SMSes the customer about the mandate and every
    // upcoming debit. India's rules require a pre-debit notification at least
    // 24 hours before each charge — leave this on.
    customer_notify: 1,
    notes: {
      tier,
      source: 'genroll.in',
      customer_email: String(body.email || '').slice(0, 120),
      customer_name: String(body.name || '').slice(0, 120)
    }
  };

  try {
    const auth = 'Basic ' + Buffer.from(`${keyId}:${secret}`).toString('base64');
    const r = await fetch('https://api.razorpay.com/v1/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify(payload)
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      // Surface Razorpay's own message — it is usually precise (e.g. plan not
      // found, subscriptions not enabled on the account).
      console.error('razorpay_create_subscription_failed', r.status, data);
      return res.status(502).json({
        error: 'razorpay_error',
        status: r.status,
        message: (data && data.error && data.error.description) || 'Razorpay rejected the request.'
      });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      subscriptionId: data.id,
      status: data.status,
      shortUrl: data.short_url || null,
      keyId // publishable key, needed by Checkout in the browser
    });
  } catch (err) {
    console.error('create_subscription_exception', err);
    return res.status(500).json({ error: 'server_error' });
  }
};
