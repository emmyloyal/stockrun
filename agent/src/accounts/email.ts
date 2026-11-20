// Email for sign-in codes, sent through the Gmail API over HTTPS (Render's free plan blocks the SMTP ports).
// Setup: a Google Cloud OAuth client (Desktop app) with the Gmail API on, then `npm run gmail:auth` once on your
// computer to write GMAIL_REFRESH_TOKEN into .env. The only permission asked for is gmail.send: it cannot read mail.
import { envValue } from '../chain/platform.ts';
import type { EmailSender } from './accounts.ts';

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

/** Encode a header value that may hold non-ASCII text (RFC 2047). */
const header = (v: string) => /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;

/** A plain-text email as the raw RFC 822 message Gmail expects, base64url-encoded. */
export function rawEmail(from: string, to: string, subject: string, text: string): string {
  if (/[\r\n]/.test(from + to + subject)) throw new Error('Email headers cannot contain line breaks');
  const body = Buffer.from(text, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  const msg = [
    `From: ${from}`, `To: ${to}`, `Subject: ${header(subject)}`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body,
  ].join('\r\n');
  return Buffer.from(msg, 'utf8').toString('base64url');
}

export class GmailSender implements EmailSender {
  private o: { clientId: string; clientSecret: string; refreshToken: string; from: string };
  private fetch: typeof fetch;
  private token: { value: string; until: number } | null = null;
  constructor(o: { clientId: string; clientSecret: string; refreshToken: string; from: string; fetch?: typeof fetch }) {
    this.o = { clientId: o.clientId, clientSecret: o.clientSecret, refreshToken: o.refreshToken, from: o.from };
    this.fetch = o.fetch ?? fetch;
  }

  /** A short-lived access token from the refresh token, reused until a minute before it expires. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const r = await this.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.o.clientId, client_secret: this.o.clientSecret, refresh_token: this.o.refreshToken, grant_type: 'refresh_token' }),
    });
    const j = await r.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!r.ok || !j.access_token) {
      throw new Error(`Email not sent (Google sign-in ${r.status}: ${j.error_description ?? j.error ?? 'no detail'}${j.error === 'invalid_grant' ? '. Run npm run gmail:auth again.' : ''})`);
    }
    this.token = { value: j.access_token, until: Date.now() + Math.max(0, (j.expires_in ?? 3600) - 60) * 1000 };
    return j.access_token;
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    const r = await this.fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: rawEmail(this.o.from, to, subject, text) }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({})) as { error?: { message?: string } };
      if (r.status === 401) this.token = null;
      throw new Error(`Email not sent (Gmail ${r.status}: ${j.error?.message ?? 'no detail'})`);
    }
  }
}

/** Development sender: prints emailed codes on the server console. Never use in production. */
export class ConsoleEmail implements EmailSender {
  readonly sent: { to: string; subject: string; text: string }[] = [];
  async send(to: string, subject: string, text: string) { this.sent.push({ to, subject, text }); console.log(`[email to ${to}] ${subject}`); }
}

/**
 * Gmail when GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN and GMAIL_FROM are set. Otherwise the console
 * where `allowConsole` (local chain) or SMS=console is set, and otherwise none: email sign-in is then switched off.
 */
export function emailFromEnv(env: NodeJS.ProcessEnv, allowConsole: boolean): { mail: EmailSender | null; kind: string } {
  const id = envValue(env, 'GMAIL_CLIENT_ID'), secret = envValue(env, 'GMAIL_CLIENT_SECRET');
  const refresh = envValue(env, 'GMAIL_REFRESH_TOKEN'), from = envValue(env, 'GMAIL_FROM');
  if (id && secret && refresh && from) {
    const sender = /</.test(from) ? from : `StockRun <${from}>`;
    return { mail: new GmailSender({ clientId: id, clientSecret: secret, refreshToken: refresh, from: sender }), kind: `Gmail from ${from}` };
  }
  if (allowConsole || envValue(env, 'SMS') === 'console') return { mail: new ConsoleEmail(), kind: 'console (codes printed here, no email sent)' };
  return { mail: null, kind: 'off (set the GMAIL_* keys)' };
}
