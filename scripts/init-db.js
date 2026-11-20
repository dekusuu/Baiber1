/**
 * Creates all Bai-ber tables in an EMPTY database, using whatever database your settings point at
 * (DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME). Use it for a new database such as the "railway" one on
 * Railway, where you cannot choose the database name:
 *
 *     npm run db:init
 *
 * It runs schema.sql without its "CREATE DATABASE" and "USE" lines, so the tables are created in DB_NAME itself.
 * It refuses to touch a database that already has Bai-ber tables: an older database is upgraded with
 * "npm run migrate" instead.
 */
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

async function main() {
  const database = process.env.DB_NAME || 'bai_ber';
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database,
    charset: 'utf8mb4',
    multipleStatements: true,
  });
  try {
    const [existing] = await connection.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('users', 'messages', 'charges', 'payments')`);
    if (existing.length) {
      throw new Error(
        `Database "${database}" already has Bai-ber tables (${existing.map((row) => row.TABLE_NAME).join(', ')}). `
        + 'Nothing was changed. To upgrade an older database run: npm run migrate');
    }

    const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8')
      .replace(/^\s*CREATE\s+DATABASE\b[^;]*;/im, '')
      .replace(/^\s*USE\s+[^;]*;/im, '');
    await connection.query(schema);

    const [tables] = await connection.query(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME');
    console.log(`Created ${tables.length} tables in "${database}": ${tables.map((row) => row.TABLE_NAME).join(', ')}.`);
    console.log('Next: npm run admin:create -- <username>');
  } finally {
    await connection.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
