const test = require('node:test');
const assert = require('node:assert/strict');
const users = require('../models/userModel');
const messages = require('../models/messageModel');

test('new usernames have a six-character minimum', () => {
  assert.ok(users.validateUsername('short'));
  assert.equal(users.validateUsername('Tester'), null);
});

test('message validation trims content and rejects blank or oversized messages', () => {
  assert.deepEqual(messages.validateContent('  hello  '), {ok: true, content: 'hello'});
  assert.equal(messages.validateContent('   ').ok, false);
  assert.equal(messages.validateContent('a'.repeat(2001)).ok, false);
});

test('only active regular users may chat; only active administrators may use the admin area', () => {
  assert.equal(users.canChat({status: 'active', role: 'user'}), true);
  assert.equal(users.canChat({status: 'active', role: 'admin'}), false);
  assert.equal(users.canChat({status: 'inactive', role: 'user'}), false);
  assert.equal(users.canChat(undefined), false);

  assert.equal(users.canAdmin({status: 'active', role: 'admin'}), true);
  assert.equal(users.canAdmin({status: 'active', role: 'user'}), false);
  assert.equal(users.canAdmin({status: 'inactive', role: 'admin'}), false);

  assert.equal(users.canSignIn({status: 'active', role: 'user'}), true);
  assert.equal(users.canSignIn({status: 'active', role: 'admin'}), true);
  assert.equal(users.canSignIn({status: 'inactive', role: 'admin'}), false);
  assert.equal(users.canSignIn({status: 'active', role: 'something-else'}), false);
});

test('other people never see roles or password hashes, and an admin account shows as inactive to them', () => {
  const row = {user_id: 7, username: 'someone_x', password_hash: 'secret', status: 'active', role: 'admin', created_at: '2026-01-02 03:04:05'};
  assert.deepEqual(users.toPublic(row), {id: 7, username: 'someone_x', status: 'inactive', createdAt: '2026-01-02T03:04:05Z'});
  assert.equal(users.toSession(row).role, 'admin');
  assert.equal(users.toSession(row).status, 'active');
  assert.equal('password_hash' in users.toSession(row), false);
});
