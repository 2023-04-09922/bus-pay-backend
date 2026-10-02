import { Injectable, Logger } from '@nestjs/common';

import { normalizePhone, TZ_PHONE_PATTERN } from '../auth/identity';
import {
  maskPhone,
  type SmsProviderName,
  type SmsSendResult,
  type SmsSender,
} from './sms-provider';

@Injectable()
export class MockSmsProvider implements SmsSender {
  readonly name: SmsProviderName = 'mock';
  private readonly logger = new Logger(MockSmsProvider.name);

  isConfigured(): boolean {
    return true;
  }

  send(
    phone: string,
    _message: string,
    recipientId: string,
  ): Promise<SmsSendResult> {
    const recipient = normalizePhone(phone);
    if (!TZ_PHONE_PATTERN.test(recipient)) {
      return Promise.resolve({
        ok: false,
        provider: 'mock',
        error: 'Invalid Tanzanian phone number',
      });
    }
    this.logger.log(
      `provider=mock recipient=${maskPhone(recipient)} messageId=mock-${recipientId} status=mock`,
    );
    return Promise.resolve({
      ok: true,
      provider: 'mock',
      mocked: true,
      requestId: `mock-${recipientId}`,
      providerStatus: 'mock',
    });
  }
}
