# Genroll Studio — switch-on checklist

The site is live at **https://genroll.in** and everything below is already
deployed. Nothing here needs code changes: the site reads its own environment
and turns features on by itself.

**The rule that makes this safe:** with no environment variables set, every
endpoint returns `503` and the UI stays in preview mode. Nothing breaks, nothing
charges, nothing lies to a visitor. The moment a variable is present, that
feature switches on.

Payments and generation are **two independent switches**. Either can go live
first.

---

## Where the keys go

Vercel → project **genroll** → **Settings → Environment Variables**.
Add each one for **Production** (and Preview if you want to test there), then
**Redeploy** — Vercel only picks up new variables on a fresh deploy.

> Paste keys straight into Vercel. Don't send them through chat, email or
> Slack — anything that lands in a message history should be treated as burned
> and rotated.

---

## Switch 1 — Generation (Higgsfield)

| Variable | Value |
|---|---|
| `HIGGSFIELD_KEY_ID` | your key id |
| `HIGGSFIELD_KEY_SECRET` | your key secret |
| `HIGGSFIELD_BASE_URL` | *(optional)* see the note below |

Or, if your key came as a single `id:secret` string, use one variable instead:

| Variable | Value |
|---|---|
| `HIGGSFIELD_CREDENTIALS` | `keyid:keysecret` |

**Base URL — tested, and it is not the problem.** Higgsfield's docs show
`https://api.higgsfield.ai`; their Node SDK defaults to
`https://platform.higgsfield.ai`. On 21 Sep 2026 both hosts were tried against
this deployment and **both returned exactly the same `401 Invalid credentials`**,
so the discrepancy is not what blocks generation. `HIGGSFIELD_BASE_URL` is
currently set to the `platform.` host; either value works the same.

### Current status: 401 from Higgsfield

Everything on this side is verified working — the endpoints deploy, the env vars
are read, `/api/config` reports `generation.enabled: true`, the allow-list guard
rejects unknown paths, and the server reaches Higgsfield and gets a well-formed
reply. The only failure is Higgsfield rejecting the key pair.

Check in the Higgsfield console:

1. **Are there genuinely two different values?** Both variables were saved with
   36 characters each; if the same value went into both, auth fails.
2. **Was the secret copied in full?** A secret longer than 36 characters would
   have been truncated.
3. **Is the key active, and does the account have credits?** New accounts
   sometimes issue a key before enabling it.
4. **If the console shows one combined `id:secret` string**, delete
   `HIGGSFIELD_KEY_ID` / `HIGGSFIELD_KEY_SECRET` and set `HIGGSFIELD_CREDENTIALS`
   to that single string instead. The code accepts either shape.

**Endpoint allow-list.** `api/generate.js` will only call paths listed in
`ALLOWED_PATHS`, so a visitor can't point it anywhere else. It currently allows:

- `/higgsfield-ai/soul/v2/standard`
- `/flux-pro/kontext/max/text-to-image`
- `/v1/image2video/dop`

Add whatever else your plan includes — one line each.

**How it works.** Higgsfield is asynchronous: `POST /api/generate` starts a job
and returns a `requestId`; the browser then polls `GET /api/job?id=…` until the
status is `completed`, `failed` or `nsfw`. The key never reaches the browser —
the page only ever talks to our own two endpoints.

⚠️ **Output files expire.** Higgsfield keeps generated media for about seven
days. Anything a customer should keep must be copied into your own storage
(Vercel Blob, S3, Cloudflare R2). That is not built yet — see *Still to build*.

---

## Switch 2 — Payments (Razorpay Orders — credit top-ups)

The site sells **credits, not subscriptions**: 1 credit = ₹1, bought whenever
the customer wants. That means **no monthly Plans, and no recurring-billing
activation** — those are only needed for the Subscriptions API, which this site
no longer uses. If you already created Plans in the dashboard, just ignore them.

### a) Account

Sign up at razorpay.com and complete **KYC** — business PAN, bank account,
address proof. Expect a few working days. Test mode works before KYC finishes.

### b) Keys

Dashboard → **Settings → API Keys → Generate Key**.

| Variable | Where it comes from |
|---|---|
| `RAZORPAY_KEY_ID` | shown in the dashboard (starts `rzp_test_` or `rzp_live_`) |
| `RAZORPAY_KEY_SECRET` | shown **once**, at generation — save it right then |
| `RAZORPAY_WEBHOOK_SECRET` | you choose this when creating the webhook (step c) |
| `RZP_MIN_TOPUP_INR` | *(optional)* smallest top-up, default `10` |
| `RZP_MAX_TOPUP_INR` | *(optional)* largest top-up, default `50000` |

The min/max are enforced **server-side** in `api/create-order.js`, because
anything the browser sends can be forged. Keep them matching the Credits page.

### c) Webhook

Settings → **Webhooks → Add New Webhook**:

- **URL:** `https://genroll.in/api/webhook`
- **Secret:** any long random string — put the same value in `RAZORPAY_WEBHOOK_SECRET`
- **Events:** `payment.captured`, `payment.failed`, `payment.authorized`,
  and optionally `order.paid`, `refund.processed`

The webhook secret is a **different value** from your API key secret.

**Why the webhook matters more than the checkout callback.** The callback comes
from the customer's browser and can be lost — closed tab, dead phone, bad
network. `payment.captured` always arrives. Credits should be granted there,
keyed on the payment id so a retried webhook cannot credit twice.

### d) Signature order — the one thing people get wrong

Orders and Subscriptions sign in **opposite orders**:

| Flow | Signed string |
|---|---|
| Orders (what this site uses) | `order_id + "\|" + payment_id` |
| Subscriptions | `payment_id + "\|" + subscription_id` |

`api/verify.js` uses the Orders form, and additionally re-reads the payment
from Razorpay so the credited amount comes from Razorpay's record rather than
from the browser.

### e) What happens then

`/api/config` starts returning `enabled: true` and the Credits page buttons
switch from *"Payments disabled"* to a working top-up. The header pill says
test or live. Test mode is safe — cards are simulated and no money moves.

---

## Still to build (be honest about this)

The payment plumbing is complete and verified; the *business* logic behind it is
not, because it needs a database:

1. **No customer accounts.** There is no sign-in, so credits can't yet be
   attached to a person. `api/verify.js` proves a payment is real but stores
   nothing — there's a marked `TODO` where the write belongs.
2. **No credit balance.** Nothing records how many credits were bought, and
   nothing deducts them when a generation runs. **This is the blocker: until it
   exists, a customer can pay real money and receive nothing.** Keep live keys
   off the site until it does — test keys only.
3. **Generated media isn't stored.** Higgsfield expires files in ~7 days.
4. **No refund path.** Refunds have to be issued by hand in the dashboard.

Vercel Postgres or KV plus a simple email sign-in closes all four. Until then,
keep the honest disclosures on the Plans page exactly as they are — they
describe what the product actually does today.

---

## Quick checks

```bash
# Is anything switched on?
curl -s https://genroll.in/api/config | jq
# Before keys:  {"enabled":false,"generation":{"enabled":false}, ...}
# The "missing" array names exactly which variables are absent.
```

- Payments should be tested with Razorpay **test** keys first, end to end,
  before live keys go anywhere near the site — and not at all before credit
  balances exist (see *Still to build*).
- After adding or changing any variable: **redeploy**.

---

## Files

| Path | Does |
|---|---|
| `index.html` | the whole front end, single file |
| `api/config.js` | tells the browser what's switched on — never returns a secret |
| `api/create-order.js` | creates a Razorpay order for a credit top-up |
| `api/verify.js` | verifies the checkout signature (`order_id\|payment_id`) |
| `api/webhook.js` | receives Razorpay events; the reliable record of payment |
| `api/generate.js` | starts a Higgsfield job |
| `api/job.js` | polls a Higgsfield job |

No `package.json`, no dependencies, no build step — every endpoint uses plain
`fetch` and Node's built-in `crypto`. Editing `index.html` on GitHub redeploys
the site automatically.
