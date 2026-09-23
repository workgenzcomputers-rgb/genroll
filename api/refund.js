// POST /api/refund   { credits: 120 }
// -> { ok: true, credits, balance, requestId }
//
// Lets a signed-in customer send unused credits back and get the money
// returned to the card or UPI id they paid from.
//
// WHY THIS RECORDS A REQUEST INSTEAD OF PAYING OUT ON THE SPOT
//
// Paying out automatically from a button would be the easy version, and it is
// the version that loses money. Razorpay's fee on the original payment is not
// returned when you refund, so a buy-then-immediately-sell-back loop costs the
// business roughly 2% of the amount every time, and nothing here would stop
// someone running that loop. There is also no way, at this size, to tell a real
// change of mind from card testing.
//
// So this endpoint does the half that must be instant and safe:
//   - it takes the credits out of the balance straight away, atomically, so the
//     same credits cannot be spent AND refunded, and
//   - it writes a request the owner settles in the Razorpay dashboard.
//
// Nothing is promised to the customer that the system cannot keep.

const crypto = require('crypto');
const L = require('./_lib');

const MIN = Number(process.env.REFUND_MIN_CREDITS || 10);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!L.authReady) {
    return res.status(503).json({ error: 'not_configured', message: 'Accounts are not switched on yet.' });
  }

  const userId = L.currentUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'sign_in_required', message: 'Sign in to send credits back.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const credits = Math.floor(Number(body.credits));
  if (!Number.isFinite(credits) || credits < MIN) {
    return res.status(400).json({
      error: 'bad_amount',
      message: `Send back a whole number of credits, ${MIN} or more.`
    });
  }

  try {
    const user = await L.getUser(userId);
    if (!user) return res.status(401).json({ error: 'sign_in_required' });

    // One open request at a time. Two requests racing would each pass their own
    // balance check and the customer would end up owed more than they hold.
    const openKey = `refund:open:${userId}`;
    const claimed = await L.cmd('SET', openKey, '1', 'NX', 'EX', String(30 * 86400));
    if (claimed === null) {
      return res.status(409).json({
        error: 'already_requested',
        message: 'You already have a request being processed. It will be settled before you can send more back.'
      });
    }

    // Take the credits first. If anything below fails, they go back.
    const spend = await L.spendCredits(userId, credits);
    if (!spend.ok) {
      await L.cmd('DEL', openKey);
      return res.status(400).json({
        error: 'insufficient_credits',
        message: `You have ${spend.balance} credits.`,
        balance: spend.balance
      });
    }

    const requestId = 'rf_' + crypto.randomBytes(9).toString('hex');
    try {
      await L.setJSON(`refund:${requestId}`, {
        id: requestId,
        userId,
        email: user.email,
        credits,
        amountInr: credits,          // 1 credit = Rs.1
        status: 'requested',
        createdAt: Date.now()
      }, 365 * 86400);
      // A list the owner can read to see what is waiting.
      await L.cmd('LPUSH', 'refunds:pending', requestId);
    } catch (err) {
      // The ledger is the thing that must not be wrong: put the credits back.
      console.error('refund_record_failed', userId, credits, err.message);
      await L.refundCredits(userId, credits);
      await L.cmd('DEL', openKey);
      return res.status(503).json({ error: 'store_error', message: 'Could not record that. Your credits are untouched.' });
    }

    console.log('REFUND_REQUESTED', requestId, user.email, credits);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      requestId,
      credits,
      balance: spend.balance,
      message: 'Request received. The money goes back to the method you paid from.'
    });
  } catch (err) {
    console.error('refund_exception', err);
    return res.status(500).json({ error: 'server_error' });
  }
};
