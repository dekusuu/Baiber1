/**
 * End-to-end checks of billing, the admin role and the admin area against a real MySQL database.
 * Off by default; see tests/helpers/integration.js.   BAIBER_INTEGRATION=1 npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers/integration');

const skip = !h.enabled && 'set BAIBER_INTEGRATION=1 to run the MySQL integration tests';
const KEY = (n) => String(n).padStart(32, 'a'); // a valid 32-character request key

test('billing and the admin area (MySQL)', { skip }, async (t) => {
  await h.resetDatabase();
  const app = await h.startApp();
  t.after(() => app.stop());

  const pool = require('../database');
  const billing = require('../models/billingModel');
  const bal = async (user) => (await billing.balanceOf(user.id)).balanceCents;
  const count = async (table) => Number((await pool.query(`SELECT COUNT(*) AS n FROM ${table}`))[0][0].n);

  const admin = await h.makeUser('theadmin', { role: 'admin' });
  const alice = await h.makeUser('alice_one');
  const bob = await h.makeUser('bob_two_x');
  const carol = await h.makeUser('carol_three');
  await h.makeFriends(alice, bob);

  const adminC = app.client();
  const aliceC = app.client();
  const bobC = app.client();
  const guest = app.client();

  const adminLogin = await adminC.login(admin.username, admin.password);
  const aliceLogin = await aliceC.login(alice.username, alice.password);
  await bobC.login(bob.username, bob.password);

  await t.test('roles: who lands where and who may enter what', async () => {
    assert.equal(adminLogin.location, '/admin');
    assert.equal(aliceLogin.location, '/chat');
    assert.equal((await guest.get('/admin')).location, '/login');
    assert.equal((await aliceC.get('/admin')).status, 404);
    assert.equal((await aliceC.get('/admin/billing')).status, 404);
    assert.equal((await aliceC.post('/admin/payments', { userId: String(bob.id), amount: '5' })).status, 404);
    assert.equal((await adminC.get('/chat')).location, '/admin');
    assert.equal((await adminC.get('/')).location, '/admin');
    assert.equal((await adminC.api('GET', '/api/billing')).status, 403);
    assert.equal((await adminC.api('POST', '/api/messages', { recipientId: alice.id, content: 'hi there' })).status, 403);
    assert.equal((await aliceC.api('GET', '/api/billing')).status, 200);
  });

  await t.test('registering always makes a regular user, whatever the form says', async () => {
    await guest.get('/register');
    const result = await guest.post('/register', {
      username: 'sneaky_user', password: 'Passw0rd!test', confirmPassword: 'Passw0rd!test', role: 'admin',
    });
    assert.equal(result.location, '/login');
    const [[row]] = await pool.query("SELECT role FROM users WHERE username = 'sneaky_user'");
    assert.equal(row.role, 'user');
  });

  let helloId;
  await t.test('every character sent costs $1, charged together with the message', async () => {
    const sent = await aliceC.api('POST', '/api/messages', { recipientId: bob.id, content: 'hello' });
    assert.equal(sent.status, 201);
    helloId = sent.json.message.id;
    assert.deepEqual(sent.json.charge, { chars: 5, amountCents: 500 });
    assert.equal(sent.json.balanceCents, 500);

    const emoji = await aliceC.api('POST', '/api/messages', { recipientId: bob.id, content: 'hi\u{1F600}' });
    assert.deepEqual(emoji.json.charge, { chars: 3, amountCents: 300 }, 'an emoji counts as one character');

    const padded = await aliceC.api('POST', '/api/messages', { recipientId: bob.id, content: '   hey   ' });
    assert.equal(padded.json.charge.chars, 3, 'surrounding spaces are trimmed before counting');

    assert.equal(await bal(alice), 1100);
    const mine = await aliceC.api('GET', '/api/billing');
    assert.equal(mine.json.balanceCents, 1100);
    assert.equal(mine.json.charges.length, 3);
  });

  await t.test('a refused message (not friends) is not stored and not billed', async () => {
    const before = { messages: await count('messages'), charges: await count('charges') };
    const refused = await aliceC.api('POST', '/api/messages', { recipientId: carol.id, content: 'hello carol' });
    assert.equal(refused.status, 403);
    assert.equal(await count('messages'), before.messages);
    assert.equal(await count('charges'), before.charges);
    assert.equal(await bal(alice), 1100);
  });

  await t.test('editing bills only the extra characters; shorter edits never refund', async () => {
    const longer = await aliceC.api('PUT', `/api/messages/${helloId}`, { content: 'hello world' });
    assert.deepEqual(longer.json.charge, { chars: 6, amountCents: 600 });
    assert.equal(await bal(alice), 1700);

    const shorter = await aliceC.api('PUT', `/api/messages/${helloId}`, { content: 'hi' });
    assert.equal(shorter.json.charge, null);
    const back = await aliceC.api('PUT', `/api/messages/${helloId}`, { content: 'hello world' });
    assert.equal(back.json.charge, null, 'going back to a length that was already paid for is free');
    assert.equal(await bal(alice), 1700);

    const plusOne = await aliceC.api('PUT', `/api/messages/${helloId}`, { content: 'hello worlds' });
    assert.deepEqual(plusOne.json.charge, { chars: 1, amountCents: 100 });
    assert.equal(await bal(alice), 1800);
  });

  await t.test('deleting a message does not refund it', async () => {
    const deleted = await aliceC.api('DELETE', `/api/messages/${helloId}`);
    assert.equal(deleted.status, 200);
    assert.equal(await bal(alice), 1800);
  });

  await t.test('messages from before billing are free; only characters added by an edit are billed', async () => {
    const [res] = await pool.execute(`INSERT INTO messages (sender_id, receiver_id, content, sent_at, chars_covered)
      VALUES (?, ?, 'old message', UTC_TIMESTAMP(), 11)`, [alice.id, bob.id]);
    assert.equal(await bal(alice), 1800);
    const edit = await aliceC.api('PUT', `/api/messages/${res.insertId}`, { content: 'old message!' });
    assert.deepEqual(edit.json.charge, { chars: 1, amountCents: 100 });
    assert.equal(await bal(alice), 1900);
  });

  let firstPaymentId;
  await t.test('an admin records a payment; double submits and bad input are handled', async () => {
    const ok = await adminC.post('/admin/payments', {
      userId: String(alice.id), amount: '10', receivedOn: '', note: 'cash at the counter', requestKey: KEY(1), returnTo: '/admin/billing',
    });
    assert.match(ok.location, /^\/admin\/payments\/\d+\/receipt$/);
    firstPaymentId = Number(ok.location.split('/')[3]);
    assert.equal(await bal(alice), 900);

    const again = await adminC.post('/admin/payments', {
      userId: String(alice.id), amount: '10', receivedOn: '', note: 'cash at the counter', requestKey: KEY(1), returnTo: '/admin/billing',
    });
    assert.equal(again.location, ok.location, 'the same form submitted twice points at the same receipt');
    assert.equal(await count('payments'), 1);
    assert.equal(await bal(alice), 900);

    const receipt = await adminC.get(ok.location);
    assert.equal(receipt.status, 200);
    assert.match(receipt.body, /OR-000001/);
    assert.match(receipt.body, /\$10/);
    assert.match(receipt.body, /alice_one/);

    const bad = [
      ['not a number', { amount: 'abc' }, /number/],
      ['zero', { amount: '0' }, /greater than zero/],
      ['negative', { amount: '-5' }, /number/],
      ['three decimals', { amount: '10.999' }, /number/],
      ['too large', { amount: '999999999' }, /cannot be more than/],
      ['no user', { userId: '' }, /Choose which user paid/],
      ['an admin account', { userId: String(admin.id) }, /Choose which user paid/],
      ['a date in the future', { receivedOn: '2999-01-01' }, /future/],
      ['a nonsense date', { receivedOn: '2026-13-45' }, /valid date/],
    ];
    for (const [label, change, message] of bad) {
      const result = await adminC.post('/admin/payments', {
        userId: String(alice.id), amount: '5', receivedOn: '', note: '', requestKey: KEY(50), returnTo: '/admin/billing', ...change,
      });
      assert.equal(result.location, '/admin/billing', `${label}: redirected back`);
      const page = await adminC.get(result.location);
      assert.match(page.body, message, `${label}: explains what is wrong`);
    }
    assert.equal(await count('payments'), 1, 'nothing invalid was recorded');
  });

  await t.test('an earlier date is stored; the return link cannot leave the admin area', async () => {
    const result = await adminC.post('/admin/payments', {
      userId: String(bob.id), amount: '1.50', receivedOn: '2026-01-15', note: '', requestKey: KEY(2), returnTo: 'https://evil.example',
    });
    const id = Number(result.location.split('/')[3]);
    const payment = await billing.findPayment(id);
    assert.equal(payment.amountCents, 150);
    assert.match(payment.paidAt, /^2026-01-1[45]T/);
    const failing = await adminC.post('/admin/payments', { userId: '', amount: '5', returnTo: 'https://evil.example/x' });
    assert.equal(failing.location, '/admin/billing', 'an outside link is ignored');
  });

  await t.test('voiding a payment puts the amount back on the balance', async () => {
    const short = await adminC.post(`/admin/payments/${firstPaymentId}/void`, { reason: 'x', returnTo: '/admin/billing?tab=payments' });
    assert.match((await adminC.get(short.location)).body, /reason/i);
    assert.equal(await bal(alice), 900, 'a missing reason voids nothing');

    const voided = await adminC.post(`/admin/payments/${firstPaymentId}/void`, { reason: 'wrong amount entered', returnTo: '/admin/billing?tab=payments' });
    assert.equal(voided.location, '/admin/billing?tab=payments');
    assert.equal(await bal(alice), 1900);
    assert.match((await adminC.get(`/admin/payments/${firstPaymentId}/receipt`)).body, /VOID/);

    await adminC.post(`/admin/payments/${firstPaymentId}/void`, { reason: 'again', returnTo: '/admin/billing?tab=payments' });
    assert.equal(await bal(alice), 1900, 'voiding twice changes nothing');
  });

  await t.test('the admin pages show real numbers', async () => {
    await adminC.post('/admin/payments', {
      userId: String(alice.id), amount: '2', receivedOn: '', note: '=SUM(1+1)', requestKey: KEY(3), returnTo: '/admin/billing',
    });
    assert.equal(await bal(alice), 1700);

    const dash = await adminC.get('/admin');
    assert.equal(dash.status, 200);
    assert.match(dash.body, /Outstanding/);
    assert.match(dash.body, /Characters billed per day/);
    assert.match(dash.body, /alice_one/, 'the biggest balance is listed');
    assert.match(dash.body, /\$17/);
    assert.doesNotMatch(dash.body, /<script>/i, 'no inline script (the CSP forbids it)');

    const list = await adminC.get('/admin/users');
    assert.match(list.body, /alice_one/);
    assert.doesNotMatch(list.body, new RegExp(`/admin/users/${admin.id}"`), 'administrators are not listed as users');
    const filtered = await adminC.get('/admin/users?q=bob_two');
    assert.match(filtered.body, /bob_two_x/);
    assert.doesNotMatch(filtered.body, new RegExp(`href="/admin/users/${alice.id}"`), 'alice is filtered out of the table');

    const detail = await adminC.get(`/admin/users/${alice.id}`);
    assert.equal(detail.status, 200);
    assert.match(detail.body, /OR-000003/);
    assert.match(detail.body, /Message sent/);
    assert.doesNotMatch(detail.body, /hello world/, 'message text is never shown to administrators');
    assert.equal((await adminC.get(`/admin/users/${admin.id}`)).status, 404);
    assert.equal((await adminC.get('/admin/users/abc')).status, 404);

    const billingPage = await adminC.get('/admin/billing');
    assert.equal(billingPage.status, 200);
    assert.match(billingPage.body, /alice_one/);
    const payments = await adminC.get('/admin/billing?tab=payments');
    assert.match(payments.body, /OR-000001/);
    assert.match(payments.body, /Void/);
    assert.equal((await adminC.get('/admin/billing?tab=payments&from=2026-01-01&to=2026-01-31')).status, 200);

    const csv = await adminC.get('/admin/billing/payments.csv');
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.body, /OR-000001/);
    assert.match(csv.body, /VOID/);
    assert.match(csv.body, /'=SUM\(1\+1\)/, 'a note starting with = cannot run as a spreadsheet formula');
  });

  await t.test('deactivating a user signs them out at once; reactivating lets them back in', async () => {
    assert.equal((await bobC.api('GET', '/api/me')).status, 200);
    await adminC.post(`/admin/users/${bob.id}/status`, { status: 'inactive' });
    assert.equal((await bobC.api('GET', '/api/me')).status, 401);
    const denied = await app.client();
    await denied.get('/login');
    const login = await denied.post('/login', { username: bob.username, password: bob.password });
    assert.equal(login.status, 403);
    await adminC.post(`/admin/users/${bob.id}/status`, { status: 'active' });
    const again = app.client();
    assert.equal((await again.login(bob.username, bob.password)).location, '/chat');
    await bobC.login(bob.username, bob.password);
  });

  await t.test('people messaging each other at the same moment do not deadlock and every message is billed', async () => {
    const before = await count('charges');
    const jobs = [];
    for (let i = 0; i < 8; i += 1) {
      jobs.push(aliceC.api('POST', '/api/messages', { recipientId: bob.id, content: `ping ${i}` }));
      jobs.push(bobC.api('POST', '/api/messages', { recipientId: alice.id, content: `pong ${i}` }));
    }
    const results = await Promise.all(jobs);
    assert.deepEqual(results.map((r) => r.status), new Array(16).fill(201));
    assert.equal(await count('charges'), before + 16);
    const [[sum]] = await pool.query('SELECT SUM(amount_cents) AS cents FROM charges WHERE user_id = ?', [bob.id]);
    assert.equal(Number(sum.cents), 8 * 600);
  });

  await t.test('the user sees the new balance live when an admin records a payment', async () => {
    const { io } = require('socket.io-client');
    const socket = io(app.base, { extraHeaders: { cookie: aliceC.cookieHeader }, transports: ['websocket'], reconnection: false });
    try {
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
      const next = new Promise((resolve) => socket.once('billing:updated', resolve));
      const before = await bal(alice);
      await adminC.post('/admin/payments', {
        userId: String(alice.id), amount: '3', receivedOn: '', note: '', requestKey: KEY(4), returnTo: '/admin/billing',
      });
      const update = await next;
      assert.equal(update.balanceCents, before - 300);
    } finally {
      socket.close();
    }
  });
});
