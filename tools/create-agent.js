// Create, reset or deactivate an agent account.
//
//   npm run create-agent -- agent@example.com "a-long-password" "Agent Name" agent
//   npm run create-agent -- admin@example.com "a-long-password" "Administrator" admin
//
// Running it again for an existing email resets that account's password, name
// and role, and reactivates it. Nothing is printed except the outcome — never
// the password.
import 'dotenv/config';
import crypto from 'crypto';
import { get, run } from '../db.js';
import { prepareDatabase } from '../schema.js';
import { hashPassword, passwordProblem, now } from '../auth.js';

const [emailArg, password, nameArg, roleArg] = process.argv.slice(2);
const email = String(emailArg || '').trim().toLowerCase();
const name = String(nameArg || '').trim() || 'Agent';
const role = roleArg === 'admin' ? 'admin' : 'agent';

function die(message) {
  console.error(message);
  process.exit(1);
}

if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email)) die('Usage: npm run create-agent -- email "password" "Full Name" [agent|admin]');
const problem = passwordProblem(password);
if (problem) die(problem);

await prepareDatabase();
const existing = await get('SELECT id FROM agents WHERE email = ?', [email]);
if (existing) {
  await run('UPDATE agents SET name=?, role=?, password_hash=?, active=1 WHERE id=?',
    [name, role, await hashPassword(password), existing.id]);
  await run('UPDATE sessions SET revoked_at=? WHERE agent_id=? AND revoked_at IS NULL', [now(), existing.id]);
  console.log(`Updated ${role} account and revoked old sessions: ${email}`);
} else {
  await run('INSERT INTO agents(id,email,name,role,password_hash,active,created_at) VALUES(?,?,?,?,?,?,?)',
    [crypto.randomUUID(), email, name, role, await hashPassword(password), 1, now()]);
  console.log(`Created ${role} account: ${email}`);
}
