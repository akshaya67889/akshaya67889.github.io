import { createClient } from "npm:@supabase/supabase-js@2";
import { convert } from "npm:html-to-text@9.0.5";
import {
  identifySource,
  verifyGatewayMarker,
  parseHeaders,
  parseAddress,
  normalizeBody,
  sha256,
  randomChallenge,
  retryDecision,
} from "./core.js";

type Any = Record<string, any>;
const env = (name: string, required = true) => {
  const value = Deno.env.get(name) || "";
  if (required && !value) throw new Error(`missing_${name}`);
  return value;
};
const SUPABASE_URL = env("SUPABASE_URL");
const service = createClient(SUPABASE_URL, env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anon = env("SUPABASE_ANON_KEY");
const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
const fail = (
  code: string,
  message: string,
  status = 400,
  headers: Record<string, string> = {},
) => json({ error: { code, message } }, status, headers);
function checked<T>(result: { data: T; error: any }): T {
  if (result.error) throw result.error;
  return result.data;
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function encryptionKey() {
  const raw = unb64(env("INBOX_TOKEN_ENCRYPTION_KEY"));
  if (raw.length !== 32) throw new Error("invalid_encryption_key");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}
async function encrypt(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(),
    new TextEncoder().encode(value),
  );
  return { ciphertext: b64(new Uint8Array(ciphertext)), nonce: b64(iv) };
}
async function decrypt(ciphertext: string, nonce: string) {
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(nonce) },
      await encryptionKey(),
      unb64(ciphertext),
    ),
  );
}
async function caller(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!/^Bearer\s+\S+$/i.test(auth))
    throw fail("unauthorized", "Sign in required", 401);
  const client = createClient(SUPABASE_URL, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await client.auth.getUser(auth.slice(7));
  if (error || !data.user) throw fail("unauthorized", "Sign in required", 401);
  return data.user.id;
}

async function gmailToken(refresh: string) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("GMAIL_CLIENT_ID"),
      client_secret: env("GMAIL_CLIENT_SECRET"),
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token)
    throw Object.assign(new Error("gmail_token_failed"), {
      status: response.status,
      detail: data.error,
    });
  return data.access_token as string;
}
async function gcall(
  token: string,
  path: string,
  init: RequestInit = {},
  deadline = Date.now() + 10000,
) {
  const remaining = Math.max(1, Math.min(10000, deadline - Date.now()));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
      {
        ...init,
        signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) },
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw Object.assign(new Error("gmail_api_failed"), {
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        detail: data.error?.errors?.[0]?.reason || data.error?.status,
      });
    return data;
  } finally {
    clearTimeout(timer);
  }
}
function decode(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return new TextDecoder().decode(
    Uint8Array.from(
      atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4)),
      (c) => c.charCodeAt(0),
    ),
  );
}
function bodyParts(part: Any, output: Any) {
  if (!part) return;
  const type = part.mimeType || "";
  if (part.body?.data && (type === "text/plain" || type === "text/html")) {
    const text = decode(part.body.data);
    if (type === "text/plain" && !output.text) output.text = text;
    if (type === "text/html" && !output.html) output.html = text;
  }
  if (part.filename)
    output.attachments.push({
      filename: String(part.filename).slice(0, 255),
      mimeType: type,
      size: Number(part.body?.size || 0),
    });
  for (const child of part.parts || []) bodyParts(child, output);
}
function safeText(body: Any) {
  if (body.text) return normalizeBody(body.text);
  if (body.html) return normalizeBody(convert(body.html, { wordwrap: false }));
  return "";
}

async function parsed(message: Any, owner: string, sources: Any[]) {
  const headers = parseHeaders(message.payload?.headers || []);
  const body: Any = { text: "", html: "", attachments: [] };
  bodyParts(message.payload, body);
  const text = safeText(body);
  const messageId =
    headers["message-id"]?.length === 1 ? headers["message-id"][0] : "";
  const outerFrom = parseAddress(headers.from?.[0] || "");
  const marker = await verifyGatewayMarker(
    message.payload?.headers || [],
    messageId,
    env("INBOX_GATEWAY_HMAC_SECRET", false),
    {
      internalDate: message.internalDate,
      subject: headers.subject?.[0] || "",
      bodySha256: await sha256(text),
    },
  );
  const identity = identifySource(
    message.payload?.headers || [],
    sources,
    messageId,
    marker,
  );
  const originalFrom = marker?.sender || outerFrom;
  const received =
    Number(message.internalDate) ||
    Date.parse(headers.date?.[0] || "") ||
    Date.now();
  return {
    owner_id: owner,
    gmail_message_id: message.id,
    gmail_thread_id: message.threadId || null,
    source_id: identity.sourceId,
    source_identity_status: identity.status,
    original_from: originalFrom,
    subject: normalizeBody(headers.subject?.[0] || "").slice(0, 1000),
    received_at: new Date(received).toISOString(),
    text_body: text.slice(0, 500000),
    html_body: null,
    attachments: body.attachments,
    headers: {
      "message-id": messageId ? [messageId] : [],
      "reply-to": (headers["reply-to"] || []).slice(0, 1),
    },
    is_read: !(message.labelIds || []).includes("UNREAD"),
    updated_at: new Date().toISOString(),
  };
}
async function connection(owner: string) {
  return checked(
    await service
      .from("inbox_connections")
      .select("*")
      .eq("owner_id", owner)
      .maybeSingle(),
  );
}
async function acquire(owner: string) {
  const data = checked(
    await service.rpc("inbox_acquire_sync_lock", {
      p_owner_id: owner,
      p_lease_seconds: 120,
    }),
  );
  return typeof data === "string" ? data : data?.token || null;
}
async function release(owner: string, token: string) {
  checked(
    await service.rpc("inbox_release_sync_lock", {
      p_owner_id: owner,
      p_lease_token: token,
    }),
  );
}
async function checkpoint(owner: string, token: string, values: Any) {
  const result = await service
    .from("inbox_sync_checkpoints")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("owner_id", owner)
    .eq("lease_token", token)
    .select("owner_id");
  if (result.error) throw result.error;
  if (!result.data?.length) throw new Error("sync_lease_lost");
}
async function recordError(
  owner: string,
  token: string,
  error: Any,
  attempt: number,
) {
  const decision = retryDecision(
    error?.status || 0,
    attempt,
    error?.retryAfter,
    error?.detail,
  );
  checked(
    await service.from("inbox_errors").insert({
      owner_id: owner,
      operation: "sync",
      code: String(error?.message || "sync_failed").slice(0, 100),
      message:
        "Gmail synchronization failed; retry is scheduled when applicable.",
      retryable: decision.retry,
      attempts: attempt,
    }),
  );
  await checkpoint(owner, token, {
    attempts: attempt,
    next_run_at: new Date(
      Date.now() + (decision.retry ? decision.delayMs : 31536000000),
    ).toISOString(),
    last_error_code: String(error?.message || "sync_failed").slice(0, 100),
  });
  return decision;
}
async function importMessage(
  token: string,
  owner: string,
  id: string,
  sources: Any[],
  deleted: Set<string>,
  deadline: number,
) {
  if (deleted.has(id)) return 0;
  let message: Any;
  try {
    message = await gcall(
      token,
      `messages/${encodeURIComponent(id)}?format=full`,
      {},
      deadline,
    );
  } catch (error: any) {
    if (error.status === 404) return 0;
    throw error;
  }
  const row = await parsed(message, owner, sources);
  const existing = checked(
    await service
      .from("inbox_messages")
      .select("is_read,source_id,source_identity_status")
      .eq("owner_id", owner)
      .eq("gmail_message_id", id)
      .maybeSingle(),
  ) as Any;
  if (existing) {
    row.is_read = Boolean(existing.is_read);
    if (
      existing.source_identity_status === "manual_unverified" &&
      row.source_identity_status === "unknown"
    ) {
      row.source_id = existing.source_id;
      row.source_identity_status = "manual_unverified";
    }
  }
  checked(
    await service.from("inbox_messages").upsert(row, {
      onConflict: "owner_id,gmail_message_id",
      ignoreDuplicates: false,
    }),
  );
  return 1;
}

async function sync(owner: string) {
  const conn = await connection(owner);
  if (!conn || conn.status === "disconnected") throw new Error("not_connected");
  let cp = checked(
    await service
      .from("inbox_sync_checkpoints")
      .select("*")
      .eq("owner_id", owner)
      .maybeSingle(),
  ) as Any;
  if (cp?.next_run_at && new Date(cp.next_run_at) > new Date())
    return {
      status: "deferred",
      imported: 0,
      has_more: true,
      next_run_at: cp.next_run_at,
    };
  const lease = await acquire(owner);
  if (!lease) return { status: "busy", imported: 0, has_more: true };
  const deadline = Date.now() + 90000;
  let imported = 0;
  try {
    cp = checked(
      await service
        .from("inbox_sync_checkpoints")
        .select("*")
        .eq("owner_id", owner)
        .maybeSingle(),
    ) as Any;
    const token = await gmailToken(
      await decrypt(conn.encrypted_refresh_token, conn.token_nonce),
    );
    const sources = (checked(
      await service
        .from("inbox_sources")
        .select("id,email,status,verification_method,verification_challenge")
        .eq("owner_id", owner),
    ) || []) as Any[];
    const mode = cp?.mode === "idle" ? "history" : cp?.mode || "backfill";
    if (mode === "history" && cp?.history_id) {
      const stableHistory = cp.history_id;
      let ids: string[] = cp.pending_ids || [];
      let nextPage = cp.pending_next_page || null;
      let targetHistory = cp.pending_history_id || stableHistory;
      if (!ids.length) {
        const page = await gcall(
          token,
          `history?startHistoryId=${encodeURIComponent(stableHistory)}&maxResults=25${cp.page_token ? `&pageToken=${encodeURIComponent(cp.page_token)}` : ""}`,
          {},
          deadline,
        );
        const changed = new Set<string>();
        const removed = new Set<string>();
        for (const event of page.history || []) {
          for (const item of [
            ...(event.messagesAdded || []),
            ...(event.labelsAdded || []),
            ...(event.labelsRemoved || []),
          ])
            if (item.message?.id) changed.add(item.message.id);
          for (const item of event.messagesDeleted || [])
            if (item.message?.id) removed.add(item.message.id);
        }
        for (const id of removed) {
          checked(
            await service
              .from("inbox_tombstones")
              .upsert(
                { owner_id: owner, gmail_message_id: id },
                { onConflict: "owner_id,gmail_message_id" },
              ),
          );
          checked(
            await service
              .from("inbox_messages")
              .delete()
              .eq("owner_id", owner)
              .eq("gmail_message_id", id),
          );
          changed.delete(id);
        }
        ids = [...changed];
        nextPage = page.nextPageToken || null;
        targetHistory = page.historyId || stableHistory;
      }
      const batch = ids.slice(0, 25),
        remaining = ids.slice(25);
      const dead = checked(
        await service
          .from("inbox_tombstones")
          .select("gmail_message_id")
          .eq("owner_id", owner)
          .in("gmail_message_id", batch.length ? batch : ["__none__"]),
      );
      const deleted = new Set(
        (dead || []).map((item: Any) => item.gmail_message_id),
      );
      for (const id of batch) {
        if (Date.now() > deadline) throw new Error("sync_deadline");
        imported += await importMessage(
          token,
          owner,
          id,
          sources,
          deleted,
          deadline,
        );
      }
      const hasMore = remaining.length > 0 || Boolean(nextPage);
      await checkpoint(owner, lease, {
        history_id: hasMore ? stableHistory : targetHistory,
        page_token: remaining.length ? cp.page_token : nextPage,
        pending_ids: remaining,
        pending_next_page: remaining.length ? nextPage : null,
        pending_history_id: remaining.length ? targetHistory : null,
        mode: hasMore ? "history" : "idle",
        attempts: 0,
        next_run_at: new Date().toISOString(),
        last_error_code: null,
      });
      checked(
        await service
          .from("inbox_connections")
          .update({
            last_synced_at: new Date().toISOString(),
            status: "connected",
            updated_at: new Date().toISOString(),
          })
          .eq("owner_id", owner),
      );
      return { status: "ok", imported, has_more: hasMore };
    }
    const page = await gcall(
      token,
      `messages?maxResults=25${cp?.page_token ? `&pageToken=${encodeURIComponent(cp.page_token)}` : ""}`,
      {},
      deadline,
    );
    const ids = (page.messages || []).slice(0, 25).map((item: Any) => item.id);
    const dead = checked(
      await service
        .from("inbox_tombstones")
        .select("gmail_message_id")
        .eq("owner_id", owner)
        .in("gmail_message_id", ids.length ? ids : ["__none__"]),
    );
    const deleted = new Set(
      (dead || []).map((item: Any) => item.gmail_message_id),
    );
    for (const id of ids) {
      if (Date.now() > deadline) throw new Error("sync_deadline");
      imported += await importMessage(
        token,
        owner,
        id,
        sources,
        deleted,
        deadline,
      );
    }
    const hasMore = Boolean(page.nextPageToken);
    await checkpoint(owner, lease, {
      page_token: page.nextPageToken || null,
      history_id: cp?.history_id || conn.history_id,
      mode: hasMore ? "backfill" : "history",
      attempts: 0,
      next_run_at: new Date().toISOString(),
      last_error_code: null,
    });
    checked(
      await service
        .from("inbox_connections")
        .update({
          last_synced_at: new Date().toISOString(),
          status: "connected",
          updated_at: new Date().toISOString(),
        })
        .eq("owner_id", owner),
    );
    return { status: "ok", imported, has_more: hasMore };
  } catch (error: any) {
    if (error.status === 404 && error.message === "gmail_api_failed") {
      const profile = await gcall(
        await gmailToken(
          await decrypt(conn.encrypted_refresh_token, conn.token_nonce),
        ),
        "profile",
      );
      await checkpoint(owner, lease, {
        mode: "backfill",
        history_id: profile.historyId,
        pending_ids: [],
        pending_next_page: null,
        pending_history_id: null,
        page_token: null,
        next_run_at: new Date().toISOString(),
      });
      return { status: "reset", imported, has_more: true };
    }
    if (error.status === 401 || error.detail === "invalid_grant")
      checked(
        await service
          .from("inbox_connections")
          .update({ status: "reauthorization_required" })
          .eq("owner_id", owner),
      );
    const attempt = Number(cp?.attempts || 0) + 1;
    const decision = await recordError(owner, lease, error, attempt);
    return {
      status: "error",
      imported,
      has_more: decision.retry,
      retry_in_ms: decision.delayMs,
    };
  } finally {
    await release(owner, lease);
  }
}

async function status(owner: string) {
  const [conn, sources, errors] = await Promise.all([
    connection(owner),
    service
      .from("inbox_sources")
      .select(
        "id,email,route_address,status,verification_challenge,verified_at",
      )
      .eq("owner_id", owner)
      .order("created_at"),
    service
      .from("inbox_errors")
      .select(
        "id,operation,code,message,retryable,attempts,created_at,resolved_at",
      )
      .eq("owner_id", owner)
      .is("resolved_at", null)
      .order("created_at", { ascending: false })
      .limit(25),
  ]);
  if (sources.error) throw sources.error;
  if (errors.error) throw errors.error;
  return {
    connection: conn
      ? {
          email: conn.gmail_email,
          status: conn.status,
          last_synced_at: conn.last_synced_at,
          updated_at: conn.updated_at,
        }
      : null,
    sources: sources.data || [],
    errors: errors.data || [],
    configured: Boolean(
      Deno.env.get("GMAIL_CLIENT_ID") &&
      Deno.env.get("GMAIL_CLIENT_SECRET") &&
      Deno.env.get("INBOX_TOKEN_ENCRYPTION_KEY") &&
      Deno.env.get("GMAIL_REDIRECT_URI") &&
      Deno.env.get("APP_ORIGIN"),
    ),
  };
}
async function beginConnect(owner: string) {
  const state = crypto.randomUUID() + crypto.randomUUID();
  checked(
    await service.from("inbox_oauth_states").insert({
      owner_id: owner,
      state_hash: await sha256(state),
      expires_at: new Date(Date.now() + 600000).toISOString(),
    }),
  );
  const params = new URLSearchParams({
    client_id: env("GMAIL_CLIENT_ID"),
    redirect_uri: env("GMAIL_REDIRECT_URI"),
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    state,
  });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` };
}
async function oauthCallback(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("action") !== "oauth.callback")
    return fail("invalid_oauth", "Callback action is required");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return fail("invalid_oauth", "Missing OAuth parameters");
  const stateResult = checked(
    await service.rpc("inbox_consume_oauth_state", {
      p_state_hash: await sha256(state),
    }),
  ) as Any;
  const stateRow = Array.isArray(stateResult) ? stateResult[0] : stateResult;
  if (!stateRow?.owner_id)
    return fail("invalid_oauth", "Expired or already-used state");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env("GMAIL_CLIENT_ID"),
      client_secret: env("GMAIL_CLIENT_SECRET"),
      redirect_uri: env("GMAIL_REDIRECT_URI"),
      grant_type: "authorization_code",
    }),
  });
  const token = await response.json().catch(() => ({}));
  if (
    !response.ok ||
    !token.refresh_token ||
    !String(token.scope || "")
      .split(" ")
      .includes("https://www.googleapis.com/auth/gmail.readonly")
  )
    return fail(
      "oauth_scope_invalid",
      "Google did not grant the required read-only Gmail scope.",
      502,
    );
  const profile = await gcall(token.access_token, "profile");
  const existing = await connection(stateRow.owner_id);
  const imported =
    existing && existing.gmail_email !== profile.emailAddress
      ? checked(
          await service
            .from("inbox_messages")
            .select("id")
            .eq("owner_id", stateRow.owner_id)
            .limit(1),
        )
      : [];
  if (
    existing &&
    existing.gmail_email !== profile.emailAddress &&
    (existing.status !== "disconnected" || (imported || []).length > 0)
  )
    return fail(
      "mailbox_change_requires_purge",
      "Disconnect and purge the previous mailbox before connecting another.",
      409,
    );
  const encrypted = await encrypt(token.refresh_token);
  checked(
    await service.from("inbox_connections").upsert(
      {
        owner_id: stateRow.owner_id,
        gmail_email: profile.emailAddress,
        encrypted_refresh_token: encrypted.ciphertext,
        token_nonce: encrypted.nonce,
        status: "connected",
        history_id: profile.historyId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "owner_id" },
    ),
  );
  checked(
    await service.from("inbox_sync_checkpoints").upsert(
      {
        owner_id: stateRow.owner_id,
        history_id: profile.historyId,
        mode: "backfill",
        page_token: null,
        next_run_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "owner_id" },
    ),
  );
  const appUrl =
    env("APP_URL", false) ||
    "https://akshaya67889.github.io/pollpe-daily/inbox.html";
  return new Response(null, {
    status: 303,
    headers: {
      location: `${appUrl}${appUrl.includes("?") ? "&" : "?"}gmail=connected`,
      "cache-control": "no-store",
    },
  });
}

function dto(message: Any) {
  return {
    ...message,
    source_account_id: message.source_id,
    source_status:
      message.source_identity_status === "manual_unverified"
        ? "manual"
        : message.source_identity_status,
    original_sender: message.original_from,
    snippet: normalizeBody(message.text_body || "").slice(0, 240),
  };
}
async function sourceVerify(owner: string, body: Any) {
  if (body.attested !== true || !body.message_id)
    throw new Error("test_message_and_attestation_required");
  const source = checked(
    await service
      .from("inbox_sources")
      .select("*")
      .eq("owner_id", owner)
      .eq("id", body.id || body.source_id)
      .single(),
  ) as Any;
  const conn = await connection(owner);
  if (!conn || conn.status === "disconnected") throw new Error("not_connected");
  const token = await gmailToken(
    await decrypt(conn.encrypted_refresh_token, conn.token_nonce),
  );
  const message = await gcall(
    token,
    `messages/${encodeURIComponent(String(body.message_id))}?format=full`,
  );
  const headers = parseHeaders(message.payload?.headers || []);
  const row = await parsed(message, owner, []);
  const marker = await verifyGatewayMarker(
    message.payload?.headers || [],
    headers["message-id"]?.length === 1 ? headers["message-id"][0] : "",
    env("INBOX_GATEWAY_HMAC_SECRET", false),
    {
      internalDate: message.internalDate,
      subject: headers.subject?.[0] || "",
      bodySha256: await sha256(row.text_body || ""),
    },
  );
  if (
    !marker ||
    marker.source !== String(source.email).toLowerCase() ||
    !String(row.text_body).includes(source.verification_challenge)
  )
    throw new Error("signed_source_challenge_not_verified");
  checked(
    await service
      .from("inbox_sources")
      .update({
        status: "verified",
        verification_method: "signed_gateway",
        verification_message_id: message.id,
        verified_at: new Date().toISOString(),
      })
      .eq("owner_id", owner)
      .eq("id", source.id),
  );
  const verified = {
    ...source,
    status: "verified",
    verification_method: "signed_gateway",
  };
  await importMessage(
    token,
    owner,
    message.id,
    [verified],
    new Set(),
    Date.now() + 10000,
  );
  return {
    verified: true,
    source: checked(
      await service
        .from("inbox_sources")
        .select(
          "id,email,route_address,status,verification_challenge,verified_at",
        )
        .eq("owner_id", owner)
        .eq("id", source.id)
        .single(),
    ),
  };
}
async function revokeConnection(owner: string) {
  const conn = await connection(owner);
  if (conn && conn.status !== "disconnected") {
    try {
      const refresh = await decrypt(
        conn.encrypted_refresh_token,
        conn.token_nonce,
      );
      const response = await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refresh }),
        signal: AbortSignal.timeout(10000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
  return true;
}

async function withMutationLock(owner: string, fn: () => Promise<Any>) {
  const token = await acquire(owner);
  if (!token)
    throw fail(
      "sync_busy",
      "Synchronization is running. Wait briefly and try again.",
      409,
    );
  try {
    return await fn();
  } finally {
    await release(owner, token);
  }
}
async function action(owner: string, body: Any) {
  switch (body.action) {
    case "status":
      return status(owner);
    case "connect":
      return beginConnect(owner);
    case "sync":
      return sync(owner);
    case "sources.add": {
      const email = parseAddress(body.email || "");
      if (!email) throw new Error("invalid_source_email");
      const conn = await connection(owner);
      if (!conn || conn.status === "disconnected")
        throw new Error("connect_central_inbox_first");
      const [local, domain] = String(conn.gmail_email).split("@");
      const route = `${local.split("+")[0]}+pollpe${randomChallenge().slice(0, 16)}@${domain}`;
      const challenge = randomChallenge();
      const row = checked(
        await service
          .from("inbox_sources")
          .insert({
            owner_id: owner,
            email,
            route_address: route,
            verification_challenge: challenge,
            status: "pending",
          })
          .select("id,email,route_address,status,verification_challenge")
          .single(),
      );
      return { source: row };
    }
    case "sources.verify":
      return sourceVerify(owner, body);
    case "retry": {
      checked(
        await service
          .from("inbox_sync_checkpoints")
          .update({ attempts: 0, next_run_at: new Date().toISOString() })
          .eq("owner_id", owner),
      );
      const result = await sync(owner);
      if (result.status === "ok") {
        let q = service
          .from("inbox_errors")
          .update({ resolved_at: new Date().toISOString() })
          .eq("owner_id", owner)
          .is("resolved_at", null);
        if (body.id) q = q.eq("id", body.id);
        checked(await q);
      }
      return result;
    }
    case "resolve": {
      if (!body.source_id || !body.message_id)
        throw new Error("source_and_message_required");
      checked(
        await service
          .from("inbox_sources")
          .select("id")
          .eq("owner_id", owner)
          .eq("id", body.source_id)
          .single(),
      );
      const result = checked(
        await service
          .from("inbox_messages")
          .update({
            source_id: body.source_id,
            source_identity_status: "manual_unverified",
            updated_at: new Date().toISOString(),
          })
          .eq("owner_id", owner)
          .eq("id", body.message_id)
          .select("id,source_id,source_identity_status")
          .single(),
      );
      return { message: result };
    }
    case "list": {
      let query = service
        .from("inbox_messages")
        .select(
          "id,gmail_message_id,gmail_thread_id,source_id,source_identity_status,original_from,subject,received_at,text_body,attachments,is_read",
          { count: "exact" },
        )
        .eq("owner_id", owner)
        .order("received_at", { ascending: false })
        .order("id", { ascending: false });
      if (body.source_id) query = query.eq("source_id", body.source_id);
      if (body.unknown === true || body.unknown === "unknown")
        query = query.eq("source_identity_status", "unknown");
      if (body.unknown === "verified")
        query = query.eq("source_identity_status", "verified");
      if (body.unknown === "manual")
        query = query.eq("source_identity_status", "manual_unverified");
      if (body.from) query = query.gte("received_at", body.from);
      if (body.to) query = query.lte("received_at", body.to);
      if (body.query) {
        const term = String(body.query)
          .replace(/[\\%_(),.]/g, " ")
          .trim()
          .slice(0, 100);
        if (term)
          query = query.or(
            `subject.ilike.*${term}*,original_from.ilike.*${term}*,text_body.ilike.*${term}*`,
          );
      }
      const page = Math.max(0, Number(body.page) || 0);
      const result = await query.range(page * 25, page * 25 + 24);
      if (result.error) throw result.error;
      return {
        messages: (result.data || []).map(dto),
        has_more: (result.count || 0) > (page + 1) * 25,
      };
    }
    case "detail": {
      const result = await service
        .from("inbox_messages")
        .select("*")
        .eq("owner_id", owner)
        .eq("id", body.id)
        .single();
      if (result.error) throw result.error;
      return { message: dto(result.data) };
    }
    case "read": {
      const result = await service
        .from("inbox_messages")
        .update({
          is_read: Boolean(body.is_read),
          updated_at: new Date().toISOString(),
        })
        .eq("owner_id", owner)
        .eq("id", body.id)
        .select("id,is_read")
        .single();
      if (result.error) throw result.error;
      return { message: result.data };
    }
    case "delete": {
      return withMutationLock(owner, async () => {
        const row = checked(
          await service
            .from("inbox_messages")
            .select("gmail_message_id")
            .eq("owner_id", owner)
            .eq("id", body.id)
            .single(),
        ) as Any;
        checked(
          await service
            .from("inbox_tombstones")
            .upsert(
              { owner_id: owner, gmail_message_id: row.gmail_message_id },
              { onConflict: "owner_id,gmail_message_id" },
            ),
        );
        checked(
          await service
            .from("inbox_messages")
            .delete()
            .eq("owner_id", owner)
            .eq("id", body.id),
        );
        return { deleted: true };
      });
    }
    case "purge": {
      return withMutationLock(owner, async () => {
        const revoked = await revokeConnection(owner);
        checked(await service.rpc("inbox_purge_owner", { p_owner_id: owner }));
        return { purged: true, disconnected: true, revoked };
      });
    }
    case "disconnect": {
      return withMutationLock(owner, async () => {
        const revoked = await revokeConnection(owner);
        checked(
          await service
            .from("inbox_connections")
            .update({
              status: "disconnected",
              encrypted_refresh_token: "purged",
              token_nonce: "purged",
              history_id: null,
            })
            .eq("owner_id", owner),
        );
        checked(
          await service
            .from("inbox_sync_checkpoints")
            .delete()
            .eq("owner_id", owner),
        );
        return { disconnected: true, revoked };
      });
    }
    default:
      throw new Error("unknown_action");
  }
}
async function cron(req: Request, body: Any) {
  const secret = env("INBOX_CRON_SECRET");
  if (secret.length < 32 || req.headers.get("x-cron-secret") !== secret)
    throw fail("unauthorized", "Cron authentication failed", 401);
  if (body.action !== "cron.sync")
    throw fail("invalid_action", "action cron.sync required");
  const rows = checked(
    await service
      .from("inbox_connections")
      .select("owner_id")
      .eq("status", "connected")
      .limit(25),
  );
  const results = [];
  for (const row of rows || [])
    results.push({ owner_id: row.owner_id, result: await sync(row.owner_id) });
  return { results };
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin") || "";
  const configuredOrigin =
    env("APP_ORIGIN", false) || "https://akshaya67889.github.io";
  const allowed = (() => {
    try {
      return new URL(configuredOrigin).origin;
    } catch {
      return configuredOrigin.replace(/\/$/, "");
    }
  })();
  const cors: Record<string, string> = { "cache-control": "no-store" };
  if (origin === allowed)
    Object.assign(cors, {
      "access-control-allow-origin": origin,
      "access-control-allow-headers":
        "authorization,apikey,content-type,x-cron-secret",
      "access-control-allow-methods": "POST,OPTIONS",
    });
  try {
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (
      url.searchParams.has("code") ||
      url.searchParams.get("action") === "oauth.callback"
    ) {
      const response = await oauthCallback(request);
      Object.entries(cors).forEach(([key, value]) =>
        response.headers.set(key, value),
      );
      return response;
    }
    if (request.method !== "POST")
      return fail("method_not_allowed", "POST required", 405, cors);
    const body = await request.json();
    const result =
      body.action === "cron.sync"
        ? await cron(request, body)
        : await action(await caller(request), body);
    return json(result, 200, cors);
  } catch (error: any) {
    if (error instanceof Response) {
      Object.entries(cors).forEach(([key, value]) =>
        error.headers.set(key, value),
      );
      return error;
    }
    console.error(
      JSON.stringify({
        code: error?.message || "internal_error",
        status: error?.status || 500,
      }),
    );
    return fail(
      error?.message === "unknown_action" ? "unknown_action" : "request_failed",
      error?.message === "unknown_action" ? "Unknown action" : "Request failed",
      error?.status >= 500 ? 502 : 400,
      cors,
    );
  }
});
