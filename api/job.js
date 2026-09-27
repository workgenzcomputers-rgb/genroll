// GET /api/job?id=<request_id>
// -> { status, url, raw }
//
// Polls a Higgsfield job. The browser polls THIS endpoint, never Higgsfield
// directly, so the API key is never exposed.
//
// Statuses: queued | in_progress | nsfw | failed | completed
// On completion the media URL lives at jobs[0].results.raw.url (SDK shape).
//
// Higgsfield keeps output files for at least seven days — copy anything you
// need to keep into your own storage before then.

const L = require('./_lib');

const BASE = (process.env.HIGGSFIELD_BASE_URL || 'https://api.higgsfield.ai').replace(/\/+$/, '');

// A job that ends as failed or nsfw produced nothing, so the credits taken at
// the start go back. The guard key makes this happen exactly once, however
// many times the browser polls.
async function refundIfDead(id, status) {
  if (!L.authReady) return;
  if (status !== 'failed' && status !== 'nsfw') return;
  try {
    const record = await L.getJSON(`job:${id}`);
    if (!record || !record.userId || !record.cost) return;
    const first = await L.cmd('SET', `refunded:${id}`, '1', 'NX', 'EX', String(30 * 86400));
    if (first === null) return;
    await L.refundCredits(record.userId, record.cost);
    console.log('refunded', id, record.userId, record.cost, status);
  } catch (err) {
    console.error('refund_check_failed', id, err.message);
  }
}

function credentials() {
  const combined = process.env.HIGGSFIELD_CREDENTIALS;
  if (combined) return combined;
  const id = process.env.HIGGSFIELD_KEY_ID;
  const secret = process.env.HIGGSFIELD_KEY_SECRET;
  if (id && secret) return `${id}:${secret}`;
  return null;
}

// Pull the first usable media URL out of whatever shape comes back.
//
// The old version only knew the SDK's jobs[].results.raw.url shape and missed
// the one Seedance actually returns, where the file arrives in a "video"
// field, so a finished job reported completed with no URL. Rather than chase
// each model's shape, walk the payload: try the fields that normally carry
// media first, then anything else, and prefer a link that looks like a file
// over one that merely looks like a URL.
function firstUrl(data) {
  const seen = new Set();
  const found = [];
  const PREFERRED = ['url', 'video', 'image', 'audio', 'file', 'output', 'result', 'raw', 'jobs', 'results'];

  const walk = (node, depth) => {
    if (node == null || depth > 8 || found.length > 40) return;
    if (typeof node === 'string') {
      if (/^https?:\/\//i.test(node)) found.push(node);
      return;
    }
    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { for (const v of node) walk(v, depth + 1); return; }
    for (const key of PREFERRED) if (key in node) walk(node[key], depth + 1);
    for (const key of Object.keys(node)) if (!PREFERRED.includes(key)) walk(node[key], depth + 1);
  };
  walk(data, 0);

  const isMedia = u => /\.(mp4|mov|webm|m4v|gif|png|jpe?g|webp|mp3|wav|m4a)(\?|$)/i.test(u);
  return found.find(isMedia) || found[0] || null;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const creds = credentials();
  if (!creds) return res.status(503).json({ error: 'generation_not_configured' });

  const id = String((req.query && req.query.id) || '').trim();
  // Request ids are opaque tokens; keep this strict so nothing else can be
  // injected into the URL.
  if (!id || !/^[A-Za-z0-9_-]{1,120}$/.test(id)) {
    return res.status(400).json({ error: 'bad_request_id' });
  }

  try {
    const r = await fetch(`${BASE}/requests/${encodeURIComponent(id)}/status`, {
      headers: { Authorization: `Key ${creds}` }
    });
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      console.error('higgsfield_status_failed', r.status, data);
      return res.status(502).json({
        error: 'higgsfield_error',
        status: r.status,
        message: data.message || data.detail || 'Could not read the job status.'
      });
    }

    const status = data.status || 'unknown';
    await refundIfDead(id, status);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      status,
      url: status === 'completed' ? firstUrl(data) : null,
      // 'nsfw' and 'failed' are terminal — the UI should stop polling on them.
      terminal: ['completed', 'failed', 'nsfw'].includes(status)
    });
  } catch (err) {
    console.error('job_exception', err);
    return res.status(500).json({ error: 'server_error' });
  }
};
