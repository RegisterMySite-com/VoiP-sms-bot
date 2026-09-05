import { DurableObject } from "cloudflare:workers";
import type { Bindings, ChatMessage } from "../types";

const MAX_TURNS = 20;
const INBOUND_LIMIT = 20;
const INBOUND_WINDOW_MS = 60 * 60 * 1000;
const OUTBOUND_LIMIT = 60;
const OUTBOUND_WINDOW_MS = 60 * 60 * 1000;

/**
 * One Durable Object per phone number.
 * Stores recent chat turns for multi-turn SMS and enforces per-number rate limits.
 */
export class ConversationDO extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hits_kind_ts ON hits (kind, created_at);
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/history" && request.method === "GET") {
        return Response.json({ messages: this.history() });
      }
      if (url.pathname === "/append" && request.method === "POST") {
        const body = (await request.json()) as { role: ChatMessage["role"]; content: string };
        this.append(body.role, body.content);
        return Response.json({ ok: true, messages: this.history() });
      }
      if (url.pathname === "/rate-limit" && request.method === "POST") {
        const body = (await request.json()) as { kind: "inbound" | "outbound" };
        return Response.json(this.checkAndHit(body.kind));
      }
      if (url.pathname === "/reset" && request.method === "POST") {
        this.ctx.storage.sql.exec("DELETE FROM turns");
        return Response.json({ ok: true });
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("ConversationDO error", err);
      return Response.json({ error: "durable object failed" }, { status: 500 });
    }
  }

  private history(): ChatMessage[] {
    const rows = this.ctx.storage.sql
      .exec<{ role: ChatMessage["role"]; content: string }>(
        "SELECT role, content FROM turns ORDER BY id DESC LIMIT ?",
        MAX_TURNS,
      )
      .toArray()
      .reverse();
    return rows;
  }

  private append(role: ChatMessage["role"], content: string) {
    if (role === "system") return;
    this.ctx.storage.sql.exec(
      "INSERT INTO turns (role, content, created_at) VALUES (?, ?, ?)",
      role,
      content.slice(0, 2000),
      Date.now(),
    );
    const count = this.ctx.storage.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM turns").one().c;
    if (count > MAX_TURNS) {
      this.ctx.storage.sql.exec(
        "DELETE FROM turns WHERE id IN (SELECT id FROM turns ORDER BY id ASC LIMIT ?)",
        count - MAX_TURNS,
      );
    }
  }

  private checkAndHit(kind: "inbound" | "outbound"): { allowed: boolean; remaining: number; retryAfterSec: number } {
    const now = Date.now();
    const windowMs = kind === "inbound" ? INBOUND_WINDOW_MS : OUTBOUND_WINDOW_MS;
    const limit = kind === "inbound" ? INBOUND_LIMIT : OUTBOUND_LIMIT;
    const cutoff = now - windowMs;

    this.ctx.storage.sql.exec("DELETE FROM hits WHERE created_at < ?", cutoff);
    const used = this.ctx.storage.sql
      .exec<{ c: number }>("SELECT COUNT(*) AS c FROM hits WHERE kind = ? AND created_at >= ?", kind, cutoff)
      .one().c;

    if (used >= limit) {
      const oldest = this.ctx.storage.sql
        .exec<{ created_at: number }>(
          "SELECT created_at FROM hits WHERE kind = ? ORDER BY created_at ASC LIMIT 1",
          kind,
        )
        .one();
      const retryAfterSec = oldest ? Math.max(1, Math.ceil((oldest.created_at + windowMs - now) / 1000)) : 60;
      return { allowed: false, remaining: 0, retryAfterSec };
    }

    this.ctx.storage.sql.exec("INSERT INTO hits (kind, created_at) VALUES (?, ?)", kind, now);
    return { allowed: true, remaining: limit - used - 1, retryAfterSec: 0 };
  }
}

export async function conversationStub(env: Bindings, phone: string) {
  const id = env.CONVERSATION.idFromName(phone);
  return env.CONVERSATION.get(id);
}

export async function getHistory(env: Bindings, phone: string): Promise<ChatMessage[]> {
  const stub = await conversationStub(env, phone);
  const res = await stub.fetch("https://do/history");
  const json = (await res.json()) as { messages: ChatMessage[] };
  return json.messages ?? [];
}

export async function appendTurn(
  env: Bindings,
  phone: string,
  role: ChatMessage["role"],
  content: string,
): Promise<ChatMessage[]> {
  const stub = await conversationStub(env, phone);
  const res = await stub.fetch("https://do/append", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, content }),
  });
  const json = (await res.json()) as { messages: ChatMessage[] };
  return json.messages ?? [];
}

export async function consumeRateLimit(
  env: Bindings,
  phone: string,
  kind: "inbound" | "outbound",
): Promise<{ allowed: boolean; remaining: number; retryAfterSec: number }> {
  const stub = await conversationStub(env, phone);
  const res = await stub.fetch("https://do/rate-limit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind }),
  });
  return (await res.json()) as { allowed: boolean; remaining: number; retryAfterSec: number };
}
