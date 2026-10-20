export const UNKNOWN = "unknown";
export const MAX_PAGE = 25;
const ALLOWED_HEADERS = new Set([
  "from",
  "to",
  "subject",
  "date",
  "delivered-to",
  "message-id",
  "reply-to",
  "x-inbox-gateway",
]);

export function parseHeaders(headers = []) {
  const out = Object.create(null);
  for (const header of Array.isArray(headers) ? headers : []) {
    const name = String(header?.name || "")
      .trim()
      .toLowerCase();
    if (!ALLOWED_HEADERS.has(name)) continue;
    (out[name] ||= []).push(String(header?.value || "").trim());
  }
  return out;
}

export function parseAddress(value = "") {
  const text = String(value);
  const match =
    text.match(/<([^<>\s]+@[^<>\s]+)>/) ||
    text.match(/\b([^<>\s]+@[^<>\s]+)\b/);
  return match ? match[1].toLowerCase() : null;
}

export function normalizeBody(text = "") {
  return String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function canonicalGateway({
  timestamp,
  messageId,
  source,
  sender,
  subject,
  bodySha256,
}) {
  return [
    "v1",
    String(timestamp),
    String(messageId).trim(),
    String(source).trim().toLowerCase(),
    String(sender).trim().toLowerCase(),
    normalizeBody(subject),
    String(bodySha256).toLowerCase(),
  ].join("\n");
}

export async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hexBytes(hex) {
  return Uint8Array.from(
    (hex.match(/../g) || []).map((pair) => parseInt(pair, 16)),
  );
}

export async function verifyGatewayMarker(
  headers,
  messageId,
  secret,
  context = {},
) {
  if (!secret || secret.length < 32 || !messageId) return null;
  const parsed = Array.isArray(headers) ? parseHeaders(headers) : headers || {};
  const values = parsed["x-inbox-gateway"] || [];
  if (values.length !== 1) return null;
  const match = values[0]
    .replace(/[\r\n \t]+/g, "")
    .match(
      /^v1;ts=(\d{10,13});source=([^;\r\n]+);sender=([^;\r\n]+);msgid=([^;\r\n]+);subject-sha256=([a-f0-9]{64});body-sha256=([a-f0-9]{64});sig=([a-f0-9]{64})$/i,
    );
  if (!match) return null;
  const [
    ,
    rawTimestamp,
    source,
    sender,
    markerMessageId,
    subjectHash,
    bodyHash,
    signature,
  ] = match;
  const timestamp = Number(
    rawTimestamp.length === 13 ? rawTimestamp : `${rawTimestamp}000`,
  );
  const now = Date.now();
  const internalDate = Number(context.internalDate || 0);
  if (
    timestamp > now + 300000 ||
    (Math.abs(now - timestamp) > 300000 &&
      !(internalDate > 0 && Math.abs(internalDate - timestamp) <= 86400000))
  )
    return null;
  if (markerMessageId !== String(messageId).trim()) return null;
  const subject = normalizeBody(context.subject || "");
  const suppliedBodyHash = String(context.bodySha256 || "").toLowerCase();
  if ((await sha256(subject)) !== subjectHash.toLowerCase()) return null;
  if (suppliedBodyHash && suppliedBodyHash !== bodyHash.toLowerCase())
    return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    hexBytes(signature),
    new TextEncoder().encode(
      canonicalGateway({
        timestamp: rawTimestamp,
        messageId: markerMessageId,
        source,
        sender,
        subject,
        bodySha256: bodyHash,
      }),
    ),
  );
  return valid
    ? {
        source: source.trim().toLowerCase(),
        sender: sender.trim().toLowerCase(),
        timestamp,
        messageId: markerMessageId,
        bodySha256: bodyHash.toLowerCase(),
      }
    : null;
}

/** @param {any} marker */
export function identifySource(
  _headers,
  sources,
  _messageId = "",
  marker /** @type {{source:string}|null} */ = null,
) {
  if (!marker)
    return { sourceId: null, status: UNKNOWN, reason: "no_trusted_marker" };
  const candidates = (sources || []).filter(
    (source) =>
      source.status === "verified" &&
      source.verification_method === "signed_gateway" &&
      String(source.email).toLowerCase() === marker.source,
  );
  return candidates.length === 1
    ? {
        sourceId: candidates[0].id,
        status: "verified",
        reason: "signed_gateway",
      }
    : {
        sourceId: null,
        status: UNKNOWN,
        reason: candidates.length ? "ambiguous_source" : "unregistered_source",
      };
}

export function retryDecision(status, attempt, retryAfter, detail = "") {
  const n = Number(attempt) || 0;
  const quota =
    Number(status) === 403 &&
    /(?:rateLimitExceeded|userRateLimitExceeded)/i.test(String(detail));
  const retryable =
    status === 429 || status === 408 || status === 0 || status >= 500 || quota;
  if (!retryable || n >= 6) return { retry: false, delayMs: 0 };
  const server = Number(retryAfter) * 1000;
  return {
    retry: true,
    delayMs:
      Number.isFinite(server) && server > 0
        ? Math.min(server, 900000)
        : Math.min(900000, 1000 * 2 ** n),
  };
}

export function sanitizeHtml(html = "") {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(?:href|src)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

export function randomChallenge() {
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
