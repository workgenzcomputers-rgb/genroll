// GET /api/config
// Public, safe-to-expose configuration for the browser.
// NEVER returns RAZORPAY_KEY_SECRET or the webhook secret.
//
// While the env vars are unset this returns { enabled: false } and the site
// stays in preview mode — nothing breaks before the Razorpay account is ready.

const PLAN_ENV = {
  spark:  'RZP_PLAN_SPARK',
  studio: 'RZP_PLAN_STUDIO',
  scale:  'RZP_PLAN_SCALE'
};

module.exports = (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const keyId  = process.env.RAZORPAY_KEY_ID || '';
  const secret = process.env.RAZORPAY_KEY_SECRET || '';

  const plans = {};
  let anyPlan = false;
  for (const [tier, envName] of Object.entries(PLAN_ENV)) {
    const id = process.env[envName] || null;
    plans[tier] = id;
    if (id) anyPlan = true;
  }

  const enabled = Boolean(keyId && secret && anyPlan);

  // Tell the UI exactly what is missing, so the Plans page can say something
  // useful instead of failing silently.
  const missing = [];
  if (!keyId)  missing.push('RAZORPAY_KEY_ID');
  if (!secret) missing.push('RAZORPAY_KEY_SECRET');
  if (!anyPlan) missing.push('at least one RZP_PLAN_* id');

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    enabled,
    keyId: enabled ? keyId : null,   // publishable key only, and only once live
    plans,
    mode: keyId.startsWith('rzp_live_') ? 'live'
        : keyId.startsWith('rzp_test_') ? 'test'
        : 'unconfigured',
    missing
  });
};
