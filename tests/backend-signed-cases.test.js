import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalGateway,
  identifySource,
  sha256,
  verifyGatewayMarker,
} from "../supabase/functions/protected-inbox/core.js";

const secret = "gateway-secret-that-is-at-least-32-characters";
const body = "Verification challenge body";
const messageId = "<signed-message@example.test>";
const sources = [
  { id: "source-a", email: "a@example.test", status: "verified", verification_method: "signed_gateway" },
  { id: "source-b", email: "b@example.test", status: "verified", verification_method: "signed_gateway" },
  { id: "source-c", email: "c@example.test", status: "verified", verification_method: "signed_gateway" },
];

async function hex(data) {
  return [...new Uint8Array(data)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function markerFor(source, timestamp = Date.now(), subject = "Signed subject", id = messageId, text = body) {
  const [subjectHash, bodyHash] = await Promise.all([sha256(subject), sha256(text)]);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonicalGateway({ timestamp, messageId: id, source, sender: "sender@example.test", subject, bodySha256: bodyHash })));
  return {
    marker: `v1;ts=${timestamp};source=${source};sender=sender@example.test;msgid=${id};subject-sha256=${subjectHash};body-sha256=${bodyHash};sig=${await hex(sig)}`,
    subject,
    bodyHash,
  };
}

test("signed gateway verifies and identifies each of three registered sources", async () => {
  for (const source of sources) {
    const made = await markerFor(source.email);
    const verified = await verifyGatewayMarker(
      [{ name: "X-Inbox-Gateway", value: made.marker }], messageId, secret,
      { subject: made.subject, bodySha256: made.bodyHash, internalDate: Date.now() },
    );
    assert.equal(verified?.source, source.email);
    assert.equal(identifySource([], sources, messageId, verified).sourceId, source.id);
  }
});

test("source, body, subject, and message-id tampering are rejected", async () => {
  const made = await markerFor("a@example.test");
  const checks = [
    made.marker.replace("source=a@example.test", "source=attacker@example.test"),
    made.marker.replace(/body-sha256=[a-f0-9]+/, "body-sha256=" + "0".repeat(64)),
    made.marker,
    made.marker,
  ];
  assert.equal(await verifyGatewayMarker([{ name: "X-Inbox-Gateway", value: checks[0] }], messageId, secret, { subject: made.subject, bodySha256: made.bodyHash }), null);
  assert.equal(await verifyGatewayMarker([{ name: "X-Inbox-Gateway", value: checks[1] }], messageId, secret, { subject: made.subject, bodySha256: made.bodyHash }), null);
  assert.equal(await verifyGatewayMarker([{ name: "X-Inbox-Gateway", value: checks[2] }], messageId, secret, { subject: "Changed subject", bodySha256: made.bodyHash }), null);
  assert.equal(await verifyGatewayMarker([{ name: "X-Inbox-Gateway", value: checks[3] }], "<different@example.test>", secret, { subject: made.subject, bodySha256: made.bodyHash }), null);
});

test("future timestamps fail while a historical marker is accepted with matching Gmail internalDate", async () => {
  const future = await markerFor("a@example.test", Date.now() + 301000);
  assert.equal(await verifyGatewayMarker([{ name: "X-Inbox-Gateway", value: future.marker }], messageId, secret, { subject: future.subject, bodySha256: future.bodyHash }), null);
  const historicalAt = Date.now() - 86400000 + 1000;
  const historical = await markerFor("a@example.test", historicalAt);
  const accepted = await verifyGatewayMarker([{ name: "X-Inbox-Gateway", value: historical.marker }], messageId, secret, { subject: historical.subject, bodySha256: historical.bodyHash, internalDate: historicalAt });
  assert.equal(accepted?.source, "a@example.test");
});
