// GET /api/media  ->  { items: [{ id, url, at }] }
//
// The Generations tab used to live entirely in the page, so a refresh emptied
// it. /api/job records every finished job against the account that paid for
// it; this hands that list back, newest first.
//
// It answers 200 with an empty list rather than an error when nobody is signed
// in or the store is unreachable, because an empty tab is a fine outcome and a
// broken page is not.

const L = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');

  if (!L.authReady) return res.status(200).json({ items: [] });
  const userId = L.currentUserId(req);
  if (!userId) return res.status(200).json({ items: [] });

  try {
    const raw = await L.cmd('LRANGE', `gen:${userId}`, '0', '49');
    const items = (Array.isArray(raw) ? raw : [])
      .map(function (s) { try { return JSON.parse(s); } catch (e) { return null; } })
      .filter(function (x) { return x && typeof x.url === 'string'; });
    return res.status(200).json({ items });
  } catch (err) {
    console.error('media_list_failed', err.message);
    return res.status(200).json({ items: [] });
  }
};
