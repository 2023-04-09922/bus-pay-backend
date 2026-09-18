import { config as loadEnv } from 'dotenv';
import pg from 'pg';

loadEnv({ override: true });

const raw = process.env.DATABASE_URL;
if (!raw) {
  console.error('MISSING_DATABASE_URL');
  process.exit(1);
}

const url = new URL(raw);
const dbName = url.pathname.replace(/^\//, '').split('?')[0];
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dbName)) {
  console.error('INVALID_DATABASE_NAME');
  process.exit(1);
}

const admin = new pg.Client({
  host: url.hostname,
  port: Number(url.port || 5432),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: 'postgres',
});

try {
  await admin.connect();
  const found = await admin.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [dbName],
  );
  if (found.rowCount === 0) {
    await admin.query(`CREATE DATABASE "${dbName}"`);
    console.log('CREATED_DATABASE');
  } else {
    console.log('DATABASE_EXISTS');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'CONNECT_FAILED');
  process.exit(1);
} finally {
  await admin.end().catch(() => undefined);
}
