// POST /api/generate
//   { path: "<higgsfield endpoint path>", input: { prompt, ... } }
// -> { requestId, status, statusUrl }
//
// Starts a Higgsfield generation job. The API key NEVER reaches the browser —
// it lives only in this function's environment.
//
// Higgsfield facts this is built on (verified Sep 2026):
//   auth header : Authorization: Key <KEY_ID>:<KEY_SECRET>
//   model        : asynchronous. The POST returns status "queued" plus a
//                  request_id / status_url; you then poll for the result.
//   statuses     : queued | in_progress | nsfw | failed | completed
//
// NOTE ON BASE URL: Higgsfield's own docs show https://api.higgsfield.ai while
// their Node SDK defaults to https://platform.higgsfield.ai. We could not
// reconcile the two, so it is an env var. Set HIGGSFIELD_BASE_URL to whichever
// your account's quick-start page shows; the default below follows the docs.

const L = require('./_lib');

const BASE = (process.env.HIGGSFIELD_BASE_URL || 'https://api.higgsfield.ai').replace(/\/+$/, '');

// What each endpoint costs the customer, in credits (1 credit = Rs.1). These
// are deliberately flat and conservative: a wrong guess here is money, so the
// number is charged up front and refunded in full if the job does not produce
// anything. Override per deployment without touching code.
const IMAGE = Number(process.env.COST_IMAGE || 5);
const VIDEO = Number(process.env.COST_VIDEO || 40);

const COST = {
  '/higgsfield-ai/soul/v2/standard': IMAGE,
  '/higgsfield-ai/soul/standard': IMAGE,
  '/bytedance/seedance-2.5/text-to-video': VIDEO,
  '/kling-video/v2.5-turbo/pro/text-to-video': VIDEO,
  '/kling-video/v2.5-turbo/pro/image-to-video': VIDEO,
  '/kling-video/v2.5-turbo/standard/image-to-video': VIDEO,
  '/minimax/hailuo-2.3/standard/text-to-video': VIDEO,
  '/minimax/hailuo-2.3/standard/image-to-video': VIDEO,
  '/v1/image2video/dop': VIDEO
};

// Only these endpoint paths may be called, so a visitor cannot point this
// function at an arbitrary URL. Add the ones your account actually has.
// Paths come from Higgsfield's own OpenAPI document, plus the two confirmed by
// probing this key directly. FLUX Kontext Max was removed: it answers 404
// model_not_found, so this account cannot call it.
const ALLOWED_PATHS = new Set(Object.keys(COST));

function credentials() {
  // The console now issues ONE key string, so take it verbatim; older
  // accounts that had a separate id and secret still work via the two vars.
  const combined = process.env.HIGGSFIELD_CREDENTIALS;
  if (combined) return combined;
  const id = process.env.HIGGSFIELD_KEY_ID;
  const secret = process.env.HIGGSFIELD_KEY_SECRET;
  if (id && secret) return `${id}:${secret}`;
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const creds = credentials();
  if (!creds) {
    return res.status(503).json({
      error: 'generation_not_configured',
      message: 'Higgsfield credentials are not set on this deployment yet.'
    });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const path = String(body.path || '');
  if (!ALLOWED_PATHS.has(path)) {
    return res.status(400).json({
      error: 'path_not_allowed',
      message: 'That endpoint is not in this deployment\'s allow-list.',
      allowed: [...ALLOWED_PATHS]
    });
  }

  // Once the ledger exists, generating costs money, so it needs a signed-in
  // account to bill. Before that it stays open, exactly as it was.
  let userId = null;
  const cost = COST[path] || 0;
  if (L.authReady) {
    userId = L.currentUserId(req);
    if (!userId) {
      return res.status(401).json({
        error: 'sign_in_required',
        message: 'Sign in to generate. Each generation uses credits from your balance.'
      });
    }
  }

  const input = (body.input && typeof body.input === 'object') ? body.input : {};
  const prompt = String(input.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'missing_prompt' });
  if (prompt.length > 5000) return res.status(400).json({ error: 'prompt_too_long' });

  // Take the credits before calling the provider, so two tabs cannot both
  // spend the last credit. Anything that goes wrong below puts them back.
  if (userId && cost > 0) {
    let spend;
    try {
      spend = await L.spendCredits(userId, cost);
    } catch (err) {
      console.error('spend_failed', err.message);
      return res.status(503).json({ error: 'store_error', message: 'Could not read your balance. Nothing was charged.' });
    }
    if (!spend.ok) {
      return res.status(402).json({
        error: 'insufficient_credits',
        message: `This costs ${cost} credits and you have ${spend.balance}.`,
        need: cost,
        balance: spend.balance
      });
    }
  }

  const refund = async (why) => {
    if (!userId || cost <= 0) return;
    try { await L.refundCredits(userId, cost); }
    catch (err) { console.error('refund_failed', why, userId, cost, err.message); }
  };

  try {
    const r = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Key ${creds}` },
      body: JSON.stringify({ ...input, prompt })
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      console.error('higgsfield_generate_failed', r.status, data);
      await refund('provider_rejected');
      return res.status(502).json({
        error: 'higgsfield_error',
        status: r.status,
        message: data.message || data.detail || 'Higgsfield rejected the request.'
      });
    }

    const requestId = data.request_id || data.id || null;
    if (!requestId) {
      await refund('no_request_id');
      return res.status(502).json({ error: 'no_request_id', message: 'The provider did not return a job id. Nothing was charged.' });
    }

    // Remember who paid for this job, so a later failure can be refunded.
    if (userId && cost > 0) {
      try { await L.setJSON(`job:${requestId}`, { userId, cost }, 7 * 86400); }
      catch (err) { console.error('job_record_failed', requestId, err.message); }
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      requestId,
      status: data.status || 'queued',
      // Returned for reference only — polling goes through /api/job so the key
      // stays server-side.
      statusUrl: data.status_url || null
    });
  } catch (err) {
    console.error('generate_exception', err);
    await refund('exception');
    return res.status(500).json({ error: 'server_error', message: 'Nothing was charged.' });
  }
};
