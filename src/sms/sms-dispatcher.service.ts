import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { normalizePhone, TZ_PHONE_PATTERN } from '../auth/identity';
import { PrismaService } from '../prisma/prisma.service';
import { BeemSmsProvider, localStatusFromBeem } from './beem-sms.provider';
import { MockSmsProvider } from './mock-sms.provider';
import {
  DELIVERY_POLL_WINDOW_MS,
  deliveryPollDelayMs,
  FIRST_DELIVERY_POLL_MS,
  MAX_DELIVERY_POLLS,
  MAX_SEND_ATTEMPTS,
  resolveSmsProvider,
  sendBackoffMs,
  SENDING_STALE_MS,
  type SmsProviderName,
  type SmsSendResult,
} from './sms-provider';
import { SwalaSmsProvider } from './swala-sms.provider';
import { mergeDeliveryStatus } from './sms-status';
import { localStatusFromSwala } from './swala-webhook.service';

type OutboxClaim = {
  id: string;
  attemptCount: number;
  status: string;
  providerStatus: string | null;
};

@Injectable()
export class SmsDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SmsDispatcherService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mock: MockSmsProvider,
    private readonly beem: BeemSmsProvider,
    private readonly swala: SwalaSmsProvider,
  ) {}

  onModuleInit() {
    const enabled = (process.env.SMS_DISPATCH_ENABLED ?? 'true').toLowerCase();
    if (enabled === 'false' || enabled === '0') {
      this.logger.warn('SMS dispatcher disabled (SMS_DISPATCH_ENABLED=false)');
      return;
    }

    const intervalMs = Number(process.env.SMS_DISPATCH_INTERVAL_MS ?? 3_000);
    const provider = this.providerName();
    if (provider === 'swala' && !this.swala.isConfigured()) {
      this.logger.warn(
        'SMS_PROVIDER=swala but SWALA_API_KEY or SWALA_SENDER_ID is missing',
      );
    }
    if (provider === 'beem' && !this.beem.isConfigured()) {
      this.logger.warn(
        'SMS_PROVIDER=beem but BEEM_API_KEY, BEEM_SECRET_KEY, or BEEM_SENDER_ID is missing',
      );
    }
    this.logger.log(`SMS dispatcher started (${provider}, every ${intervalMs}ms)`);
    void this.flush();
    this.timer = setInterval(() => void this.flush(), intervalMs);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async flush(limit = 25) {
    if (!(await this.isSmsEnabled())) {
      return { processed: 0, skipped: 'smsEnabled=false' as const };
    }

    await this.recoverStaleSending(limit);
    const dispatched = await this.dispatchPending(limit);
    await this.pollBeemDeliveries(limit);
    return dispatched;
  }

  async sendTest(phone: string, message: string) {
    const recipient = normalizePhone(phone);
    if (!TZ_PHONE_PATTERN.test(recipient)) {
      throw new BadRequestException(
        'Use a Tanzanian number like +255712345678',
      );
    }
    const body = message.trim();
    if (!body || body.length > 1600) {
      throw new BadRequestException('Message must be 1 to 1600 characters');
    }

    const provider = this.providerName();
    const row = await this.prisma.smsOutbox.create({
      data: {
        phone: recipient,
        type: 'ADMIN_TEST',
        message: body,
        status: 'SENDING',
        provider,
      },
    });
    const result = await this.dispatch(recipient, body, row.id);
    const status = await this.applyOutcome(row, result);

    return {
      accepted: result.ok,
      provider,
      messageId: result.requestId ?? null,
      status,
      providerStatus: result.mocked ? 'mock' : (result.providerStatus ?? null),
      outboxId: row.id,
      error: result.ok ? undefined : (result.error ?? 'SMS failed'),
    };
  }

  async refreshDelivery(messageId: string) {
    const provider = providerFromMessageId(messageId);
    const row = await this.prisma.smsOutbox.findUnique({
      where: {
        provider_providerMessageId: {
          provider,
          providerMessageId: messageId,
        },
      },
    });
    if (provider === 'mock' || row?.providerStatus === 'mock') {
      return {
        accepted: true,
        provider: 'mock' as const,
        messageId,
        status: row?.status ?? 'SENT_MOCK',
        providerStatus: 'mock',
      };
    }

    if (provider === 'beem') {
      if (!row?.phone) {
        return {
          accepted: false,
          provider: 'beem' as const,
          messageId,
          status: row?.status ?? null,
          providerStatus: row?.providerStatus ?? null,
          error: 'No outbox row for this Beem request id',
        };
      }
      const beemResult = await this.beem.fetchDelivery(row.phone, messageId);
      if (!beemResult.ok) {
        return {
          accepted: false,
          provider: 'beem' as const,
          messageId,
          status: row.status,
          providerStatus: row.providerStatus,
          error: beemResult.error,
        };
      }
      const status = await this.writeDelivery(
        row,
        localStatusFromBeem(beemResult.providerStatus),
        beemResult.providerStatus,
      );
      return {
        accepted: true,
        provider: 'beem' as const,
        messageId,
        status,
        providerStatus: beemResult.providerStatus ?? null,
      };
    }

    const result = await this.swala.fetchStatus(messageId);
    if (!result.ok) {
      return {
        accepted: false,
        provider: 'swala' as const,
        messageId,
        status: row?.status ?? null,
        providerStatus: row?.providerStatus ?? null,
        error: result.error,
      };
    }

    const incoming = localStatusFromSwala(result.providerStatus);
    const status = row
      ? await this.writeDelivery(row, incoming, result.providerStatus)
      : incoming;

    return {
      accepted: true,
      provider: 'swala' as const,
      messageId: result.requestId ?? messageId,
      status,
      providerStatus: result.providerStatus ?? null,
    };
  }

  providerName(): SmsProviderName {
    return resolveSmsProvider();
  }

  providerHealth() {
    const configured = (ready: boolean) =>
      ready ? 'CONFIGURED' : 'NOT_CONFIGURED';
    return {
      selected: this.providerName(),
      mock: 'CONFIGURED',
      swala: configured(this.swala.isConfigured()),
      beem: configured(this.beem.isConfigured()),
    };
  }

  private async dispatchPending(limit: number) {
    const now = new Date();
    const batch = await this.prisma.smsOutbox.findMany({
      where: {
        status: 'PENDING',
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    let sent = 0;
    let failed = 0;
    let retrying = 0;
    let uncertain = 0;
    for (const row of batch) {
      const claimed = await this.prisma.smsOutbox.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: { status: 'SENDING', provider: this.providerName() },
      });
      if (claimed.count !== 1) continue;

      const result = await this.dispatch(row.phone, row.message, row.id);
      const status = await this.applyOutcome(row, result);
      if (status === 'FAILED') failed += 1;
      else if (status === 'PENDING') retrying += 1;
      else if (status === 'UNCERTAIN') uncertain += 1;
      else sent += 1;
    }

    if (batch.length > 0) {
      this.logger.debug(
        `SMS flush: ${sent} sent, ${retrying} retrying, ${uncertain} uncertain, ${failed} failed, ${batch.length} attempted`,
      );
    }
    return { processed: batch.length, sent, failed, retrying, uncertain };
  }

  private async recoverStaleSending(limit: number) {
    const staleBefore = new Date(Date.now() - SENDING_STALE_MS);
    const rows = await this.prisma.smsOutbox.findMany({
      where: { status: 'SENDING', updatedAt: { lt: staleBefore } },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });

    for (const row of rows) {
      if (row.provider === 'beem' || (row.provider == null && this.providerName() === 'beem')) {
        await this.prisma.smsOutbox.updateMany({
          where: { id: row.id, status: 'SENDING' },
          data: {
            status: 'UNCERTAIN',
            lastError:
              'Beem send was interrupted before acceptance could be confirmed',
          },
        });
        continue;
      }

      const attemptCount = row.attemptCount + 1;
      if (attemptCount >= MAX_SEND_ATTEMPTS) {
        await this.prisma.smsOutbox.updateMany({
          where: { id: row.id, status: 'SENDING' },
          data: {
            status: 'FAILED',
            attemptCount,
            lastError: 'Sending was interrupted and the retry limit was reached',
          },
        });
        continue;
      }

      await this.prisma.smsOutbox.updateMany({
        where: { id: row.id, status: 'SENDING' },
        data: {
          status: 'PENDING',
          attemptCount,
          nextAttemptAt: new Date(Date.now() + sendBackoffMs(attemptCount)),
          lastError: 'Sending was interrupted and will be retried',
        },
      });
    }
  }

  private async pollBeemDeliveries(limit: number) {
    const now = new Date();
    const windowStart = new Date(now.getTime() - DELIVERY_POLL_WINDOW_MS);
    const batch = await this.prisma.smsOutbox.findMany({
      where: {
        provider: 'beem',
        status: { in: ['SENT', 'UNCERTAIN'] },
        providerMessageId: { not: null },
        deliveryPollCount: { lt: MAX_DELIVERY_POLLS },
        createdAt: { gte: windowStart },
        OR: [
          { nextDeliveryPollAt: null },
          { nextDeliveryPollAt: { lte: now } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    for (const row of batch) {
      if (!row.providerMessageId) continue;
      const nextCount = row.deliveryPollCount + 1;
      const reserved = await this.prisma.smsOutbox.updateMany({
        where: {
          id: row.id,
          status: row.status,
          deliveryPollCount: row.deliveryPollCount,
        },
        data: {
          deliveryPollCount: nextCount,
          nextDeliveryPollAt:
            nextCount >= MAX_DELIVERY_POLLS
              ? null
              : new Date(now.getTime() + deliveryPollDelayMs(nextCount)),
        },
      });
      if (reserved.count !== 1) continue;

      const report = await this.beem.fetchDelivery(row.phone, row.providerMessageId);
      if (!report.ok || !report.providerStatus) continue;
      await this.writeDelivery(
        row,
        localStatusFromBeem(report.providerStatus),
        report.providerStatus,
      );
    }
  }

  private async applyOutcome(
    row: { id: string; attemptCount?: number },
    result: SmsSendResult,
  ): Promise<string> {
    const provider = result.provider;
    if (result.uncertain) {
      await this.prisma.smsOutbox.update({
        where: { id: row.id },
        data: {
          status: 'UNCERTAIN',
          provider,
          providerMessageId: result.requestId,
          providerStatus: result.providerStatus ?? null,
          lastError: result.error ?? 'Provider acceptance could not be confirmed',
          nextDeliveryPollAt: result.requestId
            ? new Date(Date.now() + FIRST_DELIVERY_POLL_MS)
            : null,
        },
      });
      this.logger.warn(
        `SMS ${row.id} UNCERTAIN: ${result.error ?? 'acceptance unknown'}`,
      );
      return 'UNCERTAIN';
    }

    if (!result.ok && result.retryable) {
      const attemptCount = (row.attemptCount ?? 0) + 1;
      if (attemptCount >= MAX_SEND_ATTEMPTS) {
        await this.prisma.smsOutbox.update({
          where: { id: row.id },
          data: {
            status: 'FAILED',
            provider,
            attemptCount,
            lastError: result.error ?? 'SMS failed',
          },
        });
        this.logger.warn(`SMS ${row.id} failed: ${result.error ?? 'unknown'}`);
        return 'FAILED';
      }
      await this.prisma.smsOutbox.update({
        where: { id: row.id },
        data: {
          status: 'PENDING',
          provider,
          attemptCount,
          nextAttemptAt: new Date(Date.now() + sendBackoffMs(attemptCount)),
          lastError: result.error ?? 'SMS failed',
        },
      });
      this.logger.warn(
        `SMS ${row.id} retry scheduled: ${result.error ?? 'unknown'}`,
      );
      return 'PENDING';
    }

    if (!result.ok) {
      await this.prisma.smsOutbox.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          provider,
          providerStatus: result.providerStatus ?? null,
          lastError: result.error ?? 'SMS failed',
        },
      });
      this.logger.warn(`SMS ${row.id} failed: ${result.error ?? 'unknown'}`);
      return 'FAILED';
    }

    const status = this.outcomeStatus(result);
    await this.prisma.smsOutbox.update({
      where: { id: row.id },
      data: {
        status,
        provider,
        providerMessageId: result.requestId,
        providerStatus: result.mocked ? 'mock' : (result.providerStatus ?? null),
        lastError: null,
        nextAttemptAt: null,
        nextDeliveryPollAt:
          provider === 'beem' && status === 'SENT'
            ? new Date(Date.now() + FIRST_DELIVERY_POLL_MS)
            : null,
      },
    });
    return status;
  }

  private async writeDelivery(
    row: OutboxClaim,
    incoming: string,
    providerStatus: string | undefined,
  ): Promise<string> {
    const status = mergeDeliveryStatus(row.status, incoming);
    if (status === row.status) return status;
    await this.prisma.smsOutbox.update({
      where: { id: row.id },
      data: {
        status,
        providerStatus: providerStatus ?? null,
        ...(status === 'DELIVERED' || status === 'FAILED'
          ? { nextDeliveryPollAt: null }
          : {}),
      },
    });
    return status;
  }

  private dispatch(phone: string, message: string, recipientId: string) {
    return this.activeSender().send(phone, message, recipientId);
  }

  private activeSender() {
    const name = this.providerName();
    if (name === 'swala') return this.swala;
    if (name === 'beem') return this.beem;
    return this.mock;
  }

  private outcomeStatus(result: SmsSendResult): string {
    if (!result.ok) return 'FAILED';
    if (result.mocked || result.provider === 'mock') return 'SENT_MOCK';
    if (result.provider === 'beem') return localStatusFromBeem(result.providerStatus);
    return localStatusFromSwala(result.providerStatus);
  }

  private async isSmsEnabled(): Promise<boolean> {
    try {
      const setting = await this.prisma.systemSetting.findUnique({
        where: { key: 'smsEnabled' },
      });
      if (!setting) return true;
      return setting.value.toLowerCase() !== 'false';
    } catch {
      return true;
    }
  }
}

function providerFromMessageId(messageId: string): SmsProviderName {
  if (messageId.startsWith('mock-')) return 'mock';
  if (/^\d+$/.test(messageId)) return 'beem';
  return 'swala';
}
