# Khusela Consent

A small, self-contained service for capturing a client's signed consent for Khusela Debt Management to access, obtain, process and use their credit and personal information.

It is deliberately separate from the ITC extractor. It has its own database, its own agent accounts and its own signing links. The agent desk and the API are served from the same Express origin, so the session cookie can be `HttpOnly` and `SameSite=Strict` without CORS.

The signed consent statement is stored per request and is exactly:

> I hereby confirm that i give Khusela Debt Management permission to access, obtain, process and use my credit and personal information in accordance to their mandate.

followed by **Signature:**.

## What it does

1. An agent signs in with an email address and password.
2. The agent enters the client's name, ID number and WhatsApp number and/or email address.
3. The service creates a one-time signing link. The agent sends it with the WhatsApp or Email button (the device's share/app link), or copies it.
4. The client opens the link, reads the statement, draws a signature and submits.
5. The agent desk notices the signature, fills in the signed record and offers the archived signed PDF.
6. A signed PDF is generated once at signing time and stored in the database with the signature image, timestamp, signing IP and a verification code. Downloads return that archived PDF, not a fresh rendering.

## Local setup

```powershell
cd C:\Users\ayabo\Downloads\project-hr\consent
npm install
Copy-Item .env.example .env
# Edit .env and set at least ADMIN_EMAIL, ADMIN_PASSWORD and PUBLIC_BASE_URL
npm start
```

Open `http://localhost:3000`.

The first account is created only when the `agents` table is empty. If the configured password is too weak (fewer than 10 characters, or no letters and number), the server logs a warning and does not create it. Create or reset an account directly with:

```powershell
npm run create-agent -- khuselamanagement@gmail.com "a-long-password" "Khusela Administrator" admin
npm run create-agent -- agent@example.com "another-long-password" "Agent Name" agent
```

Running the command again for an existing email resets that account's password, name and role, and reactivates it. The CLI never prints the password.

For development without a `.env`, the server uses `http://localhost:3000`, a local SQLite database in `storage/`, and no seeded account. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` before the first start, or use the CLI.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `STORAGE_DIR` | `./storage` | Local SQLite database and nothing else. Ignored when Turso is configured. |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | Public origin used to build signing links. On Render, `RENDER_EXTERNAL_URL` is used automatically. Set this when using a custom domain. |
| `ADMIN_EMAIL` | none | First administrator's email. Used only when the agents table is empty. |
| `ADMIN_PASSWORD` | none | First administrator's password. Use a long password with letters and numbers. |
| `ADMIN_NAME` | `Administrator` | First administrator's display name. |
| `SESSION_HOURS` | `12` | Session lifetime, clamped to 1–168 hours. |
| `TOKEN_EXPIRY_DAYS` | `7` | Consent link lifetime, clamped to 1–30 days. |
| `LOGIN_LIMIT` | `8` | Failed/successful login attempts per IP + email inside the window. |
| `LOGIN_WINDOW_MS` | `900000` | Login limiter window in milliseconds. |
| `TRUST_PROXY_HOPS` | `1` on Render, `0` locally | Reverse proxy hops to trust for `X-Forwarded-For`. On Render keep this at `1`; Render appends the real client address but does not strip client-supplied values. |
| `TURSO_DATABASE_URL` | unset | Hosted Turso/libSQL URL. When set, Turso is used instead of the local file. |
| `TURSO_AUTH_TOKEN` | unset | Turso token. |

**Important:** `PUBLIC_BASE_URL` must match the browser's origin exactly, including `https://` and any custom domain. The server rejects state-changing requests whose `Origin`/`Referer` does not match it.

## Agent desk

- **New consent request** creates the one-time link.
- **Send via WhatsApp** opens WhatsApp with the client's number and the link; **Send via Email** opens the device's email app. The service itself does not send messages.
- **Signed consent form** fills in automatically when the client signs. The desk polls while a request is pending.
- **Download signed PDF** downloads the archived signed document.
- **New link** regenerates the token for an unsigned request and invalidates the previous link. Links are held only in the current browser session; after a reload, use **New link** to create a fresh one.
- **Consent records** supports search by name, ID or contact, filtering by status, **Refresh**, and **Download all signed (PDF)** for a backup bundle.
- **Agent accounts** is visible to administrators only. Administrators can add an account with either role and deactivate/reactivate accounts. Role changes and password resets are done with the CLI (which revokes that account's old sessions). There is no password-reset UI.

## Security model

- There is no public registration. Accounts are created by an administrator or the CLI.
- Passwords are hashed with Node's `scrypt` and a random salt. Plain passwords are never stored or logged.
- Sessions are random 32-byte tokens. Only a SHA-256 hash of the token is stored in the database. The raw token is held in an `HttpOnly`, `SameSite=Strict`, `Secure` (on HTTPS) cookie.
- Login responses do not reveal whether an email address exists.
- State-changing requests require a per-session CSRF token (`x-csrf-token`) and a matching origin. The CSRF token is held in JavaScript memory, not in local storage.
- Login attempts are limited per IP + email in process memory. If more than one instance is ever run, put the limiter in a shared store first.
- Signing links contain a random token. Only its hash is stored, and the raw link is returned only when it is created or renewed. A link is single-use and expires.
- Signatures are stored as image bytes in the database. The signed PDF is stored beside them. API responses are `Cache-Control: no-store`.
- The signing page is served with `Referrer-Policy: no-referrer` so the token is not leaked through referrers.
- The PDF contains a verification code derived from the record identity, signing time and signature image, plus the signing IP for audit. The audit log records account, consent, signature and PDF access events.
- The PDF is an electronic record of consent. Whether it meets a particular legal or industry standard should be confirmed for your use case; the service is not a qualified electronic-signature provider.

## Data and storage

Tables created by `schema.js`:

- `agents` — agent accounts and roles.
- `sessions` — hashed session tokens, CSRF tokens, expiry and revocation.
- `consent_requests` — client details, consent text, hashed link token, status and signing metadata.
- `signatures` — signature image bytes and signing metadata.
- `consent_pdfs` — the archived signed PDF and its SHA-256.
- `audit_log` — append-only events (creation, renewal, signing, downloads, logins, account changes).

Use Turso in production. Render's free disk is ephemeral, so a local SQLite file on Render would be lost on the next deploy or restart. Turso survives redeploys and gives you a managed backup path. Download the signed PDF bundle periodically as a separate, human-readable backup. Retain ID numbers, signatures and contact details only as long as your mandate and applicable law require, and restrict access to administrators.

## Deploy to Render

The folder is a standalone service. Put it in its own Git repository (it is not currently a Git repository), then:

1. Create a Turso database and copy its URL and auth token.
2. Push this folder to GitHub.
3. In Render, choose **New > Blueprint** and select the repository. `render.yaml` defines the service and prompts for `ADMIN_PASSWORD` and the Turso values.
4. Deploy. The first start creates the administrator from `ADMIN_EMAIL`/`ADMIN_PASSWORD`.
5. Open the Render URL and sign in. If you use a custom domain, set `PUBLIC_BASE_URL` to that exact origin and redeploy.
6. To reset the administrator password later, run the create-agent command locally with the production `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in your environment.

`render.yaml` uses `npm ci`, which requires the committed `package-lock.json`. It is present in this folder.

The free Render web service may spin down when idle. Signing links still work after the cold start, but the first request may be slow.

## Tests

```powershell
npm test
```

The test starts the real server on a random port with a throwaway SQLite database and covers: seeding, authentication, CSRF and origin checks, record creation, exact consent text, one-time signing and replay rejection, signature retrieval, archived PDF download, backup PDF export, agent isolation, admin-only team management, and the shared client helpers. It does not require a browser.

## Project layout

```
consent/
  server.js              Express app and all routes
  auth.js                passwords, sessions, CSRF, origin checks
  db.js                  Turso / local SQLite access
  schema.js              database schema and indexes
  pdf.js                 consent PDF, bundle PDF, consent text
  public/
    index.html           agent login and desk
    sign.html            client signing page
    css/                 styles
    js/core.js           shared helpers and consent text
    js/app.js            agent desk logic
    js/signing.js        client canvas and submission
    manifest.webmanifest PWA metadata
    sw.js                offline shell (never caches /api or /sign)
  tools/create-agent.js  create/reset accounts
  tools/test_flow.js     end-to-end test
  render.yaml            Render Blueprint
  .env.example           configuration template
```

## Known limits

- Login limiting is in process memory, not shared between instances.
- There is no password-reset email flow, no email verification and no 2FA. Use the CLI to reset a password.
- WhatsApp and email are share links, not server-side message delivery.
- All administrators can see all consent records. Agents see only their own.
- There is no automatic retention/deletion policy; add one that matches your mandate and local law.
- The service expects a modern browser with `fetch`, `canvas` and pointer events.
