/**
 * One-time upgrade for a database created by an older Bai-ber (before billing and the admin role).
 *
 *   npm run migrate
 *
 * Safe to run more than once: every step first checks whether it is already done.
 * A brand-new database made from the current schema.sql does not need this.
 *
 * What it does:
 *   1. users:    adds "role" ('user' | 'admin') and turns old "legacy_admin" accounts into role = 'admin',
 *                then drops "legacy_admin".
 *   2. messages: adds "chars_covered" and sets it to each existing message's length, so everything
 *                sent BEFORE billing is free and only new messages are charged.
 *   3. charges and payments: creates the two billing tables.
 */
require('dotenv').config({ quiet: true });
const pool = require('../database');

async function columnExists(conn, table, column) {
  const [rows] = await conn.execute(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, column]);
  return rows.length > 0;
}

async function tableExists(conn, table) {
  const [rows] = await conn.execute(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
  return rows.length > 0;
}

async function migrate() {
  const conn = await pool.getConnection();
  const done = [];
  try {
    // ---- 1. users.role (replaces users.legacy_admin) ----
    if (!(await columnExists(conn, 'users', 'role'))) {
      await conn.query("ALTER TABLE users ADD COLUMN role ENUM('user','admin') NOT NULL DEFAULT 'user' AFTER status");
      done.push('users.role added');
    }
    if (await columnExists(conn, 'users', 'legacy_admin')) {
      const [result] = await conn.query("UPDATE users SET role = 'admin' WHERE legacy_admin = 1");
      await conn.query('ALTER TABLE users DROP COLUMN legacy_admin');
      done.push(`users.legacy_admin removed (${result.affectedRows} old admin account(s) became role 'admin')`);
    }

    // ---- 2. messages.chars_covered ----
    if (!(await columnExists(conn, 'messages', 'chars_covered'))) {
      await conn.query('ALTER TABLE messages ADD COLUMN chars_covered INT NOT NULL DEFAULT 0');
      const [result] = await conn.query('UPDATE messages SET chars_covered = CHAR_LENGTH(content)');
      done.push(`messages.chars_covered added (${result.affectedRows} existing messages are free)`);
    }

    // ---- 3. billing tables ----
    if (!(await tableExists(conn, 'charges'))) {
      await conn.query(`CREATE TABLE charges (
        charge_id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NOT NULL,
        message_id INT NOT NULL,
        kind ENUM('send','edit') NOT NULL,
        chars INT NOT NULL,
        amount_cents BIGINT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX user_time (user_id, created_at),
        INDEX by_message (message_id),
        INDEX by_time (created_at),
        FOREIGN KEY (user_id) REFERENCES users(user_id),
        FOREIGN KEY (message_id) REFERENCES messages(message_id),
        CHECK (chars > 0 AND amount_cents >= 0)
      ) ENGINE=InnoDB`);
      done.push('table charges created');
    }
    if (!(await tableExists(conn, 'payments'))) {
      await conn.query(`CREATE TABLE payments (
        payment_id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NOT NULL,
        amount_cents BIGINT NOT NULL,
        paid_at DATETIME NOT NULL,
        note VARCHAR(255) NULL,
        recorded_by INT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        request_key CHAR(32) NULL UNIQUE,
        voided_at DATETIME NULL,
        voided_by INT NULL,
        void_reason VARCHAR(255) NULL,
        INDEX user_paid (user_id, paid_at),
        INDEX by_paid (paid_at),
        FOREIGN KEY (user_id) REFERENCES users(user_id),
        FOREIGN KEY (recorded_by) REFERENCES users(user_id),
        FOREIGN KEY (voided_by) REFERENCES users(user_id),
        CHECK (amount_cents > 0)
      ) ENGINE=InnoDB`);
      done.push('table payments created');
    }
  } finally {
    conn.release();
  }

  if (done.length) {
    console.log('Migration finished:');
    done.forEach((line) => console.log('  - ' + line));
    console.log('Next: create your first administrator with  npm run admin:create -- <username>');
  } else {
    console.log('Nothing to do: the database is already up to date.');
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
}).finally(() => pool.end());
