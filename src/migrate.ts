import fs from 'node:fs/promises';
import path from 'node:path';
import mysql, { RowDataPacket } from 'mysql2/promise';
import { config } from './config';
import { logger } from './logger';

/** Minimal forward-only migration runner. A MySQL advisory lock makes concurrent deploys safe. */
async function main(): Promise<void> {
  const conn = await mysql.createConnection({
    host: config.MYSQL_HOST,
    port: config.MYSQL_PORT,
    user: config.MYSQL_USER,
    password: config.MYSQL_PASSWORD,
    database: config.MYSQL_DATABASE,
    multipleStatements: true,
  });

  try {
    const [lock] = await conn.query<RowDataPacket[]>("SELECT GET_LOCK('chat_migrations', 30) AS got");
    if (lock[0]?.['got'] !== 1) throw new Error('Could not acquire migration lock');

    await conn.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name VARCHAR(255) NOT NULL PRIMARY KEY,
         applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
       ) ENGINE=InnoDB`,
    );
    const [done] = await conn.query<RowDataPacket[]>('SELECT name FROM schema_migrations');
    const applied = new Set(done.map((r) => r['name'] as string));

    const dir = path.join(__dirname, '..', 'migrations');
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      logger.info({ file }, 'applying migration');
      await conn.query(await fs.readFile(path.join(dir, file), 'utf8'));
      await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
    }
    logger.info('migrations up to date');
  } finally {
    await conn.query("SELECT RELEASE_LOCK('chat_migrations')").catch(() => undefined);
    await conn.end();
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, 'migration failed');
  process.exit(1);
});
