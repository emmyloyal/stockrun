import { describe, expect, it } from 'vitest';
import { TermiiSms, smsFromEnv } from '../src/accounts/sms.ts';

const fakeFetch = (status: number, body: unknown) => {
  const calls: { url: string; body: Record<string, string> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
};

describe('Termii SMS', () => {
  it('sends the code to 234… without the plus, on the DND route by default', async () => {
    const { f, calls } = fakeFetch(200, { code: 'ok', message_id: '1', message: 'Successfully Sent' });
    await new TermiiSms({ apiKey: 'k', from: 'StockRun', fetch: f }).send('+2348031234567', 'Your StockRun code is 123456.');
    expect(calls[0].url).toBe('https://api.ng.termii.com/api/sms/send');
    expect(calls[0].body).toMatchObject({ api_key: 'k', to: '2348031234567', from: 'StockRun', sms: 'Your StockRun code is 123456.', type: 'plain', channel: 'dnd' });
  });

  it('uses a custom base URL and channel', async () => {
    const { f, calls } = fakeFetch(200, { code: 'ok' });
    await new TermiiSms({ apiKey: 'k', from: 'N-Alert', channel: 'generic', baseUrl: 'https://v3.api.termii.com/', fetch: f }).send('+2349020000000', 'x');
    expect(calls[0].url).toBe('https://v3.api.termii.com/api/sms/send');
    expect(calls[0].body.channel).toBe('generic');
  });

  it('throws with Termii\'s message when the send fails', async () => {
    const { f } = fakeFetch(400, { message: 'Insufficient balance' });
    await expect(new TermiiSms({ apiKey: 'k', from: 'StockRun', fetch: f }).send('+2348031234567', 'x')).rejects.toThrow(/Termii 400: Insufficient balance/);
  });
});

describe('choosing the SMS sender', () => {
  it('prefers Termii, then Twilio, then console only where allowed', () => {
    const twilio = { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_SMS_FROM: '+15550000000' };
    expect(smsFromEnv({ TERMII_API_KEY: 'k', TERMII_SENDER_ID: 'StockRun', ...twilio }, false).kind).toMatch(/^Termii from StockRun \(dnd route\)/);
    expect(smsFromEnv(twilio, false).kind).toMatch(/^Twilio/);
    expect(smsFromEnv({ SMS: 'console' }, false).kind).toMatch(/^console/);
    expect(() => smsFromEnv({ TERMII_API_KEY: 'k' }, false)).toThrow(/No SMS sender/);
  });
});
