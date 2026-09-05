import { Hono } from "hono";
import type { AppVariables, Bindings } from "../types";
import { randomId } from "../lib/crypto";
import { normalizeE164, sendTwilioSms, TwilioError } from "../lib/twilio";
import { listConversations, listMessages, recordExchange, stats, writeAudit } from "../lib/db";
import { appendTurn, consumeRateLimit, getHistory } from "../durable-objects/ConversationDO";
import { MODEL_ID, SYSTEM_PROMPT } from "../lib/ai";
import { splitSms } from "../lib/sms";

export const apiRoutes = new Hono<{ Bindings: Bindings; Variables: AppVariables }>();

apiRoutes.get("/health", (c) =>
  c.json({
    ok: true,
    app: c.env.APP_NAME,
    brand: c.env.APP_BRAND,
    twilioConfigured: Boolean(c.env.TWILIO_ACCOUNT_SID && c.env.TWILIO_AUTH_TOKEN && c.env.TWILIO_PHONE_NUMBER),
    phoneNumber: c.env.TWILIO_PHONE_NUMBER || null,
    aiModel: MODEL_ID,
    githubOAuth: Boolean(c.env.GITHUB_CLIENT_ID),
    passwordLogin: Boolean(c.env.DASHBOARD_USER && c.env.DASHBOARD_PASSWORD),
  }),
);

apiRoutes.get("/config", (c) =>
  c.json({
    appName: c.env.APP_NAME,
    brand: c.env.APP_BRAND,
    phoneNumber: c.env.TWILIO_PHONE_NUMBER,
    modelId: MODEL_ID,
    systemPrompt: SYSTEM_PROMPT,
    githubOAuth: Boolean(c.env.GITHUB_CLIENT_ID),
    passwordLogin: Boolean(c.env.DASHBOARD_USER && c.env.DASHBOARD_PASSWORD),
  }),
);

apiRoutes.get("/stats", async (c) => c.json(await stats(c.env.DB)));

apiRoutes.get("/conversations", async (c) => {
  const rows = await listConversations(c.env.DB, 80);
  return c.json({ conversations: rows });
});

apiRoutes.get("/messages", async (c) => {
  const phone = c.req.query("phone");
  const limit = Number(c.req.query("limit") ?? "100");
  const rows = await listMessages(c.env.DB, { phone: phone || undefined, limit });
  return c.json({ messages: rows });
});

apiRoutes.get("/conversations/:phone/history", async (c) => {
  const phone = normalizeE164(c.req.param("phone"));
  const history = await getHistory(c.env, phone);
  return c.json({ phone, history });
});

apiRoutes.post("/send", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json()) as { to?: string; body?: string };
  const to = normalizeE164(body.to ?? "");
  const text = (body.body ?? "").trim();

  if (!to || !to.startsWith("+")) {
    return c.json({ error: "Provide a valid destination number in E.164 format." }, 400);
  }
  if (!text) return c.json({ error: "Message body is required." }, 400);
  if (text.length > 1600) return c.json({ error: "Message exceeds 1600 characters." }, 400);

  const limit = await consumeRateLimit(c.env, `dashboard:${user.id}`, "outbound");
  if (!limit.allowed) {
    return c.json(
      { error: `Outbound rate limit reached. Try again in ${limit.retryAfterSec}s.` },
      429,
    );
  }

  const parts = splitSms(text);
  const sent: { sid: string; status: string; body: string }[] = [];
  const statusCallback =
    c.env.PUBLIC_BASE_URL && !c.env.PUBLIC_BASE_URL.includes("YOUR_SUBDOMAIN")
      ? `${c.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/webhooks/twilio/status`
      : `${new URL(c.req.url).origin}/webhooks/twilio/status`;

  try {
    for (const part of parts) {
      const result = await sendTwilioSms(c.env, to, part, statusCallback);
      await appendTurn(c.env, to, "assistant", part);
      await recordExchange(c.env, {
        id: randomId("msg"),
        twilioSid: result.sid,
        direction: "outbound",
        from: c.env.TWILIO_PHONE_NUMBER,
        to,
        body: part,
        status: result.status,
        source: "dashboard",
      });
      sent.push({ sid: result.sid, status: result.status, body: part });
    }
  } catch (err) {
    const message = err instanceof TwilioError ? err.message : "Failed to send SMS.";
    const code = err instanceof TwilioError ? err.code : undefined;
    return c.json({ error: message, code, sent }, 502);
  }

  await writeAudit(c.env.DB, user.login, "send_sms", `${to} (${sent.length} part${sent.length === 1 ? "" : "s"})`);
  return c.json({ ok: true, sent });
});
