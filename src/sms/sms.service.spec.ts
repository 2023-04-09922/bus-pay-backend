import { BadRequestException } from '@nestjs/common';

import { SmsService } from './sms.service';

describe('SmsService.enqueue', () => {
  it('rejects an over-long phone number before creating an outbox row', async () => {
    const create = jest.fn();
    const service = new SmsService({ smsOutbox: { create } } as never);
    await expect(
      service.enqueue('071234567890', 'TOP_UP', 'hello'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });

  it('stores a normalized Tanzanian number', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'sms-1' });
    const service = new SmsService({ smsOutbox: { create } } as never);
    await service.enqueue('0712345678', 'TOP_UP', 'hello');
    expect(create).toHaveBeenCalledWith({
      data: {
        phone: '+255712345678',
        type: 'TOP_UP',
        message: 'hello',
        status: 'PENDING',
      },
    });
  });
});
