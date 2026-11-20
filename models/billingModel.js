/**
 * Billing: 1 character sent = 1 dollar (see BILLING_RATE_CENTS), paid face to face and recorded by an admin.
 *
 * Money is always a whole number of CENTS (never a float). A user's balance is calculated, never stored:
 *
 *     balance = SUM(charges.amount_cents) - SUM(payments.amount_cents WHERE voided_at IS NULL)
 *
 * A positive balance means the user owes that much; a negative balance is credit.
 * Charges are written in the SAME transaction as the message they belong to (messageModel), so a
 * message can never exist without its charge. Deleting a message never refunds it.
 */
const pool = require('../database');
const { toIso } = require('./userModel');

const num = (value) => Number(value) || 0;

/* ---------------- configuration (all optional, see .env.example) ---------------- */

/** Price of one character in cents. Default 100 = one dollar. */
const RATE_CENTS_PER_CHAR = (() => {
  const value = Math.floor(Number(process.env.BILLING_RATE_CENTS));
  return Number.isSafeInteger(value) && value > 0 ? value : 100;
})();

/**
 * Optional ceiling on what a user may owe, in whole dollars.
 *   unset / blank -> no limit: people send freely and simply build up a balance
 *   0             -> prepaid: a message is refused unless the user already has enough credit
 *   50            -> a message is refused if it would take the unpaid balance above $50
 */
const CREDIT_LIMIT_CENTS = (() => {
  const raw = (process.env.BILLING_CREDIT_LIMIT || '').trim();
  if (raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
})();

/** The admin's time zone as minutes from UTC (Manila = 480). Only used for "today" and daily groupings. */
const ADMIN_UTC_OFFSET_MINUTES = (() => {
  const value = Math.round(Number(process.env.ADMIN_UTC_OFFSET_MINUTES));
  return Number.isFinite(value) && value >= -720 && value <= 840 ? value : 0;
})();

const MAX_PAYMENT_CENTS = 100000000; // $1,000,000: a typo guard, not a business rule

/* ---------------- pure helpers ---------------- */

/** Characters in a message. Counts every character (spaces and line breaks too); an emoji counts as 1. */
function countChars(text) {
  return Array.from(String(text)).length;
}

const costCents = (chars) => chars * RATE_CENTS_PER_CHAR;

/** 1234500 -> "$12,345"; 1250 -> "$12.50"; -500 -> "-$5". */
function formatMoney(cents) {
  const value = num(cents);
  const abs = Math.abs(value);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  const rest = abs % 100;
  const text = `$${dollars}${rest ? `.${String(rest).padStart(2, '0')}` : ''}`;
  return value < 0 ? `-${text}` : text;
}

/** "1,250.50" / "$40" -> { ok: true, cents } (digits only, at most two decimals, greater than zero). */
function parseMoney(input) {
  const text = String(input === undefined || input === null ? '' : input).trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) {
    return { ok: false, error: 'Enter the amount as a number, for example 150 or 150.50.' };
  }
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (cents <= 0) return { ok: false, error: 'The amount must be greater than zero.' };
  if (cents > MAX_PAYMENT_CENTS) return { ok: false, error: `The amount cannot be more than ${formatMoney(MAX_PAYMENT_CENTS)}.` };
  return { ok: true, cents };
}

const receiptNumber = (id) => `OR-${String(id).padStart(6, '0')}`;

/** "2026-11-20 08:05:09" in UTC, the format the database columns use. */
const toSqlUtc = (date) => date.toISOString().slice(0, 19).replace('T', ' ');

/** Start (as a Date) of the admin's calendar day that contains `now`. */
function dayStartUtc(now = Date.now(), offsetMinutes = ADMIN_UTC_OFFSET_MINUTES) {
  const local = now + offsetMinutes * 60000;
  return new Date(Math.floor(local / 86400000) * 86400000 - offsetMinutes * 60000);
}

/** "YYYY-MM-DD" typed by an admin (their local date) -> the matching UTC Date at local midnight, or null. */
function parseLocalDate(text, offsetMinutes = ADMIN_UTC_OFFSET_MINUTES) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''));
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utc = Date.UTC(year, month - 1, day);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return new Date(utc - offsetMinutes * 60000);
}

/** "YYYY-MM-DD" of the admin's calendar day that contains the given instant. */
const localDateString = (date, offsetMinutes = ADMIN_UTC_OFFSET_MINUTES) =>
  new Date(date.getTime() + offsetMinutes * 60000).toISOString().slice(0, 10);

/* ---------------- balances and charges ---------------- */

/** `db` is the pool or a transaction connection. */
async function totalsFor(db, userId) {
  const [[row]] = await db.execute(
    `SELECT (SELECT COALESCE(SUM(amount_cents), 0) FROM charges WHERE user_id = ?) AS charged,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE user_id = ? AND voided_at IS NULL) AS paid`,
    [userId, userId]);
  const chargedCents = num(row.charged);
  const paidCents = num(row.paid);
  return { chargedCents, paidCents, balanceCents: chargedCents - paidCents };
}

/** Totals for one user, read through the shared pool. */
const balanceOf = (userId) => totalsFor(pool, userId);

/**
 * Runs `work(connection)` in one database transaction. The work returns { ok: false, ... } to roll back
 * (nothing is saved), anything else to commit.
 * When a credit limit is set, a per-user lock makes one person's sends queue up, so two messages sent at
 * the same instant cannot both squeeze under the limit. (No row locks are used, so two people messaging
 * each other at the same time cannot deadlock.)
 */
async function inTransaction(userId, work) {
  const conn = await pool.getConnection();
  const lockName = `baiber:billing:${userId}`;
  let locked = false;
  try {
    if (CREDIT_LIMIT_CENTS !== null) {
      const [[row]] = await conn.query('SELECT GET_LOCK(?, 10) AS got', [lockName]);
      if (Number(row.got) !== 1) throw new Error('Could not obtain the billing lock for user ' + userId);
      locked = true;
    }
    await conn.beginTransaction();
    try {
      const result = await work(conn);
      if (result && result.ok === false) await conn.rollback();
      else await conn.commit();
      return result;
    } catch (err) {
      try { await conn.rollback(); } catch (rollbackError) { /* the original error matters more */ }
      throw err;
    }
  } finally {
    if (locked) {
      try { await conn.query('SELECT RELEASE_LOCK(?)', [lockName]); } catch (releaseError) { /* connection is gone: the lock went with it */ }
    }
    conn.release();
  }
}

/** Would this charge keep the user inside the credit limit? Call inside inTransaction. */
async function checkCredit(conn, userId, cents) {
  if (CREDIT_LIMIT_CENTS === null || cents <= 0) return { ok: true };
  const { balanceCents } = await totalsFor(conn, userId);
  if (balanceCents + cents <= CREDIT_LIMIT_CENTS) return { ok: true };
  return { ok: false, reason: 'credit', balanceCents, costCents: cents, limitCents: CREDIT_LIMIT_CENTS };
}

/** The error text shown to a person whose message was refused by the credit limit. */
function creditMessage({ costCents: cost, balanceCents, limitCents }) {
  if (limitCents === 0) {
    return `You do not have enough credit for this message (${formatMoney(cost)}). Please pay at the counter first.`;
  }
  return `This message (${formatMoney(cost)}) would take your unpaid balance of ${formatMoney(balanceCents)} over the ` +
    `${formatMoney(limitCents)} limit. Please pay at the counter first.`;
}

async function recordCharge(conn, { userId, messageId, kind, chars, cents }) {
  await conn.execute(
    `INSERT INTO charges (user_id, message_id, kind, chars, amount_cents, created_at)
     VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())`, [userId, messageId, kind, chars, cents]);
}

/* ---------------- payments ---------------- */

const PAYMENT_SELECT = `SELECT p.*, u.username, r.username AS recorder, v.username AS voider
  FROM payments p
  JOIN users u ON u.user_id = p.user_id
  JOIN users r ON r.user_id = p.recorded_by
  LEFT JOIN users v ON v.user_id = p.voided_by`;

function toPayment(row) {
  if (!row) return null;
  return {
    id: row.payment_id,
    receiptNo: receiptNumber(row.payment_id),
    userId: row.user_id,
    username: row.username,
    amountCents: num(row.amount_cents),
    paidAt: toIso(row.paid_at),
    note: row.note || '',
    recordedBy: row.recorded_by,
    recorder: row.recorder,
    createdAt: toIso(row.created_at),
    voided: Boolean(row.voided_at),
    voidedAt: toIso(row.voided_at),
    voider: row.voider || null,
    voidReason: row.void_reason || '',
  };
}

async function findPayment(id) {
  const [rows] = await pool.execute(`${PAYMENT_SELECT} WHERE p.payment_id = ?`, [id]);
  return toPayment(rows[0]);
}

/** Records cash received. `paidAt` is a Date (when the cash changed hands) or null for "now". */
async function recordPayment({ userId, amountCents, paidAt, note, adminId, requestKey }) {
  if (requestKey) {
    // Look first: a repeated submit must not burn a receipt number (a failed INSERT still uses up an id).
    const [existing] = await pool.execute(`${PAYMENT_SELECT} WHERE p.request_key = ?`, [requestKey]);
    if (existing.length) return { ok: false, duplicate: true, payment: toPayment(existing[0]) };
  }
  try {
    const [result] = await pool.execute(
      `INSERT INTO payments (user_id, amount_cents, paid_at, note, recorded_by, created_at, request_key)
       VALUES (?, ?, COALESCE(?, UTC_TIMESTAMP()), ?, ?, UTC_TIMESTAMP(), ?)`,
      [userId, amountCents, paidAt ? toSqlUtc(paidAt) : null, note || null, adminId, requestKey || null]);
    return { ok: true, payment: await findPayment(result.insertId) };
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY' || !requestKey) throw err;
    // The same form was submitted twice: report the payment that was already recorded.
    const [rows] = await pool.execute(`${PAYMENT_SELECT} WHERE p.request_key = ?`, [requestKey]);
    return { ok: false, duplicate: true, payment: toPayment(rows[0]) };
  }
}

/** Cancels a payment (it stays in the history, marked void, and stops counting toward the balance). */
async function voidPayment(id, adminId, reason) {
  const [result] = await pool.execute(
    `UPDATE payments SET voided_at = UTC_TIMESTAMP(), voided_by = ?, void_reason = ?
     WHERE payment_id = ? AND voided_at IS NULL`, [adminId, reason, id]);
  return result.affectedRows > 0;
}

/* ---------------- what one user sees ---------------- */

/** Totals + recent activity for the Profile dialog. */
async function summaryFor(userId) {
  const totals = await totalsFor(pool, userId);
  const [payments] = await pool.execute(`${PAYMENT_SELECT} WHERE p.user_id = ? AND p.voided_at IS NULL
    ORDER BY p.paid_at DESC, p.payment_id DESC LIMIT 5`, [userId]);
  const [charges] = await pool.execute(`SELECT charge_id, kind, chars, amount_cents, created_at FROM charges
    WHERE user_id = ? ORDER BY charge_id DESC LIMIT 10`, [userId]);
  return {
    ...totals,
    rateCents: RATE_CENTS_PER_CHAR,
    creditLimitCents: CREDIT_LIMIT_CENTS,
    payments: payments.map(toPayment),
    charges: charges.map((row) => ({
      id: row.charge_id,
      kind: row.kind,
      chars: row.chars,
      amountCents: num(row.amount_cents),
      at: toIso(row.created_at),
    })),
  };
}

module.exports = {
  RATE_CENTS_PER_CHAR, CREDIT_LIMIT_CENTS, ADMIN_UTC_OFFSET_MINUTES, MAX_PAYMENT_CENTS,
  num, countChars, costCents, formatMoney, parseMoney, receiptNumber, toSqlUtc,
  dayStartUtc, parseLocalDate, localDateString,
  totalsFor, balanceOf, inTransaction, checkCredit, creditMessage, recordCharge,
  PAYMENT_SELECT, toPayment, findPayment, recordPayment, voidPayment, summaryFor,
};
