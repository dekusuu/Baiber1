const pool = require('../database.js');
const { toIso } = require('./userModel');
const billing = require('./billingModel');

const MAX_LENGTH = 2000;

function toApi(row) {
  if (!row) return null;
  return {
    id: row.message_id,
    senderId: row.sender_id,
    receiverId: row.receiver_id,
    content: row.content,
    sentAt: toIso(row.sent_at),
    deleted: Boolean(row.deleted_at),
    editedAt: toIso(row.edited_at),
  };
}

module.exports = {
  MAX_LENGTH,

  /**
   * Normalises and validates message text.
   * Returns { ok: true, content } or { ok: false, error }.
   */
  validateContent(raw) {
    if (typeof raw !== 'string') return { ok: false, error: 'Message must be text.' };
    const content = raw.replace(/\r\n?/g, '\n').trim();
    if (!content) return { ok: false, error: 'Message cannot be empty.' };
    if (content.length > MAX_LENGTH) {
      return { ok: false, error: `Message is too long (maximum ${MAX_LENGTH} characters).` };
    }
    return { ok: true, content };
  },

  async findById(id) {
    const [rows] = await pool.execute('SELECT * FROM messages WHERE message_id = ?', [id]);
    return toApi(rows[0]);
  },

  /**
   * Sends a message AND bills it, in one transaction (both are saved, or neither is).
   * Returns:
   *   { ok: true, message, charge: { chars, cents } }
   *   { ok: false, reason: 'not_friends' }
   *   { ok: false, reason: 'credit', balanceCents, costCents, limitCents }   (only when a credit limit is set)
   */
  async create(sender, receiver, content) {
    const chars = billing.countChars(content);
    const cents = billing.costCents(chars);
    const outcome = await billing.inTransaction(sender, async (conn) => {
      // Check friendship in the INSERT so a removed friendship cannot authorize a later write.
      const [result] = await conn.execute(`INSERT INTO messages (sender_id, receiver_id, content, sent_at, chars_covered)
        SELECT ?, ?, ?, UTC_TIMESTAMP(), ? FROM friendships
        WHERE active_low = LEAST(?, ?) AND active_high = GREATEST(?, ?) AND status = 'accepted'`,
        [sender, receiver, content, chars, sender, receiver, sender, receiver]);
      if (!result.affectedRows) return { ok: false, reason: 'not_friends' };

      const credit = await billing.checkCredit(conn, sender, cents);
      if (!credit.ok) return credit; // rolls the message back

      await billing.recordCharge(conn, { userId: sender, messageId: result.insertId, kind: 'send', chars, cents });
      return { ok: true, messageId: result.insertId };
    });
    if (!outcome.ok) return outcome;
    return { ok: true, message: await this.findById(outcome.messageId), charge: { chars, cents } };
  },

  /**
   * Edits the sender's own message. Only characters beyond what the message already covers are billed,
   * so shortening or rewording at the same length is free and a longer text pays for the extra part.
   * Returns { ok: true, message, charge: { chars, cents } | null } or { ok: false, reason: 'missing' | 'credit', ... }
   */
  async update(id, sender, content) {
    const chars = billing.countChars(content);
    const outcome = await billing.inTransaction(sender, async (conn) => {
      const [rows] = await conn.execute(`SELECT chars_covered FROM messages
        WHERE message_id = ? AND sender_id = ? AND deleted_at IS NULL FOR UPDATE`, [id, sender]);
      if (!rows.length) return { ok: false, reason: 'missing' };

      const extra = Math.max(0, chars - rows[0].chars_covered);
      const cents = billing.costCents(extra);
      if (extra > 0) {
        const credit = await billing.checkCredit(conn, sender, cents);
        if (!credit.ok) return credit;
      }

      await conn.execute(`UPDATE messages SET content = ?, edited_at = UTC_TIMESTAMP(),
        chars_covered = GREATEST(chars_covered, ?) WHERE message_id = ?`, [content, chars, id]);
      if (extra > 0) await billing.recordCharge(conn, { userId: sender, messageId: id, kind: 'edit', chars: extra, cents });
      return { ok: true, charge: extra > 0 ? { chars: extra, cents } : null };
    });
    if (!outcome.ok) return outcome;
    return { ok: true, message: await this.findById(id), charge: outcome.charge };
  },

  /** Deleting never refunds what was charged for the message. */
  async remove(id, sender) {
    const [result] = await pool.execute(`UPDATE messages SET content = 'Message deleted', deleted_at = UTC_TIMESTAMP(), edited_at = NULL
      WHERE message_id = ? AND sender_id = ? AND deleted_at IS NULL`, [id, sender]);
    return result.affectedRows;
  },

  async history(me, peer, {before, limit}) {
    const [rows] = await pool.execute(`SELECT * FROM messages WHERE
      ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
      AND (? IS NULL OR message_id < ?) ORDER BY message_id DESC LIMIT ?`,
      [me, peer, peer, me, before, before, String(limit + 1)]);
    return {messages: rows.slice(0, limit).reverse().map(toApi), hasMore: rows.length > limit};
  },

  async conversationsFor(me) {
    const [rows] = await pool.execute(`WITH latest AS (
      SELECT IF(sender_id = ?, receiver_id, sender_id) AS peer_id, MAX(message_id) AS last_id
      FROM messages WHERE sender_id = ? OR receiver_id = ? GROUP BY peer_id)
      SELECT m.*, u.user_id, u.username, u.status, u.role,
        (SELECT COUNT(*) FROM messages x WHERE x.sender_id = u.user_id AND x.receiver_id = ?
          AND x.message_id > COALESCE(r.last_read_id, 0)) AS unread
      FROM latest JOIN messages m ON m.message_id = latest.last_id JOIN users u ON u.user_id = latest.peer_id
      LEFT JOIN conversation_reads r ON r.user_id = ? AND r.peer_id = u.user_id ORDER BY latest.last_id DESC`,
      [me, me, me, me, me]);
    return rows.map(row => ({
      peer: {id: row.user_id, username: row.username, status: row.role === 'admin' ? 'inactive' : row.status},
      lastMessage: toApi(row), unread: Number(row.unread)
    }));
  },

  async readPosition(me, peer) {
    const [rows] = await pool.execute('SELECT last_read_id FROM conversation_reads WHERE user_id = ? AND peer_id = ?', [me, peer]);
    return rows[0]?.last_read_id || 0;
  },

  async markRead(me, peer, id) {
    const [result] = await pool.execute(`INSERT INTO conversation_reads (user_id, peer_id, last_read_id)
      SELECT ?, ?, message_id FROM messages WHERE message_id = ? AND sender_id = ? AND receiver_id = ?
      ON DUPLICATE KEY UPDATE last_read_id = GREATEST(last_read_id, ?)`, [me, peer, id, peer, me, id]);
    return result.affectedRows;
  }
};
