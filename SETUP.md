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

## Switch 2 — Payments (Razorpay Subscriptions)

### a) Account

1. Sign up at razorpay.com and complete **KYC** — business PAN, bank account,
   address proof. Expect a few working days.
2. In the dashboard, request **Subscriptions** to be enabled. Recurring billing
   is a separate activation from ordinary payments, and it is the step people
   forget.

### b) Create the three plans

Dashboard → **Subscriptions → Plans → Create Plan**, billing cycle **Monthly**:

| Plan | Amount | Copy the plan id into |
|---|---|---|
| Starter | ₹499 | `RZP_PLAN_STARTER` |
| Creator | ₹1,499 | `RZP_PLAN_CREATOR` |
| Studio | ₹4,999 | `RZP_PLAN_STUDIO` |

Plan ids look like `plan_XXXXXXXXXXXXXX`. The amounts must match what the site
shows, or the page becomes a lie.

### c) Keys and webhook

| Variable | Where it comes from |
|---|---|
| `RAZORPAY_KEY_ID` | Settings → API Keys (starts `rzp_test_` or `rzp_live_`) |
| `RAZORPAY_KEY_SECRET` | shown **once** when you generate the key — save it then |
| `RAZORPAY_WEBHOOK_SECRET` | you choose this when creating the webhook |
| `RZP_PLAN_STARTER` / `RZP_PLAN_CREATOR` / `RZP_PLAN_STUDIO` | from step (b) |

Then Settings → **Webhooks → Add New Webhook**:

- **URL:** `https://genroll.in/api/webhook`
- **Secret:** any long random string — put the same value in `RAZORPAY_WEBHOOK_SECRET`
- **Events:** `subscription.activated`, `subscription.charged`,
  `subscription.pending`, `subscription.halted`, `subscription.cancelled`,
  `subscription.completed`

The webhook secret is a **different value** from your API key secret.

### d) What happens then

The Plans page buttons change from *"Payments disabled"* to *"Subscribe →"* on
their own, and the header pill says whether you're in test or live mode. Test
mode is safe: cards are simulated and no money moves.

---

## UPI AutoPay — two rules worth knowing

- **₹15,000 per debit** is the standard ceiling that goes through without the
  customer re-authenticating. All three plans sit well under it, so renewals are
  frictionless.
- **A pre-debit notification is required at least 24 hours before every
  charge.** The code sets `customer_notify: 1`, which makes Razorpay send these
  for you. Leave it on.

---

## Still to build (be honest about this)

The payment plumbing is complete and verified; the *business* logic behind it is
not, because it needs a database:

1. **No customer accounts.** There is no sign-in, so a subscription can't yet be
   attached to a person. `api/verify.js` proves a payment is real but stores
   nothing — there's a marked `TODO` where the write belongs.
2. **The allowance pool isn't metered.** Plans promise a monthly ₹ pool; nothing
   counts spend against it yet. `subscription.charged` in `api/webhook.js` is
   where the monthly reset goes.
3. **Generated media isn't stored.** Higgsfield expires files in ~7 days.
4. **No cancel / pause UI.** Customers can only cancel from the Razorpay emails.

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
  before live keys go anywhere near the site.
- After adding or changing any variable: **redeploy**.

---

## Files

| Path | Does |
|---|---|
| `index.html` | the whole front end, single file |
| `api/config.js` | tells the browser what's switched on — never returns a secret |
| `api/create-subscription.js` | creates a Razorpay subscription for a tier |
| `api/verify.js` | verifies the checkout signature (`payment_id\|subscription_id`) |
| `api/webhook.js` | receives Razorpay events; the only reliable renewal signal |
| `api/generate.js` | starts a Higgsfield job |
| `api/job.js` | polls a Higgsfield job |

No `package.json`, no dependencies, no build step — every endpoint uses plain
`fetch` and Node's built-in `crypto`. Editing `index.html` on GitHub redeploys
the site automatically.
