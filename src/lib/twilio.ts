import { hmacSha1Base64, timingSafeEqual } from "./crypto";
import type { Bindings } from "../types";

const TWILIO_API = "https://api.twilio.com/2010-04-01";

export function normalizeE164(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("+")) return trimmed.replace(/[^\d+]/g, "");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits ? `+${digits}` : trimmed;
}

/**
 * Twilio signs: full URL + POST params sorted by key, each key+value appended
 * with no delimiter. HMAC-SHA1, base64, Auth Token as key.
 * @see https://www.twilio.com/docs/usage/security#validating-requests
 */
export async function validateTwilioSignature(
  authToken: string,
  signature: string | null,
  url: string,
  params: URLSearchParams,
): Promise<boolean> {
  if (!signature || !authToken) return false;

  const keys = [...new Set([...params.keys()])].sort();
  let data = url;
  for (const key of keys) {
    for (const value of params.getAll(key)) {
      data += key + value;
    }
  }

  const expected = await hmacSha1Base64(authToken, data);
  return timingSafeEqual(signature, expected);
}

export function webhookUrl(env: Bindings, request: Request, path: string): string {
  if (path.endsWith("/sms") && env.TWILIO_WEBHOOK_URL) {
    return env.TWILIO_WEBHOOK_URL;
  }
  const base = env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (base && !base.includes("YOUR_SUBDOMAIN")) {
    return `${base}${path}`;
  }
  const incoming = new URL(request.url);
  return `${incoming.origin}${path}`;
}

export async function sendTwilioSms(
  env: Bindings,
  to: string,
  body: string,
  statusCallback?: string,
): Promise<{ sid: string; status: string; errorCode?: string }> {
  const from = env.TWILIO_PHONE_NUMBER;
  const url = `${TWILIO_API}/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  if (statusCallback) params.set("StatusCallback", statusCallback);

  const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  const json = (await res.json()) as {
    sid?: string;
    status?: string;
    code?: number;
    message?: string;
  };

  if (!res.ok || !json.sid) {
    const err = json.message || `Twilio send failed (${res.status})`;
    throw new TwilioError(err, json.code ? String(json.code) : String(res.status));
  }

  return { sid: json.sid, status: json.status ?? "queued" };
}

export class TwilioError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = "TwilioError";
  }
}

export function emptyTwiml(): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
