// Database access for the Khusela consent service.
//
// The same two-mode setup as the signature service:
//   TURSO_DATABASE_URL set -> hosted libSQL/Turso (survives redeploys)
//   unset                  -> a local SQLite file, for development and tests
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@libsql/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const STORAGE_DIR = path.resolve(__dirname, process.env.STORAGE_DIR || './storage');
const REMOTE = String(process.env.TURSO_DATABASE_URL || '').trim();
export const USING_REMOTE_DB = !!REMOTE;

if (!REMOTE) fs.mkdirSync(STORAGE_DIR, { recursive: true });

export const DB_URL = REMOTE || 'file:' + path.join(STORAGE_DIR, 'khusela-consent.db');

const client = createClient({
  url: DB_URL,
  authToken: REMOTE ? (process.env.TURSO_AUTH_TOKEN || undefined) : undefined,
});

export async function all(sql, args = []) {
  return (await client.execute({ sql, args })).rows;
}

export async function get(sql, args = []) {
  return (await client.execute({ sql, args })).rows[0] || null;
}

export async function run(sql, args = []) {
  return client.execute({ sql, args });
}

// Statements in one atomic batch: a signature and its audit entry are either
// both stored or neither is.
export async function write(statements) {
  return client.batch(statements, 'write');
}

export async function ddl(statements) {
  for (const sql of statements) await client.execute(sql);
}

export function isUniqueViolation(e) {
  const text = String(e?.cause?.code || e?.code || '') + ' ' + String(e?.message || '');
  return text.includes('UNIQUE');
}
