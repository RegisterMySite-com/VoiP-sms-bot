const root = document.getElementById("root");

const state = {
  user: null,
  config: null,
  stats: { total: 0, inbound: 0, outbound: 0, threads: 0, last_24h: 0 },
  conversations: [],
  messages: [],
  activePhone: null,
  to: "",
  body: "",
  filter: "",
  error: "",
  sending: false,
  loading: true,
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
}

function fmtTime(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderLogin() {
  const github = state.config?.githubOAuth;
  const password = state.config?.passwordLogin;
  root.innerHTML = `
    <div class="login">
      <div class="card">
        <div class="brand" style="margin-bottom:18px">
          <div class="mark">SB</div>
          <div>
            <h1>SMS Bot</h1>
            <p>by registermysite.com</p>
          </div>
        </div>
        <p class="lead">Sign in to send SMS from your Twilio number and monitor the Workers AI auto-responder.</p>
        <div class="stack">
          ${
            github
              ? `<a class="primary" style="display:block;text-align:center;text-decoration:none" href="/auth/github">Continue with GitHub</a>`
              : `<p class="hint">GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.</p>`
          }
          ${
            password
              ? `<div class="divider">or password</div>
                 <label>Username <input id="user" autocomplete="username" /></label>
                 <label>Password <input id="pass" type="password" autocomplete="current-password" /></label>
                 <button class="primary" id="pw">Sign in</button>`
              : ""
          }
          <p class="hint">Cloudflare Access sessions are accepted automatically when the dashboard sits behind Access.</p>
          <p class="error" id="login-error"></p>
        </div>
      </div>
    </div>
  `;
  document.getElementById("pw")?.addEventListener("click", async () => {
    const err = document.getElementById("login-error");
    try {
      await api("/auth/password", {
        method: "POST",
        body: JSON.stringify({
          username: document.getElementById("user").value,
          password: document.getElementById("pass").value,
        }),
      });
      await boot();
    } catch (e) {
      err.textContent = e.message;
    }
  });
}

function filteredConversations() {
  const q = state.filter.trim().toLowerCase();
  if (!q) return state.conversations;
  return state.conversations.filter((row) =>
    `${row.phone} ${row.last_preview || ""}`.toLowerCase().includes(q),
  );
}

function threadMessages() {
  if (!state.activePhone) return state.messages.slice().reverse();
  return state.messages
    .filter((m) => m.from_number === state.activePhone || m.to_number === state.activePhone)
    .slice()
    .reverse();
}

function renderApp() {
  const phone = state.config?.phoneNumber || "Not configured";
  const user = state.user;
  const threads = filteredConversations();
  const messages = threadMessages();

  root.innerHTML = `
    <div class="app">
      <header class="topbar">
        <div class="brand">
          <div class="mark">SB</div>
          <div>
            <h1>SMS Bot</h1>
            <p>by registermysite.com</p>
          </div>
        </div>
        <div class="top-meta">
          <span class="pill"><span class="dot"></span>${escapeHtml(phone)}</span>
          ${user.avatar ? `<img class="avatar" src="${escapeHtml(user.avatar)}" alt="" />` : `<span class="avatar"></span>`}
          <span>${escapeHtml(user.name || user.login)}</span>
          <button class="ghost" id="logout">Sign out</button>
        </div>
      </header>
      <div class="shell">
        <section class="col threads">
          <div class="col-head"><h2>Conversations</h2><span>${state.stats.threads}</span></div>
          <div class="stats">
            <div class="stat"><b>${state.stats.last_24h}</b><span>Last 24h</span></div>
            <div class="stat"><b>${state.stats.inbound}</b><span>Inbound</span></div>
            <div class="stat"><b>${state.stats.outbound}</b><span>Outbound</span></div>
          </div>
          <input class="search" id="filter" placeholder="Filter by number" value="${escapeHtml(state.filter)}" />
          <div class="list">
            ${
              threads.length
                ? threads
                    .map(
                      (row) => `
              <button class="thread ${row.phone === state.activePhone ? "active" : ""}" data-phone="${escapeHtml(row.phone)}">
                <div class="who">${escapeHtml(row.phone)}</div>
                <div class="preview">${escapeHtml(row.last_preview || "")}</div>
                <div class="meta"><span>${escapeHtml(row.last_status || "")} · ${escapeHtml(row.last_direction || "")}</span><span>${escapeHtml(fmtTime(row.last_message_at))}</span></div>
              </button>`,
                    )
                    .join("")
                : `<p class="hint" style="padding:12px">No conversations yet. Send a message or text the Twilio number.</p>`
            }
          </div>
        </section>
        <section class="col">
          <div class="col-head">
            <h2>${state.activePhone ? escapeHtml(state.activePhone) : "Message history"}</h2>
            ${state.activePhone ? `<button class="ghost" id="clear-phone">All threads</button>` : ""}
          </div>
          <div class="timeline">
            ${
              messages.length
                ? messages
                    .map((m) => {
                      const outbound = m.direction === "outbound";
                      return `
                  <article class="bubble ${outbound ? "out" : "in"}">
                    <div class="body">${escapeHtml(m.body)}</div>
                    <div class="foot">
                      <span>${outbound ? "You" : escapeHtml(m.from_number)} · ${escapeHtml(m.source)}</span>
                      <span class="status ${escapeHtml(m.status)}">${escapeHtml(m.status)}</span>
                      <span>${escapeHtml(fmtTime(m.created_at))}</span>
                    </div>
                  </article>`;
                    })
                    .join("")
                : `<div class="empty"><h3>Waiting for traffic</h3><p>Inbound texts hit /webhooks/twilio/sms, get an LLM reply, and show up here with delivery status.</p></div>`
            }
          </div>
        </section>
        <section class="col composer-col">
          <div class="col-head"><h2>Send SMS</h2></div>
          <form class="composer" id="send-form">
            <label>To
              <input id="to" name="to" placeholder="+15551234567" value="${escapeHtml(state.to)}" />
            </label>
            <label>Message
              <textarea id="body" name="body" maxlength="1600" placeholder="Keep it short. This is SMS.">${escapeHtml(state.body)}</textarea>
            </label>
            <button class="primary" ${state.sending ? "disabled" : ""}>${state.sending ? "Sending…" : "Send message"}</button>
            <p class="error">${escapeHtml(state.error)}</p>
            <p class="hint">Outbound sends are rate-limited. Status updates arrive on the Twilio status callback.</p>
          </form>
          <div class="col-head"><h2>Auto-responder prompt</h2></div>
          <pre class="prompt-box">${escapeHtml(state.config?.systemPrompt || "")}</pre>
          <p class="hint" style="padding:0 16px 20px">Edit SYSTEM_PROMPT in src/lib/ai.ts, then redeploy. Model: ${escapeHtml(state.config?.modelId || "")}</p>
        </section>
      </div>
    </div>
  `;

  document.getElementById("logout").onclick = async () => {
    await fetch("/auth/logout", { method: "POST", credentials: "include" });
    state.user = null;
    render();
  };
  document.getElementById("filter").oninput = (e) => {
    state.filter = e.target.value;
    renderApp();
  };
  document.getElementById("clear-phone")?.addEventListener("click", async () => {
    state.activePhone = null;
    state.to = "";
    await refreshMessages();
    renderApp();
  });
  document.querySelectorAll(".thread").forEach((el) => {
    el.addEventListener("click", async () => {
      state.activePhone = el.dataset.phone;
      state.to = el.dataset.phone;
      await refreshMessages();
      renderApp();
    });
  });
  document.getElementById("send-form").onsubmit = onSend;
  document.getElementById("to").oninput = (e) => {
    state.to = e.target.value;
  };
  document.getElementById("body").oninput = (e) => {
    state.body = e.target.value;
  };
}

async function onSend(event) {
  event.preventDefault();
  state.error = "";
  state.sending = true;
  renderApp();
  try {
    await api("/api/send", {
      method: "POST",
      body: JSON.stringify({ to: state.to, body: state.body }),
    });
    state.body = "";
    state.activePhone = state.to;
    await Promise.all([refreshConversations(), refreshMessages(), refreshStats()]);
  } catch (e) {
    state.error = e.message;
  } finally {
    state.sending = false;
    renderApp();
  }
}

function render() {
  if (state.loading) {
    root.innerHTML = `<div class="login"><div class="card"><p>Loading SMS Bot…</p></div></div>`;
    return;
  }
  if (!state.user) {
    renderLogin();
    return;
  }
  renderApp();
}

async function refreshConversations() {
  const data = await api("/api/conversations");
  state.conversations = data.conversations || [];
}

async function refreshMessages() {
  const qs = state.activePhone ? `?phone=${encodeURIComponent(state.activePhone)}` : "";
  const data = await api(`/api/messages${qs}`);
  state.messages = data.messages || [];
}

async function refreshStats() {
  state.stats = await api("/api/stats");
}

async function boot() {
  state.loading = true;
  render();
  try {
    const publicCfg = await fetch("/api/health", { credentials: "include" }).then((r) => r.json());
    state.config = publicCfg;

    const me = await fetch("/auth/me", { credentials: "include" });
    if (me.ok) state.user = (await me.json()).user;

    if (state.user) {
      const [config] = await Promise.all([
        api("/api/config"),
        refreshConversations(),
        refreshMessages(),
        refreshStats(),
      ]);
      state.config = { ...publicCfg, ...config };
    }
  } catch (err) {
    console.error(err);
  } finally {
    state.loading = false;
    render();
  }
}

boot();
setInterval(() => {
  if (!state.user) return;
  Promise.all([refreshConversations(), refreshMessages(), refreshStats()])
    .then(() => renderApp())
    .catch(() => {});
}, 12_000);
