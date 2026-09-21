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

const BASE = (process.env.HIGGSFIELD_BASE_URL || 'https://api.higgsfield.ai').replace(/\/+$/, '');

// Only these endpoint paths may be called, so a visitor cannot point this
// function at an arbitrary URL. Add the ones your account actually has.
const ALLOWED_PATHS = new Set([
  '/higgsfield-ai/soul/v2/standard',
  '/flux-pro/kontext/max/text-to-image',
  '/v1/image2video/dop',
  '/bytedance/seedance-2.5/text-to-video'
]);

function credentials() {
  // Accept either a single "id:secret" pair or two separate vars.
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

  const input = (body.input && typeof body.input === 'object') ? body.input : {};
  const prompt = String(input.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'missing_prompt' });
  if (prompt.length > 5000) return res.status(400).json({ error: 'prompt_too_long' });

  try {
    const r = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Key ${creds}` },
      body: JSON.stringify({ ...input, prompt })
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      console.error('higgsfield_generate_failed', r.status, data);
      return res.status(502).json({
        error: 'higgsfield_error',
        status: r.status,
        message: data.message || data.detail || 'Higgsfield rejected the request.'
      });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      requestId: data.request_id || data.id || null,
      status: data.status || 'queued',
      // Returned for reference only — polling goes through /api/job so the key
      // stays server-side.
      statusUrl: data.status_url || null
    });
  } catch (err) {
    console.error('generate_exception', err);
    return res.status(500).json({ error: 'server_error' });
  }
};
