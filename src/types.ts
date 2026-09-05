export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface SessionUser {
  provider: "github" | "access" | "password";
  id: string;
  login: string;
  name: string;
  email: string;
  avatar: string;
  exp: number;
}

export interface MessageRow {
  id: string;
  twilio_sid: string | null;
  direction: "inbound" | "outbound";
  from_number: string;
  to_number: string;
  body: string;
  status: string;
  source: "inbound" | "dashboard" | "auto-reply";
  error_code: string | null;
  created_at: number;
  updated_at: number;
}

export interface ConversationRow {
  phone: string;
  last_direction: string | null;
  last_preview: string | null;
  last_status: string | null;
  last_message_at: number;
  message_count: number;
}

export type Bindings = {
  AI: Ai;
  DB: D1Database;
  CONVERSATION: DurableObjectNamespace;
  ASSETS: { fetch: (request: Request) => Promise<Response> };

  APP_NAME: string;
  APP_BRAND: string;
  PUBLIC_BASE_URL: string;

  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_PHONE_NUMBER: string;
  TWILIO_WEBHOOK_URL?: string;

  SESSION_SECRET: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  ALLOWED_USERS?: string;
  DASHBOARD_USER?: string;
  DASHBOARD_PASSWORD?: string;
};

export type AppVariables = {
  user: SessionUser;
};
