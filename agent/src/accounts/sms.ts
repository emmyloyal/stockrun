// SMS for sign-in codes: Termii (Nigeria) or Twilio when configured; otherwise nothing is sent (see smsFromEnv).
import { envValue } from '../chain/platform.ts';
import { ConsoleSms, type SmsSender } from './accounts.ts';

export class TwilioSms implements SmsSender {
  private sid: string; private token: string; private from: string; private fetch: typeof fetch;
  constructor(o: { accountSid: string; authToken: string; from: string; fetch?: typeof fetch }) {
    this.sid = o.accountSid; this.token = o.authToken; this.from = o.from; this.fetch = o.fetch ?? fetch;
  }
  async send(phone: string, text: string): Promise<void> {
    const r = await this.fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.sid)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${this.sid}:${this.token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: phone, From: this.from, Body: text }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({})) as { code?: number; message?: string };
      throw new Error(`SMS not sent (Twilio ${r.status}${j.code ? ` ${j.code}` : ''}: ${j.message ?? 'no detail'})`);
    }
  }
}

/**
 * Termii, a Nigerian SMS gateway (https://developers.termii.com). Numbers go as 234XXXXXXXXXX (no plus).
 * Channel "dnd" reaches numbers on Do-Not-Disturb (most Nigerian lines) but needs a sender ID Termii has approved for
 * it; "generic" works with any sender ID but skips DND lines.
 */
export class TermiiSms implements SmsSender {
  private o: { apiKey: string; from: string; channel: string; baseUrl: string }; private fetch: typeof fetch;
  constructor(o: { apiKey: string; from: string; channel?: string; baseUrl?: string; fetch?: typeof fetch }) {
    this.o = { apiKey: o.apiKey, from: o.from, channel: o.channel || 'dnd', baseUrl: (o.baseUrl || 'https://api.ng.termii.com').replace(/\/+$/, '') };
    this.fetch = o.fetch ?? fetch;
  }
  async send(phone: string, text: string): Promise<void> {
    const r = await this.fetch(`${this.o.baseUrl}/api/sms/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: this.o.apiKey, to: phone.replace(/^\+/, ''), from: this.o.from, sms: text, type: 'plain', channel: this.o.channel }),
    });
    const j = await r.json().catch(() => ({})) as { code?: string; message?: string };
    if (!r.ok || (j.code !== undefined && j.code !== 'ok')) throw new Error(`SMS not sent (Termii ${r.status}: ${j.message ?? 'no detail'})`);
  }
}

/**
 * Termii when TERMII_API_KEY and TERMII_SENDER_ID are set; else Twilio when TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
 * TWILIO_SMS_FROM are set. Otherwise codes are printed on the server console, which is only allowed when
 * `allowConsole` is true (local chain) or SMS=console is set explicitly (a pilot where the operator reads codes out).
 * Never fall back silently on a real network.
 */
export function smsFromEnv(env: NodeJS.ProcessEnv, allowConsole: boolean): { sms: SmsSender; kind: string } {
  const tKey = envValue(env, 'TERMII_API_KEY'), tFrom = envValue(env, 'TERMII_SENDER_ID');
  if (tKey && tFrom) {
    const channel = envValue(env, 'TERMII_CHANNEL') || 'dnd';
    return { sms: new TermiiSms({ apiKey: tKey, from: tFrom, channel, baseUrl: envValue(env, 'TERMII_BASE_URL') }), kind: `Termii from ${tFrom} (${channel} route)` };
  }
  const sid = envValue(env, 'TWILIO_ACCOUNT_SID'), token = envValue(env, 'TWILIO_AUTH_TOKEN'), from = envValue(env, 'TWILIO_SMS_FROM');
  if (sid && token && from) return { sms: new TwilioSms({ accountSid: sid, authToken: token, from }), kind: `Twilio from ${from}` };
  if (allowConsole || envValue(env, 'SMS') === 'console') return { sms: new ConsoleSms(), kind: 'console (codes printed here, no SMS sent)' };
  throw new Error('No SMS sender: set TERMII_API_KEY and TERMII_SENDER_ID (or the TWILIO_* keys), or SMS=console to print codes on this console.');
}
