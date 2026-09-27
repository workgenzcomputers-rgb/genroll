// GET /api/probe   TEMPORARY - remove once the catalog is settled.
//
// Answers one question: which model endpoints will this deployment's key
// actually accept? The site only lists models that have been confirmed, so
// this is how a model earns its place instead of being taken on trust.
//
// It sends GET to a POST-only endpoint on purpose. An endpoint that exists
// answers 405 Method Not Allowed; one that does not answers 404. Nothing is
// ever posted, so no job can start and no credits can be spent by probing.
//
// The candidate list is fixed in this file, so the endpoint cannot be aimed
// at an arbitrary host, and it needs a signed-in account so it is not a free
// probe for strangers.

const L = require('./_lib');

const BASE = (process.env.HIGGSFIELD_BASE_URL || 'https://api.higgsfield.ai').replace(/\/+$/, '');

const CANDIDATES = [
  '/bytedance/seedance-2.5/text-to-video',
  '/bytedance/seedance-2.0/text-to-video',
  '/kling-video/v3.0/std/text-to-video',
  '/kling-video/v2.5-turbo/pro/text-to-video',
  '/minimax/h3/text-to-video',
  '/minimax/hailuo-2.3/standard/text-to-video',
  '/alibaba/wan-3.0-prime/text-to-video',
  '/alibaba/wan-3.0/text-to-video',
  '/wan/v2.7/text-to-video',
  '/alibaba/happy-horse/v1.1/text-to-video',
  '/lightricks/ltx-2.5/text-to-video/fast',
  '/lightricks/ltx-2.5/text-to-video/pro',
  '/higgsfield/cinema-studio/4.0',
  '/xai/grok-imagine-video/v1.5/reference-to-video',
  '/higgsfield-ai/soul/v2/standard',
  '/ideogram/v4.0',
  '/recraft/v4.1/text-to-image',
  '/alibaba/qwen-image-3/text-to-image',
  '/xai/grok-imagine-image-2.0',
  '/z-image/turbo',
  '/marketing-studio/image',
  // Controls. These do not exist. If they answer 405 like everything else,
  // then 405 is just what this host says to any unmatched path, and a 405
  // above proves nothing. Worth knowing before trusting a single result.
  '/bytedance/seedance-9.9/text-to-video',
  '/definitely/not/a/real/model-xyz'
];

function credentials() {
  const combined = process.env.HIGGSFIELD_CREDENTIALS;
  if (combined) return combined;
  const id = process.env.HIGGSFIELD_KEY_ID;
  const secret = process.env.HIGGSFIELD_KEY_SECRET;
  if (id && secret) return id + ':' + secret;
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (L.authReady && !L.currentUserId(req)) {
    return res.status(401).json({ error: 'sign_in_required' });
  }
  const creds = credentials();
  if (!creds) return res.status(503).json({ error: 'generation_not_configured' });

  const results = [];
  for (const path of CANDIDATES) {
    try {
      // GET turned out to be useless here: this host answers 405 to any path,
      // real or invented, so every candidate "existed". POST an empty body
      // instead. A real endpoint rejects it with a validation error naming the
      // fields it wanted; a path that is not routed answers 404. Every model
      // in the list requires a prompt, so an empty body cannot start a job.
      const r = await fetch(BASE + path, {
        method: 'POST',
        headers: { Authorization: 'Key ' + creds, 'Content-Type': 'application/json' },
        body: '{}'
      });
      let detail = '';
      try { detail = (await r.text()).slice(0, 160); } catch (e) {}
      results.push({
        path: path,
        http: r.status,
        // 405 means the route is there and simply wants POST.
        verdict: (r.status === 422 || r.status === 400) ? 'exists'
               : r.status === 404 ? 'missing'
               : (r.status === 401 || r.status === 403) ? 'auth'
               : r.status === 200 || r.status === 201 ? 'started-a-job'
               : 'unclear',
        detail: detail
      });
    } catch (err) {
      results.push({ path: path, http: 0, verdict: 'error', detail: String(err.message).slice(0, 120) });
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ base: BASE, results: results });
};
