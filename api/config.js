// GET /api/config
// Public, safe-to-expose configuration for the browser.
// NEVER returns RAZORPAY_KEY_SECRET or the webhook secret.
//
// While the env vars are unset this returns { enabled: false } and the site
// stays in preview mode — nothing breaks before the Razorpay account is ready.
//
// Pricing model: one-time credit top-ups via Razorpay ORDERS. 1 credit = Rs.1.
// No plan ids, no recurring-billing activation needed.

module.exports = (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const keyId  = process.env.RAZORPAY_KEY_ID || '';
  const secret = process.env.RAZORPAY_KEY_SECRET || '';

  const enabled = Boolean(keyId && secret);

  // Credits are only worth selling if we can remember them. Vercel injects
  // these two the moment a KV store is linked to the project, so this flag
  // flips on by itself — and until it does, the Credits page keeps its
  // top-up button shut rather than taking money for nothing.
  const ledgerReady = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

  // Tell the UI exactly what is missing, so the Credits page can say something
  // useful instead of failing silently.
  const missing = [];
  if (!keyId)  missing.push('RAZORPAY_KEY_ID');
  if (!secret) missing.push('RAZORPAY_KEY_SECRET');
  if (!ledgerReady) missing.push('a credit store (link Vercel KV)');

  // Generation is a separate switch from payments — either can go live first.
  const genReady = Boolean(
        process.env.HIGGSFIELD_CREDENTIALS ||
    (process.env.HIGGSFIELD_KEY_ID && process.env.HIGGSFIELD_KEY_SECRET)
  );

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    enabled,
    generation: { enabled: genReady },
    ledger: { enabled: ledgerReady },
    keyId: enabled ? keyId : null,   // publishable key only, and only once live
    topup: {
      currency: 'INR',
      creditsPerRupee: 1,
      min: Number(process.env.RZP_MIN_TOPUP_INR || 10),
      max: Number(process.env.RZP_MAX_TOPUP_INR || 50000)
    },
    // Credits are bought, not billed monthly. Kept so older builds of the page
    // that still read `plans` degrade quietly instead of throwing.
    plans: {},
    mode: keyId.startsWith('rzp_live_') ? 'live'
        : keyId.startsWith('rzp_test_') ? 'test'
        : 'unconfigured',
    missing
  });
};
