/**
 * Authentication: register, login, logout and "change my password".
 *
 * Also home of createLimiter(), the tiny in-memory rate limiter used here (failed logins,
 * sign-ups, password changes) and by chatController (friend requests, socket events).
 */
const bcrypt = require('bcryptjs');
const userModel = require('../models/userModel');

/** Where a signed-in person lands: administrators get the admin area, everyone else the chat. */
const homeFor = (user) => (user && user.role === 'admin' ? '/admin' : '/chat');

// Cost factor 10 is a good balance for bcryptjs (pure JavaScript). Raise it for production.
// bcrypt only accepts 4-31, so the value is clamped to a sensible range.
const BCRYPT_ROUNDS = Math.min(Math.max(Number(process.env.BCRYPT_ROUNDS) || 10, 4), 15);

// Hashing a fake password when the username does not exist keeps response time
// similar, so attackers cannot discover which usernames are registered.
const DUMMY_HASH = bcrypt.hashSync('bai-ber-dummy-password', BCRYPT_ROUNDS);

/**
 * Fixed-window rate limiter kept in memory (fine for a single-process app).
 *   peek(key)    -> is this key currently blocked?  (does not count)
 *   consume(key) -> count one hit and say whether it is still allowed
 *   reset(key)   -> forget the key (e.g. after a successful login)
 */
function createLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> { count, resetAt }
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, Math.min(windowMs, 60 * 1000));
  timer.unref();

  function current(key) {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) return { count: 0, resetAt: now + windowMs };
    return entry;
  }

  return {
    peek(key) {
      const entry = current(key);
      return { limited: entry.count >= max, retryAfterMs: Math.max(0, entry.resetAt - Date.now()) };
    },
    consume(key) {
      const entry = current(key);
      entry.count += 1;
      hits.set(key, entry);
      return { allowed: entry.count <= max, retryAfterMs: Math.max(0, entry.resetAt - Date.now()) };
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

// Only FAILED attempts are counted, so normal users are never slowed down.
const WINDOW_15_MIN = 15 * 60 * 1000;
const loginByAccount = createLimiter({ windowMs: WINDOW_15_MIN, max: 8 });
const loginByIp = createLimiter({ windowMs: WINDOW_15_MIN, max: 40 });
// Sign-ups per network address per hour. A whole classroom can share one address, so the default is generous.
const registerByIp = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.REGISTER_LIMIT_PER_HOUR) || 30,
});
const passwordByUser = createLimiter({ windowMs: WINDOW_15_MIN, max: 5 });

const text = (value) => (typeof value === 'string' ? value : '');

/** Closes live Socket.IO connections that match a test (e.g. "belongs to this login session"). */
function disconnectSockets(req, shouldClose) {
  const io = req.app.get('io');
  if (!io) return;
  for (const socket of io.sockets.sockets.values()) {
    if (shouldClose(socket)) socket.disconnect(true);
  }
}

module.exports = {
  homeFor,
  createLimiter,
  disconnectSockets,

  showLogin(req, res) {
    const info =
      req.query.reason === 'inactive'
        ? 'Your account has been deactivated. Please contact the site operator.'
        : null;
    res.render('auth/login', { title: 'Sign in', error: null, info, username: '' });
  },

  async login(req, res, next) {
    try {
      const username = text(req.body && req.body.username).trim();
      const password = text(req.body && req.body.password);
      const show = (status, error) =>
        res.status(status).render('auth/login', { title: 'Sign in', error, info: null, username });

      if (!username || !password) return show(400, 'Please enter your username and password.');

      const accountKey = username.toLowerCase();
      const blocked = loginByAccount.peek(accountKey);
      const ipBlocked = loginByIp.peek(req.ip);
      if (blocked.limited || ipBlocked.limited) {
        const wait = Math.max(blocked.retryAfterMs, ipBlocked.retryAfterMs);
        res.set('Retry-After', String(Math.ceil(wait / 1000)));
        return show(429, 'Too many failed attempts. Please wait a few minutes and try again.');
      }

      // Users and administrators sign in here; the role decides where they land.
      const user = (await userModel.findByUsername(username)) || null;
      const passwordOk = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);

      if (!user || !passwordOk) {
        loginByAccount.consume(accountKey);
        loginByIp.consume(req.ip);
        // Same message for "no such user" and "wrong password".
        return show(401, 'Invalid username or password.');
      }

      // Only people who proved they know the password learn that the account is inactive.
      if (user.status !== 'active') {
        return show(403, 'This account has been deactivated. Please contact the site operator.');
      }

      loginByAccount.reset(accountKey);

      // regenerate() issues a brand new session id, which prevents session-fixation attacks.
      return req.session.regenerate((regenError) => {
        if (regenError) return next(regenError);
        req.session.userId = user.user_id;
        return req.session.save((saveError) => {
          if (saveError) return next(saveError);
          return res.redirect(homeFor(user));
        });
      });
    } catch (err) {
      return next(err);
    }
  },

  showRegister(req, res) {
    res.render('auth/register', { title: 'Create account', errors: {}, username: '' });
  },

  async register(req, res, next) {
    try {
      // Note: "role" and "status" are never read from the request. Every account is an active, regular user.
      const username = text(req.body && req.body.username).trim();
      const password = text(req.body && req.body.password);
      const confirmPassword = text(req.body && req.body.confirmPassword);
      const show = (status, errors) =>
        res.status(status).render('auth/register', { title: 'Create account', errors, username });

      if (!registerByIp.consume(req.ip).allowed) {
        return show(429, { form: 'Too many sign-ups from this network. Please try again later.' });
      }

      const errors = {};
      const usernameError = userModel.validateUsername(username);
      if (usernameError) errors.username = usernameError;
      else if (await userModel.findByUsername(username)) errors.username = 'This username is already in use.';

      const passwordError = userModel.validatePassword(password);
      if (passwordError) errors.password = passwordError;

      if (!confirmPassword) errors.confirmPassword = 'Please confirm your password.';
      else if (password !== confirmPassword) errors.confirmPassword = 'Passwords do not match.';

      if (Object.keys(errors).length) return show(400, errors);

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      let userId;
      try {
        userId = await userModel.create({ username, passwordHash });
      } catch (err) {
        // Two people registering the same name at the same moment: the UNIQUE constraint decides.
        if (err.code === 'ER_DUP_ENTRY') {
          return show(400, { username: 'This username is already in use.' });
        }
        throw err;
      }

      // Sign the new account in straight away. regenerate() issues a fresh session id (no session fixation);
      // the flash message is added after it, because regenerate() empties the session.
      return req.session.regenerate((regenError) => {
        if (regenError) return next(regenError);
        req.session.userId = userId;
        req.flash('success', `Welcome to Bai-ber, ${username}! Your account is ready.`);
        return req.session.save((saveError) => {
          if (saveError) return next(saveError);
          return res.redirect('/chat'); // registration only ever creates regular users
        });
      });
    } catch (err) {
      return next(err);
    }
  },

  async rename(req, res) {
    const username = text(req.body?.username).trim();
    if (username === req.user.username) return res.json({ ok: true, username });
    const error = userModel.validateUsername(username);
    if (error) return res.status(400).json({ ok: false, error });
    try {
      await userModel.rename(req.user.id, username);
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
      return res.status(409).json({ ok: false, error: 'This username is already in use.' });
    }
    req.app.get('io').emit('profile:renamed', { id: req.user.id, username });
    return res.json({ ok: true, username });
  },

  logout(req, res) {
    const sid = req.sessionID;
    req.session.destroy(() => {
      disconnectSockets(req, (socket) => socket.data.sid === sid); // close this login's live connections
      res.clearCookie('baiber.sid');
      res.redirect('/login');
    });
  },

  /** JSON endpoint used by the Profile dialog. */
  async changePassword(req, res, next) {
    try {
      const currentPassword = text(req.body && req.body.currentPassword);
      const newPassword = text(req.body && req.body.newPassword);
      const confirmPassword = text(req.body && req.body.confirmPassword);
      const limiterKey = String(req.user.id);

      if (passwordByUser.peek(limiterKey).limited) {
        return res.status(429).json({ ok: false, error: 'Too many attempts. Please try again later.' });
      }

      const row = await userModel.findById(req.user.id);
      const currentOk = currentPassword && (await bcrypt.compare(currentPassword, row.password_hash));
      if (!currentOk) {
        passwordByUser.consume(limiterKey);
        return res.status(400).json({ ok: false, errors: { currentPassword: 'Current password is incorrect.' } });
      }

      const errors = {};
      const passwordError = userModel.validatePassword(newPassword);
      if (passwordError) errors.newPassword = passwordError;
      else if (newPassword === currentPassword) errors.newPassword = 'Choose a password you have not used just now.';
      if (!errors.newPassword && newPassword !== confirmPassword) errors.confirmPassword = 'Passwords do not match.';
      if (Object.keys(errors).length) return res.status(400).json({ ok: false, errors });

      await userModel.setPassword(req.user.id, await bcrypt.hash(newPassword, BCRYPT_ROUNDS));
      passwordByUser.reset(limiterKey);

      // Sign out every OTHER device, keep this one.
      await userModel.signOutOtherSessions(req.user.id, req.sessionID);
      disconnectSockets(req, (socket) => socket.data.userId === req.user.id && socket.data.sid !== req.sessionID);

      return res.json({ ok: true, message: 'Password updated. Other devices were signed out.' });
    } catch (err) {
      return next(err);
    }
  },
};
