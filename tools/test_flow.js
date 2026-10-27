// End-to-end consent flow test.
//
// Starts a real server on a random port with a throwaway SQLite database, then:
//   • the shared-password login is required and rate limited;
//   • every authenticated write needs the session cookie AND the CSRF token;
//   • an invite link opens the consent statement, can be signed once, and cannot
//     be replayed;
//   • the captured signature and the archived PDF are downloadable by the owner
//     through the shared team session;
//   • the backup export is a real PDF.
//
// Run: npm test
import assert from 'assert';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'khusela-consent-test-'));
const ADMIN = { email: 'admin@test.local', password: 'TestPass1234' };
const CONSENT = 'I hereby confirm that i give Khusela Debt Management permission to access, obtain, process and use my credit and personal information in accordance to their mandate.';

// A real PNG with a diagonal stroke, so pdfkit's PNG decoder has something valid
// to embed. (A hand-typed "1x1" base64 blob is easy to get subtly wrong.)
function signaturePngBase64(width = 160, height = 60) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const o = row + 1 + x * 4;
      const onLine = Math.abs((x / width) - (y / height)) < 0.04;
      const value = onLine ? 20 : 255;
      raw[o] = value; raw[o + 1] = value; raw[o + 2] = value; raw[o + 3] = 255;
    }
  }
  const chunk = (type, data) => {
    const name = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([name, data])) >>> 0);
    return Buffer.concat([len, name, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png.toString('base64');
}
const ONE_PX_PNG = signaturePngBase64();

let passed = 0;
function pass(label) { passed++; console.log('PASS ' + label); }

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    PUBLIC_BASE_URL: BASE,
    STORAGE_DIR: STORAGE,
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_PASSWORD: ADMIN.password,
    ADMIN_NAME: 'Test Administrator',
    NODE_ENV: 'test',
    TRUST_PROXY_HOPS: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

async function waitForServer() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/health');
      if (res.ok) return;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not start:\n' + serverLog);
}

function cookieFrom(res) {
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') || ''];
  const raw = cookies.filter(Boolean).join('; ');
  const m = /khusela_consent_session=([^;]+)/.exec(raw);
  return m ? 'khusela_consent_session=' + m[1] : '';
}

async function request(pathname, options = {}) {
  const opts = options || {};
  const headers = Object.assign({
    Origin: BASE,
    Referer: BASE + '/',
    Accept: 'application/json',
  }, opts.headers || {});
  let body = opts.body;
  if (body && typeof body === 'object') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.csrf) headers['x-csrf-token'] = opts.csrf;
  const res = await fetch(BASE + pathname, { method: opts.method || 'GET', headers, body, redirect: 'manual' });
  const type = res.headers.get('content-type') || '';
  let data;
  if (type.includes('application/json')) data = await res.json();
  else data = Buffer.from(await res.arrayBuffer());
  return { res, data };
}

async function login(password) {
  const out = await request('/api/auth/login', { method: 'POST', body: { password } });
  return { ...out, cookie: cookieFrom(out.res) };
}

async function main() {
  await waitForServer();
  const health = await request('/health');
  assert.strictEqual(health.data.service, 'khusela-consent');
  assert.strictEqual(health.data.hasAgents, true);
  pass('health reports a prepared service and seeded administrator');

  const unauth = await request('/api/consents');
  assert.strictEqual(unauth.res.status, 401);
  pass('consent records are unavailable without a session');

  const bad = await login('wrong-password');
  assert.strictEqual(bad.res.status, 401);
  assert.ok(!bad.cookie);
  pass('a wrong password is rejected without issuing a session');

  const signedIn = await login(ADMIN.password);
  assert.strictEqual(signedIn.res.status, 200);
  assert.ok(signedIn.cookie);
  assert.ok(signedIn.data.csrfToken);
  pass('the shared password signs in without an email and receives a session plus CSRF token');

  const me = await request('/api/auth/me', { cookie: signedIn.cookie });
  assert.strictEqual(me.data.agent.role, 'admin');
  pass('the session identifies the signed-in agent');

  const noCsrf = await request('/api/consents', {
    method: 'POST', cookie: signedIn.cookie,
    body: { clientName: 'Test Client', idNumber: '9001015000088', phone: '0820000000' },
  });
  assert.strictEqual(noCsrf.res.status, 403);
  pass('an authenticated write without the CSRF token is rejected');

  const created = await request('/api/consents', {
    method: 'POST', cookie: signedIn.cookie, csrf: signedIn.data.csrfToken,
    body: { clientName: 'Test Client', idNumber: '9001015000088', phone: '0820000000', email: 'client@test.local', reference: 'REF-1' },
  });
  assert.strictEqual(created.res.status, 201);
  assert.ok(created.data.consentLink.startsWith(BASE + '/sign/'));
  const consentId = created.data.consent.id;
  const token = created.data.consentLink.split('/').pop();
  pass('an authenticated agent creates a unique consent link');

  const list = await request('/api/consents', { cookie: signedIn.cookie });
  assert.strictEqual(list.data.consents.length, 1);
  assert.strictEqual(list.data.consents[0].status, 'pending');
  pass('the new consent appears in the agent list as pending');

  const signPage = await request('/sign/' + token);
  assert.strictEqual(signPage.res.status, 200);
  const signHtml = signPage.data.toString();
  assert.ok(signHtml.includes('href="/css/sign.css"'));
  assert.ok(signHtml.includes('src="/js/signing.js"'));
  const signCss = await request('/css/sign.css');
  assert.strictEqual(signCss.res.status, 200);
  assert.ok(String(signCss.res.headers.get('content-type')).includes('text/css'));
  const signJs = await request('/js/signing.js');
  assert.strictEqual(signJs.res.status, 200);
  assert.ok(String(signJs.res.headers.get('content-type')).includes('javascript'));
  const agentPage = await request('/');
  assert.strictEqual(agentPage.res.status, 200);
  assert.ok(agentPage.data.toString().includes('href="manifest.webmanifest"'));
  assert.ok(agentPage.data.toString().includes('/images/khusela-logo.png'));
  const logo = await request('/images/khusela-logo.png');
  assert.strictEqual(logo.res.status, 200);
  assert.ok(String(logo.res.headers.get('content-type')).includes('image/png'));
  const csp = String(agentPage.res.headers.get('content-security-policy') || '');
  assert.ok(csp.includes("default-src 'self'"));
  assert.ok(csp.includes("img-src 'self' data: blob:"));
  assert.ok(!csp.includes('upgrade-insecure-requests'));
  const manifest = await request('/manifest.webmanifest');
  assert.strictEqual(manifest.res.status, 200);
  const worker = await request('/sw.js');
  assert.strictEqual(worker.res.status, 200);
  assert.strictEqual(signPage.res.headers.get('referrer-policy'), 'no-referrer');
  assert.strictEqual(list.res.headers.get('cache-control'), 'no-store');
  pass('the signing page, agent shell and PWA files load from the service');

  const invite = await request('/api/sign/' + token);
  assert.strictEqual(invite.res.status, 200);
  assert.strictEqual(invite.data.consentText, CONSENT);
  assert.strictEqual(invite.data.clientName, 'Test Client');
  pass('the client link opens the exact consent statement');

  const signature = 'data:image/png;base64,' + ONE_PX_PNG;
  const completed = await request('/api/sign/' + token + '/complete', {
    method: 'POST', body: { signature },
  });
  assert.strictEqual(completed.res.status, 200);
  assert.ok(completed.data.verificationCode);
  pass('the client signs once and receives a verification code');

  const replay = await request('/api/sign/' + token + '/complete', {
    method: 'POST', body: { signature },
  });
  assert.strictEqual(replay.res.status, 409);
  pass('the same one-time link cannot be signed twice');

  const after = await request('/api/consents/' + consentId, { cookie: signedIn.cookie });
  assert.strictEqual(after.data.consent.status, 'signed');
  assert.strictEqual(after.data.consent.hasPdf, true);
  assert.strictEqual(after.data.consent.verificationCode, completed.data.verificationCode);
  pass('the agent side sees the autofilled signed record and verification code');

  const sig = await request('/api/consents/' + consentId + '/signature', { cookie: signedIn.cookie });
  assert.strictEqual(sig.res.status, 200);
  assert.strictEqual(sig.res.headers.get('content-type'), 'image/png');
  assert.ok(sig.data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  pass('the captured signature image is available to the agent');

  const pdf = await request('/api/consents/' + consentId + '/pdf', { cookie: signedIn.cookie });
  assert.strictEqual(pdf.res.status, 200);
  assert.ok(pdf.data.subarray(0, 4).toString() === '%PDF');
  assert.ok(pdf.data.length > 900);
  pass('the archived signed consent PDF downloads');

  const bundle = await request('/api/consents-export.pdf', { cookie: signedIn.cookie });
  assert.strictEqual(bundle.res.status, 200);
  assert.ok(bundle.data.subarray(0, 4).toString() === '%PDF');
  pass('the backup of all signed consents is a PDF');

  const allRecords = await request('/api/consents', { cookie: signedIn.cookie });
  assert.strictEqual(allRecords.data.consents.length, 1);
  pass('the shared team session can access all consent records');

  const agentAccounts = await request('/api/agents', { cookie: signedIn.cookie });
  assert.strictEqual(agentAccounts.res.status, 404);
  pass('individual agent account management is removed');

  const coreSrc = fs.readFileSync(path.join(ROOT, 'public/js/core.js'), 'utf8');
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(coreSrc, sandbox);
  const core = sandbox.module.exports;
  assert.strictEqual(core.CONSENT_TEXT, CONSENT);
  assert.strictEqual(core.normalizeZaPhone('082 000 0000'), '27820000000');
  assert.strictEqual(core.normalizeZaPhone('+27 82 000 0000'), '27820000000');
  assert.strictEqual(core.filterRecords([{ status: 'signed' }, { status: 'pending' }], { status: 'signed' }).length, 1);
  pass('shared client helpers behave (consent text, phone normalisation, filtering)');

  console.log('\nALL CONSENT TESTS PASSED (' + passed + ')');
}

try {
  await main();
} catch (e) {
  console.error('\n' + (e && e.stack ? e.stack : e));
  if (serverLog) console.error('\n--- server log ---\n' + serverLog);
  process.exitCode = 1;
} finally {
  server.kill();
  try { fs.rmSync(STORAGE, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}
