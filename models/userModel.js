const pool = require('../database');

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{6,24}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX_BYTES = 72; // bcrypt ignores everything after 72 bytes

/** Two roles: "user" chats and is billed, "admin" manages users and billing and never chats. */
const isAdmin = (row) => Boolean(row) && row.role === 'admin';

/** May this account sign in at all? (active user or active admin) */
function canSignIn(row) {
  return Boolean(row) && row.status === 'active' && (row.role === 'user' || row.role === 'admin');
}

/** May this account chat right now? Used for login to /chat, every chat request and every socket event. */
function canChat(row) {
  return Boolean(row) && row.status === 'active' && row.role === 'user';
}

/** May this account use the admin area right now? */
function canAdmin(row) {
  return Boolean(row) && row.status === 'active' && row.role === 'admin';
}

/** The database stores UTC timestamps as "YYYY-MM-DD HH:MM:SS" in UTC. Turn it into ISO-8601. */
function toIso(value) {
  return value ? `${String(value).replace(' ', 'T')}Z` : null;
}

/** Escape LIKE wildcards so searching for "50%" does not match everything. */
function likePattern(text) {
  return `%${String(text).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** Shape sent to browsers about OTHER people: never includes the password hash or role. */
function toPublic(row) {
  if (!row) return null;
  return {
    id: row.user_id,
    username: row.username,
    // An admin account cannot chat, so people who talked to one in an older version see it as inactive.
    status: isAdmin(row) ? 'inactive' : row.status,
    createdAt: toIso(row.created_at),
  };
}

/** Shape of the signed-in person (req.user): includes the real status and the role. */
function toSession(row) {
  if (!row) return null;
  return {
    id: row.user_id,
    username: row.username,
    status: row.status,
    role: row.role,
    createdAt: toIso(row.created_at),
  };
}

/** The relationship between "me" and another person, from my point of view. */
function relationFrom(meId, row) {
  if (!row) return { state: 'none', requestId: null };
  if (row.status === 'accepted') return { state: 'friends', requestId: row.friendship_id };
  return { state: row.sender_id === meId ? 'outgoing' : 'incoming', requestId: row.friendship_id };
}

/** A Friends-tab row: the other person plus when the relationship last changed. */
function toFriendEntry(row) {
  return {
    requestId: row.friendship_id,
    since: toIso(row.updated_at),
    user: { id: row.user_id, username: row.username, status: row.status },
  };
}

const activePair = 'active_low = LEAST(?, ?) AND active_high = GREATEST(?, ?)';
module.exports = {
  toIso, toPublic, toSession, isAdmin, canSignIn, canChat, canAdmin, relationFrom, likePattern,
  validateUsername(username) {
    if (typeof username !== 'string' || !username.trim()) return 'Username is required.';
    if (username.trim().length < 6) return "Username must be at least 6 characters.";
    if (!USERNAME_PATTERN.test(username.trim())) {
      return 'Username must be 6-24 characters: letters, numbers, dots, underscores or hyphens.';
    }
    return null;
  },

  /** Returns an error message, or null when the password is acceptable. */
  validatePassword(password) {
    if (typeof password !== 'string' || !password) return 'Password is required.';
    if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
    if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
      return `Password is too long (maximum ${PASSWORD_MAX_BYTES} bytes).`;
    }
    return null;
  },

  async findById(id) {
    const [rows] = await pool.execute('SELECT * FROM users WHERE user_id = ?', [id]);
    return rows[0];
  },
  async findByUsername(username) {
    const [rows] = await pool.execute('SELECT * FROM users WHERE username = ?', [username]);
    return rows[0];
  },
  /** The website only ever creates role "user"; the create-admin script passes role "admin". */
  /** Returns the new account's user_id. */
  async create({username, passwordHash, role = 'user'}) {
    const [result] = await pool.execute('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, UTC_TIMESTAMP())',
      [username, passwordHash, role === 'admin' ? 'admin' : 'user']);
    return result.insertId;
  },
  async rename(id, username) {
    await pool.execute('UPDATE users SET username = ? WHERE user_id = ?', [username, id]);
  },
  async setPassword(id, hash) {
    await pool.execute('UPDATE users SET password_hash = ? WHERE user_id = ?', [hash, id]);
  },
  /** Used by the admin area to deactivate / reactivate a chat account. */
  async setStatus(id, status) {
    const [result] = await pool.execute("UPDATE users SET status = ? WHERE user_id = ? AND role = 'user'",
      [status === 'inactive' ? 'inactive' : 'active', id]);
    return result.affectedRows;
  },
  /** Ends every login of this person (all devices). */
  async endAllSessions(id) {
    await pool.execute('DELETE FROM sessions WHERE user_id = ?', [id]);
  },
  async signOutOtherSessions(id, sid) {
    await pool.execute('DELETE FROM sessions WHERE user_id = ? AND sid <> ?', [id, sid]);
  },
  async search(me, query) {
    const [rows] = await pool.execute(`SELECT * FROM users WHERE user_id <> ? AND status = 'active'
      AND role = 'user' AND username LIKE ? ORDER BY username LIMIT 30`, [me, likePattern(query.trim().slice(0, 50))]);
    return rows.map(toPublic);
  },
  async findRequest(id) {
    const [rows] = await pool.execute('SELECT * FROM friendships WHERE friendship_id = ?', [id]);
    return rows[0];
  },
  async relationBetween(me, peer) {
    const [rows] = await pool.execute('SELECT * FROM friendships WHERE ' + activePair, [me, peer, me, peer]);
    return relationFrom(me, rows[0]);
  },
  async relationsFor(me) {
    const [rows] = await pool.execute(`SELECT * FROM friendships WHERE
      (sender_id = ? OR receiver_id = ?) AND status IN ('pending','accepted')`, [me, me]);
    return new Map(rows.map(row => [row.sender_id === me ? row.receiver_id : row.sender_id, relationFrom(me, row)]));
  },
  async friendsOverview(me) {
    const [rows] = await pool.execute(`SELECT f.*, u.user_id, u.username, u.status AS account_status
      FROM friendships f JOIN users u ON u.user_id = IF(f.sender_id = ?, f.receiver_id, f.sender_id)
      WHERE (f.sender_id = ? OR f.receiver_id = ?)
        AND (f.status = 'accepted' OR (f.status = 'pending' AND u.status = 'active'))
      ORDER BY IF(f.status = 'accepted', u.username, NULL), f.friendship_id DESC`, [me, me, me]);
    const result = { friends: [], incoming: [], outgoing: [] };
    for (const row of rows) {
      const list = row.status === 'accepted' ? result.friends : row.sender_id === me ? result.outgoing : result.incoming;
      list.push(toFriendEntry({...row, status: row.account_status}));
    }
    return result;
  },
  async sendRequest(me, peer) {
    try {
      const [result] = await pool.execute(`INSERT INTO friendships (sender_id, receiver_id, created_at, updated_at)
        VALUES (?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [me, peer]);
      return {ok: true, request: await this.findRequest(result.insertId)};
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
      return {ok: false, relation: await this.relationBetween(me, peer)};
    }
  },
  async respondToRequest(me, id, accept) {
    const [result] = await pool.execute(`UPDATE friendships SET status = ?, updated_at = UTC_TIMESTAMP()
      WHERE friendship_id = ? AND receiver_id = ? AND status = 'pending'`, [accept ? 'accepted' : 'declined', id, me]);
    return result.affectedRows ? this.findRequest(id) : null;
  },
  async cancelRequest(me, id) {
    const [result] = await pool.execute(`UPDATE friendships SET status = 'cancelled', updated_at = UTC_TIMESTAMP()
      WHERE friendship_id = ? AND sender_id = ? AND status = 'pending'`, [id, me]);
    return result.affectedRows ? this.findRequest(id) : null;
  },
  async unfriend(id, me) {
    const [result] = await pool.execute(`DELETE FROM friendships WHERE friendship_id = ?
      AND status = 'accepted' AND (sender_id = ? OR receiver_id = ?)`, [id, me, me]);
    return result.affectedRows;
  }
};
