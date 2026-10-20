(() => {
  "use strict";
  const cfg = window.POLLPE_CONFIG || {};
  const base = String(cfg.url || "").replace(/\/$/, "");
  const key = cfg.key || "";
  const $ = (id) => document.getElementById(id);
  const els = [
    "authView",
    "authForm",
    "authEmail",
    "authPassword",
    "authSubmit",
    "authStatus",
    "appView",
    "settingsView",
    "globalStatus",
    "connectionStatus",
    "lastSynced",
    "messageCount",
    "unknownCount",
    "identityStatus",
    "headerDot",
    "headerIdentity",
    "logoutButton",
    "refreshButton",
    "syncButton",
    "searchInput",
    "sourceFilter",
    "fromFilter",
    "toFilter",
    "unknownFilter",
    "clearFilters",
    "settingsButton",
    "messageList",
    "listStatus",
    "listSummary",
    "previousButton",
    "nextButton",
    "pageLabel",
    "closeSettings",
    "connectButton",
    "disconnectButton",
    "centralInboxCopy",
    "centralBadge",
    "sourceForm",
    "sourceEmail",
    "sourceList",
    "unknownList",
    "retryButton",
    "purgeButton",
    "settingsStatus",
    "errorList",
    "detailDialog",
    "closeDetail",
    "detailTitle",
    "detailMeta",
    "detailBody",
    "detailAttachments",
    "toast",
  ].reduce(
    (o, id) => (
      (o[id] = $(id.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()))),
      o
    ),
    {},
  );
  const state = {
    session: null,
    status: null,
    sources: [],
    messages: [],
    page: 1,
    pageSize: 25,
    hasMore: false,
    busy: false,
    detail: null,
  };
  const stored = sessionStorage.getItem("pollpe_inbox_session");
  if (stored) {
    try {
      state.session = JSON.parse(stored);
    } catch (_) {
      sessionStorage.removeItem("pollpe_inbox_session");
    }
  }
  const text = (v, fallback = "") => String(v ?? fallback);
  const formatDate = (value) => {
    const d = new Date(value);
    return Number.isNaN(d.getTime())
      ? "Unknown time"
      : new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(d);
  };
  const normalizeMessage = (m) => ({
    ...m,
    source_account_id: m.source_account_id ?? m.source_id,
    source_status:
      m.source_status ??
      (m.source_identity_status === "manual_unverified"
        ? "manual"
        : m.source_identity_status),
    original_sender: m.original_sender ?? m.original_from,
  });
  const normalizeSource = (s) => ({
    ...s,
    status: s.status ?? s.source_identity_status ?? "unknown",
  });
  const apiError = (data, status) => {
    const e =
      data && typeof data.error === "object" ? data.error.message : data?.error;
    return (
      e || data?.message || data?.msg || `Inbox request failed (${status}).`
    );
  };
  const esc = (value) => text(value).trim();
  function setStatus(node, message, kind = "") {
    if (!node) return;
    node.textContent = message || "";
    node.className = "inline-status" + (kind ? " " + kind : "");
  }
  function banner(message, kind = "") {
    els.globalStatus.textContent = message || "";
    els.globalStatus.className = "status-banner" + (kind ? " " + kind : "");
  }
  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => els.toast.classList.remove("show"), 3600);
  }
  function configured() {
    return Boolean(base && key);
  }
  function saveSession() {
    if (state.session)
      sessionStorage.setItem(
        "pollpe_inbox_session",
        JSON.stringify(state.session),
      );
    else sessionStorage.removeItem("pollpe_inbox_session");
  }
  function authHeaders() {
    return {
      apikey: key,
      Authorization: `Bearer ${state.session.access_token}`,
      "Content-Type": "application/json",
    };
  }
  async function auth(path, body) {
    if (!configured())
      throw new Error(
        "Add the Supabase URL and publishable key to config.js before signing in.",
      );
    const r = await fetch(`${base}/auth/v1/${path}`, {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok)
      throw new Error(
        data.error_description ||
          data.msg ||
          data.message ||
          `Sign-in failed (${r.status}).`,
      );
    return data;
  }
  async function refreshSession() {
    if (!state.session?.refresh_token) return false;
    const previous = state.session;
    try {
      const data = await auth("token?grant_type=refresh_token", {
        refresh_token: state.session.refresh_token,
      });
      if (state.session !== previous) return false;
      state.session = data;
      saveSession();
      return true;
    } catch (_) {
      state.session = null;
      saveSession();
      return false;
    }
  }
  async function api(action, payload = {}, retried = false) {
    if (!state.session?.access_token) throw new Error("Please sign in again.");
    if (!configured()) throw new Error("Supabase is not configured.");
    const session = state.session;
    const r = await fetch(`${base}/functions/v1/protected-inbox`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ action, ...payload }),
    });
    const data = await r.json().catch(() => ({}));
    if (
      !state.session ||
      (state.session !== session && state.session.user?.id !== session.user?.id)
    )
      throw new Error("Please sign in again.");
    if (r.status === 401 && !retried && (await refreshSession()))
      return api(action, payload, true);
    if (r.status === 401) {
      showAuth();
      throw new Error("Your session expired. Please sign in again.");
    }
    if (!r.ok) throw new Error(apiError(data, r.status));
    return data;
  }
  function showApp() {
    els.authView.hidden = true;
    els.appView.hidden = false;
    els.logoutButton.hidden = false;
    els.headerIdentity.textContent =
      state.session?.user?.email || "Protected inbox";
  }
  function showAuth() {
    state.session = null;
    state.messages = [];
    state.sources = [];
    state.status = null;
    state.detail = null;
    state.page = 1;
    state.hasMore = false;
    state.request = (state.request || 0) + 1;
    saveSession();
    els.authPassword.value = "";
    els.detailDialog.close();
    [
      els.messageList,
      els.sourceList,
      els.unknownList,
      els.errorList,
      els.detailMeta,
      els.detailBody,
      els.detailAttachments,
    ].forEach((node) => node.replaceChildren());
    els.authView.hidden = false;
    els.appView.hidden = true;
    els.settingsView.hidden = true;
    els.logoutButton.hidden = true;
    els.headerIdentity.textContent = "Protected inbox";
  }
  function statusLabel(status) {
    return status === "verified"
      ? "Verified"
      : status === "manual"
        ? "Manual label"
        : "Unknown";
  }
  function badge(status) {
    const b = document.createElement("span");
    b.className = `badge badge-${status || "muted"}`;
    b.textContent = statusLabel(status);
    return b;
  }
  function renderConnection() {
    const c = state.status?.connection;
    const configuredBackend = state.status?.configured !== false;
    els.connectionStatus.textContent =
      c?.status === "connected"
        ? "Connected"
        : configuredBackend
          ? "Not connected"
          : "Setup required";
    els.lastSynced.textContent = c?.last_synced_at
      ? `Last sync ${formatDate(c.last_synced_at)}`
      : "No sync recorded";
    els.headerDot.className =
      "connection-dot " + (c?.status === "connected" ? "online" : "offline");
    els.centralInboxCopy.textContent = c?.email
      ? `${c.email} · ${c.status || "connected"}`
      : "Not connected. Connect the central Gmail inbox through the secure server flow.";
    els.centralBadge.textContent =
      c?.status === "connected" ? "Connected" : "Not connected";
    els.centralBadge.className = `badge ${c?.status === "connected" ? "badge-verified" : "badge-muted"}`;
    els.connectButton.hidden = c?.status === "connected";
    els.disconnectButton.hidden = !c || c.status !== "connected";
  }
  async function loadStatus() {
    const data = await api("status");
    state.status = data;
    state.sources = (data.sources || []).map(normalizeSource);
    renderConnection();
    renderSources();
    renderErrors();
  }
  function sourceName(id) {
    return state.sources.find((s) => String(s.id) === String(id));
  }
  function renderErrors() {
    const errors = state.status?.errors || [];
    els.errorList.replaceChildren();
    if (!errors.length) return;
    const heading = document.createElement("p");
    heading.className = "error-heading";
    heading.textContent = `${errors.length} processing error${errors.length === 1 ? "" : "s"}`;
    els.errorList.append(heading);
    errors.forEach((err) => {
      const row = document.createElement("div");
      row.className = "source-row error-row";
      const copy = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = err.message || err.code || "Import error";
      const small = document.createElement("small");
      small.textContent = err.id
        ? `Error ${err.id}`
        : "Temporary import failure";
      copy.append(strong, small);
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "quiet-button";
      retry.textContent = "Retry";
      retry.addEventListener("click", () =>
        runAction("retry", { id: err.id }, "Retry requested."),
      );
      row.append(copy, retry);
      els.errorList.append(row);
    });
  }
  function renderSources() {
    const current = els.sourceFilter.value;
    els.sourceFilter.replaceChildren();
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "All sources";
    els.sourceFilter.append(all);
    state.sources.forEach((s) => {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = s.email;
      els.sourceFilter.append(o);
    });
    els.sourceFilter.value = current;
    els.sourceList.replaceChildren();
    if (!state.sources.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "No source routes registered yet.";
      els.sourceList.append(p);
      return;
    }
    state.sources.forEach((s) => {
      const row = document.createElement("div");
      row.className = "source-row";
      const copy = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = s.email;
      const small = document.createElement("small");
      small.textContent = `${s.route_address || "Route not assigned"} · ${statusLabel(s.status)}`;
      copy.append(strong, small);
      const actions = document.createElement("div");
      if (s.status !== "verified") {
        const verify = document.createElement("button");
        verify.type = "button";
        verify.className = "quiet-button";
        verify.textContent = "Verify test";
        verify.addEventListener("click", () => verifySource(s));
        actions.append(verify);
      }
      row.append(copy, badge(s.status), actions);
      els.sourceList.append(row);
    });
  }
  function renderUnknowns() {
    els.unknownList.replaceChildren();
    const rows = state.messages.filter(
      (m) => (m.source_status || "unknown") === "unknown",
    );
    if (!rows.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "No unknown messages on this page.";
      els.unknownList.append(p);
      return;
    }
    rows.forEach((m) => {
      const row = document.createElement("div");
      row.className = "source-row";
      const copy = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = m.subject || "(No subject)";
      const small = document.createElement("small");
      small.textContent = `${formatDate(m.received_at)} · ${m.original_sender || "Sender unavailable"}`;
      copy.append(strong, small);
      const select = document.createElement("select");
      select.setAttribute(
        "aria-label",
        "Choose a registered source for this message",
      );
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "Choose source";
      select.append(empty);
      state.sources.forEach((s) => {
        const o = document.createElement("option");
        o.value = s.id;
        o.textContent = s.email;
        select.append(o);
      });
      const button = document.createElement("button");
      button.type = "button";
      button.className = "quiet-button";
      button.textContent = "Apply manual label";
      button.addEventListener("click", () => {
        if (select.value)
          runAction(
            "resolve",
            { message_id: m.id, source_id: select.value },
            "Manual label applied.",
          );
      });
      row.append(copy, select, button);
      els.unknownList.append(row);
    });
  }
  function renderMessages() {
    els.messageList.replaceChildren();
    const rows = state.messages || [];
    els.messageCount.textContent = rows.length ? String(rows.length) : "0";
    const unknown = rows.filter(
      (m) => (m.source_status || "unknown") === "unknown",
    ).length;
    els.unknownCount.textContent = unknown
      ? `${unknown} unknown route${unknown === 1 ? "" : "s"} need review`
      : "No unknown routes in this page";
    els.listSummary.textContent = rows.length ? `${rows.length} shown` : "";
    if (!rows.length) {
      els.listStatus.hidden = false;
      els.listStatus.replaceChildren();
      const strong = document.createElement("strong");
      strong.textContent = "No protected messages match these filters.";
      const p = document.createElement("p");
      p.textContent = state.status?.connection
        ? "Try clearing filters or sync the central inbox."
        : "Connect the central inbox in Settings to begin importing.";
      els.listStatus.append(strong, p);
    } else {
      els.listStatus.hidden = true;
      rows.forEach(renderCard);
    }
    renderUnknowns();
    els.pageLabel.textContent = `Page ${state.page}`;
    els.previousButton.disabled = state.page <= 1 || state.busy;
    els.nextButton.disabled = !state.hasMore || state.busy;
  }
  function renderCard(m) {
    const article = document.createElement("article");
    article.className = `message-card ${m.is_read ? "" : "unread"}`;
    article.tabIndex = 0;
    article.addEventListener("click", () => openDetail(m));
    article.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openDetail(m);
      }
    });
    const top = document.createElement("div");
    top.className = "message-top";
    const status = badge(m.source_status || "unknown");
    const date = document.createElement("time");
    date.dateTime = text(m.received_at);
    date.textContent = formatDate(m.received_at);
    top.append(status, date);
    const route = document.createElement("div");
    route.className = "identity-line";
    const routeLabel = document.createElement("span");
    routeLabel.className = "field-label";
    routeLabel.textContent = "Forwarded from";
    const routeValue = document.createElement("strong");
    routeValue.textContent =
      m.source_status === "verified"
        ? sourceName(m.source_account_id)?.email || "Verified source"
        : m.source_status === "manual"
          ? sourceName(m.source_account_id)?.email || "Manual source"
          : "Unknown forwarding account";
    route.append(routeLabel, routeValue);
    const original = document.createElement("div");
    original.className = "identity-line original";
    const originalLabel = document.createElement("span");
    originalLabel.className = "field-label";
    originalLabel.textContent = "Original sender";
    const originalValue = document.createElement("span");
    originalValue.textContent = esc(m.original_sender) || "Sender unavailable";
    original.append(originalLabel, originalValue);
    const subject = document.createElement("h3");
    subject.textContent = esc(m.subject) || "(No subject)";
    const snippet = document.createElement("p");
    snippet.className = "snippet";
    snippet.textContent = esc(m.snippet || m.text_body).slice(0, 220);
    const foot = document.createElement("div");
    foot.className = "message-foot";
    const read = document.createElement("span");
    read.textContent = m.is_read ? "Read" : "Unread";
    const att = document.createElement("span");
    if (Array.isArray(m.attachments) && m.attachments.length)
      att.textContent = `⌑ ${m.attachments.length} attachment${m.attachments.length === 1 ? "" : "s"}`;
    foot.append(read, att);
    article.append(top, route, original, subject, snippet, foot);
    els.messageList.append(article);
  }
  async function loadMessages() {
    if (!state.session) return;
    const request = (state.request = (state.request || 0) + 1);
    state.busy = true;
    renderMessages();
    els.listStatus.hidden = true;
    const q = {
      query: els.searchInput.value.trim(),
      source_id: els.sourceFilter.value || undefined,
      from: els.fromFilter.value || undefined,
      to: els.toFilter.value
        ? `${els.toFilter.value}T23:59:59.999Z`
        : undefined,
      unknown: els.unknownFilter.value || undefined,
      page: state.page - 1,
      limit: state.pageSize,
    };
    try {
      const data = await api("list", q);
      if (request !== state.request || !state.session) return;
      state.messages = (data.messages || []).map(normalizeMessage);
      state.hasMore = Boolean(data.has_more);
      renderMessages();
    } catch (e) {
      if (request !== state.request) return;
      if (e.message.includes("sign in")) {
        showAuth();
      }
      banner(e.message, "error");
      state.messages = [];
      state.hasMore = false;
      renderMessages();
    } finally {
      if (request === state.request && state.session) {
        state.busy = false;
        renderMessages();
      }
    }
  }
  async function openDetail(m) {
    try {
      const detail = await api("detail", { id: m.id });
      m = normalizeMessage(detail.message || detail);
    } catch (e) {
      toast(e.message);
      return;
    }
    if (!state.session) return;
    state.detail = m;
    els.detailTitle.textContent = esc(m.subject) || "(No subject)";
    els.detailMeta.replaceChildren();
    const lines = [
      [
        "Forwarded from",
        m.source_status === "unknown"
          ? "Unknown forwarding account"
          : sourceName(m.source_account_id)?.email || "Verified source",
      ],
      ["Original sender", esc(m.original_sender) || "Unavailable"],
      ["Received", formatDate(m.received_at)],
      ["Source status", statusLabel(m.source_status || "unknown")],
      ["Gmail message ID", m.gmail_message_id || "Unavailable"],
    ];
    lines.forEach(([label, value]) => {
      const p = document.createElement("p");
      const strong = document.createElement("strong");
      strong.textContent = `${label}: `;
      p.append(strong, document.createTextNode(value));
      els.detailMeta.append(p);
    });
    els.detailBody.replaceChildren();
    const body = document.createElement("pre");
    body.className = "safe-body";
    body.textContent = esc(m.text_body) || "No plain-text body was supplied.";
    els.detailBody.append(body);
    els.detailAttachments.replaceChildren();
    if (m.attachments?.length) {
      const h = document.createElement("h3");
      h.textContent = "Attachments";
      els.detailAttachments.append(h);
      m.attachments.forEach((a) => {
        const p = document.createElement("p");
        p.textContent = `${a.filename || "Attachment"} · ${a.mimeType || "file"} · ${a.size || "size unavailable"}`;
        els.detailAttachments.append(p);
      });
    }
    const controls = document.createElement("div");
    controls.className = "form-actions";
    const unread = document.createElement("button");
    unread.type = "button";
    unread.className = "secondary-button";
    unread.textContent = "Mark unread";
    unread.addEventListener("click", async () => {
      await runAction(
        "read",
        { id: m.id, is_read: false },
        "Marked unread in PollPe.",
      );
      els.detailDialog.close();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger-button";
    remove.textContent = "Delete imported copy";
    remove.addEventListener("click", async () => {
      if (
        !confirm(
          "Delete this imported copy? The original Gmail message is not changed.",
        )
      )
        return;
      await runAction("delete", { id: m.id }, "Imported copy deleted.");
      els.detailDialog.close();
    });
    controls.append(unread, remove);
    els.detailAttachments.append(controls);
    els.detailDialog.showModal();
    if (!m.is_read) {
      try {
        await api("read", { id: m.id, is_read: true });
        m.is_read = true;
        const card = state.messages.find((row) => row.id === m.id);
        if (card) card.is_read = true;
        renderMessages();
      } catch (_) {}
    }
  }
  async function verifySource(s) {
    const hint = s.verification_challenge
      ? `\n\nInclude this exact challenge in the test message body: ${s.verification_challenge}`
      : "";
    const messageId = window.prompt(
      `Send a test message to ${s.email} from another sender and forward it through the configured trusted bridge. Enter its Gmail message ID from the detail view.${hint}`,
    );
    if (!messageId) return;
    try {
      const result = await api("sources.verify", {
        id: s.id,
        message_id: messageId.trim(),
        attested: true,
      });
      toast(
        result.source?.status === "verified"
          ? "Signed source and test message verified."
          : "Route test recorded; source remains unverified without a trusted signed gateway.",
      );
      await loadStatus();
    } catch (e) {
      toast(e.message);
    }
  }
  async function connect() {
    try {
      const data = await api("connect", {
        url: `${location.origin}${location.pathname}`,
      });
      if (data.url) location.assign(data.url);
      else toast("The server did not return an authorization URL.");
    } catch (e) {
      setStatus(els.settingsStatus, e.message, "error");
    }
  }
  async function runAction(action, payload, success) {
    if (state.actionBusy) return;
    state.actionBusy = true;
    els.syncButton.disabled = true;
    els.retryButton.disabled = true;
    try {
      const result = await api(action, payload);
      if (result.revoked === false) {
        banner(
          "Disconnected locally, but Google revocation could not be confirmed. Remove this app in your Google Account third-party access settings.",
          "error",
        );
        toast(
          "Local access stopped. Please also revoke access in your Google Account.",
        );
      } else if (result.status === "error") {
        banner(
          "Synchronization failed. See processing errors in Settings; no failed batch was skipped.",
          "error",
        );
        toast("Synchronization failed; inspect errors before retrying.");
      } else if (result.status === "deferred") {
        toast(
          "A retry is waiting for its backoff period. Check Settings for details.",
        );
      } else if (result.status === "busy") {
        toast("Synchronization is already running.");
      } else {
        toast(
          result.has_more
            ? "Batch synchronized. More mail remains for subsequent runs."
            : success,
        );
      }
      await loadStatus();
      await loadMessages();
    } catch (e) {
      setStatus(els.settingsStatus, e.message, "error");
      banner(e.message, "error");
    } finally {
      state.actionBusy = false;
      els.syncButton.disabled = false;
      els.retryButton.disabled = false;
    }
  }
  function bind() {
    els.authForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      els.authSubmit.disabled = true;
      setStatus(els.authStatus, "Signing in…");
      try {
        state.session = await auth("token?grant_type=password", {
          email: els.authEmail.value.trim(),
          password: els.authPassword.value,
        });
        els.authPassword.value = "";
        saveSession();
        showApp();
        await loadStatus();
        await loadMessages();
      } catch (err) {
        setStatus(els.authStatus, err.message, "error");
      } finally {
        els.authSubmit.disabled = false;
      }
    });
    els.logoutButton.addEventListener("click", () => {
      const token = state.session?.access_token;
      if (token)
        fetch(`${base}/auth/v1/logout`, {
          method: "POST",
          headers: { apikey: key, Authorization: `Bearer ${token}` },
        }).catch(() => {});
      state.session = null;
      saveSession();
      showAuth();
    });
    els.refreshButton.addEventListener("click", () => {
      loadStatus()
        .then(loadMessages)
        .catch((e) => banner(e.message, "error"));
    });
    els.syncButton.addEventListener("click", () =>
      runAction("sync", {}, "Sync requested."),
    );
    els.settingsButton.addEventListener("click", () => {
      els.settingsView.hidden = false;
      els.settingsView.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    els.closeSettings.addEventListener("click", () => {
      els.settingsView.hidden = true;
    });
    els.connectButton.addEventListener("click", connect);
    els.disconnectButton.addEventListener("click", () => {
      if (
        confirm(
          "Disconnect the central inbox? Imported messages will remain until you purge them.",
        )
      )
        runAction("disconnect", {}, "Central inbox disconnected.");
    });
    els.retryButton.addEventListener("click", () =>
      runAction("retry", {}, "Retry requested."),
    );
    els.purgeButton.addEventListener("click", () => {
      if (
        confirm(
          "Permanently purge all imported messages and processing history? This cannot be undone.",
        )
      )
        runAction("purge", {}, "Imported mail purged.");
    });
    els.sourceForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api("sources.add", { email: els.sourceEmail.value.trim() });
        els.sourceEmail.value = "";
        setStatus(
          els.settingsStatus,
          "Source registered. Send a test message before verifying.",
          "success",
        );
        await loadStatus();
      } catch (err) {
        setStatus(els.settingsStatus, err.message, "error");
      }
    });
    [
      els.searchInput,
      els.sourceFilter,
      els.fromFilter,
      els.toFilter,
      els.unknownFilter,
    ].forEach((el) =>
      el.addEventListener(el === els.searchInput ? "input" : "change", () => {
        state.page = 1;
        loadMessages();
      }),
    );
    els.clearFilters.addEventListener("click", () => {
      [
        els.searchInput,
        els.sourceFilter,
        els.fromFilter,
        els.toFilter,
        els.unknownFilter,
      ].forEach((el, i) => {
        if (i === 0) el.value = "";
        else el.value = "";
      });
      state.page = 1;
      loadMessages();
    });
    els.previousButton.addEventListener("click", () => {
      if (state.page > 1) {
        state.page--;
        loadMessages();
      }
    });
    els.nextButton.addEventListener("click", () => {
      if (state.hasMore) {
        state.page++;
        loadMessages();
      }
    });
    els.closeDetail.addEventListener("click", () => els.detailDialog.close());
    els.detailDialog.addEventListener("click", (e) => {
      if (e.target === els.detailDialog) els.detailDialog.close();
    });
  }
  async function boot() {
    bind();
    setInterval(() => {
      if (
        state.session &&
        !document.hidden &&
        !state.busy &&
        !els.detailDialog.open
      )
        loadStatus()
          .then(loadMessages)
          .catch(() => {});
    }, 60000);
    if (!configured()) {
      setStatus(
        els.authStatus,
        "Setup required: add Supabase URL and publishable key to config.js.",
        "error",
      );
      return;
    }
    if (location.search || location.hash)
      history.replaceState({}, document.title, location.pathname);
    if (state.session) {
      showApp();
      try {
        await loadStatus();
        await loadMessages();
      } catch (e) {
        if (!(await refreshSession())) {
          showAuth();
          setStatus(
            els.authStatus,
            "Your session expired. Please sign in again.",
            "error",
          );
        }
      }
    }
  }
  boot();
})();
