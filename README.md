# Khusela Consent

A small, self-contained service for capturing a client's signed consent for Khusela Debt Management to access, obtain, process and use their credit and personal information.

It is deliberately separate from the ITC extractor. It has its own database and signing links. The agent desk and the API are served from the same Express origin, so the session cookie can be `HttpOnly` and `SameSite=Strict` without CORS.

The desk currently uses one shared team password instead of individual logins. Anyone with that password can access every consent record. This is simpler, but it does not identify which team member performed an action.

The signed consent statement is stored per request and is exactly:

> I hereby confirm that i give Khusela Debt Management permission to access, obtain, process and use my credit and personal information in accordance to their mandate.

followed by **Signature:**.

## What it does

1. A team member signs in with the shared password.
2. A team member enters the client's name, ID number and WhatsApp number and/or email address.
3. The service creates a one-time signing link. The agent sends it with the WhatsApp or Email button (the device's share/app link), or copies it.
4. The client opens the link, reads the statement, draws a signature and submits.
5. The agent desk notices the signature, fills in the signed record and offers the archived signed PDF.
6. A signed PDF is generated once at signing time and stored in the database with the signature image, timestamp, signing IP and a verification code. Downloads return that archived PDF, not a fresh rendering.

## Local setup

```powershell
cd C:\Users\ayabo\Downloads\project-hr\consent
npm install
Copy-Item .env.example .env
# Edit .env and set ADMIN_PASSWORD and PUBLIC_BASE_URL
npm start
```

Open `http://localhost:3000`.

Set `ADMIN_PASSWORD` to a strong password with at least 10 characters, including letters and numbers. It is the shared login password; changing it in Render and redeploying changes the password accepted for new logins. Existing sessions remain valid until they expire or are signed out.

The first start creates an internal administrator record when the database is empty. `ADMIN_EMAIL` and `ADMIN_NAME` provide that record's attribution; team members do not enter an email to sign in.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `STORAGE_DIR` | `./storage` | Local SQLite database and nothing else. Ignored when Turso is configured. |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | Public origin used to build signing links. On Render, `RENDER_EXTERNAL_URL` is used automatically. Set this when using a custom domain. |
| `ADMIN_EMAIL` | none | Internal administrator attribution, used only when the agents table is empty. |
| `ADMIN_PASSWORD` | none | Shared team login password. Use a unique password with at least 10 characters, letters and numbers. |
| `ADMIN_NAME` | `Administrator` | Internal administrator attribution, used only when the agents table is empty. |
| `SESSION_HOURS` | `12` | Session lifetime, clamped to 1–168 hours. |
| `TOKEN_EXPIRY_DAYS` | `7` | Consent link lifetime, clamped to 1–30 days. |
| `LOGIN_LIMIT` | `8` | Failed/successful login attempts per IP inside the window. |
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
- All team members use the shared password and have access to every consent record. There is no individual account management.

## Security model

- The shared password is configured as `ADMIN_PASSWORD`, hashed in memory with Node's `scrypt`, and never stored or logged by the service.
- Every team member shares administrator-level access. Anyone who knows the password can view and manage all consent records; actions cannot be attributed to an individual team member.
- Sessions are random 32-byte tokens. Only a SHA-256 hash of the token is stored in the database. The raw token is held in an `HttpOnly`, `SameSite=Strict`, `Secure` (on HTTPS) cookie.
- State-changing requests require a per-session CSRF token (`x-csrf-token`) and a matching origin. The CSRF token is held in JavaScript memory, not in local storage.
- Login attempts are limited per IP in process memory. If more than one instance is ever run, put the limiter in a shared store first.
- Signing links contain a random token. Only its hash is stored, and the raw link is returned only when it is created or renewed. A link is single-use and expires.
- Signatures are stored as image bytes in the database. The signed PDF is stored beside them. API responses are `Cache-Control: no-store`.
- The signing page is served with `Referrer-Policy: no-referrer` so the token is not leaked through referrers.
- The PDF contains a verification code derived from the record identity, signing time and signature image, plus the signing IP for audit. The audit log records consent, signature, PDF access and shared-session login events.
- The PDF is an electronic record of consent. Whether it meets a particular legal or industry standard should be confirmed for your use case; the service is not a qualified electronic-signature provider.

## Data and storage

Tables created by `schema.js`:

- `agents` — internal administrator attribution for shared-password sessions.
- `sessions` — hashed session tokens, CSRF tokens, expiry and revocation.
- `consent_requests` — client details, consent text, hashed link token, status and signing metadata.
- `signatures` — signature image bytes and signing metadata.
- `consent_pdfs` — the archived signed PDF and its SHA-256.
- `audit_log` — append-only events (creation, renewal, signing, downloads, logins, account changes).

Use Turso in production. Render's free disk is ephemeral, so a local SQLite file on Render would be lost on the next deploy or restart. Turso survives redeploys and gives you a managed backup path. Download the signed PDF bundle periodically as a separate, human-readable backup. Retain ID numbers, signatures and contact details only as long as your mandate and applicable law require, and restrict access to administrators.

## Deploy to Render

The folder is a standalone service. Put it in its own Git repository, then:

1. Create a Turso database and copy its URL and auth token.
2. Push this folder to GitHub.
3. In Render, choose **New > Blueprint** and select the repository. `render.yaml` defines the service and prompts for `ADMIN_PASSWORD` and the Turso values.
4. Deploy. The first start creates the internal administrator attribution record.
5. Open the Render URL and sign in with the shared password. If you use a custom domain, set `PUBLIC_BASE_URL` to that exact origin and redeploy.
6. To change the shared password, update `ADMIN_PASSWORD` in Render and redeploy. New logins use the updated password; existing sessions last until they expire or are signed out.

`render.yaml` uses `npm ci`, which requires the committed `package-lock.json`. It is present in this folder.

The free Render web service may spin down when idle. Signing links still work after the cold start, but the first request may be slow.

## Tests

```powershell
npm test
```

The test starts the real server on a random port with a throwaway SQLite database and covers: seeding, shared-password authentication, CSRF and origin checks, record creation, exact consent text, one-time signing and replay rejection, signature retrieval, archived PDF download, backup PDF export, shared access to records, and the shared client helpers. It does not require a browser.

## Project layout

```
consent/
  server.js              Express app and all routes
  auth.js                passwords, sessions, CSRF, origin checks
  db.js                  Turso / local SQLite access
  schema.js              database schema and indexes
  pdf.js                 consent PDF, bundle PDF, consent text
  public/
    index.html           shared-password login and desk
    sign.html            client signing page
    css/                 styles
    js/core.js           shared helpers and consent text
    js/app.js            agent desk logic
    js/signing.js        client canvas and submission
    manifest.webmanifest PWA metadata
    sw.js                offline shell (never caches /api or /sign)
  tools/test_flow.js     end-to-end test
  render.yaml            Render Blueprint
  .env.example           configuration template
```

## Known limits

- Login limiting is in process memory, not shared between instances.
- One shared password provides access to all records; keep it private and rotate it in Render if it is exposed.
- WhatsApp and email are share links, not server-side message delivery.
- There is no automatic retention/deletion policy; add one that matches your mandate and local law.
- The service expects a modern browser with `fetch`, `canvas` and pointer events.
