import type { Bindings, ConversationRow, MessageRow } from "../types";
import { preview } from "./sms";
import { randomId } from "./crypto";

export async function insertMessage(
  db: D1Database,
  row: Omit<MessageRow, "updated_at"> & { updated_at?: number },
): Promise<void> {
  const now = row.updated_at ?? row.created_at;
  await db
    .prepare(
      `INSERT INTO messages
        (id, twilio_sid, direction, from_number, to_number, body, status, source, error_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.twilio_sid,
      row.direction,
      row.from_number,
      row.to_number,
      row.body,
      row.status,
      row.source,
      row.error_code,
      row.created_at,
      now,
    )
    .run();
}

export async function updateMessageStatus(
  db: D1Database,
  twilioSid: string,
  status: string,
  errorCode?: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE messages
       SET status = ?, error_code = COALESCE(?, error_code), updated_at = ?
       WHERE twilio_sid = ?`,
    )
    .bind(status, errorCode ?? null, Date.now(), twilioSid)
    .run();
}

export async function upsertConversation(
  db: D1Database,
  phone: string,
  patch: {
    last_direction: string;
    last_preview: string;
    last_status: string;
    last_message_at: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO conversations (phone, last_direction, last_preview, last_status, last_message_at, message_count)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(phone) DO UPDATE SET
         last_direction = excluded.last_direction,
         last_preview = excluded.last_preview,
         last_status = excluded.last_status,
         last_message_at = excluded.last_message_at,
         message_count = conversations.message_count + 1`,
    )
    .bind(phone, patch.last_direction, preview(patch.last_preview), patch.last_status, patch.last_message_at)
    .run();
}

export async function listConversations(db: D1Database, limit = 50): Promise<ConversationRow[]> {
  const res = await db
    .prepare(
      `SELECT phone, last_direction, last_preview, last_status, last_message_at, message_count
       FROM conversations
       ORDER BY last_message_at DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<ConversationRow>();
  return res.results ?? [];
}

export async function listMessages(
  db: D1Database,
  opts: { phone?: string; limit?: number },
): Promise<MessageRow[]> {
  const limit = Math.min(opts.limit ?? 100, 200);
  if (opts.phone) {
    const res = await db
      .prepare(
        `SELECT * FROM messages
         WHERE from_number = ? OR to_number = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .bind(opts.phone, opts.phone, limit)
      .all<MessageRow>();
    return res.results ?? [];
  }
  const res = await db
    .prepare(`SELECT * FROM messages ORDER BY created_at DESC LIMIT ?`)
    .bind(limit)
    .all<MessageRow>();
  return res.results ?? [];
}

export async function writeAudit(db: D1Database, actor: string, action: string, detail: string) {
  await db
    .prepare(`INSERT INTO audit_log (id, actor, action, detail, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(randomId("aud"), actor, action, detail, Date.now())
    .run();
}

export async function stats(db: D1Database) {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM messages) AS total,
         (SELECT COUNT(*) FROM messages WHERE direction = 'inbound') AS inbound,
         (SELECT COUNT(*) FROM messages WHERE direction = 'outbound') AS outbound,
         (SELECT COUNT(*) FROM conversations) AS threads,
         (SELECT COUNT(*) FROM messages WHERE created_at > ?) AS last_24h`,
    )
    .bind(Date.now() - 86_400_000)
    .first<{
      total: number;
      inbound: number;
      outbound: number;
      threads: number;
      last_24h: number;
    }>();
  return row ?? { total: 0, inbound: 0, outbound: 0, threads: 0, last_24h: 0 };
}

export function peerPhone(ourNumber: string, from: string, to: string): string {
  return from === ourNumber ? to : from;
}

export async function recordExchange(
  env: Bindings,
  input: {
    id: string;
    twilioSid: string | null;
    direction: "inbound" | "outbound";
    from: string;
    to: string;
    body: string;
    status: string;
    source: "inbound" | "dashboard" | "auto-reply";
    errorCode?: string | null;
  },
) {
  const now = Date.now();
  await insertMessage(env.DB, {
    id: input.id,
    twilio_sid: input.twilioSid,
    direction: input.direction,
    from_number: input.from,
    to_number: input.to,
    body: input.body,
    status: input.status,
    source: input.source,
    error_code: input.errorCode ?? null,
    created_at: now,
    updated_at: now,
  });
  await upsertConversation(env.DB, peerPhone(env.TWILIO_PHONE_NUMBER, input.from, input.to), {
    last_direction: input.direction,
    last_preview: input.body,
    last_status: input.status,
    last_message_at: now,
  });
}
