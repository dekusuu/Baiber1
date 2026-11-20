/**
 * Admin area: Dashboard, Users and Billing / Payment.
 *
 * Every route here sits behind requireAdmin (server.js), and every state-changing route is a POST that
 * carries the CSRF token like all other forms. Administrators see counts and money only, never message text.
 */
const crypto = require('crypto');
const userModel = require('../models/userModel');
const billingModel = require('../models/billingModel');
const adminModel = require('../models/adminModel');
const chatController = require('./chatController');
const { disconnectSockets } = require('./authController');

const DAY_MS = 86400000;
const text = (value) => (typeof value === 'string' ? value : '');
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const positiveInt = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** Only ever redirect back into the admin area (never to a link a form field could point elsewhere). */
function safeReturn(value, fallback) {
  const path = text(value);
  return /^\/admin(\/[A-Za-z0-9\-._~%/]*)?(\?[A-Za-z0-9\-._~%=&+]*)?$/.test(path) && !path.includes('//') ? path : fallback;
}

/** A fresh one-time token for the "Record payment" form (stops a double click recording the payment twice). */
const newRequestKey = () => crypto.randomBytes(16).toString('hex');

/** Builds "/admin/users?q=ann&page=2" from the current filters, replacing some of them. */
function linker(path, query) {
  return (overrides = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...query, ...overrides })) {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${path}?${qs}` : path;
  };
}

/** A round axis maximum (4, 8, 12, 20, 40, 80, ...) whose half is also a clean number. */
function niceMax(value) {
  if (value <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(value / 4));
  for (const step of [4, 8, 12, 20]) if (step * power >= value) return step * power;
  return 40 * power;
}

/** 0, 2,500, 12K, 4M - full numbers under 10,000, compact above. */
function axisLabel(value) {
  if (value < 10000) return value.toLocaleString('en-US');
  if (value < 1000000) return `${value / 1000}K`;
  return `${Number((value / 1000000).toFixed(2))}M`;
}

const adminRender = (res, view, data) => res.render(view, { section: 'dashboard', ...data });

module.exports = {
  /** GET /admin */
  async dashboard(req, res) {
    const stats = await adminModel.dashboard({ onlineNow: chatController.onlineCount() });
    const peak = Math.max(0, ...stats.daily.map((day) => day.chars));
    const axisMax = niceMax(peak);
    adminRender(res, 'admin/dashboard', {
      section: 'dashboard',
      title: 'Dashboard',
      stats,
      chart: {
        max: axisMax,
        ticks: [0, axisMax / 2, axisMax].map((value) => ({ value, label: axisLabel(value), at: (value / axisMax) * 100 })),
        days: stats.daily.map((day, index) => {
          const date = new Date(`${day.day}T00:00:00Z`);
          const format = (options) => date.toLocaleDateString('en-US', { ...options, timeZone: 'UTC' });
          return {
            ...day,
            height: (day.chars / axisMax) * 100,
            label: format({ weekday: 'short', month: 'short', day: 'numeric' }),
            dayNumber: date.getUTCDate(),
            month: index === 0 || date.getUTCDate() === 1 ? format({ month: 'short' }) : '',
          };
        }),
        rate: billingModel.RATE_CENTS_PER_CHAR,
      },
    });
  },

  /** GET /admin/users */
  async users(req, res) {
    const query = {
      q: text(req.query.q).trim().slice(0, 50),
      status: pick(req.query.status, ['all', 'active', 'inactive'], 'all'),
      sort: pick(req.query.sort, Object.keys(adminModel.USER_SORTS), 'username'),
    };
    const { users, pager } = await adminModel.listUsers({ ...query, page: req.query.page });
    const pageUrl = linker('/admin/users', query);
    adminRender(res, 'admin/users', {
      section: 'users',
      title: 'Users',
      users, pager, query, pageUrl,
      choices: await adminModel.userChoices(),
      requestKey: newRequestKey(),
      today: billingModel.localDateString(new Date()),
      returnTo: pageUrl({ page: pager.page > 1 ? pager.page : undefined }),
    });
  },

  /** GET /admin/users/:id */
  async userDetail(req, res) {
    const id = positiveInt(req.params.id);
    const person = id && await adminModel.userStats(id);
    if (!person) return res.status(404).render('error', { status: 404, title: 'User not found', message: 'That user does not exist.' });
    const { charges, pager } = await adminModel.userCharges(id, { page: req.query.cp });
    const { payments } = await adminModel.listPayments({ userId: id, status: 'all', pageSize: 100 });
    const pageUrl = linker(`/admin/users/${id}`, {});
    return adminRender(res, 'admin/user-detail', {
      section: 'users',
      title: person.username,
      person, charges, pager, payments,
      chargesUrl: (page) => pageUrl({ cp: page > 1 ? page : undefined }),
      choices: [{ id: person.id, username: person.username, status: person.status, balanceCents: person.balanceCents }],
      requestKey: newRequestKey(),
      today: billingModel.localDateString(new Date()),
      returnTo: `/admin/users/${id}`,
      rate: billingModel.RATE_CENTS_PER_CHAR,
    });
  },

  /** POST /admin/users/:id/status  { status: 'active' | 'inactive' } */
  async setUserStatus(req, res) {
    const id = positiveInt(req.params.id);
    const status = pick(req.body && req.body.status, ['active', 'inactive'], null);
    const target = id && await userModel.findById(id);
    if (!target || target.role !== 'user' || !status) {
      req.flash('error', 'That user could not be changed.');
      return res.redirect('/admin/users');
    }
    if (target.status !== status) {
      await userModel.setStatus(id, status);
      if (status === 'inactive') {
        await userModel.endAllSessions(id); // signed out everywhere, at once
        disconnectSockets(req, (socket) => socket.data.userId === id);
      }
    }
    req.flash('success', status === 'inactive'
      ? `${target.username} was deactivated and signed out.`
      : `${target.username} was reactivated.`);
    return res.redirect(`/admin/users/${id}`);
  },

  /** GET /admin/billing?tab=balances|payments */
  async billing(req, res) {
    const tab = pick(req.query.tab, ['balances', 'payments'], 'balances');
    const data = {
      section: 'billing',
      title: 'Billing / Payment',
      tab,
      totals: await adminModel.moneyTotals(),
      rateCents: billingModel.RATE_CENTS_PER_CHAR,
      choices: await adminModel.userChoices(),
      requestKey: newRequestKey(),
      today: billingModel.localDateString(new Date()),
    };

    if (tab === 'balances') {
      const query = {
        tab,
        q: text(req.query.q).trim().slice(0, 50),
        filter: pick(req.query.filter, ['all', 'owing', 'settled', 'credit'], 'owing'),
        sort: pick(req.query.sort, Object.keys(adminModel.USER_SORTS), 'balance'),
      };
      const { users, pager } = await adminModel.listUsers({ ...query, page: req.query.page });
      const pageUrl = linker('/admin/billing', query);
      return adminRender(res, 'admin/billing', {
        ...data, query, users, pager, pageUrl,
        returnTo: pageUrl({ page: pager.page > 1 ? pager.page : undefined }),
      });
    }

    const query = {
      tab,
      q: text(req.query.q).trim().slice(0, 50),
      status: pick(req.query.status, ['all', 'valid', 'voided'], 'all'),
      from: billingModel.parseLocalDate(text(req.query.from)) ? text(req.query.from) : '',
      to: billingModel.parseLocalDate(text(req.query.to)) ? text(req.query.to) : '',
    };
    const { payments, pager, collectedCents } = await adminModel.listPayments({ ...query, page: req.query.page });
    const pageUrl = linker('/admin/billing', query);
    return adminRender(res, 'admin/billing', {
      ...data, query, payments, pager, pageUrl, collectedCents,
      csvUrl: linker('/admin/billing/payments.csv', { q: query.q, status: query.status, from: query.from, to: query.to })(),
      returnTo: pageUrl({ page: pager.page > 1 ? pager.page : undefined }),
    });
  },

  /**
   * POST /admin/payments  { userId, amount, receivedOn?, note?, requestKey, returnTo }
   * Records cash received face to face. On success the printable receipt opens.
   */
  async recordPayment(req, res) {
    const body = req.body || {};
    const back = safeReturn(body.returnTo, '/admin/billing');
    const fail = (message) => {
      req.flash('error', message);
      return res.redirect(back);
    };

    const userId = positiveInt(body.userId);
    const person = userId && await userModel.findById(userId);
    if (!person || person.role !== 'user') return fail('Choose which user paid.');

    const amount = billingModel.parseMoney(body.amount);
    if (!amount.ok) return fail(amount.error);

    const note = text(body.note).trim();
    if (note.length > 255) return fail('The note is too long (maximum 255 characters).');

    // "Received on" is the admin's calendar date. Today means "right now"; an earlier day is stored at noon.
    let paidAt = null;
    const receivedOn = text(body.receivedOn).trim();
    if (receivedOn) {
      const day = billingModel.parseLocalDate(receivedOn);
      if (!day) return fail('Enter the date received as a valid date.');
      const today = billingModel.dayStartUtc();
      if (day.getTime() > today.getTime()) return fail('The date received cannot be in the future.');
      if (today.getTime() - day.getTime() > 366 * DAY_MS) return fail('The date received cannot be more than a year ago.');
      if (day.getTime() < today.getTime()) paidAt = new Date(day.getTime() + 12 * 3600 * 1000);
    }

    const requestKey = /^[a-f0-9]{32}$/.test(text(body.requestKey)) ? body.requestKey : null;
    const result = await billingModel.recordPayment({
      userId, amountCents: amount.cents, paidAt, note, adminId: req.user.id, requestKey,
    });
    if (result.duplicate) {
      req.flash('info', `That payment was already recorded (${result.payment.receiptNo}).`);
      return res.redirect(`/admin/payments/${result.payment.id}/receipt`);
    }

    await chatController.notifyBilling(req.app.get('io'), userId);
    const { balanceCents } = await billingModel.balanceOf(userId);
    req.flash('success', `Recorded ${billingModel.formatMoney(amount.cents)} from ${person.username} ` +
      `(${result.payment.receiptNo}). Balance now ${billingModel.formatMoney(balanceCents)}.`);
    return res.redirect(`/admin/payments/${result.payment.id}/receipt`);
  },

  /** POST /admin/payments/:id/void  { reason, returnTo } */
  async voidPayment(req, res) {
    const id = positiveInt(req.params.id);
    const back = safeReturn(req.body && req.body.returnTo, '/admin/billing?tab=payments');
    const payment = id && await billingModel.findPayment(id);
    if (!payment) {
      req.flash('error', 'That payment could not be found.');
      return res.redirect(back);
    }
    const reason = text(req.body && req.body.reason).trim();
    if (reason.length < 3 || reason.length > 255) {
      req.flash('error', 'Give a reason for voiding the payment (3 to 255 characters).');
      return res.redirect(back);
    }
    if (!await billingModel.voidPayment(id, req.user.id, reason)) {
      req.flash('info', `${payment.receiptNo} was already voided.`);
      return res.redirect(back);
    }
    await chatController.notifyBilling(req.app.get('io'), payment.userId);
    req.flash('success', `${payment.receiptNo} was voided. ${payment.username}'s balance went up by ${billingModel.formatMoney(payment.amountCents)}.`);
    return res.redirect(back);
  },

  /** GET /admin/payments/:id/receipt - printable. */
  async receipt(req, res) {
    const id = positiveInt(req.params.id);
    const payment = id && await billingModel.findPayment(id);
    if (!payment) return res.status(404).render('error', { status: 404, title: 'Receipt not found', message: 'That payment does not exist.' });
    adminRender(res, 'admin/receipt', {
      section: 'billing',
      title: payment.receiptNo,
      payment,
      balance: await billingModel.balanceOf(payment.userId),
      rateCents: billingModel.RATE_CENTS_PER_CHAR,
      printedAt: new Date().toISOString(),
    });
  },

  /** GET /admin/billing/payments.csv - same filters as the Payments tab, every matching row. */
  async paymentsCsv(req, res) {
    const filters = {
      q: text(req.query.q).trim().slice(0, 50),
      status: pick(req.query.status, ['all', 'valid', 'voided'], 'all'),
      from: text(req.query.from),
      to: text(req.query.to),
      all: true,
    };
    const { payments } = await adminModel.listPayments(filters);
    // A cell that starts with = + - @ would run as a formula when opened in a spreadsheet: neutralise it.
    const cell = (value) => {
      let out = String(value === undefined || value === null ? '' : value);
      if (/^[=+\-@\t\r]/.test(out)) out = `'${out}`;
      return /[",\r\n]/.test(out) ? `"${out.replace(/"/g, '""')}"` : out;
    };
    const header = ['Receipt', 'Received (UTC)', 'User', 'Amount', 'Note', 'Recorded by', 'Status', 'Voided (UTC)', 'Void reason'];
    const lines = payments.map((p) => [
      p.receiptNo, p.paidAt, p.username, (p.amountCents / 100).toFixed(2), p.note, p.recorder,
      p.voided ? 'VOID' : 'valid', p.voidedAt || '', p.voidReason,
    ].map(cell).join(','));
    const stamp = billingModel.localDateString(new Date());
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="bai-ber-payments-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    });
    res.send(`﻿${[header.map(cell).join(','), ...lines].join('\r\n')}\r\n`);
  },
};
