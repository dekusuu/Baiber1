/**
 * Shared setup for the MySQL integration tests (tests/*.integration.test.js).
 *
 * These tests CREATE and DROP a database, so they are off unless you ask for them:
 *
 *     BAIBER_INTEGRATION=1 npm test
 *
 * They use their own database (default "bai_ber_test", never your real "bai_ber") and refuse to run
 * against any database whose name does not end in "_test". Use a MySQL account that may create databases
 * (for example root on your own machine) through the usual DB_HOST / DB_USER / DB_PASSWORD settings.
 */
const fs = require('node:fs');
const path = require('node:path');

const enabled = process.env.BAIBER_INTEGRATION === '1';
const dbName = process.env.TEST_DB_NAME || 'bai_ber_test';

if (enabled) {
  if (!/_test$/.test(dbName)) throw new Error(`Refusing to run integration tests on "${dbName}": the name must end in _test.`);
  // Must be set before any application module is loaded (they read process.env when they load).
  process.env.DB_NAME = dbName;
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'integration-test-secret-integration-test-secret';
  process.env.BCRYPT_ROUNDS = '4';
  process.env.NODE_ENV = 'development';
  process.env.REGISTER_LIMIT_PER_HOUR = '1000';
}

/** Drops and re-creates the test database from schema.sql. */
async function resetDatabase() {
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });
  try {
    const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'schema.sql'), 'utf8').replace(/\bbai_ber\b/g, dbName);
    await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await conn.query(schema);
  } finally {
    await conn.end();
  }
}

/** A tiny browser: keeps cookies, follows nothing (so redirects can be asserted) and sends the CSRF token. */
class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
    this.csrf = '';
  }

  get cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async request(method, url, { form, json, headers = {} } = {}) {
    const init = { method, redirect: 'manual', headers: { ...headers } };
    if (this.cookies.size) init.headers.cookie = this.cookieHeader;
    if (form) {
      init.headers['content-type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams({ _csrf: this.csrf, ...form }).toString();
    } else if (json !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.headers['x-csrf-token'] = this.csrf;
      init.body = JSON.stringify(json);
    } else if (method !== 'GET') {
      init.headers['x-csrf-token'] = this.csrf;
    }
    const res = await fetch(this.base + url, init);
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (/;\s*Expires=Thu, 01 Jan 1970/i.test(line) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const body = await res.text();
    const page = { status: res.status, headers: res.headers, location: res.headers.get('location'), body };
    const token = /<meta name="csrf-token" content="([^"]+)"/.exec(body);
    if (token) this.csrf = token[1];
    try { page.json = JSON.parse(body); } catch (err) { page.json = null; }
    return page;
  }

  get(url, options) { return this.request('GET', url, options); }
  post(url, form) { return this.request('POST', url, { form }); }
  api(method, url, json) { return this.request(method, url, { json, headers: { accept: 'application/json' } }); }

  /** Signs in through the real login form. Returns the response of POST /login. */
  async login(username, password) {
    await this.get('/login');
    const result = await this.post('/login', { username, password });
    if (result.location) await this.get(result.location); // load the landing page so we hold the new CSRF token
    return result;
  }
}

/** Boots the real app on a random port. */
async function startApp() {
  const { start, io } = require('../../server');
  const server = await start(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    io,
    server,
    client: () => new Client(base),
    async stop() {
      await new Promise((resolve) => io.close(resolve));
      await require('../../database').end();
    },
  };
}

/** Creates accounts directly in the database. */
async function makeUser(username, { role = 'user', password = 'Passw0rd!test' } = {}) {
  const bcrypt = require('bcryptjs');
  const users = require('../../models/userModel');
  await users.create({ username, passwordHash: await bcrypt.hash(password, 4), role });
  const row = await users.findByUsername(username);
  return { id: row.user_id, username, password };
}

/** Makes two users friends (the request goes from `a` to `b` and is accepted). */
async function makeFriends(a, b) {
  const users = require('../../models/userModel');
  const { request } = await users.sendRequest(a.id, b.id);
  await users.respondToRequest(b.id, request.friendship_id, true);
}

module.exports = { enabled, dbName, resetDatabase, startApp, makeUser, makeFriends, Client };
