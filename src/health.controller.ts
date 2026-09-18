import { Controller, Get } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    const started = Date.now();

    try {
      const [row] = await this.prisma.$queryRaw<
        Array<{ database: string; db_user: string; schema: string }>
      >`
        SELECT
          current_database() AS database,
          current_user AS db_user,
          current_schema() AS schema
      `;

      return {
        status: 'ok',
        info: {
          database: {
            status: 'up',
            database: row.database,
            schema: row.schema,
            user: row.db_user,
            responseTimeMs: Date.now() - started,
          },
        },
        error: {},
      };
    } catch {
      return {
        status: 'ok',
        info: {
          api: {
            status: 'up',
          },
        },
        error: {
          database: {
            status: 'down',
            message: 'PostgreSQL is not reachable. Start the postgresql-x64-18 service.',
            responseTimeMs: Date.now() - started,
          },
        },
      };
    }
  }
}
