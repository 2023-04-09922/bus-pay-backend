import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { mergeDeliveryStatus } from './sms-status';

export type SwalaWebhookDecision = {
  ok: true;
  duplicate?: boolean;
  ignored?: boolean;
};

export function swalaSignatureMatches(
  rawBody: Buffer,
  signature: string,
  secret: string,
): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const actual = signature.trim().toLowerCase();
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(actual);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

export function localStatusFromSwala(providerStatus: string | undefined): string {
  if (providerStatus === 'delivered') return 'DELIVERED';
  if (providerStatus === 'failed') return 'FAILED';
  return 'SENT';
}

type ParsedWebhook = {
  messageId: string;
  status: 'DELIVERED' | 'FAILED';
  providerStatus: string;
};

export function parseSwalaWebhook(payload: unknown): ParsedWebhook | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const body = payload as {
    event?: unknown;
    message_id?: unknown;
    status?: unknown;
  };
  if (typeof body.message_id !== 'string' || !body.message_id) return null;
  const event = typeof body.event === 'string' ? body.event : '';
  const providerStatus = typeof body.status === 'string' ? body.status : '';
  if (event === 'sms.delivered' || providerStatus === 'delivered') {
    return {
      messageId: body.message_id,
      status: 'DELIVERED',
      providerStatus: providerStatus || 'delivered',
    };
  }
  if (event === 'sms.failed' || providerStatus === 'failed') {
    return {
      messageId: body.message_id,
      status: 'FAILED',
      providerStatus: providerStatus || 'failed',
    };
  }
  return null;
}

@Injectable()
export class SwalaWebhookService {
  private readonly logger = new Logger(SwalaWebhookService.name);

  constructor(private readonly prisma: PrismaService) {}

  async handle(
    rawBody: Buffer | undefined,
    signatureHeader: string | string[] | undefined,
  ): Promise<SwalaWebhookDecision> {
    const secret = process.env.SWALA_WEBHOOK_SECRET?.trim() ?? '';
    if (!secret) {
      this.logger.warn(
        'SwalaSMS webhook rejected: SWALA_WEBHOOK_SECRET is not configured',
      );
      throw new UnauthorizedException();
    }
    const signature = Array.isArray(signatureHeader)
      ? signatureHeader[0]
      : signatureHeader;
    if (!rawBody?.length || !signature) {
      throw new UnauthorizedException();
    }
    if (!swalaSignatureMatches(rawBody, signature, secret)) {
      this.logger.warn('SwalaSMS webhook rejected: invalid signature');
      throw new UnauthorizedException();
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as unknown;
    } catch {
      throw new BadRequestException('Invalid JSON');
    }

    const parsed = parseSwalaWebhook(payload);
    if (!parsed) {
      this.logger.log('provider=swala webhook ignored: unsupported event');
      return { ok: true, ignored: true };
    }

    const row = await this.prisma.smsOutbox.findUnique({
      where: {
        provider_providerMessageId: {
          provider: 'swala',
          providerMessageId: parsed.messageId,
        },
      },
    });
    if (!row) {
      this.logger.warn(
        `provider=swala webhook waiting for messageId=${parsed.messageId}`,
      );
      throw new ServiceUnavailableException();
    }
    const nextStatus = mergeDeliveryStatus(row.status, parsed.status);
    if (nextStatus === row.status) {
      return { ok: true, duplicate: true };
    }

    await this.prisma.smsOutbox.update({
      where: { id: row.id },
      data: {
        status: nextStatus,
        providerStatus: parsed.providerStatus,
      },
    });
    this.logger.log(
      `provider=swala messageId=${parsed.messageId} status=${parsed.providerStatus}`,
    );
    return { ok: true };
  }
}
