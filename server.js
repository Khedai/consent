// Khusela Consent — agent site and signing service.
//
// This is deliberately a separate service from the ITC extractor: its own
// database, its own logins, its own signing links. Every route that reads a
// client's information requires an authenticated agent session, and every
// signed consent has an archived PDF stored beside its signature.
import express from 'express';
import helmet from 'helmet';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { DB_URL, USING_REMOTE_DB, all, get, run, write } from './db.js';
import { prepareDatabase } from './schema.js';
import {
  SESSION_HOURS, now, sha256, randomToken, hashPassword, verifyPassword,
  passwordProblem, setSessionCookie, clearSessionCookie, createSession, sessionFor,
  revokeSession, requireAuth, requireSameOrigin, requireCsrf,
} from './auth.js';
import { buildConsentPdf, buildConsentBundle, verificationCode, CONSENT_TEXT, COMPANY } from './pdf.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const BASE = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ON_RENDER = !!(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL);
const TRUST_PROXY_HOPS = Math.max(0, Number(process.env.TRUST_PROXY_HOPS ?? (ON_RENDER ? 1 : 0)));
const TOKEN_EXPIRY_DAYS = Math.min(30, Math.max(1, Number(process.env.TOKEN_EXPIRY_DAYS || 7)));
const SHARED_PASSWORD_HASH = await hashPassword(process.env.ADMIN_PASSWORD || randomToken(32));

if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(BASE)) {
  console.warn(`WARNING: no public URL is configured. Consent links will point at ${BASE} and only work on this machine.`);
}

async function seedAdmin() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  const agents = await get('SELECT COUNT(*) AS n FROM agents');
  if (!agents.n) {
    if (!email || !password) {
      console.warn('WARNING: no shared team login is configured. Set ADMIN_EMAIL and ADMIN_PASSWORD to initialize the service.');
      return;
    }
    const problem = passwordProblem(password);
    if (problem) {
      console.warn('WARNING: ADMIN_PASSWORD is too weak — ' + problem);
      return;
    }
    await run('INSERT INTO agents(id,email,name,role,password_hash,active,created_at) VALUES(?,?,?,?,?,?,?)',
      [crypto.randomUUID(), email, String(process.env.ADMIN_NAME || 'Administrator'),
        'admin', await hashPassword(password), 1, now()]);
    console.log('Created the first administrator: ' + email);
  }
}

try {
  await prepareDatabase();
  await seedAdmin();
} catch (e) {
  console.error(`\nCould not prepare the consent database at ${DB_URL}`);
  console.error(USING_REMOTE_DB
    ? 'Check TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.'
    : 'Check that the STORAGE_DIR folder exists and is writable.');
  console.error(e.name + ': ' + e.message);
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY_HOPS);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      // Local development is served over plain HTTP, so do not ask the browser
      // to upgrade its own asset requests to https. Render always gets the
      // directive.
      'upgrade-insecure-requests': ON_RENDER ? [] : null,
      'frame-ancestors': ["'none'"],
    },
  },
}));
app.use(express.json({ limit: '2mb' }));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(requireSameOrigin(BASE));

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, {
  index: 'index.html',
  maxAge: 0,
  setHeaders(res, filePath) {
    // The worker must be revalidated so a deploy can replace it.
    if (path.basename(filePath) === 'sw.js') res.setHeader('Cache-Control', 'no-cache');
  },
}));

function wrap(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }
function audit(consentId, agentId, event, req, meta = {}) {
  return run('INSERT INTO audit_log(consent_id,agent_id,event,created_at,ip,user_agent,meta) VALUES(?,?,?,?,?,?,?)',
    [consentId || null, agentId || null, event, now(), req.ip, req.get('user-agent') || '', JSON.stringify(meta)]);
}

// ── Brute-force limiter ──────────────────────────────────────────────────────
// The counter is per address in this process; a restart forgets it.
const LOGIN_LIMIT = Math.max(3, Number(process.env.LOGIN_LIMIT || 8));
const LOGIN_WINDOW_MS = Math.max(60000, Number(process.env.LOGIN_WINDOW_MS || 15 * 60 * 1000));
const loginHits = new Map();
setInterval(() => {
  const t = Date.now();
  for (const [k, e] of loginHits) if (t - e.start >= LOGIN_WINDOW_MS) loginHits.delete(k);
}, LOGIN_WINDOW_MS).unref();

function loginKey(req) {
  return String(req.ip || 'unknown');
}

function loginRate(req, res, next) {
  const key = loginKey(req);
  const t = Date.now();
  let e = loginHits.get(key);
  if (!e || t - e.start >= LOGIN_WINDOW_MS) { e = { start: t, n: 0 }; loginHits.set(key, e); }
  e.n++;
  if (e.n <= LOGIN_LIMIT) return next();
  const wait = Math.max(1, Math.ceil((e.start + LOGIN_WINDOW_MS - t) / 1000));
  res.setHeader('Retry-After', String(wait));
  return res.status(429).json({ error: `Too many sign-in attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` });
}

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const MAX_SIGNATURE_BYTES = Math.floor(1.5 * 1024 * 1024);

function text(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function consentPublic(row) {
  return {
    id: row.id,
    clientName: row.client_name,
    idNumber: row.id_number,
    phone: row.phone || '',
    email: row.email || '',
    reference: row.reference || '',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
    signedAt: row.signed_at || null,
    verificationCode: row.verification_code || null,
    hasSignature: !!row.has_signature,
    hasPdf: !!row.has_pdf,
    agentName: row.agent_name || null,
  };
}

function canSee(agent, row) {
  return agent.role === 'admin' || row.agent_id === agent.id;
}

// ── Health ──────────────────────────────────────────────────────────────────
app.get('/health', wrap(async (req, res) => {
  const agents = await get('SELECT COUNT(*) AS n FROM agents');
  res.json({ ok: true, service: 'khusela-consent', build: process.env.RENDER_GIT_COMMIT || 'local', database: USING_REMOTE_DB ? 'remote' : 'local', hasAgents: !!agents.n, time: now() });
}));

// ── Authentication ──────────────────────────────────────────────────────────
app.post('/api/auth/login', loginRate, wrap(async (req, res) => {
  const password = String((req.body && req.body.password) || '');
  if (!password) return res.status(400).json({ error: 'Enter the shared password.' });
  const agent = await get("SELECT * FROM agents WHERE role = 'admin' AND active = 1 ORDER BY created_at LIMIT 1");
  const passwordOk = await verifyPassword(password, SHARED_PASSWORD_HASH);
  const ok = !!agent && passwordOk;
  if (!ok) {
    await audit(null, agent ? agent.id : null, 'login_failed', req, {});
    return res.status(401).json({ error: 'Password is incorrect.' });
  }
  loginHits.delete(loginKey(req));
  const session = await createSession(agent.id, req);
  setSessionCookie(res, session.token, BASE);
  await audit(null, agent.id, 'login_success', req, {});
  res.json({
    ok: true,
    agent: { id: agent.id, email: agent.email, name: agent.name, role: agent.role },
    csrfToken: session.csrf,
    expiresAt: session.expiresAt,
    sessionHours: SESSION_HOURS,
  });
}));

app.post('/api/auth/logout', requireAuth(), requireCsrf(), wrap(async (req, res) => {
  await revokeSession(req);
  clearSessionCookie(res, BASE);
  await audit(null, req.agent.id, 'logout', req, {});
  res.json({ ok: true });
}));

app.get('/api/auth/me', wrap(async (req, res) => {
  const session = await sessionFor(req);
  if (!session) return res.status(401).json({ error: 'Not signed in.' });
  res.json({
    ok: true,
    agent: { id: session.agent_id, email: session.email, name: session.name, role: session.role },
    csrfToken: session.csrf_token,
    sessionHours: SESSION_HOURS,
  });
}));

// ── Consent requests (agent side; authenticated) ────────────────────────────
app.post('/api/consents', requireAuth(), requireCsrf(), wrap(async (req, res) => {
  const b = req.body || {};
  const clientName = text(b.clientName, 120);
  const idNumber = text(b.idNumber, 30);
  const phone = text(b.phone, 30);
  const email = text(b.email, 200).toLowerCase();
  const reference = text(b.reference, 80);
  if (!clientName) return res.status(400).json({ error: 'Enter the client name.' });
  if (!idNumber) return res.status(400).json({ error: 'Enter the client ID number.' });
  if (!phone && !email) return res.status(400).json({ error: 'Enter a WhatsApp number or an email address.' });
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });

  const token = randomToken(32);
  const id = crypto.randomUUID();
  const created = now();
  const expires = new Date(Date.now() + TOKEN_EXPIRY_DAYS * 86400000).toISOString();
  await run(
    `INSERT INTO consent_requests(id,agent_id,client_name,id_number,phone,email,reference,consent_text,token_hash,created_at,expires_at,status)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending')`,
    [id, req.agent.id, clientName, idNumber, phone, email, reference, CONSENT_TEXT, sha256(token), created, expires],
  );
  await audit(id, req.agent.id, 'consent_created', req, { expires });
  res.status(201).json({
    ok: true,
    consent: {
      id, clientName, idNumber, phone, email, reference,
      createdAt: created, expiresAt: expires, status: 'pending',
    },
    consentLink: BASE + '/sign/' + token,
  });
}));

app.post('/api/consents/:id/renew', requireAuth(), requireCsrf(), wrap(async (req, res) => {
  const row = await get('SELECT * FROM consent_requests WHERE id = ?', [String(req.params.id || '')]);
  if (!row || !canSee(req.agent, row)) return res.status(404).json({ error: 'Consent request not found.' });
  if (row.status === 'signed') return res.status(400).json({ error: 'A signed consent cannot be given a new link.' });
  const token = randomToken(32);
  const created = now();
  const expires = new Date(Date.now() + TOKEN_EXPIRY_DAYS * 86400000).toISOString();
  await run("UPDATE consent_requests SET token_hash=?, created_at=?, expires_at=?, used_at=NULL, status='pending' WHERE id=?",
    [sha256(token), created, expires, row.id]);
  await audit(row.id, req.agent.id, 'consent_renewed', req, { expires });
  res.json({
    ok: true,
    consentLink: BASE + '/sign/' + token,
    consent: { id: row.id, createdAt: created, expiresAt: expires, status: 'pending' },
  });
}));

app.get('/api/consents', requireAuth(), wrap(async (req, res) => {
  const admin = req.agent.role === 'admin';
  const rows = await all(
    `SELECT c.*, a.name AS agent_name,
            CASE WHEN s.id IS NULL THEN 0 ELSE 1 END AS has_signature,
            CASE WHEN p.consent_id IS NULL THEN 0 ELSE 1 END AS has_pdf
       FROM consent_requests c
       LEFT JOIN agents a ON a.id = c.agent_id
       LEFT JOIN signatures s ON s.consent_id = c.id
       LEFT JOIN consent_pdfs p ON p.consent_id = c.id
      ${admin ? '' : 'WHERE c.agent_id = ?'}
      ORDER BY c.created_at DESC LIMIT 500`,
    admin ? [] : [req.agent.id],
  );
  // Expire links that were never used, so the list tells the truth.
  const stale = rows.filter((r) => r.status === 'pending' && Date.now() > Date.parse(r.expires_at));
  if (stale.length) {
    await Promise.all(stale.map((r) => run("UPDATE consent_requests SET status='expired' WHERE id=? AND status='pending'", [r.id])));
    stale.forEach((r) => { r.status = 'expired'; });
  }
  res.json({ ok: true, consents: rows.map(consentPublic) });
}));

app.get('/api/consents/:id', requireAuth(), wrap(async (req, res) => {
  const row = await get(
    `SELECT c.*, a.name AS agent_name,
            CASE WHEN s.id IS NULL THEN 0 ELSE 1 END AS has_signature,
            CASE WHEN p.consent_id IS NULL THEN 0 ELSE 1 END AS has_pdf
       FROM consent_requests c
       LEFT JOIN agents a ON a.id = c.agent_id
       LEFT JOIN signatures s ON s.consent_id = c.id
       LEFT JOIN consent_pdfs p ON p.consent_id = c.id
      WHERE c.id = ?`,
    [String(req.params.id || '')],
  );
  if (!row || !canSee(req.agent, row)) return res.status(404).json({ error: 'Consent request not found.' });
  if (row.status === 'pending' && Date.now() > Date.parse(row.expires_at)) {
    await run("UPDATE consent_requests SET status='expired' WHERE id=? AND status='pending'", [row.id]);
    row.status = 'expired';
  }
  res.json({ ok: true, consent: consentPublic(row) });
}));

app.get('/api/consents/:id/signature', requireAuth(), wrap(async (req, res) => {
  const row = await get('SELECT * FROM consent_requests WHERE id = ?', [String(req.params.id || '')]);
  if (!row || !canSee(req.agent, row)) return res.status(404).json({ error: 'Consent request not found.' });
  const sig = await get('SELECT signature_data FROM signatures WHERE consent_id = ?', [row.id]);
  if (!sig || !sig.signature_data) return res.status(404).json({ error: 'This consent has not been signed yet.' });
  const bytes = Buffer.from(sig.signature_data);
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  await audit(row.id, req.agent.id, 'signature_viewed', req, {});
  res.setHeader('Content-Type', isJpeg ? 'image/jpeg' : 'image/png');
  res.setHeader('Cache-Control', 'no-store');
  res.send(bytes);
}));

app.get('/api/consents/:id/pdf', requireAuth(), wrap(async (req, res) => {
  const row = await get('SELECT * FROM consent_requests WHERE id = ?', [String(req.params.id || '')]);
  if (!row || !canSee(req.agent, row)) return res.status(404).json({ error: 'Consent request not found.' });
  const pdf = await get('SELECT pdf FROM consent_pdfs WHERE consent_id = ?', [row.id]);
  if (!pdf || !pdf.pdf) return res.status(404).json({ error: 'There is no signed PDF for this consent yet.' });
  await audit(row.id, req.agent.id, 'pdf_downloaded', req, {});
  const name = (row.client_name || 'client').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Khusela-Consent-${name || row.id}.pdf"`);
  res.send(Buffer.from(pdf.pdf));
}));

app.get('/api/consents-export.pdf', requireAuth(), wrap(async (req, res) => {
  const admin = req.agent.role === 'admin';
  const rows = await all(
    `SELECT c.*, s.signature_data
       FROM consent_requests c JOIN signatures s ON s.consent_id = c.id
      ${admin ? '' : 'WHERE c.agent_id = ?'}
      ORDER BY c.signed_at`,
    admin ? [] : [req.agent.id],
  );
  const withData = rows.map((r) => ({ ...r, signature_data_url: 'data:image/png;base64,' + Buffer.from(r.signature_data).toString('base64') }));
  const pdf = await buildConsentBundle(withData);
  await audit(null, req.agent.id, 'backup_downloaded', req, { count: withData.length });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="Khusela-Signed-Consents.pdf"');
  res.send(pdf);
}));

// ── Client signing (public, tokenised, one-time) ────────────────────────────
async function getInvite(token) {
  if (!token) return null;
  const row = await get('SELECT * FROM consent_requests WHERE token_hash = ?', [sha256(token)]);
  if (!row) return null;
  if (row.used_at || row.status === 'signed') return { ...row, invalidReason: 'already_signed' };
  if (row.status === 'expired') return { ...row, invalidReason: 'expired' };
  if (Date.now() > Date.parse(row.expires_at)) return { ...row, invalidReason: 'expired' };
  return row;
}

app.get('/sign/:token', (req, res) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(publicDir, 'sign.html'));
});

app.get('/api/sign/:token', wrap(async (req, res) => {
  const inv = await getInvite(req.params.token);
  if (!inv) return res.status(404).json({ error: 'This consent link was not found.' });
  if (inv.invalidReason === 'expired') return res.status(410).json({ error: 'This consent link has expired. Please ask the agent for a new one.' });
  if (inv.invalidReason === 'already_signed') return res.status(410).json({ error: 'This consent has already been signed. Thank you.' });
  res.json({
    ok: true,
    clientName: inv.client_name,
    reference: inv.reference || '',
    consentText: inv.consent_text || CONSENT_TEXT,
    company: COMPANY,
    expiresAt: inv.expires_at,
  });
}));

app.post('/api/sign/:token/complete', wrap(async (req, res) => {
  const inv = await getInvite(req.params.token);
  if (!inv) return res.status(404).json({ error: 'This consent link was not found.' });
  if (inv.invalidReason === 'expired') return res.status(410).json({ error: 'This consent link has expired. Please ask the agent for a new one.' });
  if (inv.invalidReason === 'already_signed') return res.status(409).json({ error: 'This consent has already been signed. Thank you.' });

  const dataUrl = String((req.body && req.body.signature) || '');
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return res.status(400).json({ error: 'Please draw your signature before submitting.' });
  const bytes = Buffer.from(m[2], 'base64');
  if (!bytes.length || bytes.length > MAX_SIGNATURE_BYTES) {
    return res.status(400).json({ error: 'That signature image is too large. Please clear it and sign again.' });
  }
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!png && !jpeg) return res.status(400).json({ error: 'That signature image is not valid. Please clear it and sign again.' });

  const signedAt = now();
  const signedIp = req.ip;
  const code = verificationCode({ ...inv, signed_at: signedAt }, bytes);
  const signatureDataUrl = 'data:image/' + m[1].toLowerCase() + ';base64,' + m[2];

  let pdf;
  try {
    pdf = await buildConsentPdf({
      ...inv, signed_at: signedAt, signed_ip: signedIp, verification_code: code,
      signature_data_url: signatureDataUrl,
    });
  } catch (e) {
    console.error('consent PDF generation failed: ' + (e && e.message ? e.message : e));
    return res.status(500).json({ error: 'The consent could not be archived. Please try again.' });
  }

  try {
    await write([
      {
        sql: 'INSERT INTO signatures(id,consent_id,signature_data,signed_at,ip,user_agent) VALUES(?,?,?,?,?,?)',
        args: [crypto.randomUUID(), inv.id, bytes, signedAt, signedIp, req.get('user-agent') || ''],
      },
      {
        sql: "UPDATE consent_requests SET used_at=?,status='signed',signed_at=?,signed_ip=?,signed_user_agent=?,verification_code=? WHERE id=? AND used_at IS NULL",
        args: [signedAt, signedAt, signedIp, req.get('user-agent') || '', code, inv.id],
      },
      {
        sql: 'INSERT INTO consent_pdfs(consent_id,pdf,sha256,created_at) VALUES(?,?,?,?)',
        args: [inv.id, pdf, sha256(pdf), signedAt],
      },
      {
        sql: 'INSERT INTO audit_log(consent_id,agent_id,event,created_at,ip,user_agent,meta) VALUES(?,?,?,?,?,?,?)',
        args: [inv.id, inv.agent_id, 'client_signed', signedAt, signedIp, req.get('user-agent') || '', JSON.stringify({ verificationCode: code, xff: req.get('x-forwarded-for') || null })],
      },
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) return res.status(409).json({ error: 'This consent has already been signed. Thank you.' });
    throw e;
  }

  res.json({
    ok: true,
    signedAt,
    verificationCode: code,
    message: 'Consent recorded and signed successfully. Thank you — you can close this window.',
  });
}));

// ── Errors ──────────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: status >= 500 ? 'The consent service could not complete that request.' : (err.message || 'Request failed.') });
});

app.listen(PORT, () => console.log(`Khusela consent service listening on ${BASE}`));
