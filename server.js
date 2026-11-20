/**
 * Bai-ber: application entry point.
 *
 *   npm start
 *
 * This file wires everything together, top to bottom:
 *   1. sessions (stored in MySQL)          4. HTTP routes
 *   2. security headers + CSRF protection    5. 404 / error pages
 *   3. "who is signed in?" + route guards    6. HTTP server + Socket.IO
 */
require('dotenv').config({ quiet: true }); // must come first: other files read process.env when they load

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');

const db = require('./database.js'); // shared MySQL connection pool
const userModel = require('./models/userModel');
const billingModel = require('./models/billingModel');
const authController = require('./controllers/authController');
const chatController = require('./controllers/chatController');
const adminController = require('./controllers/adminController');

const isProduction = process.env.NODE_ENV === 'production';
const { homeFor } = authController;
const app = express();

app.disable('x-powered-by');
// Set TRUST_PROXY=1 when running behind nginx / a hosting platform so secure cookies and req.ip work.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
}
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Fallback date text for pages (public/js/common.js replaces it with the visitor's local time).
app.locals.formatUtc = (iso) =>
  iso
    ? `${new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`
    : '-';

/* ======================================================================
   1. Sessions, kept server-side in MySQL (table "sessions").
      Only a random, signed session id travels in the cookie.
   ====================================================================== */
const PLACEHOLDER_SECRETS = ['', 'change-me', 'change-me-to-a-long-random-string'];
let sessionSecret = (process.env.SESSION_SECRET || '').trim();
if (PLACEHOLDER_SECRETS.includes(sessionSecret)) {
  if (isProduction) throw new Error('SESSION_SECRET must be set to a long random string when NODE_ENV=production.');
  // Development convenience: a random secret just means everyone is logged out on restart.
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[bai-ber] SESSION_SECRET is not set; using a temporary one for this run.');
}
const SESSION_MAX_AGE_MS = (Number(process.env.SESSION_DAYS) || 7) * 24 * 60 * 60 * 1000;

class MySQLSessionStore extends session.Store {
  constructor() {
    super();
    const cleanup = () => db.execute('DELETE FROM sessions WHERE expires <= ?', [Date.now()])
      .catch(err => console.error('Session cleanup:', err.message));
    setInterval(cleanup, 15 * 60 * 1000).unref();
  }

  expiryOf(sess) {
    return sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + SESSION_MAX_AGE_MS;
  }

  async get(sid, callback) {
    try {
      const [rows] = await db.execute('SELECT sess FROM sessions WHERE sid = ? AND expires > ?', [sid, Date.now()]);
      callback(null, rows.length ? JSON.parse(rows[0].sess) : null);
    } catch (err) { callback(err); }
  }

  async set(sid, sess, callback) {
    try {
      const data = JSON.stringify(sess), expires = this.expiryOf(sess), user = sess.userId || null;
      await db.execute(`INSERT INTO sessions (sid, sess, expires, user_id) VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE sess = ?, expires = ?, user_id = ?`, [sid, data, expires, user, data, expires, user]);
      callback?.(null);
    } catch (err) { callback?.(err); }
  }

  async touch(sid, sess, callback) {
    try {
      await db.execute('UPDATE sessions SET expires = ? WHERE sid = ?', [this.expiryOf(sess), sid]);
      callback?.(null);
    } catch (err) { callback?.(err); }
  }

  async destroy(sid, callback) {
    try {
      await db.execute('DELETE FROM sessions WHERE sid = ?', [sid]);
      callback?.(null);
    } catch (err) { callback?.(err); }
  }
}

const sessionMiddleware = session({
  name: 'baiber.sid',
  secret: sessionSecret,
  store: new MySQLSessionStore(),
  resave: false,
  saveUninitialized: false, // do not create a session until we actually store something in it
  cookie: {
    httpOnly: true, // JavaScript in the page cannot read the cookie
    sameSite: 'lax', // not sent on cross-site POSTs (extra CSRF defence)
    secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProduction,
    maxAge: SESSION_MAX_AGE_MS,
  },
});

/* ======================================================================
   2. Security: headers, JSON detection, CSRF
   ====================================================================== */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'", // no inline scripts anywhere in the app
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' ws: wss:", // Socket.IO
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}

/** Should this request get a JSON answer instead of an HTML page? */
function wantsJson(req) {
  return req.originalUrl.split('?')[0].startsWith('/api/')
    || req.xhr
    || (req.get('accept') || '').includes('application/json')
    || (req.get('content-type') || '').includes('application/json');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/**
 * CSRF protection (synchronizer token pattern). Forms send the token in a hidden "_csrf" field;
 * fetch() calls send it in the "X-CSRF-Token" header. Another website cannot read it, so it cannot forge requests.
 */
function csrfProtection(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
  if (sent && safeEqual(sent, req.session.csrfToken)) return next();

  const message = 'Your session expired or the form is invalid. Please refresh the page and try again.';
  if (wantsJson(req)) return res.status(403).json({ ok: false, error: message });
  return res.status(403).render('error', { status: 403, title: 'Request blocked', message });
}

/* ======================================================================
   3. Who is signed in? (re-read from the database on EVERY request, so a
      deactivated account loses access immediately) + flash messages + guards
   ====================================================================== */
async function loadUser(req, res, next) {
  req.user = null;
  res.locals.currentUser = null;
  const userId = req.session && req.session.userId;
  if (!userId) return next();

  const row = await userModel.findById(userId);
  if (userModel.canSignIn(row)) {
    req.user = userModel.toSession(row); // includes the role: "user" or "admin"
    res.locals.currentUser = req.user;
    return next();
  }
  // Deleted or deactivated: throw the old session away and continue signed out.
  req.authFailure = row && row.status !== 'active' ? 'inactive' : 'missing';
  return req.session.regenerate(() => next());
}

/** Tiny flash-message helper (messages survive exactly one redirect). Pages only, not /api. */
function flash(req, res, next) {
  req.flash = (type, message) => {
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, message });
  };
  res.locals.flash = [];
  if (req.session && req.session.flash && !req.path.startsWith('/api/')) {
    res.locals.flash = req.session.flash;
    delete req.session.flash;
  }
  next();
}

/** Any signed-in, active account (user or admin). */
function requireAuth(req, res, next) {
  if (req.user) return next();
  if (wantsJson(req)) return res.status(401).json({ ok: false, error: 'Please sign in again.' });
  return res.redirect(req.authFailure === 'inactive' ? '/login?reason=inactive' : '/login');
}

/** Chat and billing-for-users routes: regular users only. An administrator is sent to the admin area. */
function requireUser(req, res, next) {
  return requireAuth(req, res, () => {
    if (req.user.role === 'user') return next();
    if (wantsJson(req)) return res.status(403).json({ ok: false, error: 'Administrators cannot use the chat.' });
    return res.redirect(homeFor(req.user));
  });
}

/** Admin area: administrators only. Everyone else gets a plain 404 so the area's existence is not revealed. */
function requireAdmin(req, res, next) {
  if (!req.user) return requireAuth(req, res, next); // signed out: go to the login page
  if (req.user.role === 'admin') return next();
  if (wantsJson(req)) return res.status(404).json({ ok: false, error: 'Not found.' });
  return res.status(404).render('error', {
    status: 404,
    title: 'Page not found',
    message: 'The page you are looking for does not exist.',
  });
}

/** Keeps signed-in people away from the login and register pages. */
function guestOnly(req, res, next) {
  return req.user ? res.redirect(homeFor(req.user)) : next();
}

/* ---- middleware, in order ---- */
app.use(securityHeaders);

// Static files are served before sessions so images and CSS never create a session.
app.get('/favicon.ico', (req, res) => res.status(204).end()); // the real icon is /images/logo.svg
const staticOptions = { maxAge: isProduction ? '1d' : 0 };
const nodeModules = path.join(__dirname, 'node_modules');
app.use(express.static(path.join(__dirname, 'public'), staticOptions));
app.use('/vendor/bootstrap', express.static(path.join(nodeModules, 'bootstrap', 'dist'), staticOptions));
app.use('/vendor/bootstrap-icons', express.static(path.join(nodeModules, 'bootstrap-icons', 'font'), staticOptions));
app.use('/vendor/inter', express.static(path.join(nodeModules, '@fontsource-variable', 'inter'), staticOptions));

app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use(express.json({ limit: '10kb' }));
app.use(sessionMiddleware);
app.use(loadUser);
app.use(flash);
app.use(csrfProtection);
app.use((req, res, next) => {
  res.locals.appName = 'Bai-ber';
  res.locals.money = billingModel.formatMoney; // money(cents) -> "₱1,250" in templates
  next();
});

/* ======================================================================
   4. Routes
   ====================================================================== */
app.get('/', (req, res) => res.redirect(req.user ? homeFor(req.user) : '/login'));

// Accounts
app.get('/login', guestOnly, authController.showLogin);
app.post('/login', guestOnly, authController.login);
app.get('/register', guestOnly, authController.showRegister);
app.post('/register', guestOnly, authController.register);
app.post('/logout', requireAuth, authController.logout); // POST + CSRF token, so no <img> can log you out
app.post('/api/profile/username', requireUser, authController.rename);
app.delete('/api/friends/:id', requireUser, chatController.unfriend);
app.post('/api/profile/password', requireAuth, authController.changePassword);

// Chat page and its data
app.get('/chat', requireUser, chatController.showChat);
app.get('/api/me', requireUser, chatController.me);
app.get('/api/conversations', requireUser, chatController.conversations);
const messageWrites = authController.createLimiter({windowMs: 10000, max: 40});
function limitMessageWrites(req, res, next) {
  if (messageWrites.consume(String(req.user.id)).allowed) return next();
  return res.status(429).json({ok: false, error: 'Too many message changes. Please slow down.'});
}
app.post('/api/messages', requireUser, limitMessageWrites, chatController.createMessage);
app.put('/api/messages/:id', requireUser, limitMessageWrites, chatController.editMessage);
app.delete('/api/messages/:id', requireUser, limitMessageWrites, chatController.deleteMessage);
app.get('/api/messages/:peerId', requireUser, chatController.history);
app.get('/api/billing', requireUser, chatController.billing);

// Friends
app.get('/api/friends', requireUser, chatController.friends);
app.get('/api/friends/search', requireUser, chatController.searchPeople);
app.post('/api/friends/requests', requireUser, chatController.sendFriendRequest);
app.post('/api/friends/requests/:id/accept', requireUser, chatController.acceptFriendRequest);
app.post('/api/friends/requests/:id/decline', requireUser, chatController.declineFriendRequest);
app.delete('/api/friends/requests/:id', requireUser, chatController.cancelFriendRequest);

// Admin area (administrators only): Dashboard, Users, Billing / Payment
app.get('/admin', requireAdmin, adminController.dashboard);
app.get('/admin/users', requireAdmin, adminController.users);
app.get('/admin/users/:id', requireAdmin, adminController.userDetail);
app.post('/admin/users/:id/status', requireAdmin, adminController.setUserStatus);
app.get('/admin/billing', requireAdmin, adminController.billing);
app.get('/admin/billing/payments.csv', requireAdmin, adminController.paymentsCsv);
app.post('/admin/payments', requireAdmin, adminController.recordPayment);
app.post('/admin/payments/:id/void', requireAdmin, adminController.voidPayment);
app.get('/admin/payments/:id/receipt', requireAdmin, adminController.receipt);

/* ======================================================================
   5. 404 and error handling (never leak stack traces to the browser)
   ====================================================================== */
app.use((req, res) => {
  if (wantsJson(req)) return res.status(404).json({ ok: false, error: 'Not found.' });
  return res.status(404).render('error', {
    status: 404,
    title: 'Page not found',
    message: 'The page you are looking for does not exist.',
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Body-parser problems (bad JSON, body too large) carry a 4xx status; anything else is a bug of ours.
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error('[bai-ber] unhandled error:', err);
  const message = status === 500 ? 'Something went wrong on our side. Please try again.' : 'That request could not be processed.';
  if (res.headersSent) return undefined;
  if (wantsJson(req)) return res.status(status).json({ ok: false, error: message });
  return res.status(status).render('error', { status, title: 'Something went wrong', message });
});

/* ======================================================================
   6. HTTP server + Socket.IO (the chat controller registers its own handlers)
   ====================================================================== */
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 16 * 1024, // messages are tiny text; reject anything big
});
io.engine.use(sessionMiddleware); // sockets reuse the login session cookie
app.set('io', io);
chatController.registerSocketHandlers(io);

async function start(port = process.env.PORT || 3000) {
  await db.execute('SELECT 1 FROM sessions LIMIT 0');
  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`Bai-ber is running at http://localhost:${server.address().port}`);
      resolve(server);
    });
  });
}

// Start only when launched with "node server.js" (tests import this file instead).
if (require.main === module) start().catch(async err => {
  console.error('Could not start Bai-ber. Check MySQL, schema.sql and .env.', err.message);
  await db.end();
  process.exitCode = 1;
});

module.exports = { app, server, io, start };
