/**
 * SMS Bot by RegisterMySite
 *
 * Hono Worker that:
 *  - serves an authenticated SMS dashboard
 *  - sends / receives SMS through a real Twilio number
 *  - auto-replies with Workers AI using the llm-chat-app-template model + prompt pattern
 *
 * https://registermysite.com
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { AppVariables, Bindings } from "./types";
import { getSessionUser } from "./lib/session";
import { authRoutes } from "./routes/auth";
import { webhookRoutes } from "./routes/webhooks";
import { apiRoutes } from "./routes/api";

export { ConversationDO } from "./durable-objects/ConversationDO";

const app = new Hono<{ Bindings: Bindings; Variables: AppVariables }>();

app.use("*", secureHeaders());
app.use("/api/*", cors({ origin: (origin) => origin, credentials: true }));

app.onError((err, c) => {
  console.error("unhandled", err);
  return c.json({ error: "Internal error" }, 500);
});

app.get("/healthz", (c) => c.json({ ok: true, service: "sms-bot-registermysite" }));

app.route("/auth", authRoutes);
app.route("/webhooks", webhookRoutes);

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") return next();
  const user = await getSessionUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  c.set("user", user);
  await next();
});

app.route("/api", apiRoutes);

app.all("*", async (c) => {
  if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/auth/") || c.req.path.startsWith("/webhooks/")) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
