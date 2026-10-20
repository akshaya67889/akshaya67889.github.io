# PollPe protected inbox: setup and use

PollPe keeps its existing public **Mail & OTP** board. The new [protected inbox](https://akshaya67889.github.io/pollpe-daily/inbox.html) is separate: signing out hides and clears its imported email content. The existing questions, coins, daily status, public posting, cleanup jobs, and GitHub Pages hosting are not replaced.

## What still needs your setup

Live Gmail import requires your central Gmail address, a private owner login in Supabase Authentication, a Google OAuth web client, server-only secrets, and a trusted forwarding route for each source. Enabling Gmail in Cue does not authorize this website. The three-account live acceptance test cannot be completed without those accounts and their forwarding configuration.

Ordinary forwarding can deliver messages, but it does **not** reliably prove which account forwarded them. Those messages appear as **Unknown forwarding account**. An owner-applied label is **manual and unverified**. Verified source badges require the signed bridge described below and a successful challenge test for that source.

## 1. Create the private owner login

In the existing Supabase project `ewdpamsogpqhuzreaayo`, open **Authentication → Users → Add user** and create the owner's email/password account. Do not reuse PollPe's public question-admin password. There is no public sign-up button in the new inbox.

The login uses Supabase Auth. Each request validates the user's access token on the server and scopes data to that user. Gmail refresh tokens are encrypted and never returned to the browser. Supabase login tokens are separate and are kept in the current tab's session storage until logout or expiry.

## 2. Configure Google's OAuth web client

In [Google Cloud Console](https://console.cloud.google.com/), enable **Gmail API**, configure the consent screen, and create an **OAuth client ID → Web application**. Add this exact authorized redirect URI:

```text
https://ewdpamsogpqhuzreaayo.supabase.co/functions/v1/protected-inbox?action=oauth.callback
```

The requested scope is only `https://www.googleapis.com/auth/gmail.readonly`. The website does not send mail, change Gmail's read status, or delete Gmail messages. Read/unread and delete controls affect imported PollPe copies only.

For an External app in Testing, add the central Gmail owner as a test user. [Google documents that these refresh tokens normally expire after seven days](https://developers.google.com/identity/protocols/oauth2#expiration); production use may require publishing and completing applicable Google verification requirements. See [Gmail's server-side OAuth guide](https://developers.google.com/workspace/gmail/api/auth/web-server).

## 3. Set server-only secrets

Use Supabase's Edge Function secrets settings or `supabase secrets set --env-file /absolute/path/to/private.env`. Keep this file outside the public repository and never place these values in `config.js`.

| Variable | Value |
| --- | --- |
| `GMAIL_CLIENT_ID` | Your Google web client ID |
| `GMAIL_CLIENT_SECRET` | Your Google web client secret |
| `GMAIL_REDIRECT_URI` | The exact callback URL above |
| `INBOX_TOKEN_ENCRYPTION_KEY` | Base64 encoding of 32 cryptographically random bytes |
| `APP_ORIGIN` | `https://akshaya67889.github.io` |
| `APP_URL` | `https://akshaya67889.github.io/pollpe-daily/inbox.html` |
| `INBOX_GATEWAY_HMAC_SECRET` | A separate random secret, at least 32 characters, shared only with the trusted bridge |
| `INBOX_CRON_SECRET` | A different random secret, at least 32 characters, used only for scheduled synchronization |

Supabase supplies `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` to the function runtime. Only the normal publishable key and project URL remain in the existing frontend configuration.

For example, generate the AES key with `openssl rand -base64 32` and independent gateway/cron secrets with `openssl rand -hex 32`. Save values privately; the command examples do not contain real credentials.

## 4. Deploy without changing hosting

The schema is in `supabase/migrations/20261020120000_protected_inbox.sql`; the follow-up `20261020120100_inbox_extension_schema.sql` places the email-address extension outside the public API schema. It creates only the protected-inbox tables and security functions. It does not alter existing public board, question, or coin tables.

For a fresh deployment from the repository root:

```bash
supabase login
supabase link --project-ref ewdpamsogpqhuzreaayo
supabase db push
supabase functions deploy protected-inbox --no-verify-jwt
```

The function's own code validates every normal API request with Supabase Auth. The gateway-level JWT check is intentionally disabled because Google's OAuth callback has no Supabase JWT, while the scheduler authenticates with its separate secret. The callback uses expiring single-use state; it is not an open inbox API.

Publish static files by committing to the existing GitHub Pages `main` branch, root directory. Do not move the site to a different host. If this task has already applied the migration or deployed the function, check the recorded migration/deployment status rather than reapplying changes blindly.

## 5. Connect the central Gmail inbox

Open the [protected inbox](https://akshaya67889.github.io/pollpe-daily/inbox.html), sign in, and choose **Settings → Connect Gmail**. Consent using the intended central Gmail account. Confirm that the displayed central address is correct, then choose **Sync now**.

Existing mail imports in bounded pages. Later runs use Gmail history. [Gmail requires a full-sync fallback when a history cursor expires](https://developers.google.com/workspace/gmail/api/guides/sync). Quota and temporary failures are recorded for retry rather than silently skipping messages. Message IDs have a database uniqueness constraint to prevent duplicate imports.

## 6. Configure trustworthy forwarding

For ordinary forwarding, Google's [forwarding instructions](https://support.google.com/mail/answer/10957) explain the confirmation email and source-side settings. Receiving an email in the central mailbox does not by itself prove its forwarding account.

For **verified attribution**, run `scripts/gateway_smtp_bridge.py` on a trusted mail gateway with one authenticated route/process mapped to each source account. The operator sets `INBOX_GATEWAY_SOURCE_EMAIL` for that route; the script does not infer it from the original sender, subject, or message body. Do not expose an endpoint that lets arbitrary callers select any source value.

The supplied script reads an RFC822 email from standard input and sends a signed wrapper to central Gmail. Set these variables on the gateway, not in GitHub Pages:

- `INBOX_GATEWAY_SOURCE_EMAIL`: the source account fixed for this trusted route.
- `INBOX_GATEWAY_FROM`: the gateway's sending address.
- `CENTRAL_GMAIL_ADDRESS`: the connected central Gmail mailbox.
- `INBOX_GATEWAY_HMAC_SECRET`: the same private signing secret as the Edge Function.
- `SMTP_HOST`, `SMTP_PORT` (normally 587), `SMTP_USER`, `SMTP_PASSWORD`: dedicated SMTP relay credentials, **not source-account passwords**.

Invoke it from the trusted mail system's delivery hook:

```bash
python3 scripts/gateway_smtp_bridge.py < incoming-message.eml
```

`--stdout` creates a wrapper for offline testing without sending. This script is a delivery hook, not a publicly deployed SMTP receiver. You must connect each source's forwarding route to a trusted receiver/mail system that invokes it with the correct fixed source. A random Gmail plus-alias alone is not a substitute for this trusted mapping. If no such gateway is available, the dashboard still imports mail safely, but source attribution remains Unknown/manual.

The signature binds the source, original sender, subject, message identity, and readable content. The server rejects tampered or ambiguous markers. See `docs/backend-notes.md` for the precise signing format and transport assumptions.

## 7. Verify three separate source accounts

For each source account, independently:

1. Register its email in **Settings → Forwarding sources**.
2. Read its verification challenge. Send a message **to that source** from another sender, including the exact challenge in its body. Let the configured source route forward it through the trusted bridge to central Gmail.
3. Synchronize. Open the imported message and copy its Gmail message ID from the detail view.
4. Choose **Verify test**, enter that ID, and confirm the source becomes Verified only after server signature and challenge validation.
5. Send another message through the same route. Confirm the card shows the correct **Forwarded from** account separately from **Original sender**, with matching subject, body, time, and attachment indicators.

Repeat with three distinct sources. Also test a duplicate sync, an unsigned message, a manually labeled unknown message, an HTML-only message containing a script/tracker, and a temporary synchronization failure. Do not call live acceptance complete until all three real routes pass. Aliases that cannot distinguish sources must remain unverified.

## 8. Enable the scheduled fallback

After OAuth and secrets are configured, use `supabase/setup_inbox_schedule.sql`, following its comments. It uses application-native Supabase `pg_cron`/`pg_net`, not a Cue schedule. Store the cron secret in Supabase Vault and reference it by name; do not paste it into public SQL files.

The scheduled request is `POST /functions/v1/protected-inbox` with JSON `{"action":"cron.sync"}` and header `x-cron-secret`. Keep the existing six-hour public-mail cleanup and midnight question cleanup jobs unchanged. Confirm the new job appears in `cron.job` and inspect its run history after enabling it. A configured job is not proof that a live email was imported.

## Tests and checks

```bash
node --test tests/backend*.test.js
deno check supabase/functions/protected-inbox/index.ts
deno test --allow-env --allow-read --allow-net tests/backend-api.test.ts
python3 -m http.server 8765
# In another terminal, with Python Playwright and Chromium installed:
python3 tests/frontend_regression.py
```

Browser test fixtures are test-only; the published inbox contains no hardcoded email data. Check signed-out and different-user access, OAuth state replay, duplicate imports, failed synchronization, all three real source routes, and HTML tracking/script blocking. The live three-source test remains an operational acceptance step, not something unit tests can replace.

## Disconnect, delete, and rollback

**Delete imported copy** leaves the original Gmail message unchanged and records a tombstone to prevent accidental reimport. **Purge imported mail** removes protected copies and stops that connection. **Disconnect** removes usable Gmail credentials and stops future imports. You can also revoke the app in the central Google Account's third-party access settings and disable forwarding at each source.

For rollback, disable only the new inbox scheduler and revert the protected-inbox commit/function. Do not remove or modify the public tables or their existing cleanup jobs. Back up any protected data you need before a deliberate purge.
