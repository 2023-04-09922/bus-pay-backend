import { Logger } from '@nestjs/common';

import { MockSmsProvider } from './mock-sms.provider';
import { resolveSmsProvider } from './sms-provider';
import { SwalaSmsProvider } from './swala-sms.provider';

const SENTINEL_KEY = 'swl_test_unit_key_not_real';

describe('SMS provider selection', () => {
  const original = process.env.SMS_PROVIDER;

  afterEach(() => {
    if (original === undefined) delete process.env.SMS_PROVIDER;
    else process.env.SMS_PROVIDER = original;
  });

  it('selects mock when SMS_PROVIDER=mock', () => {
    process.env.SMS_PROVIDER = 'mock';
    expect(resolveSmsProvider()).toBe('mock');
  });

  it('selects swala when SMS_PROVIDER=swala', () => {
    process.env.SMS_PROVIDER = 'swala';
    expect(resolveSmsProvider()).toBe('swala');
  });

  it('keeps beem available when SMS_PROVIDER=beem', () => {
    process.env.SMS_PROVIDER = 'beem';
    expect(resolveSmsProvider()).toBe('beem');
  });

  it('stays on mock when SMS_PROVIDER is unset', () => {
    delete process.env.SMS_PROVIDER;
    expect(resolveSmsProvider()).toBe('mock');
  });
});

describe('MockSmsProvider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('does not call the network', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const result = await new MockSmsProvider().send(
      '+255712345678',
      'hello',
      '11111111-1111-1111-1111-111111111111',
    );
    expect(result).toMatchObject({
      ok: true,
      provider: 'mock',
      mocked: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid phone number', async () => {
    const result = await new MockSmsProvider().send(
      '123',
      'hello',
      '11111111-1111-1111-1111-111111111111',
    );
    expect(result.ok).toBe(false);
  });
});

describe('SwalaSmsProvider', () => {
  const originalFetch = global.fetch;
  const original = {
    SMS_PROVIDER: process.env.SMS_PROVIDER,
    SWALA_API_KEY: process.env.SWALA_API_KEY,
    SWALA_SENDER_ID: process.env.SWALA_SENDER_ID,
    SWALA_API_BASE_URL: process.env.SWALA_API_BASE_URL,
  };

  beforeEach(() => {
    process.env.SMS_PROVIDER = 'swala';
    process.env.SWALA_API_KEY = SENTINEL_KEY;
    process.env.SWALA_SENDER_ID = 'BUSPAY';
    process.env.SWALA_API_BASE_URL = 'https://swalasms.test/api/v1';
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

  function mockFetch(response: {
    ok: boolean;
    status: number;
    body: unknown;
  }) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: response.ok,
      status: response.status,
      text: async () => JSON.stringify(response.body),
    }) as unknown as typeof fetch;
  }

  it('sends one SMS and returns the SwalaSMS message id without marking delivery', async () => {
    mockFetch({
      ok: true,
      status: 202,
      body: {
        success: true,
        data: {
          uid: '9f2c1e3a-4b7d-4e2b-9c3e-2f6a7d8b1c4e',
          status: 'queued',
        },
      },
    });
    const result = await new SwalaSmsProvider().send(
      '0712345678',
      'Bus Pay test',
      '22222222-2222-2222-2222-222222222222',
    );
    expect(result).toEqual({
      ok: true,
      provider: 'swala',
      requestId: '9f2c1e3a-4b7d-4e2b-9c3e-2f6a7d8b1c4e',
      providerStatus: 'queued',
    });
    expect(result.providerStatus).not.toBe('delivered');
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://swalasms.test/api/v1/sms/messages');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${SENTINEL_KEY}`,
    );
    const body = init.body;
    expect(typeof body).toBe('string');
    expect(JSON.parse(body as string)).toEqual({
      recipient: '+255712345678',
      sender_id: 'BUSPAY',
      body: 'Bus Pay test',
    });
  });

  it('rejects an invalid phone number before calling SwalaSMS', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    const result = await new SwalaSmsProvider().send(
      '123',
      'Bus Pay test',
      '33333333-3333-3333-3333-333333333333',
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid Tanzanian phone number');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns a safe error when SwalaSMS responds with an API error', async () => {
    mockFetch({
      ok: false,
      status: 422,
      body: {
        success: false,
        message: 'Sender is not approved',
      },
    });
    const result = await new SwalaSmsProvider().send(
      '+255712345678',
      'Bus Pay test',
      '44444444-4444-4444-4444-444444444444',
    );
    expect(result).toEqual({
      ok: false,
      provider: 'swala',
      error: 'Sender is not approved',
      retryable: false,
    });
  });

  it('returns a safe error on HTTP failure', async () => {
    mockFetch({
      ok: false,
      status: 500,
      body: { success: false, message: 'upstream' },
    });
    const result = await new SwalaSmsProvider().send(
      '+255712345678',
      'Bus Pay test',
      '55555555-5555-5555-5555-555555555555',
    );
    expect(result).toMatchObject({
      ok: false,
      provider: 'swala',
      error: 'upstream',
      retryable: true,
    });
  });

  it('returns a timeout error without calling through', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    global.fetch = jest.fn().mockRejectedValue(timeout) as unknown as typeof fetch;
    const result = await new SwalaSmsProvider().send(
      '+255712345678',
      'Bus Pay test',
      '66666666-6666-6666-6666-666666666666',
    );
    expect(result).toEqual({
      ok: false,
      provider: 'swala',
      error: 'SwalaSMS request timed out',
      retryable: true,
    });
  });

  it('fails before HTTP when the API key is missing', async () => {
    delete process.env.SWALA_API_KEY;
    global.fetch = jest.fn() as unknown as typeof fetch;
    const result = await new SwalaSmsProvider().send(
      '+255712345678',
      'Bus Pay test',
      '77777777-7777-7777-7777-777777777777',
    );
    expect(result.error).toBe('SWALA_API_KEY is not configured');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fails before HTTP when the sender ID is missing', async () => {
    delete process.env.SWALA_SENDER_ID;
    global.fetch = jest.fn() as unknown as typeof fetch;
    const result = await new SwalaSmsProvider().send(
      '+255712345678',
      'Bus Pay test',
      '88888888-8888-8888-8888-888888888888',
    );
    expect(result.error).toBe('SWALA_SENDER_ID is not configured');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('never writes the API key into logs', async () => {
    const lines: string[] = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message) => {
      lines.push(String(message));
    });
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message) => {
      lines.push(String(message));
    });
    mockFetch({
      ok: false,
      status: 401,
      body: {
        success: false,
        message: `Unauthorized ${SENTINEL_KEY}`,
      },
    });
    await new SwalaSmsProvider().send(
      '+255712345678',
      'Bus Pay test',
      '99999999-9999-9999-9999-999999999999',
    );
    expect(lines.join('\n')).not.toContain(SENTINEL_KEY);
  });
});
