// Reference material for motion transfer — the clip whose movement is copied
// and the stills it is applied to — has to sit somewhere the provider can
// fetch from. It cannot travel through this function: a serverless request
// body stops at 4.5 MB and a video is bigger than that. So the browser asks
// here for a short-lived token, uploads straight to the store, and this file
// never touches the bytes.

const { handleUpload } = require('@vercel/blob/client');
const { list, del } = require('@vercel/blob');
const L = require('./_lib');

const PREFIX = 'ref/';
const KEEP_DAYS = 7;
const MAX_BYTES = 200 * 1024 * 1024;

// Only what the motion-transfer endpoint can actually read. Anything else
// would upload fine and then fail at the provider, after the wait.
const TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'image/jpeg',
  'image/png',
  'image/webp'
];

// The store holds 1 GB on this plan, so old references are cleared out rather
// than left to fill it. Listing costs an operation against a small monthly
// budget, so the sweep runs at most once every six hours, and only while
// somebody is uploading anyway — there is nothing to clean up otherwise.
async function sweep() {
  if (!L.storeReady) return;

  try {
    const first = await L.cmd('SET', 'blobsweep', String(Date.now()), 'NX', 'EX', String(6 * 3600));
    if (!first) return;
  } catch (err) {
    return;
  }

  const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
  try {
    let cursor;
    const stale = [];
    do {
      const page = await list({ prefix: PREFIX, cursor, limit: 1000 });
      for (const blob of page.blobs) {
        if (new Date(blob.uploadedAt).getTime() < cutoff) stale.push(blob.url);
      }
      cursor = page.hasMore ? page.cursor : null;
    } while (cursor);

    if (stale.length) {
      await del(stale);
      console.log('blob_sweep_removed', stale.length);
    }
  } catch (err) {
    // A failed sweep is not worth failing an upload over; it runs again later.
    console.error('blob_sweep_failed', err.message);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(503).json({
      error: 'storage_not_configured',
      message: 'File storage is not connected on this deployment yet.'
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch (err) { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        // Without this check the store is open to anyone who finds the URL,
        // and the 1 GB is somebody else's to fill.
        const userId = L.authReady ? L.currentUserId(req) : null;
        if (L.authReady && !userId) {
          throw new Error('Sign in before uploading a reference file.');
        }

        // Everything lands under one prefix, so the sweep above knows exactly
        // what it is allowed to delete.
        if (String(pathname || '').indexOf(PREFIX) !== 0) {
          throw new Error('Reference files go under ' + PREFIX + '.');
        }

        return {
          allowedContentTypes: TYPES,
          maximumSizeInBytes: MAX_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ userId: userId || null })
        };
      },
      onUploadCompleted: async ({ blob }) => {
        console.log('reference_uploaded', blob.pathname, blob.size);
      }
    });

    await sweep();
    return res.status(200).json(result);
  } catch (err) {
    // handleUpload throws for a refused token as well as for a malformed
    // body, and the message is written to be read by whoever pressed upload.
    console.error('upload_refused', err.message);
    return res.status(400).json({ error: 'upload_refused', message: err.message });
  }
};
