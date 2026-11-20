// One-time Gmail setup: `npm run gmail:auth` (in agent/). Needs GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env
// (a Google Cloud OAuth client of type "Desktop app"). Opens Google's consent page for the sending Gmail account,
// asks only for permission to SEND mail (plus the account's address, for GMAIL_FROM), and writes GMAIL_REFRESH_TOKEN
// and GMAIL_FROM into .env. The token is never printed.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { envValue } from '../chain/platform.ts';
import { GMAIL_SEND_SCOPE } from './email.ts';

const envPath = fileURLToPath(new URL('../../../.env', import.meta.url));
if (!existsSync(envPath)) throw new Error('No .env file in the repo root.');
process.loadEnvFile(envPath);
const clientId = envValue(process.env, 'GMAIL_CLIENT_ID'), clientSecret = envValue(process.env, 'GMAIL_CLIENT_SECRET');
if (!clientId || !clientSecret) throw new Error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first (Google Cloud > APIs & Services > Credentials > OAuth client, type Desktop app).');

/** Replace (or add) one KEY= line in .env, leaving every other line as it is. */
function setEnvLine(key: string, value: string) {
  const text = readFileSync(envPath, 'utf8'), eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/), i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`; else lines.splice(lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, `${key}=${value}`);
  writeFileSync(envPath, lines.join(eol));
}

const state = randomBytes(16).toString('hex');
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/') { res.writeHead(404).end(); return; }
  const done = (msg: string, ok: boolean) => {
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/plain; charset=utf-8' }).end(msg);
    console.log(msg); server.close(); process.exitCode = ok ? 0 : 1;
  };
  if (url.searchParams.get('state') !== state) return done('That reply did not come from this setup. Run it again.', false);
  const code = url.searchParams.get('code');
  if (!code) return done(`Google said: ${url.searchParams.get('error') ?? 'no code'}. Nothing was saved.`, false);
  const { port } = server.address() as { port: number };
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: `http://127.0.0.1:${port}`, grant_type: 'authorization_code' }),
  });
  const j = await r.json().catch(() => ({})) as { refresh_token?: string; id_token?: string; error?: string; error_description?: string };
  if (!r.ok || !j.refresh_token) return done(`Google did not give a refresh token (${j.error_description ?? j.error ?? r.status}). Nothing was saved.`, false);
  // Which account was this? Google's id_token (straight from Google over HTTPS) names it, so GMAIL_FROM matches the sender.
  let from: string | undefined;
  try { from = (JSON.parse(Buffer.from(String(j.id_token).split('.')[1], 'base64url').toString('utf8')) as { email?: string }).email; } catch { /* set GMAIL_FROM by hand */ }
  setEnvLine('GMAIL_REFRESH_TOKEN', j.refresh_token);
  if (from && /^[^\s@<>]+@[^\s@<>]+$/.test(from)) setEnvLine('GMAIL_FROM', from); else from = undefined;
  done(`Saved GMAIL_REFRESH_TOKEN${from ? ` and GMAIL_FROM=${from}` : ' (now set GMAIL_FROM to the sending Gmail address)'} in .env. You can close this tab.`, true);
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address() as { port: number };
  const auth = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: clientId, redirect_uri: `http://127.0.0.1:${port}`, response_type: 'code', scope: `openid email ${GMAIL_SEND_SCOPE}`,
    access_type: 'offline', prompt: 'consent', state,
  })}`;
  console.log('Opening Google in your browser. Sign in with the Gmail account that will SEND the codes.');
  console.log(`If nothing opens, paste this link into your browser:\n${auth}\n`);
  const open = process.platform === 'win32' ? `start "" "${auth}"` : process.platform === 'darwin' ? `open "${auth}"` : `xdg-open "${auth}"`;
  exec(open, () => {});
});
