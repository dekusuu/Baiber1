// Pure billing rules. No database needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const billing = require('../models/billingModel');

test('one character costs one dollar (100 cents) by default', () => {
  assert.equal(billing.RATE_CENTS_PER_CHAR, 100);
  assert.equal(billing.costCents(5), 500);
  assert.equal(billing.costCents(0), 0);
});

test('characters are counted as people see them: spaces and line breaks count, an emoji is one', () => {
  assert.equal(billing.countChars('hello'), 5);
  assert.equal(billing.countChars('a b\nc'), 5);
  assert.equal(billing.countChars('hi\u{1F600}'), 3);
  assert.equal(billing.countChars('éè'), 2);
  assert.equal(billing.countChars(''), 0);
});

test('money is shown in whole dollars when it can be, with cents when it cannot', () => {
  assert.equal(billing.formatMoney(0), '$0');
  assert.equal(billing.formatMoney(500), '$5');
  assert.equal(billing.formatMoney(1250), '$12.50');
  assert.equal(billing.formatMoney(1234500), '$12,345');
  assert.equal(billing.formatMoney(5), '$0.05');
  assert.equal(billing.formatMoney(-500), '-$5');
  assert.equal(billing.formatMoney('300'), '$3');
  assert.equal(billing.formatMoney(undefined), '$0');
});

test('typed amounts become exact cents (no floating point)', () => {
  assert.deepEqual(billing.parseMoney('150'), {ok: true, cents: 15000});
  assert.deepEqual(billing.parseMoney('150.5'), {ok: true, cents: 15050});
  assert.deepEqual(billing.parseMoney('$1,250.05'), {ok: true, cents: 125005});
  assert.deepEqual(billing.parseMoney(' 0.10 '), {ok: true, cents: 10});
  assert.deepEqual(billing.parseMoney('19.99'), {ok: true, cents: 1999}); // 19.99 * 100 is 1998.9999999999998 as a float
  for (const bad of ['', 'abc', '0', '0.00', '-5', '10.999', '1e3', '12,34,5x', '999999999', null, undefined]) {
    assert.equal(billing.parseMoney(bad).ok, false, `"${bad}" must be rejected`);
  }
});

test('receipt numbers are zero padded', () => {
  assert.equal(billing.receiptNumber(1), 'OR-000001');
  assert.equal(billing.receiptNumber(123456), 'OR-123456');
});

test('days are cut at midnight in the administrator time zone', () => {
  // 2026-11-20 20:00 UTC is already 04:00 on the 21st in Manila (UTC+8)
  const now = Date.UTC(2026, 10, 20, 20, 0, 0);
  assert.equal(billing.dayStartUtc(now, 0).toISOString(), '2026-11-20T00:00:00.000Z');
  assert.equal(billing.dayStartUtc(now, 480).toISOString(), '2026-11-20T16:00:00.000Z');
  assert.equal(billing.localDateString(new Date(now), 480), '2026-11-21');
  assert.equal(billing.localDateString(new Date(now), 0), '2026-11-20');
  assert.equal(billing.parseLocalDate('2026-11-21', 480).toISOString(), '2026-11-20T16:00:00.000Z');
  assert.equal(billing.parseLocalDate('2026-02-30'), null);
  assert.equal(billing.parseLocalDate('nonsense'), null);
});

test('the message shown when the credit limit refuses a send', () => {
  assert.match(billing.creditMessage({costCents: 600, balanceCents: -500, limitCents: 0}), /not have enough credit.*\$6/);
  assert.match(billing.creditMessage({costCents: 500, balanceCents: 1000, limitCents: 1000}), /\$10 limit/);
});
