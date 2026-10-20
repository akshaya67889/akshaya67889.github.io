import test from "node:test";
import assert from "node:assert/strict";
import {
  identifySource,
  retryDecision,
  sanitizeHtml,
} from "../supabase/functions/protected-inbox/core.js";

const sources = [
  {
    id: "a",
    status: "verified",
    route_address: "central+abc@inbox.example",
    email: "one@example.com",
  },
];
test("alias-only Gmail Delivered-To evidence remains unknown", () => {
  assert.equal(
    identifySource(
      [{ name: "Delivered-To", value: "central+abc@inbox.example" }],
      sources,
    ).sourceId,
    null,
  );
});
test("does not trust From, body, or arbitrary headers", () => {
  const result = identifySource(
    [
      { name: "From", value: "one@example.com" },
      { name: "X-Forwarded-To", value: "central+abc@inbox.example" },
    ],
    sources,
  );
  assert.equal(result.status, "unknown");
  assert.equal(result.sourceId, null);
});
test("ambiguous routes remain unknown", () => {
  const two = [
    ...sources,
    { id: "b", status: "verified", route_address: "central+abc@inbox.example" },
  ];
  assert.equal(
    identifySource(
      [{ name: "Delivered-To", value: "central+abc@inbox.example" }],
      two,
    ).status,
    "unknown",
  );
});
test("retries quota and server failures with bounded backoff", () => {
  assert.equal(retryDecision(429, 1).retry, true);
  assert.equal(retryDecision(403, 1).retry, false);
  assert.equal(retryDecision(500, 7).retry, false);
});
test("removes active HTML execution vectors", () => {
  const safe = sanitizeHtml(
    '<p>ok</p><script>alert(1)</script><a href="javascript:x" onclick="x">x</a>',
  );
  assert.equal(safe.includes("<script"), false);
  assert.equal(safe.includes("onclick"), false);
});
