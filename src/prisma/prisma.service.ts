import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }

    super({
      adapter: new PrismaPg({
        connectionString,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
        keepAlive: true,
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await Promise.race([
        this.$connect().then(() => this.$queryRaw`SELECT 1`),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Database warmup timed out')), 5000);
        }),
      ]);
    } catch (error) {
      this.logger.warn(
        error instanceof Error
          ? error.message
          : 'PostgreSQL is not reachable yet',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
