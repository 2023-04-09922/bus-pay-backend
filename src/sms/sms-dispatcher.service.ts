import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BeemSmsProvider } from './beem-sms.provider';

@Injectable()
export class SmsDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SmsDispatcherService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly beem: BeemSmsProvider,
  ) {}

  onModuleInit() {
    const enabled = (process.env.SMS_DISPATCH_ENABLED ?? 'true').toLowerCase();
    if (enabled === 'false' || enabled === '0') {
      this.logger.warn('SMS dispatcher disabled (SMS_DISPATCH_ENABLED=false)');
      return;
    }

    const intervalMs = Number(process.env.SMS_DISPATCH_INTERVAL_MS ?? 3_000);
    this.logger.log(
      `SMS dispatcher started (${this.beem.isMockMode() ? 'MOCK — no real SMS until BEEM keys + SMS_PROVIDER=beem' : 'beem'}, every ${intervalMs}ms)`,
    );
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
    if (this.running) return { processed: 0 };
    this.running = true;
    try {
      if (!(await this.isSmsEnabled())) {
        return { processed: 0, skipped: 'smsEnabled=false' };
      }

      const batch = await this.prisma.smsOutbox.findMany({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        take: limit,
      });

      let sent = 0;
      let failed = 0;
      for (const row of batch) {
        const result = await this.beem.send(row.phone, row.message, row.id);
        if (result.ok) {
          await this.prisma.smsOutbox.update({
            where: { id: row.id },
            data: {
              status: result.mocked ? 'SENT_MOCK' : 'SENT',
            },
          });
          sent += 1;
        } else {
          await this.prisma.smsOutbox.update({
            where: { id: row.id },
            data: { status: 'FAILED' },
          });
          failed += 1;
          this.logger.warn(
            `SMS ${row.id} failed: ${result.error ?? 'unknown'}`,
          );
        }
      }

      if (batch.length > 0) {
        this.logger.debug(
          `SMS flush: ${sent} sent, ${failed} failed, ${batch.length} attempted`,
        );
      }
      return { processed: batch.length, sent, failed };
    } finally {
      this.running = false;
    }
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
