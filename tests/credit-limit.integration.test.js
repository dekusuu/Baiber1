/**
 * The optional credit limit (BILLING_CREDIT_LIMIT). Off by default; see tests/helpers/integration.js.
 * This file sets its own limit of $10, so it runs in its own process.
 */
process.env.BILLING_CREDIT_LIMIT = '10';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers/integration');

const skip = !h.enabled && 'set BAIBER_INTEGRATION=1 to run the MySQL integration tests';

test('credit limit of $10 (MySQL)', { skip }, async (t) => {
  await h.resetDatabase();
  const app = await h.startApp();
  t.after(() => app.stop());

  const pool = require('../database');
  const billing = require('../models/billingModel');
  assert.equal(billing.CREDIT_LIMIT_CENTS, 1000);

  const admin = await h.makeUser('theadmin', { role: 'admin' });
  const alice = await h.makeUser('alice_one');
  const bob = await h.makeUser('bob_two_x');
  await h.makeFriends(alice, bob);
  const aliceC = app.client();
  const adminC = app.client();
  await aliceC.login(alice.username, alice.password);
  await adminC.login(admin.username, admin.password);
  const send = (content) => aliceC.api('POST', '/api/messages', { recipientId: bob.id, content });
  const messages = async () => Number((await pool.query('SELECT COUNT(*) AS n FROM messages'))[0][0].n);

  await t.test('a message that would take the unpaid balance over the limit is refused, not stored, not billed', async () => {
    assert.equal((await send('12345')).status, 201); // $5 owed
    assert.equal((await send('12345')).status, 201); // $10 owed: exactly at the limit
    const refused = await send('x');
    assert.equal(refused.status, 402);
    assert.match(refused.json.error, /limit/i);
    assert.equal(await messages(), 2);
    assert.equal((await billing.balanceOf(alice.id)).balanceCents, 1000);
  });

  await t.test('paying at the counter lets them send again', async () => {
    await adminC.post('/admin/payments', { userId: String(alice.id), amount: '5', receivedOn: '', note: '', requestKey: 'b'.repeat(32), returnTo: '/admin/billing' });
    assert.equal((await send('12345')).status, 201);
    assert.equal((await send('1')).status, 402);
  });

  await t.test('an edit that adds characters is held to the same limit', async () => {
    await adminC.post('/admin/payments', { userId: String(alice.id), amount: '2', receivedOn: '', note: '', requestKey: 'c'.repeat(32), returnTo: '/admin/billing' });
    const [[row]] = await pool.query('SELECT message_id FROM messages ORDER BY message_id LIMIT 1');
    const tooLong = await aliceC.api('PUT', `/api/messages/${row.message_id}`, { content: '1234567890' });
    assert.equal(tooLong.status, 402); // 5 extra characters = $5, balance is $8 so $13 > $10
    const fits = await aliceC.api('PUT', `/api/messages/${row.message_id}`, { content: '1234567' });
    assert.equal(fits.status, 200); // 2 extra characters = $2 -> $10
    assert.equal((await billing.balanceOf(alice.id)).balanceCents, 1000);
  });

  await t.test('five sends at the same instant cannot all squeeze under the limit', async () => {
    await adminC.post('/admin/payments', { userId: String(alice.id), amount: '10', receivedOn: '', note: '', requestKey: 'd'.repeat(32), returnTo: '/admin/billing' });
    assert.equal((await billing.balanceOf(alice.id)).balanceCents, 0);
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => send(`msg-${i}`.padEnd(5, '.'))));
    const ok = results.filter((r) => r.status === 201).length;
    assert.equal(ok, 2, 'only two $5 messages fit under a $10 limit');
    assert.equal(results.filter((r) => r.status === 402).length, 3);
    assert.equal((await billing.balanceOf(alice.id)).balanceCents, 1000);
  });
});
