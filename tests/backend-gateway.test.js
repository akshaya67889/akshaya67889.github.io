import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  parseHeaders,
  parseAddress,
  verifyGatewayMarker,
} from "../supabase/functions/protected-inbox/core.js";
const secret = "0123456789abcdef0123456789abcdef";
function bridge(subject = "Résumé ✓", body = "Línea\r\n\r\n第二行\r\n") {
  const r = spawnSync(
    "python3",
    ["scripts/gateway_smtp_bridge.py", "--stdout"],
    {
      cwd: new URL("..", import.meta.url),
      input: `From: Original <sender@example.test>\nMessage-ID: <known@example.test>\nSubject: ${subject}\nContent-Type: text/plain; charset=utf-8\n\n${body}`,
      env: {
        ...process.env,
        INBOX_GATEWAY_HMAC_SECRET: secret,
        INBOX_GATEWAY_SOURCE_EMAIL: "source@example.test",
        INBOX_GATEWAY_FROM: "gateway@example.test",
        CENTRAL_GMAIL_ADDRESS: "central@example.test",
      },
    },
  );
  assert.equal(r.status, 0, r.stderr.toString());
  return r.stdout.toString();
}
function headersFrom(raw) {
  const r = spawnSync(
    "python3",
    [
      "-c",
      "from email import policy; from email.parser import BytesParser; import sys; m=BytesParser(policy=policy.default).parsebytes(sys.stdin.buffer.read()); import base64; print(base64.b64encode(m.get('X-Inbox-Gateway','').encode()).decode()); print(base64.b64encode(m.get('Subject','').encode()).decode())",
    ],
    { input: raw },
  );
  const [marker, subject] = r.stdout
    .toString()
    .trimEnd()
    .split("\n")
    .map((x) => Buffer.from(x, "base64").toString());
  return { headers: [{ name: "X-Inbox-Gateway", value: marker }], subject };
}
test("Python bridge marker verifies in JS including Unicode and CRLF normalization", async () => {
  const raw = bridge();
  const extracted = headersFrom(raw);
  const h = parseHeaders([
    {
      name: "X-Inbox-Gateway",
      value: extracted.headers[0].value.replace(/\s/g, ""),
    },
  ]);
  const marker = await verifyGatewayMarker(h, "<known@example.test>", secret, {
    sender: "sender@example.test",
    subject: extracted.subject,
    bodySha256: extracted.headers[0].value.match(
      /body-sha256=([a-f0-9]{64})/i,
    )?.[1],
    internalDate: Date.now(),
  });
  assert.equal(marker.source, "source@example.test");
});
test("tampering, duplicate marker, and historical timestamp are rejected or accepted correctly", async () => {
  const raw = bridge(),
    extracted = headersFrom(raw),
    marker = extracted.headers[0];
  assert.ok(marker);
  const bad = marker.value.replace("source@example.test", "other@example.test");
  assert.equal(
    await verifyGatewayMarker(
      [{ name: "X-Inbox-Gateway", value: bad }],
      "<known@example.test>",
      secret,
      { sender: "sender@example.test", subject: "Résumé ✓", bodySha256: "x" },
    ),
    null,
  );
  assert.equal(
    await verifyGatewayMarker(
      [marker, marker],
      "<known@example.test>",
      secret,
      {},
    ),
    null,
  );
});
test("multiple trusted headers are not confused with From", () =>
  assert.equal(
    parseAddress("Attacker <evil@example.test>"),
    "evil@example.test",
  ));
