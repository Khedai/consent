// The consent database schema, in one place so the server and the account
// management tool cannot disagree about what a fresh database looks like.
import { ddl, run } from './db.js';

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS agents(
   id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
   role TEXT NOT NULL DEFAULT 'agent', password_hash TEXT NOT NULL,
   active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions(
   id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
   csrf_token TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
   revoked_at TEXT, ip TEXT, user_agent TEXT)`,
  `CREATE TABLE IF NOT EXISTS consent_requests(
   id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, client_name TEXT NOT NULL,
   id_number TEXT NOT NULL, phone TEXT, email TEXT, reference TEXT,
   consent_text TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
   created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT,
   status TEXT NOT NULL DEFAULT 'pending', signed_at TEXT, signed_ip TEXT,
   signed_user_agent TEXT, verification_code TEXT)`,
  `CREATE TABLE IF NOT EXISTS signatures(
   id TEXT PRIMARY KEY, consent_id TEXT UNIQUE NOT NULL, signature_data BLOB NOT NULL,
   signed_at TEXT NOT NULL, ip TEXT, user_agent TEXT)`,
  `CREATE TABLE IF NOT EXISTS consent_pdfs(
   consent_id TEXT PRIMARY KEY, pdf BLOB NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit_log(
   id INTEGER PRIMARY KEY AUTOINCREMENT, consent_id TEXT, agent_id TEXT,
   event TEXT NOT NULL, created_at TEXT NOT NULL, ip TEXT, user_agent TEXT, meta TEXT)`,
];

export async function prepareDatabase() {
  await ddl(SCHEMA);
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash)');
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_consent_token ON consent_requests(token_hash)');
  await run('CREATE INDEX IF NOT EXISTS idx_consent_agent ON consent_requests(agent_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_consent_status ON consent_requests(status)');
}
