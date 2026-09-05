import { Hono } from "hono";
import type { Bindings } from "../types";
import { randomId } from "../lib/crypto";
import { emptyTwiml, normalizeE164, validateTwilioSignature, webhookUrl, sendTwilioSms } from "../lib/twilio";
import { recordExchange, updateMessageStatus } from "../lib/db";
import { generateSmsReply } from "../lib/ai";
import { splitSms } from "../lib/sms";
import { appendTurn, consumeRateLimit, getHistory } from "../durable-objects/ConversationDO";

export const webhookRoutes = new Hono<{ Bindings: Bindings }>();

webhookRoutes.post("/twilio/sms", async (c) => {
  const raw = await c.req.parseBody();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.set(key, value);
  }

  const url = webhookUrl(c.env, c.req.raw, "/webhooks/twilio/sms");
  const signature = c.req.header("X-Twilio-Signature");
  const valid = await validateTwilioSignature(c.env.TWILIO_AUTH_TOKEN, signature, url, params);
  if (!valid) {
    console.warn("Rejected Twilio SMS webhook: bad signature", { url });
    return c.text("Invalid signature", 403);
  }

  const from = normalizeE164(String(params.get("From") ?? ""));
  const to = normalizeE164(String(params.get("To") ?? c.env.TWILIO_PHONE_NUMBER));
  const mediaCount = Number(params.get("NumMedia") ?? "0");
  const body = String(params.get("Body") ?? "").trim() || (mediaCount > 0 ? "[media message]" : "");
  const sid = params.get("MessageSid") || params.get("SmsSid") || randomId("SM");

  if (!from || !body) return emptyTwiml();

  await recordExchange(c.env, {
    id: randomId("msg"),
    twilioSid: sid,
    direction: "inbound",
    from,
    to,
    body,
    status: params.get("SmsStatus") || "received",
    source: "inbound",
  });

  c.executionCtx.waitUntil(autoReply(c.env, from, to, body, c.req.url));
  return emptyTwiml();
});

webhookRoutes.post("/twilio/status", async (c) => {
  const raw = await c.req.parseBody();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.set(key, value);
  }

  const url = webhookUrl(c.env, c.req.raw, "/webhooks/twilio/status");
  const signature = c.req.header("X-Twilio-Signature");
  const valid = await validateTwilioSignature(c.env.TWILIO_AUTH_TOKEN, signature, url, params);
  if (!valid) return c.text("Invalid signature", 403);

  const sid = params.get("MessageSid") || params.get("SmsSid");
  const status = params.get("MessageStatus") || params.get("SmsStatus") || "unknown";
  const errorCode = params.get("ErrorCode");
  if (sid) {
    await updateMessageStatus(c.env.DB, sid, status, errorCode);
  }
  return c.text("ok");
});

async function autoReply(env: Bindings, from: string, ourNumber: string, inboundBody: string, requestUrl: string) {
  try {
    const limit = await consumeRateLimit(env, from, "inbound");
    if (!limit.allowed) {
      console.warn("Inbound auto-reply rate limited", { from, retryAfterSec: limit.retryAfterSec });
      return;
    }

    await appendTurn(env, from, "user", inboundBody);
    const history = await getHistory(env, from);
    const reply = await generateSmsReply(env, history);
    const parts = splitSms(reply);

    const statusCallback = statusCallbackUrl(env, requestUrl);

    for (const part of parts) {
      const sent = await sendTwilioSms(env, from, part, statusCallback);
      await appendTurn(env, from, "assistant", part);
      await recordExchange(env, {
        id: randomId("msg"),
        twilioSid: sent.sid,
        direction: "outbound",
        from: ourNumber,
        to: from,
        body: part,
        status: sent.status,
        source: "auto-reply",
      });
    }
  } catch (err) {
    console.error("autoReply failed", err);
  }
}

function statusCallbackUrl(env: Bindings, requestUrl: string): string {
  if (env.PUBLIC_BASE_URL && !env.PUBLIC_BASE_URL.includes("YOUR_SUBDOMAIN")) {
    return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/webhooks/twilio/status`;
  }
  return `${new URL(requestUrl).origin}/webhooks/twilio/status`;
}
