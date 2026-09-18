import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

loadEnv({ override: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
  path: 'prisma/migrations',
  seed: 'npx tsx prisma/seed.ts',
},
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
