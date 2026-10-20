const OWNER = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "https://test.example";
const calls: Array<{ url: string; method: string; body: string | null }> = [];
let handler: (request: Request) => Promise<Response>;

function response(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const originalFetch = globalThis.fetch;

await testSetup();

async function testSetup() {
  const env = Deno.env;
  env.set("SUPABASE_URL", "https://test.supabase.co");
  env.set("SUPABASE_ANON_KEY", "dummy-anon-key");
  env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role");
  env.set("SERVICE_ROLE_KEY", "test-service-role");
  env.set("APP_ORIGIN", ORIGIN);
  env.set("INBOX_CRON_SECRET", "cron-secret-that-is-at-least-32-characters");
  env.set("INBOX_GATEWAY_HMAC_SECRET", "gateway-secret-that-is-at-least-32-characters");
  env.set("INBOX_TOKEN_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");

  Object.defineProperty(Deno, "serve", {
    configurable: true,
    value: (callback: (request: Request) => Promise<Response>) => {
      handler = callback;
      return { finished: Promise.resolve() };
    },
  });
  await import("../supabase/functions/protected-inbox/index.ts?backend-api-test");
}

function reset() {
  calls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || (input instanceof Request ? input.method : "GET");
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, method, body });
    if (url.endsWith("/auth/v1/user"))
      return response({ id: OWNER, aud: "authenticated", role: "authenticated" });
    if (url.includes("/rest/v1/")) {
      // Keep all read paths valid and make an OAuth state consume return null.
      if (url.includes("/rpc/inbox_consume_oauth_state")) return response(null);
      return response([]);
    }
    return response({});
  }) as typeof fetch;
}

async function invoke(body: unknown, headers: Record<string, string> = {}) {
  reset();
  return handler(new Request("https://test.supabase.co/functions/v1/protected-inbox", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }));
}

async function payload(res: Response) {
  return await res.json();
}

Deno.test("signed-out inbox actions uniformly return JSON 401 with CORS and no-store", async () => {
  const actions = ["list", "detail", "sync", "resolve", "read", "delete", "purge"];
  for (const action of actions) {
    const res = await invoke({ action }, { origin: ORIGIN });
    const body = await payload(res);
    if (res.status !== 401 || body.error?.code !== "unauthorized")
      throw new Error(`${action} was not denied: ${res.status} ${JSON.stringify(body)}`);
    if (res.headers.get("access-control-allow-origin") !== ORIGIN)
      throw new Error(`${action} omitted CORS allow-origin`);
    if (res.headers.get("cache-control") !== "no-store")
      throw new Error(`${action} omitted no-store`);
    if (calls.some((call) => call.url.includes("/rest/v1/")))
      throw new Error(`${action} reached a database endpoint before authentication`);
  }
});

Deno.test("auth status is read-only and does not return encrypted refresh-token material", async () => {
  const res = await invoke({ action: "status" }, {
    authorization: "Bearer test-access-token",
    origin: ORIGIN,
  });
  if (res.status !== 200) throw new Error(`status failed: ${res.status}`);
  const body = await payload(res);
  if (JSON.stringify(body).includes("encrypted_refresh_token") || JSON.stringify(body).includes("token_nonce"))
    throw new Error("status leaked token ciphertext/nonce");
  if (calls.some((call) => !call.url.endsWith("/auth/v1/user") && call.method !== "GET"))
    throw new Error(`status made a client write: ${JSON.stringify(calls)}`);
});

Deno.test("list applies source, identity, date, query, and pagination filters while scoping owner_id", async () => {
  const res = await invoke({
    action: "list", source_id: "source-1", unknown: "manual", from: "2025-01-01", to: "2025-02-01", query: "invoice", page: 2,
  }, { authorization: "Bearer test-access-token" });
  if (res.status !== 200) throw new Error(`list failed: ${res.status}`);
  const rest = calls.find((call) => call.url.includes("/rest/v1/inbox_messages"));
  if (!rest) throw new Error("list did not query inbox_messages");
  const url = decodeURIComponent(rest.url);
  for (const expected of ["owner_id=eq.", "source_id=eq.source-1", "source_identity_status=eq.manual_unverified", "received_at=gte.2025-01-01", "received_at=lte.2025-02-01", "subject.ilike.*invoice*"]) {
    if (!url.includes(expected)) throw new Error(`missing list filter ${expected}: ${url}`);
  }
  if (!url.includes("offset=50") && !url.includes("range=50"))
    throw new Error(`pagination was not requested: ${url}`);
});

Deno.test("authenticated write-looking actions cannot bypass fake auth because no bearer is accepted", async () => {
  for (const action of ["resolve", "read", "delete", "purge"]) {
    const res = await invoke({ action, id: "message-1", source_id: "source-1", message_id: "gmail-1" }, { authorization: "Bearer" });
    if (res.status !== 401) throw new Error(`${action} accepted malformed bearer: ${res.status}`);
    if (calls.some((call) => call.url.includes("/rest/v1/") && call.method !== "GET"))
      throw new Error(`${action} bypassed auth with a write: ${JSON.stringify(calls)}`);
  }
});

Deno.test("source verification rejects missing attestation before any Gmail request", async () => {
  const res = await invoke({ action: "sources.verify", source_id: "source-1", message_id: "gmail-1" }, { authorization: "Bearer test-access-token" });
  if (res.status !== 400) throw new Error(`expected precondition failure, got ${res.status}`);
  const body = await payload(res);
  if (body.error?.code !== "request_failed") throw new Error(`unexpected source verify error ${JSON.stringify(body)}`);
  if (calls.some((call) => call.url.includes("gmail.googleapis.com") || call.url.includes("oauth2.googleapis.com")))
    throw new Error("source verification contacted Gmail before attestation");
});

Deno.test("forged OAuth callback state is rejected without exchanging code", async () => {
  reset();
  const res = await handler(new Request("https://test.supabase.co/functions/v1/protected-inbox?action=oauth.callback&code=forged&state=forged", { method: "GET", headers: { origin: ORIGIN } }));
  if (res.status !== 400) throw new Error(`forged callback returned ${res.status}`);
  const body = await payload(res);
  if (body.error?.code !== "invalid_oauth") throw new Error(`wrong callback error ${JSON.stringify(body)}`);
  if (calls.some((call) => call.url.includes("oauth2.googleapis.com/token"))) throw new Error("forged callback exchanged code");
});

Deno.test("cron rejects an invalid secret before reading connection rows", async () => {
  const res = await invoke({ action: "cron.sync" }, { "x-cron-secret": "wrong", origin: ORIGIN });
  if (res.status !== 401) throw new Error(`invalid cron secret returned ${res.status}`);
  const body = await payload(res);
  if (body.error?.code !== "unauthorized") throw new Error(`wrong cron error ${JSON.stringify(body)}`);
  if (calls.some((call) => call.url.includes("/rest/v1/"))) throw new Error("invalid cron secret queried database");
});

addEventListener("unload", () => { globalThis.fetch = originalFetch; });
