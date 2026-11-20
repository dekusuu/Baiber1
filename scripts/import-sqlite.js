// Run once, after schema.sql and before starting Bai-ber.
require('dotenv').config({ quiet: true });
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const pool = require('../database');

async function importRecords() {
  const filename = process.argv[2] || path.join(__dirname, '../database/messaging.db');
  const source = new DatabaseSync(filename, {readOnly: true});
  const target = await pool.getConnection();
  const columns = {
    users: ['user_id', 'username', 'password_hash', 'status', 'created_at', 'role'],
    friendships: ['friendship_id', 'sender_id', 'receiver_id', 'status', 'created_at', 'updated_at'],
    messages: ['message_id', 'sender_id', 'receiver_id', 'content', 'sent_at', 'edited_at', 'deleted_at'],
    conversation_reads: ['user_id', 'peer_id', 'last_read_id']
  };
  try {
    source.exec('BEGIN');
    await target.beginTransaction();
    for (const table of Object.keys(columns)) {
      const [existing] = await target.query('SELECT 1 FROM ' + table + ' LIMIT 1 FOR UPDATE');
      if (existing.length) throw new Error('Import requires empty application tables. Found records in ' + table);
    }
    for (const [table, fields] of Object.entries(columns)) {
      const exists = source.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (!exists && ['friendships', 'conversation_reads'].includes(table)) continue;
      const rows = source.prepare('SELECT * FROM ' + table).all();
      const sql = 'INSERT INTO ' + table + ' (' + fields.join(', ') + ') VALUES (' + fields.map(() => '?').join(', ') + ')';
      for (const row of rows) {
        // Only an explicit 'admin' keeps administrator rights; everything else is a regular user.
        if (table === 'users') row.role = row.role === 'admin' ? 'admin' : 'user';
        await target.execute(sql, fields.map(field => row[field] ?? null));
      }
      const [[count]] = await target.query('SELECT COUNT(*) AS total FROM ' + table);
      if (Number(count.total) !== rows.length) throw new Error('Count mismatch in ' + table);
      console.log(table + ': ' + rows.length + ' records checked');
    }
    // Billing starts when Bai-ber goes live: every imported message counts as already covered, so it is never charged
    // (and editing an old message bills only the characters you add to it).
    await target.query('UPDATE messages SET chars_covered = CHAR_LENGTH(content)');
    await target.commit();
    console.log('Import complete. Imported messages are free of charge. Sign in with your existing username and password.');
  } catch (err) {
    await target.rollback();
    throw err;
  } finally {
    source.close();
    target.release();
  }
}

importRecords().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
}).finally(() => pool.end());
