import mysql from 'mysql2/promise';
import { config } from './config';

export const pool = mysql.createPool({
  host: config.MYSQL_HOST,
  port: config.MYSQL_PORT,
  user: config.MYSQL_USER,
  password: config.MYSQL_PASSWORD,
  database: config.MYSQL_DATABASE,
  connectionLimit: config.MYSQL_POOL_SIZE,
  waitForConnections: true,
  queueLimit: 200, // fail fast under overload instead of queueing forever
  connectTimeout: 5_000,
  enableKeepAlive: true,
  timezone: 'Z',
  charset: 'utf8mb4',
});
