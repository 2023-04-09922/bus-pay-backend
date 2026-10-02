import { Logger } from '@nestjs/common';

import { BeemSmsProvider, localStatusFromBeem } from './beem-sms.provider';

const API_KEY = 'beem-unit-api-key';
const SECRET = 'beem-unit-secret';

describe('Beem delivery status', () => {
  it('treats acceptance as sent until a delivery report says delivered', () => {
    expect(localStatusFromBeem('accepted')).toBe('SENT');
    expect(localStatusFromBeem('PENDING')).toBe('SENT');
    expect(localStatusFromBeem('DELIVERED')).toBe('DELIVERED');
    expect(localStatusFromBeem('UNDELIVERED')).toBe('FAILED');
  });
});

describe('BeemSmsProvider', () => {
  const originalFetch = global.fetch;
  const original = {
    BEEM_API_KEY: process.env.BEEM_API_KEY,
    BEEM_SECRET_KEY: process.env.BEEM_SECRET_KEY,
    BEEM_SENDER_ID: process.env.BEEM_SENDER_ID,
    BEEM_SMS_API_KEY: process.env.BEEM_SMS_API_KEY,
    BEEM_SMS_SECRET_KEY: process.env.BEEM_SMS_SECRET_KEY,
    BEEM_SMS_SENDER_NAME: process.env.BEEM_SMS_SENDER_NAME,
    BEEM_SMS_BASE_URL: process.env.BEEM_SMS_BASE_URL,
  };

  beforeEach(() => {
    process.env.BEEM_API_KEY = API_KEY;
    process.env.BEEM_SECRET_KEY = SECRET;
    process.env.BEEM_SENDER_ID = 'BUSPAY';
    delete process.env.BEEM_SMS_API_KEY;
    delete process.env.BEEM_SMS_SECRET_KEY;
    delete process.env.BEEM_SMS_SENDER_NAME;
    process.env.BEEM_SMS_BASE_URL = 'https://beem.test/v1';
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.restoreAllMocks();
  });

  function mockFetch(response: { ok: boolean; status: number; body: unknown }) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: response.ok,
      status: response.status,
      text: async () => JSON.stringify(response.body),
    }) as unknown as typeof fetch;
  }

  it('submits one SMS and returns the Beem request id without marking delivery', async () => {
    const outboxId = 'd171d984-3a87-4b81-9ef9-6e72fb5f04d8';
    mockFetch({
      ok: true,
      status: 200,
      body: {
        successful: true,
        request_id: 67,
        message: 'Message Submitted Successfully',
      },
    });
    const result = await new BeemSmsProvider().send(
      '0712345678',
      'Bus Pay test',
      outboxId,
    );
    expect(result).toEqual({
      ok: true,
      provider: 'beem',
      requestId: '67',
      providerStatus: 'accepted',
    });
    expect(result.requestId).not.toBe(outboxId);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://beem.test/v1/send');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization.startsWith('Basic ')).toBe(true);
    expect(headers.Authorization).not.toContain(API_KEY);
    expect(headers.Authorization).not.toContain(SECRET);
    const body = init.body;
    if (typeof body !== 'string') {
      throw new Error('expected a JSON request body');
    }
    const payload = JSON.parse(body) as {
      source_addr: string;
      encoding: number;
      schedule_time: string;
      message: string;
      recipients: { recipient_id: unknown; dest_addr: string }[];
    };
    expect(payload).toEqual({
      source_addr: 'BUSPAY',
      encoding: 0,
      schedule_time: '',
      message: 'Bus Pay test',
      recipients: [{ recipient_id: 1, dest_addr: '255712345678' }],
    });
    expect(payload.recipients[0].recipient_id).not.toBe(outboxId);
    expect(body).not.toContain(outboxId);
  });

  it('rejects an invalid phone number before calling Beem', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    const result = await new BeemSmsProvider().send('123', 'Bus Pay test', '1');
    expect(result.error).toBe('Invalid Tanzanian phone number');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns a safe error when Beem rejects the request', async () => {
    mockFetch({
      ok: false,
      status: 400,
      body: { code: 111, message: 'Invalid Sender Id' },
    });
    const result = await new BeemSmsProvider().send(
      '+255712345678',
      'Bus Pay test',
      '1',
    );
    expect(result).toEqual({
      ok: false,
      provider: 'beem',
      error: 'Invalid Sender Id',
    });
  });

  it('returns a timeout error', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    global.fetch = jest.fn().mockRejectedValue(timeout) as unknown as typeof fetch;
    const result = await new BeemSmsProvider().send(
      '+255712345678',
      'Bus Pay test',
      '1',
    );
    expect(result).toMatchObject({
      ok: false,
      provider: 'beem',
      error: 'Beem request timed out',
      uncertain: true,
    });
    expect(result.retryable).toBeUndefined();
  });

  it('keeps HTTP 429 uncertain instead of scheduling another Beem send', async () => {
    mockFetch({ ok: false, status: 429, body: { message: 'Slow down' } });
    const result = await new BeemSmsProvider().send(
      '+255712345678',
      'Bus Pay test',
      '1',
    );
    expect(result.uncertain).toBe(true);
    expect(result.retryable).toBeUndefined();
  });

  it('keeps HTTP 500 uncertain instead of scheduling another Beem send', async () => {
    mockFetch({ ok: false, status: 500, body: { message: 'upstream' } });
    const result = await new BeemSmsProvider().send(
      '+255712345678',
      'Bus Pay test',
      '1',
    );
    expect(result.uncertain).toBe(true);
    expect(result.retryable).toBeUndefined();
  });

  it('selects the delivery report that matches the request id', async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: [
        { dest_addr: '255700000001', status: 'DELIVERED', request_id: '1' },
        { dest_addr: '255712345678', status: 'PENDING', request_id: '67' },
      ],
    });
    const result = await new BeemSmsProvider().fetchDelivery('+255712345678', '67');
    expect(result).toMatchObject({
      ok: true,
      provider: 'beem',
      requestId: '67',
      providerStatus: 'PENDING',
    });
  });

  it('fails before HTTP when the API key is missing', async () => {
    delete process.env.BEEM_API_KEY;
    global.fetch = jest.fn() as unknown as typeof fetch;
    const result = await new BeemSmsProvider().send(
      '+255712345678',
      'Bus Pay test',
      '1',
    );
    expect(result.error).toBe('BEEM_API_KEY is not configured');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fails before HTTP when the secret key is missing', async () => {
    delete process.env.BEEM_SECRET_KEY;
    global.fetch = jest.fn() as unknown as typeof fetch;
    const result = await new BeemSmsProvider().send(
      '+255712345678',
      'Bus Pay test',
      '1',
    );
    expect(result.error).toBe('BEEM_SECRET_KEY is not configured');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fails before HTTP when the sender ID is missing', async () => {
    delete process.env.BEEM_SENDER_ID;
    global.fetch = jest.fn() as unknown as typeof fetch;
    const result = await new BeemSmsProvider().send(
      '+255712345678',
      'Bus Pay test',
      '1',
    );
    expect(result.error).toBe('BEEM_SENDER_ID is not configured');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('never writes credentials into logs', async () => {
    const lines: string[] = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message) => {
      lines.push(String(message));
    });
    const token = Buffer.from(`${API_KEY}:${SECRET}`).toString('base64');
    mockFetch({
      ok: false,
      status: 401,
      body: { message: `Unauthorized ${API_KEY} ${SECRET} Basic ${token}` },
    });
    const result = await new BeemSmsProvider().send(
      '+255712345678',
      'Bus Pay test',
      '1',
    );
    const logged = lines.join('\n');
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(token);
    expect(result.error).not.toContain(API_KEY);
    expect(result.error).not.toContain(SECRET);
    expect(result.error).not.toContain(token);
  });
});
