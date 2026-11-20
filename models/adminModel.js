/**
 * Read-only reporting queries for the admin area (Dashboard, Users, Billing / Payment).
 * Administrators see counts and money only, never message contents.
 */
const pool = require('../database');
const { toIso, likePattern } = require('./userModel');
const billing = require('./billingModel');

const { num } = billing;
const DAY_MS = 86400000;

/** Per-user totals for every regular user. Balance = charged - paid (voided payments do not count). */
const USER_STATS = `SELECT u.user_id, u.username, u.status, u.created_at,
    COALESCE(m.messages, 0) AS messages,
    COALESCE(c.chars, 0) AS chars,
    COALESCE(c.charged, 0) AS charged,
    COALESCE(p.paid, 0) AS paid,
    COALESCE(c.charged, 0) - COALESCE(p.paid, 0) AS balance
  FROM users u
  LEFT JOIN (SELECT sender_id, COUNT(*) AS messages FROM messages GROUP BY sender_id) m ON m.sender_id = u.user_id
  LEFT JOIN (SELECT user_id, SUM(chars) AS chars, SUM(amount_cents) AS charged FROM charges GROUP BY user_id) c ON c.user_id = u.user_id
  LEFT JOIN (SELECT user_id, SUM(amount_cents) AS paid FROM payments WHERE voided_at IS NULL GROUP BY user_id) p ON p.user_id = u.user_id
  WHERE u.role = 'user'`;

function toUserStats(row) {
  if (!row) return null;
  return {
    id: row.user_id,
    username: row.username,
    status: row.status,
    createdAt: toIso(row.created_at),
    messages: num(row.messages),
    chars: num(row.chars),
    chargedCents: num(row.charged),
    paidCents: num(row.paid),
    balanceCents: num(row.balance),
  };
}

/** Keeps page numbers and sizes inside safe limits (they are placed in SQL as plain integers). */
function paging(page, pageSize, total) {
  const size = Math.min(Math.max(Math.floor(Number(pageSize)) || 20, 1), 100);
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(Math.floor(Number(page)) || 1, 1), pages);
  return { page: current, pageSize: size, pages, total, offset: (current - 1) * size };
}

const USER_SORTS = {
  username: 'username ASC',
  newest: 'user_id DESC',
  balance: 'balance DESC, username ASC',
  chars: 'chars DESC, username ASC',
  paid: 'paid DESC, username ASC',
};

module.exports = {
  USER_SORTS,

  /** One page of users for Users and Billing. filter: all | owing | settled | credit. */
  async listUsers({ q = '', status = 'all', filter = 'all', sort = 'username', page = 1, pageSize = 20 } = {}) {
    const where = [];
    const params = [];
    if (q.trim()) { where.push('username LIKE ?'); params.push(likePattern(q.trim().slice(0, 50))); }
    if (status === 'active' || status === 'inactive') { where.push('status = ?'); params.push(status); }
    if (filter === 'owing') where.push('balance > 0');
    else if (filter === 'settled') where.push('balance = 0');
    else if (filter === 'credit') where.push('balance < 0');
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const order = USER_SORTS[sort] || USER_SORTS.username;

    const [[count]] = await pool.execute(`SELECT COUNT(*) AS total FROM (${USER_STATS}) t${clause}`, params);
    const pager = paging(page, pageSize, num(count.total));
    const [rows] = await pool.execute(
      `SELECT * FROM (${USER_STATS}) t${clause} ORDER BY ${order} LIMIT ${pager.pageSize} OFFSET ${pager.offset}`, params);
    return { users: rows.map(toUserStats), pager };
  },

  async userStats(id) {
    const [rows] = await pool.execute(`SELECT * FROM (${USER_STATS}) t WHERE user_id = ?`, [id]);
    return toUserStats(rows[0]);
  },

  /** Plain list for the "Record payment" picker (with what each person owes right now). */
  async userChoices() {
    const [rows] = await pool.execute(
      `SELECT user_id, username, status, balance FROM (${USER_STATS}) t ORDER BY username LIMIT 1000`);
    return rows.map((row) => ({ id: row.user_id, username: row.username, status: row.status, balanceCents: num(row.balance) }));
  },

  /** Charge history of one user (no message text), newest first. */
  async userCharges(userId, { page = 1, pageSize = 20 } = {}) {
    const [[count]] = await pool.execute('SELECT COUNT(*) AS total FROM charges WHERE user_id = ?', [userId]);
    const pager = paging(page, pageSize, num(count.total));
    const [rows] = await pool.execute(`SELECT charge_id, message_id, kind, chars, amount_cents, created_at FROM charges
      WHERE user_id = ? ORDER BY charge_id DESC LIMIT ${pager.pageSize} OFFSET ${pager.offset}`, [userId]);
    return {
      charges: rows.map((row) => ({
        id: row.charge_id,
        messageId: row.message_id,
        kind: row.kind,
        chars: row.chars,
        amountCents: num(row.amount_cents),
        at: toIso(row.created_at),
      })),
      pager,
    };
  },

  /**
   * Payments, newest first. status: all | valid | voided. from / to are the admin's calendar dates (YYYY-MM-DD, both inclusive).
   * Also returns the total of the valid payments that match, so the page can show "collected".
   */
  async listPayments({ userId = null, q = '', status = 'all', from = '', to = '', page = 1, pageSize = 20, all = false } = {}) {
    const where = [];
    const params = [];
    if (userId) { where.push('p.user_id = ?'); params.push(userId); }
    if (q.trim()) { where.push('u.username LIKE ?'); params.push(likePattern(q.trim().slice(0, 50))); }
    if (status === 'valid') where.push('p.voided_at IS NULL');
    else if (status === 'voided') where.push('p.voided_at IS NOT NULL');
    const fromDate = billing.parseLocalDate(from);
    const toDate = billing.parseLocalDate(to);
    if (fromDate) { where.push('p.paid_at >= ?'); params.push(billing.toSqlUtc(fromDate)); }
    if (toDate) { where.push('p.paid_at < ?'); params.push(billing.toSqlUtc(new Date(toDate.getTime() + DAY_MS))); }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';

    const [[sums]] = await pool.execute(
      `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN p.voided_at IS NULL THEN p.amount_cents END), 0) AS collected
       FROM payments p JOIN users u ON u.user_id = p.user_id${clause}`, params);
    const pager = paging(all ? 1 : page, all ? 10000 : pageSize, num(sums.total));
    const [rows] = await pool.execute(
      `${billing.PAYMENT_SELECT}${clause} ORDER BY p.paid_at DESC, p.payment_id DESC LIMIT ${pager.pageSize} OFFSET ${pager.offset}`, params);
    return { payments: rows.map(billing.toPayment), pager, collectedCents: num(sums.collected) };
  },

  /** Billed / collected / outstanding, for the Dashboard and the Billing page header. */
  async moneyTotals(todayStart = billing.dayStartUtc()) {
    const [[charged]] = await pool.execute(
      `SELECT COALESCE(SUM(amount_cents), 0) AS cents,
              COALESCE(SUM(CASE WHEN created_at >= ? THEN amount_cents END), 0) AS todayCents FROM charges`,
      [billing.toSqlUtc(todayStart)]);
    const [[paid]] = await pool.execute(
      'SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM payments WHERE voided_at IS NULL');
    const [[owing]] = await pool.execute(
      `SELECT COUNT(*) AS people, COALESCE(SUM(balance), 0) AS cents FROM (${USER_STATS}) t WHERE balance > 0`);
    return {
      billedCents: num(charged.cents),
      billedTodayCents: num(charged.todayCents),
      collectedCents: num(paid.cents),
      outstandingCents: num(owing.cents),
      owingPeople: num(owing.people),
    };
  },

  /** Everything the Dashboard shows. `onlineNow` comes from the live chat connections. */
  async dashboard({ onlineNow = 0, now = Date.now() } = {}) {
    const offset = billing.ADMIN_UTC_OFFSET_MINUTES;
    const todayStart = billing.dayStartUtc(now, offset);
    const firstDay = new Date(todayStart.getTime() - 13 * DAY_MS);

    const [[users]] = await pool.execute(
      "SELECT COUNT(*) AS total, COALESCE(SUM(status = 'active'), 0) AS active FROM users WHERE role = 'user'");
    const [[messages]] = await pool.execute(
      'SELECT COUNT(*) AS total, COALESCE(SUM(sent_at >= ?), 0) AS today FROM messages', [billing.toSqlUtc(todayStart)]);
    const [[charged]] = await pool.execute(
      `SELECT COALESCE(SUM(chars), 0) AS chars,
              COALESCE(SUM(CASE WHEN created_at >= ? THEN chars END), 0) AS todayChars
       FROM charges`, [billing.toSqlUtc(todayStart)]);
    const money = await this.moneyTotals(todayStart);
    const [topRows] = await pool.execute(
      `SELECT * FROM (${USER_STATS}) t WHERE balance > 0 ORDER BY balance DESC, username ASC LIMIT 5`);
    const [recentRows] = await pool.execute(
      `${billing.PAYMENT_SELECT} WHERE p.voided_at IS NULL ORDER BY p.paid_at DESC, p.payment_id DESC LIMIT 6`);

    // Characters billed per day for the last 14 days (days with no activity count as zero).
    const [dayRows] = await pool.execute(
      `SELECT DATE(DATE_ADD(created_at, INTERVAL ? MINUTE)) AS day, SUM(chars) AS chars, SUM(amount_cents) AS cents,
              SUM(kind = 'send') AS messages
       FROM charges WHERE created_at >= ? GROUP BY day`, [offset, billing.toSqlUtc(firstDay)]);
    const byDay = new Map(dayRows.map((row) => [String(row.day).slice(0, 10), row]));
    const daily = [];
    for (let i = 13; i >= 0; i -= 1) {
      const start = new Date(todayStart.getTime() - i * DAY_MS);
      const label = billing.localDateString(start, offset);
      const row = byDay.get(label);
      daily.push({ day: label, chars: row ? num(row.chars) : 0, cents: row ? num(row.cents) : 0, messages: row ? num(row.messages) : 0 });
    }

    return {
      users: { total: num(users.total), active: num(users.active), online: onlineNow },
      messages: { total: num(messages.total), today: num(messages.today) },
      chars: { total: num(charged.chars), today: num(charged.todayChars) },
      money,
      topOwing: topRows.map(toUserStats),
      recentPayments: recentRows.map(billing.toPayment),
      daily,
    };
  },
};
