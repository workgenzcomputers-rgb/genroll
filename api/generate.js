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

// One flagship per provider. Each of these was confirmed against this
// deployment's key: an empty POST came back 400 or 422 naming the fields it
// wanted, while two invented paths in the same run came back 404. The older
// variants that used to sit here (Soul, Kling 2.5, Hailuo 2.3, DoP) came out
// when their successors went in.
const COST = {
  '/bytedance/seedance-2.5/text-to-video': VIDEO,
  '/kling-video/v3.0/std/text-to-video': VIDEO,
  '/minimax/h3/text-to-video': VIDEO,
  '/alibaba/wan-3.0-prime/text-to-video': VIDEO,
  '/higgsfield/cinema-studio/4.0': VIDEO,
  '/higgsfield/genjutsu/motion-transfer/v1.0': VIDEO,
  '/recraft/v4.1/text-to-image': IMAGE,
  '/alibaba/qwen-image-3/text-to-image': IMAGE,
  '/xai/grok-imagine-image-2.0': IMAGE
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
  let cost = COST[path] || 0;
  let owner = false;
  if (L.authReady) {
    userId = L.currentUserId(req);
    if (!userId) {
      return res.status(401).json({
        error: 'sign_in_required',
        message: 'Sign in to generate. Each generation uses credits from your balance.'
      });
    }

    // Owner accounts run straight against the provider key with no credits
    // taken. The check is on the email attached to the session this server
    // issued, never on anything in the request, so it cannot be claimed.
    try {
      const who = await L.getUser(userId);
      if (who && L.isOwner(who.email)) { owner = true; cost = 0; }
    } catch (err) {
      // If the lookup fails, fall through as an ordinary account and charge.
      console.error('owner_lookup_failed', err.message);
    }
  }

  const input = (body.input && typeof body.input === 'object') ? body.input : {};
  const prompt = String(input.prompt || '').trim();
  // Motion transfer works from the source clip and stills, so it is the one
  // model that can run without a written prompt.
  const motionTransfer = path === '/higgsfield/genjutsu/motion-transfer/v1.0';
  if (!prompt && !motionTransfer) return res.status(400).json({ error: 'missing_prompt' });
  if (prompt.length > 5000) return res.status(400).json({ error: 'prompt_too_long' });

  // Motion transfer takes the source material as links the provider fetches
  // itself. Those links come from whoever is using the site, so check them
  // here rather than forwarding whatever was typed: https only, a real host,
  // and nothing pointing back inside a private network.
  const badUrl = (value) => {
    let u;
    try { u = new URL(String(value)); } catch { return 'that is not a URL'; }
    if (u.protocol !== 'https:') return 'links must start with https://';
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h === '[::1]') return 'that address is not reachable from the internet';
    if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.)/.test(h)) return 'that address is not reachable from the internet';
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return 'that address is not reachable from the internet';
    if (String(value).length > 2000) return 'that link is too long';
    return null;
  };

  const links = [];
  if (input.video_url) links.push(input.video_url);
  if (Array.isArray(input.image_urls)) links.push(...input.image_urls);
  for (const link of links) {
    const why = badUrl(link);
    if (why) return res.status(400).json({ error: 'bad_source_url', message: 'Check the source links: ' + why + '.' });
  }
  if (links.length > 6) return res.status(400).json({ error: 'too_many_sources' });

  if (motionTransfer && (!input.video_url || !Array.isArray(input.image_urls) || !input.image_urls.length)) {
    return res.status(400).json({
      error: 'missing_sources',
      message: 'Genjutsu needs a link to the motion video and at least one image link.'
    });
  }

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

    // Remember whose job this is. It used to be written only when credits had
    // been taken, which quietly broke the owner path: an owner pays nothing, so
    // no record was kept, so /api/job had no account to file the finished video
    // under and it disappeared on the next reload. This record is what anchors
    // the Generations list, not only the refund, so it is written for every
    // signed-in job. A zero cost refunds nothing — refundIfDead skips it.
    if (userId) {
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
