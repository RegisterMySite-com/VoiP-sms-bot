# SMS Bot by RegisterMySite

Production-ready Twilio SMS dashboard on Cloudflare Workers.

Authenticated operators send and monitor SMS from a real Twilio number. Inbound texts hit a Worker webhook, get a Workers AI reply using the same model and prompt pattern as Cloudflare’s official [llm-chat-app-template](https://github.com/cloudflare/templates/tree/main/llm-chat-app-template), and stay in a per-number conversation.

**Brand:** SMS Bot · [registermysite.com](https://registermysite.com)

## Architecture

```
Phone  ──SMS──►  Twilio number
                    │
                    │ webhook (signature-checked)
                    ▼
              Cloudflare Worker (Hono)
                    │
         ┌──────────┼──────────────┐
         ▼          ▼              ▼
   Workers AI    Durable Object   D1
   llama-3.1     history + RL     message log
         │
         └── REST ──► Twilio ──SMS──► Phone

Browser ──OAuth / Access──► same Worker ── dashboard UI
```

| Piece | Role |
| --- | --- |
| Hono Worker | Routes, auth, dashboard APIs |
| Workers AI | Auto-replies (`@cf/meta/llama-3.1-8b-instruct-fp8`) |
| Durable Object (SQLite) | Last 20 turns per number + rate limits |
| D1 | Message history, delivery status, conversation list |
| Static assets | Dashboard UI (no separate Pages project) |

Nothing leaves the Cloudflare + Twilio boundary.

## 1. Prerequisites

- Node 18+
- Cloudflare account with Workers, Workers AI, D1, and Durable Objects
- Twilio account with an SMS-capable number
- Wrangler 4 (`npm i` in this folder)

## 2. Install

```bash
git clone https://github.com/RegisterMySite-com/VoiP-sms-bot.git
cd VoiP-sms-bot
npm install
cp .dev.vars.example .dev.vars
```

## 3. Create D1 and wire the database id

```bash
npx wrangler d1 create sms-bot-registermysite
```

Paste the printed `database_id` into `wrangler.jsonc` → `d1_databases[0].database_id`.

```bash
npm run db:migrate:local
npm run db:migrate
```

## 4. Set secrets

```bash
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_PHONE_NUMBER     # E.164, e.g. +15551234567
npx wrangler secret put SESSION_SECRET          # long random string
```

Optional but recommended:

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put ALLOWED_USERS           # github-login,you@registermysite.com
npx wrangler secret put DASHBOARD_USER          # bootstrap only
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler secret put TWILIO_WEBHOOK_URL      # exact public SMS webhook URL
```

Local values go in `.dev.vars` (gitignored).

## 5. Public URL and OAuth

Edit `PUBLIC_BASE_URL` in `wrangler.jsonc` to the Worker URL or custom domain:

```text
https://sms-bot-registermysite.<account>.workers.dev
```

GitHub OAuth app:

1. GitHub → Settings → Developer settings → OAuth Apps → New
2. Homepage: your `PUBLIC_BASE_URL`
3. Callback: `https://<your-domain>/auth/github/callback`
4. Copy client id / secret into secrets

Cloudflare Access (preferred in production): put the Worker hostname behind Access. The dashboard trusts `Cf-Access-Authenticated-User-Email` when that email is on `ALLOWED_USERS` (or when the allowlist is empty).

## 6. Deploy

```bash
npx wrangler deploy
```

Confirm `/healthz` and `/api/health` respond.

## 7. Connect the Twilio number

In Twilio Console → Phone Numbers → your number → Messaging:

| Field | Value |
| --- | --- |
| A message comes in | `https://<your-domain>/webhooks/twilio/sms` |
| HTTP | `POST` |
| Status callback (optional, also set per-send) | `https://<your-domain>/webhooks/twilio/status` |

If signature checks fail after deploy, set `TWILIO_WEBHOOK_URL` to the **exact** inbound URL Twilio calls (scheme, host, path, no trailing slash mismatch). Twilio signs that URL plus the POST body.

Send a test SMS to the number. You should get an AI reply, and the thread should appear in the dashboard.

## Customize the auto-responder

Edit `src/lib/ai.ts`:

```ts
export const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

export const SYSTEM_PROMPT = `You are SMS Bot by RegisterMySite ...`;
```

That is the same extension point as the official llm-chat-app-template (`MODEL_ID` + `SYSTEM_PROMPT` in the Worker). Keep the prompt SMS-aware: short, no markdown.

Optional AI Gateway: pass a `gateway` option into `env.AI.run` the same way the template does.

Redeploy after prompt changes. The live prompt is visible in the dashboard sidebar.

## Dashboard

Sign in, then:

- See the Twilio number and 24h / inbound / outbound counts
- Browse conversations (admin view of recent threads)
- Open a thread for sent + received bodies and delivery status
- Send outbound SMS
- Read the active system prompt

Polls every 12 seconds for new traffic.

## Rate limits

Enforced in the per-number Durable Object:

- Inbound auto-replies: 20 / hour / remote number
- Dashboard sends: 60 / hour / operator

Replies are clamped and split so they stay inside Twilio’s 1600-character cap.

## Security notes

- `/webhooks/twilio/*` is public and **must** stay signature-checked. Do not put Access in front of those paths; exclude them from the Access policy.
- Protect `/` and `/api/*` with Access or GitHub OAuth + `ALLOWED_USERS`.
- Store Twilio credentials only as Worker secrets.
- `DASHBOARD_PASSWORD` is a bootstrap hatch. Prefer GitHub OAuth or Access in production.
- Empty `ALLOWED_USERS` allows any authenticated identity. Set the allowlist.

## Project layout

```text
src/index.ts                     Worker entry (Hono)
src/lib/ai.ts                    Model + system prompt
src/lib/twilio.ts                REST send + HMAC-SHA1 validation
src/lib/session.ts               Signed cookie + Access header
src/durable-objects/ConversationDO.ts
src/routes/webhooks.ts           Inbound SMS + status + auto-reply
src/routes/api.ts                Dashboard APIs
src/routes/auth.ts               GitHub OAuth + password + logout
public/                          Dashboard UI
schema.sql                       D1 tables
```

## Local development

```bash
npm run db:migrate:local
npm run dev
```

Workers AI calls go to the real binding. Twilio webhooks cannot reach `localhost` unless you tunnel (`cloudflared tunnel` or similar) and point the number at that URL.

```bash
npm run tail
```

## Common failures

| Symptom | Fix |
| --- | --- |
| 403 on inbound webhook | `TWILIO_WEBHOOK_URL` / `PUBLIC_BASE_URL` must match the URL Twilio signed |
| Dashboard 401 loop | Set `SESSION_SECRET`, check OAuth callback URL, or use Access |
| Send fails 502 | Confirm number is SMS-capable and the destination is reachable |
| No AI reply | Confirm Workers AI is enabled; check `wrangler tail` |
| D1 errors on first request | Run `npm run db:migrate` |
