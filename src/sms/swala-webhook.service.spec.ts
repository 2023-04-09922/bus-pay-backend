import { createHmac } from 'node:crypto';

import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

import { localStatusFromSwala, SwalaWebhookService } from './swala-webhook.service';

describe('Swala delivery status', () => {
  it('keeps API acceptance as sent until the carrier reports delivery', () => {
    expect(localStatusFromSwala('queued')).toBe('SENT');
    expect(localStatusFromSwala('sent')).toBe('SENT');
    expect(localStatusFromSwala('delivered')).toBe('DELIVERED');
    expect(localStatusFromSwala('failed')).toBe('FAILED');
  });
});

describe('SwalaWebhookService', () => {
  const secret = 'unit-webhook-secret';
  const original = process.env.SWALA_WEBHOOK_SECRET;

  beforeEach(() => {
    process.env.SWALA_WEBHOOK_SECRET = secret;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.SWALA_WEBHOOK_SECRET;
    else process.env.SWALA_WEBHOOK_SECRET = original;
  });

  function signed(body: unknown) {
    const raw = Buffer.from(JSON.stringify(body));
    const signature = createHmac('sha256', secret).update(raw).digest('hex');
    return { raw, signature };
  }

  it('rejects a webhook with a bad signature', async () => {
    const update = jest.fn();
    const service = new SwalaWebhookService({
      smsOutbox: { findUnique: jest.fn(), update },
    } as never);
    const raw = Buffer.from('{"event":"sms.delivered"}');
    await expect(service.handle(raw, 'not-the-signature')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('updates delivery once and ignores the duplicate callback', async () => {
    const messageId = '9f2c1e3a-4b7d-4e2b-9c3e-2f6a7d8b1c4e';
    let status = 'SENT';
    const update = jest.fn().mockImplementation(async () => {
      status = 'DELIVERED';
    });
    const findUnique = jest.fn().mockImplementation(async () => ({
      id: 'row-1',
      status,
      provider: 'swala',
      providerMessageId: messageId,
    }));
    const service = new SwalaWebhookService({
      smsOutbox: { findUnique, update },
    } as never);
    const payload = {
      event: 'sms.delivered',
      message_id: messageId,
      status: 'delivered',
    };
    const { raw, signature } = signed(payload);

    await expect(service.handle(raw, signature)).resolves.toEqual({ ok: true });
    await expect(service.handle(raw, signature)).resolves.toEqual({
      ok: true,
      duplicate: true,
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: { status: 'DELIVERED', providerStatus: 'delivered' },
    });
  });

  it('returns 503 when a valid webhook arrives before the message id is stored', async () => {
    const service = new SwalaWebhookService({
      smsOutbox: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    } as never);
    const { raw, signature } = signed({
      event: 'sms.delivered',
      message_id: '9f2c1e3a-4b7d-4e2b-9c3e-2f6a7d8b1c4e',
      status: 'delivered',
    });
    await expect(service.handle(raw, signature)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('keeps DELIVERED when a later failed webhook arrives', async () => {
    const update = jest.fn();
    const service = new SwalaWebhookService({
      smsOutbox: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'row-1',
          status: 'DELIVERED',
          provider: 'swala',
          providerMessageId: '9f2c1e3a-4b7d-4e2b-9c3e-2f6a7d8b1c4e',
        }),
        update,
      },
    } as never);
    const { raw, signature } = signed({
      event: 'sms.failed',
      message_id: '9f2c1e3a-4b7d-4e2b-9c3e-2f6a7d8b1c4e',
      status: 'failed',
    });
    await expect(service.handle(raw, signature)).resolves.toEqual({
      ok: true,
      duplicate: true,
    });
    expect(update).not.toHaveBeenCalled();
  });
});
