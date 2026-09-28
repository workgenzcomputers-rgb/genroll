// Shared helpers: key-value store, sessions, users, credits.
//
// Files whose name starts with "_" are not routed as endpoints by Vercel, so
// this is private to the functions that require it.
//
// Storage is Upstash Redis over its REST API — the same store Vercel links as
// "KV", which injects KV_REST_API_URL and KV_REST_API_TOKEN automatically.
// No npm package: every call is plain fetch, so the repo stays dependency-free.

const crypto = require('crypto');

const KV_URL = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';

const storeReady = Boolean(KV_URL && KV_TOKEN);

// --- store ------------------------------------------------------------------

async function cmd(...args) {
  if (!storeReady) throw new Error('store_not_configured');
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args.map(String))
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    console.error('kv_error', r.status, data.error);
    throw new Error('store_error');
  }
  return data.result;
}

async function getJSON(key) {
  const raw = await cmd('GET', key);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function setJSON(key, value, ttlSeconds) {
  const args = ['SET', key, JSON.stringify(value)];
  if (ttlSeconds) args.push('EX', String(ttlSeconds));
  return cmd(...args);
}

// --- sessions ---------------------------------------------------------------
//
// A session is a signed cookie, not a database row: value.signature, where the
// signature is HMAC-SHA256 over the value with SESSION_SECRET. Nothing secret
// travels in it — only the user id and an expiry.

const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_DAYS = 30;
const COOKIE = 'gr_session';

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function makeToken(userId) {
  const body = Buffer.from(
    JSON.stringify({ u: userId, exp: Date.now() + SESSION_DAYS * 864e5 })
  ).toString('base64url');
  return `${body}.${sign(body)}`;
}

function readToken(token) {
  if (!SESSION_SECRET || !token || token.indexOf('.') < 0) return null;
  const [body, signature] = token.split('.');
  if (!safeEqual(sign(body), signature)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (!payload || !payload.u || !payload.exp || payload.exp < Date.now()) return null;
  return payload.u;
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || '';
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function setSessionCookie(res, userId) {
  const token = makeToken(userId);
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

function currentUserId(req) {
  return readToken(parseCookies(req)[COOKIE]);
}

// --- users ------------------------------------------------------------------
//
// One record per email address. The id is derived from the email so the same
// person signing in with Google and with a link lands on the same account and
// the same balance.

function userIdForEmail(email) {
  return crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex').slice(0, 32);
}

async function upsertUser(email, how) {
  const id = userIdForEmail(email);
  const key = `user:${id}`;
  const existing = await getJSON(key);
  const user = existing || { id, email: String(email).trim().toLowerCase(), credits: 0, createdAt: Date.now() };
  user.lastSignInAt = Date.now();
  user.lastSignInWith = how;
  await setJSON(key, user);
  return user;
}

async function getUser(id) {
  if (!id) return null;
  return getJSON(`user:${id}`);
}

// --- credits ----------------------------------------------------------------
//
// The balance lives in its own counter so it can be changed atomically; the
// user record keeps everything else. A Lua script does the decrement so a
// balance can never go below zero, however many requests arrive at once.

const SPEND = `
local balance = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
if balance < amount then return -1 end
return redis.call('DECRBY', KEYS[1], amount)
`;

async function balanceOf(userId) {
  const v = await cmd('GET', `credits:${userId}`);
  return Number(v || 0);
}

// Idempotent: the same paymentId can never be credited twice, however many
// times Razorpay retries its webhook.
async function addCredits(userId, amount, paymentId) {
  const guard = `credited:${paymentId}`;
  const first = await cmd('SET', guard, userId, 'NX', 'EX', String(60 * 86400));
  if (first === null) return { added: false, balance: await balanceOf(userId) };
  const balance = await cmd('INCRBY', `credits:${userId}`, String(Math.round(amount)));
  return { added: true, balance: Number(balance) };
}

async function spendCredits(userId, amount) {
  const result = await cmd('EVAL', SPEND, '1', `credits:${userId}`, String(Math.round(amount)));
  if (Number(result) < 0) return { ok: false, balance: await balanceOf(userId) };
  return { ok: true, balance: Number(result) };
}

async function refundCredits(userId, amount) {
  const balance = await cmd('INCRBY', `credits:${userId}`, String(Math.round(amount)));
  return Number(balance);
}

// Accounts that generate on the owner's own provider key without touching the
// credit ledger. Credits are this site's internal accounting for customers;
// the owner already pays the provider directly, so charging them their own
// currency would just move a number around.
//
// The list comes from the environment and is compared against the email on the
// server-verified session. Nothing the browser sends is consulted, so a
// visitor cannot claim to be the owner.
const OWNERS = String(process.env.OWNER_EMAILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function isOwner(email) {
  if (!email || !OWNERS.length) return false;
  return OWNERS.indexOf(String(email).trim().toLowerCase()) > -1;
}

// --- what a generation costs --------------------------------------------------
//
// Every price here is Higgsfield's own published rate for that endpoint, read
// from its catalogue on 2026-09-28. They are the LIST prices, not the
// promotional ones on the dashboard that day: every one of those discounts
// carries discount_expires_at = 2026-10-01, and a bill built on a rate that
// dies in two days would start losing money the moment it did.
//
// A flat forty credits a video used to stand in for all of this. It was wrong
// in both directions at once — Kling costs a fifth of that, and one Genjutsu
// clip cost $3.41 against forty rupees taken.
//
// Where the catalogue says "from", the rate is the cheapest tier that model
// sells; a higher resolution can cost more than this, so these are floors.
const RATES = {
  '/bytedance/seedance-2.5/text-to-video':     { usd: 0.2057, per: 'second', from: true },
  '/kling-video/v3.0/std/text-to-video':       { usd: 0.084,  per: 'second' },
  // Omni is quoted at two tiers: $0.084 a second for a one-second clip and
  // $0.112 for the five- and ten-second ones. Five and ten are the only lengths
  // it accepts, so the higher tier is the one that can actually be billed.
  '/kling-video/omni/first-last-frame':        { usd: 0.112,  per: 'second' },
  '/minimax/h3/text-to-video':                 { usd: 0.13,   per: 'second' },
  '/alibaba/wan-3.0-prime/text-to-video':      { usd: 0.068,  per: 'second', from: true },
  '/higgsfield/cinema-studio/4.0':             { usd: 0.2057, per: 'second', from: true },
  '/higgsfield/genjutsu/motion-transfer/v1.0': { usd: 0.318,  per: 'second', from: true },
  // Marketing Studio publishes a price for its 1k tier only, so only 1k is
  // offered on the page; 2k and 4k would be sold at a rate nobody has stated.
  '/marketing-studio/image':                   { usd: 0.0162, per: 'image', from: true },
  // Soul 2 prices its 720p tier only, so 720p is the tier the page sells.
  '/higgsfield-ai/soul/v2/standard':           { usd: 0.0032, per: 'image', from: true },
  '/recraft/v4.1/text-to-image':               { usd: 0.035,  per: 'image' },
  '/alibaba/qwen-image-3/text-to-image':       { usd: 0.04,   per: 'image', from: true },
  '/xai/grok-imagine-image-2.0':               { usd: 0.04,   per: 'image', from: true }
};

const USD_INR = Number(process.env.USD_INR || 95.791);
const MARGIN = Number(process.env.PRICE_MARGIN || 1.2);
const MAX_SECONDS = 30;

function rateFor(path) {
  return Object.prototype.hasOwnProperty.call(RATES, path) ? RATES[path] : null;
}

// One credit is one rupee, so a charge is the provider's dollar cost converted
// and marked up. Rounded up, because a fraction of a credit cannot be taken and
// rounding down would sell the remainder at a loss.
function creditsFor(path, seconds) {
  const rate = rateFor(path);
  if (!rate) return null;
  let units = 1;
  if (rate.per === 'second') {
    units = Math.round(Number(seconds));
    if (!isFinite(units) || units < 1) units = 1;
    if (units > MAX_SECONDS) units = MAX_SECONDS;
  }
  return Math.ceil(rate.usd * units * USD_INR * MARGIN);
}

// What the page needs to quote a price before anything is spent. The same
// numbers the server bills with, so the quote cannot drift from the charge.
function priceTable() {
  const out = {};
  for (const path in RATES) {
    if (!Object.prototype.hasOwnProperty.call(RATES, path)) continue;
    out[path] = {
      per: RATES[path].per,
      from: Boolean(RATES[path].from),
      credits: Math.ceil(RATES[path].usd * USD_INR * MARGIN * 100) / 100
    };
  }
  return { rates: out, usdInr: USD_INR, margin: MARGIN, maxSeconds: MAX_SECONDS };
}

module.exports = {
  storeReady,
  isOwner,
  rateFor, creditsFor, priceTable,
  authReady: Boolean(SESSION_SECRET && storeReady),
  googleReady: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  emailReady: Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM),
  cmd, getJSON, setJSON,
  sign, safeEqual,
  setSessionCookie, clearSessionCookie, currentUserId, parseCookies,
  userIdForEmail, upsertUser, getUser,
  balanceOf, addCredits, spendCredits, refundCredits
};
