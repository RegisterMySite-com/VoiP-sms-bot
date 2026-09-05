import { Hono } from "hono";
import type { Bindings, SessionUser } from "../types";
import {
  clearSessionCookie,
  getSessionUser,
  isAllowed,
  sessionExpiry,
  setSessionCookie,
} from "../lib/session";
import { randomId, timingSafeEqual } from "../lib/crypto";

export const authRoutes = new Hono<{ Bindings: Bindings }>();

authRoutes.get("/me", async (c) => {
  const user = await getSessionUser(c);
  if (!user) return c.json({ user: null }, 401);
  return c.json({ user });
});

authRoutes.get("/github", async (c) => {
  const id = c.env.GITHUB_CLIENT_ID;
  if (!id) return c.text("GitHub OAuth is not configured (GITHUB_CLIENT_ID).", 500);

  const state = randomId("st");
  const redirectUri = `${originOf(c.env, c.req.url)}/auth/github/callback`;
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", state);

  c.header(
    "Set-Cookie",
    `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${
      new URL(c.req.url).protocol === "https:" ? "; Secure" : ""
    }`,
  );
  return c.redirect(url.toString());
});

authRoutes.get("/github/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const cookieHeader = c.req.header("Cookie") ?? "";
  const saved = cookieHeader.match(/(?:^|;\s*)oauth_state=([^;]+)/)?.[1];

  if (!code || !state || !saved || !timingSafeEqual(state, saved)) {
    return c.text("Invalid OAuth state.", 400);
  }
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
    return c.text("GitHub OAuth is not configured.", 500);
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${originOf(c.env, c.req.url)}/auth/github/callback`,
    }),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenJson.access_token) {
    return c.text(`GitHub token exchange failed: ${tokenJson.error ?? "unknown"}`, 401);
  }

  const ghUser = await githubJson<{
    id: number;
    login: string;
    name: string | null;
    email: string | null;
    avatar_url: string;
  }>("https://api.github.com/user", tokenJson.access_token);

  let email = ghUser.email ?? "";
  if (!email) {
    const emails = await githubJson<{ email: string; primary: boolean; verified: boolean }[]>(
      "https://api.github.com/user/emails",
      tokenJson.access_token,
    );
    email = emails.find((e) => e.primary && e.verified)?.email ?? emails[0]?.email ?? "";
  }

  if (!isAllowed(c.env.ALLOWED_USERS, ghUser.login, email)) {
    return c.text("This GitHub account is not on the dashboard allowlist.", 403);
  }

  const user: SessionUser = {
    provider: "github",
    id: String(ghUser.id),
    login: ghUser.login,
    name: ghUser.name || ghUser.login,
    email,
    avatar: ghUser.avatar_url,
    exp: sessionExpiry(),
  };
  await setSessionCookie(c, user);
  return c.redirect("/");
});

authRoutes.post("/password", async (c) => {
  const expectedUser = c.env.DASHBOARD_USER;
  const expectedPass = c.env.DASHBOARD_PASSWORD;
  if (!expectedUser || !expectedPass) {
    return c.json({ error: "Password login is disabled." }, 400);
  }

  const body = (await c.req.json()) as { username?: string; password?: string };
  const username = (body.username ?? "").trim();
  const password = body.password ?? "";
  if (!timingSafeEqual(username, expectedUser) || !timingSafeEqual(password, expectedPass)) {
    return c.json({ error: "Invalid credentials." }, 401);
  }
  if (!isAllowed(c.env.ALLOWED_USERS, username, username)) {
    return c.json({ error: "User is not on the allowlist." }, 403);
  }

  const user: SessionUser = {
    provider: "password",
    id: username,
    login: username,
    name: username,
    email: "",
    avatar: "",
    exp: sessionExpiry(),
  };
  await setSessionCookie(c, user);
  return c.json({ ok: true, user });
});

authRoutes.post("/logout", async (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoutes.get("/logout", async (c) => {
  clearSessionCookie(c);
  return c.redirect("/");
});

function originOf(env: Bindings, requestUrl: string): string {
  if (env.PUBLIC_BASE_URL && !env.PUBLIC_BASE_URL.includes("YOUR_SUBDOMAIN")) {
    return env.PUBLIC_BASE_URL.replace(/\/$/, "");
  }
  return new URL(requestUrl).origin;
}

async function githubJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "sms-bot-registermysite",
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}`);
  return res.json() as Promise<T>;
}
