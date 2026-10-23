// Passwords, sessions and the small amount of middleware that stands between
// the internet and a client's personal information.
//
// Passwords are never stored or logged: scrypt with a random 16-byte salt, and
// verification compares fixed-length digests with timingSafeEqual. A login
// creates a random 32-byte session token; only its SHA-256 hash is stored, so a
// copy of the database cannot be replayed as a live session. The token travels
// in an HttpOnly, SameSite=Strict cookie — JavaScript on the page cannot read it.
import crypto from 'crypto';
import { promisify } from 'util';
import { get, run } from './db.js';

const scrypt = promisify(crypto.scrypt);

export const SESSION_COOKIE = 'khusela_consent_session';
export const SESSION_HOURS = Math.min(168, Math.max(1, Number(process.env.SESSION_HOURS || 12)));
const SESSION_MS = SESSION_HOURS * 60 * 60 * 1000;
const KEYLEN = 64;

export function now() {
  return new Date().toISOString();
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password), salt, KEYLEN);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  let actual;
  try {
    actual = await scrypt(String(password), salt, expected.length);
  } catch (e) {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function passwordProblem(password) {
  const p = String(password || '');
  if (p.length < 10) return 'Use a password of at least 10 characters.';
  if (p.length > 200) return 'That password is too long.';
  if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) return 'Use letters and at least one number.';
  return '';
}

export function cookieValue(req, name) {
  const header = String((req.headers && req.headers.cookie) || '');
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return ''; }
    }
  }
  return '';
}

export function setSessionCookie(res, token, base) {
  const secure = /^https:/i.test(base) || process.env.NODE_ENV === 'production';
  const bits = [
    SESSION_COOKIE + '=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=' + Math.floor(SESSION_MS / 1000),
  ];
  if (secure) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

export function clearSessionCookie(res, base) {
  const secure = /^https:/i.test(base) || process.env.NODE_ENV === 'production';
  const bits = [
    SESSION_COOKIE + '=',
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ];
  if (secure) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

export async function createSession(agentId, req) {
  const token = randomToken(32);
  const csrf = randomToken(32);
  const created = new Date();
  const expires = new Date(created.getTime() + SESSION_MS);
  await run(
    'INSERT INTO sessions(id,agent_id,token_hash,csrf_token,created_at,expires_at,ip,user_agent) VALUES(?,?,?,?,?,?,?,?)',
    [crypto.randomUUID(), agentId, sha256(token), csrf, created.toISOString(), expires.toISOString(),
      req.ip || '', req.get('user-agent') || ''],
  );
  return { token, csrf, expiresAt: expires.toISOString() };
}

export async function sessionFor(req) {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token) return null;
  const row = await get(
    `SELECT s.id AS session_id, s.csrf_token, s.expires_at, s.agent_id,
            a.email, a.name, a.role, a.active
       FROM sessions s JOIN agents a ON a.id = s.agent_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL`,
    [sha256(token)],
  );
  if (!row) return null;
  if (Date.now() > Date.parse(row.expires_at) || !row.active) {
    await run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [now(), row.session_id]);
    return null;
  }
  return row;
}

export async function revokeSession(req) {
  const token = cookieValue(req, SESSION_COOKIE);
  if (token) await run('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?', [now(), sha256(token)]);
}

export function requireAuth() {
  return async (req, res, next) => {
    try {
      const session = await sessionFor(req);
      if (!session) return res.status(401).json({ error: 'Please sign in again.' });
      req.session = session;
      req.agent = { id: session.agent_id, email: session.email, name: session.name, role: session.role };
      next();
    } catch (e) {
      next(e);
    }
  };
}

// State-changing requests must come from this site. SameSite=Strict already
// stops another site's form from carrying the session cookie; this also rejects
// a forged Origin, and the per-session CSRF token stops a same-site script from
// acting with a cookie it cannot read. GET requests are not checked because they
// must not change anything.
export function requireSameOrigin(base) {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = String(req.get('origin') || '');
    const referer = String(req.get('referer') || '');
    const originOk = !origin || origin === base;
    const refererOk = !referer || referer.startsWith(base + '/') || referer === base;
    if (!originOk || !refererOk) return res.status(403).json({ error: 'Request origin rejected.' });
    next();
  };
}

export function requireCsrf() {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const presented = String(req.get('x-csrf-token') || '');
    const expected = String((req.session && req.session.csrf_token) || '');
    if (!presented || !expected) return res.status(403).json({ error: 'CSRF token missing.' });
    const a = Buffer.from(sha256(presented), 'hex');
    const b = Buffer.from(sha256(expected), 'hex');
    if (!crypto.timingSafeEqual(a, b)) return res.status(403).json({ error: 'CSRF token rejected.' });
    next();
  };
}
