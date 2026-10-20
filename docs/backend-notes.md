# Protected inbox backend notes

The backend is the `protected-inbox` Supabase Edge Function and migration
`supabase/migrations/20261020120000_protected_inbox.sql`. It has no browser Gmail
secret. **Apply the complete migration before deploying the function.**

## Required configuration

Set these Supabase function secrets (startup fails clearly when a required value
is missing): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`,
`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REDIRECT_URI`,
`INBOX_TOKEN_ENCRYPTION_KEY` (base64 encoding of exactly 32 random bytes),
`APP_ORIGIN` (normally `https://akshaya67889.github.io`),
`INBOX_ROUTE_DOMAIN`, `INBOX_GATEWAY_HMAC_SECRET` (at least 32 random characters),
and `INBOX_CRON_SECRET` (at least 32 random characters). The gateway also needs
`INBOX_GATEWAY_SOURCE_EMAIL`, `INBOX_GATEWAY_FROM`, `CENTRAL_GMAIL_ADDRESS`,
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASSWORD` when using
`scripts/gateway_smtp_bridge.py`.

Deploy with `supabase functions deploy protected-inbox --no-verify-jwt`.
`--no-verify-jwt` is intentional: OAuth callback and the scheduler have their own
checks; every ordinary action calls Supabase `auth.getUser` on the explicit Bearer
JWT. Never expose service-role, OAuth client secret, encryption, SMTP, or gateway
keys to the frontend.

## Trusted source routing

Ordinary Gmail forwarding cannot prove the forwarding account. Alias or
`Delivered-To` evidence therefore remains pending/unknown. For production
attribution, configure a separate trusted route/process per source and run the
standard-library SMTP bridge. It reads one RFC822 message on stdin; the operator
sets `INBOX_GATEWAY_SOURCE_EMAIL` for that route, so source identity is trusted
only as strongly as this route-to-source/operator mapping. It never infers source
from `From`.

The bridge creates exactly one `X-Inbox-Gateway` marker on a wrapper sent from the
configured gateway address. The marker is:

```text
v1;ts=<unix-seconds>;source=<lowercase source>;sender=<lowercase original sender>;
msgid=<original RFC Message-ID>;subject-sha256=<sha256 normalized subject>;
body-sha256=<sha256 normalized readable text>;sig=<hex HMAC-SHA256>
```

The HMAC canonical text is the seven lines `v1`, timestamp, message ID, lowercase
source, lowercase sender, normalized subject, lowercase body SHA-256. Normalizing
means CRLF/CR -> LF, trailing spaces before LF removed, runs of 3+ LF reduced to
2, and trimming. Both Python and WebCrypto use UTF-8. The signature binds message
identity, source, sender, subject and body. Duplicate, malformed, future, tampered,
unknown-source, or multiple marker headers are rejected. Historical messages are
accepted when marker timestamp is within 24 hours of Gmail `internalDate`; this
is transport freshness, not a five-minute wall-clock rule. Gmail/API imports never
render raw HTML: plain text is preferred and HTML-only messages are converted to
readable text with `html-to-text`; only whitelisted metadata headers are stored.

`Sources.verify` requires an owner-attested Gmail test message containing the
challenge body and a valid signed marker. Alias-only tests remain pending, never
verified. If an earlier unknown message is reprocessed after a source becomes
verified, history sync updates its attribution.

## Synchronization and API

OAuth captures the Gmail profile `historyId` **before** starting the bounded 25
message backfill. Checkpoint pages advance only after every message in that page
has succeeded, so a failed message cannot silently advance the token. Backfill
then switches to Gmail history synchronization. `messagesAdded`, label changes,
and `messagesDeleted` are handled; `404` expired history resets to a fresh bounded
backfill. A DB RPC provides an atomic lease lock and release. Retries write a
bounded exponential `next_run_at`; retry does not resolve its error until a later
sync succeeds. A per-message failure leaves the batch checkpoint unchanged and is
reported for retry.

`list` uses the frontend's zero-based 25-row pages and deterministic
`received_at DESC, id DESC` order. Search is bounded and escapes `%`, `_`, commas,
periods and parentheses before constructing the PostgREST OR expression. DTOs
include both raw fields and compatible `source_account_id`, `source_status`,
`original_sender`, and `snippet`. `read` is local-only and never changes Gmail.
Initial read state comes from Gmail's `UNREAD` label. Delete writes a tombstone;
purge tombstones all current IDs, disconnects, and removes checkpoints, preventing
intentional deletes from reimporting. A mailbox change requires disconnect and
purge first. OAuth state consumption is one atomic update. Callback requires
`?action=oauth.callback`, validates refresh token/scopes through the exchange, and
returns a safe 303 (no inline script).

All responses are `no-store`; CORS permits only the configured allowlist origin
(default above). Cron is POST `{ "action": "cron.sync" }` with
`x-cron-secret: <INBOX_CRON_SECRET>` and loops at most 25 connected owners,
respecting each checkpoint's `next_run_at`. No cron job is created automatically.
If desired, configure pg_cron/pg_net separately using a Vault secret reference;
never put credentials in this repository, and preserve existing jobs.

## Verification performed

Node backend suite: **8 tests passing** (core attribution/retry/HTML checks plus deterministic Python bridge -> WebCrypto Unicode/CRLF and tamper/duplicate-marker checks). Python bridge syntax and whitespace checks also pass. Deno is not installed in this execution environment, so `deno check` could not be rerun here. The project has not been deployed or committed. Remaining operational limitations: apply the migration before use, verify the fenced lease RPCs in Supabase, Gmail API/SMTP behavior, OAuth consent and returned scopes, trusted per-source route mapping, and a real three-source forwarding acceptance test must be configured and exercised by the operator.
