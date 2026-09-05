import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import type { Bindings, SessionUser } from "../types";
import { bytesToBase64Url, base64UrlToBytes, hmacSha256, timingSafeEqual } from "./crypto";

const COOKIE = "smsbot_session";
const TTL_SECONDS = 60 * 60 * 24 * 7;

function cookieOpts(c: Context<{ Bindings: Bindings }>) {
  const url = new URL(c.req.url);
  return {
    path: "/",
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: url.protocol === "https:",
    maxAge: TTL_SECONDS,
  };
}

export async function signSession(secret: string, user: SessionUser): Promise<string> {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(user)));
  const sig = bytesToBase64Url(await hmacSha256(secret, payload));
  return `${payload}.${sig}`;
}

export async function readSession(secret: string, token: string | undefined): Promise<SessionUser | null> {
  if (!token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = bytesToBase64Url(await hmacSha256(secret, payload));
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const json = new TextDecoder().decode(base64UrlToBytes(payload));
    const user = JSON.parse(json) as SessionUser;
    if (!user?.id || !user.exp || user.exp * 1000 < Date.now()) return null;
    return user;
  } catch {
    return null;
  }
}

export async function setSessionCookie(c: Context<{ Bindings: Bindings }>, user: SessionUser) {
  const token = await signSession(c.env.SESSION_SECRET, user);
  setCookie(c, COOKIE, token, cookieOpts(c));
}

export function clearSessionCookie(c: Context<{ Bindings: Bindings }>) {
  deleteCookie(c, COOKIE, { path: "/" });
}

export async function getSessionUser(c: Context<{ Bindings: Bindings }>): Promise<SessionUser | null> {
  const accessEmail = c.req.header("Cf-Access-Authenticated-User-Email");
  if (accessEmail && isAllowed(c.env.ALLOWED_USERS, accessEmail, accessEmail)) {
    return {
      provider: "access",
      id: accessEmail,
      login: accessEmail,
      name: accessEmail.split("@")[0],
      email: accessEmail,
      avatar: "",
      exp: Math.floor(Date.now() / 1000) + TTL_SECONDS,
    };
  }

  return readSession(c.env.SESSION_SECRET, getCookie(c, COOKIE));
}

export function sessionExpiry(): number {
  return Math.floor(Date.now() / 1000) + TTL_SECONDS;
}

export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowed(allowlistRaw: string | undefined, login: string, email: string): boolean {
  const list = parseAllowlist(allowlistRaw);
  if (list.length === 0) return true;
  const candidates = [login, email].map((v) => v.toLowerCase());
  return candidates.some((v) => list.includes(v));
}
