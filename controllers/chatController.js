const userModel = require('../models/userModel');
const messageModel = require('../models/messageModel');
const billingModel = require('../models/billingModel');

const PAGE_SIZE = 50;
const room = (userId) => `user:${userId}`; // every user has a private Socket.IO room
const fail = (error) => ({ ok: false, error });
const notFound = (res, error) => res.status(404).json({ ok: false, error });


// userId -> Set of socket ids (a person may have several tabs open)
const online = new Map();

/** Accepts a positive integer (number or digit string); anything else is null. */
function parseId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) return null;
  const id = Number(value);
  return id > 0 ? id : null;
}

const isId = (value) => Number.isSafeInteger(value) && value > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Pushes a friendship change to the two people involved (every open tab of each).
 * Each side is told about the OTHER person from their own point of view:
 *   { friendshipId, user: { id, username, status }, relation: { state, requestId }, byMe }
 * followed by friends:updated so any open Friends list refreshes from the database.
 */
async function notifyFriendship(req, event, request, actor, other) {
  const io = req.app.get('io');
  if (!io) return;
  const sides = [
    { to: actor, about: other, byMe: true },
    { to: other, about: actor, byMe: false },
  ];
  for (const { to, about, byMe } of sides) {
    io.to(room(to.user_id)).emit(event, {
      friendshipId: request.friendship_id,
      byMe,
      user: { id: about.user_id, username: about.username, status: about.status },
      relation: await userModel.relationBetween(to.user_id, about.user_id),
    });
    io.to(room(to.user_id)).emit('friends:updated', { userId: about.user_id });
  }
}

/**
 * Tells every open tab of one person what they owe now (after a charge or after an admin records a payment).
 * Sends totals only, never the other person's data.
 */
async function notifyBilling(io, userId) {
  if (!io) return;
  const { chargedCents, paidCents, balanceCents } = await billingModel.balanceOf(userId);
  io.to(room(userId)).emit('billing:updated', { chargedCents, paidCents, balanceCents });
}

/** Loads the request named in the URL if the signed-in user is part of it; otherwise answers 404. */
async function loadRequest(req, res) {
  const id = parseId(req.params.id);
  const row = id ? await userModel.findRequest(id) : null;
  // Same answer for "does not exist" and "is not yours": no information leak.
  if (!row || (row.sender_id !== req.user.id && row.receiver_id !== req.user.id)) {
    notFound(res, 'Friend request not found.');
    return null;
  }
  return row;
}

/** Accept (true) or decline (false). Only the RECEIVER of a pending request gets past the checks. */
function respondToRequest(accept) {
  return async (req, res) => {
    const row = await loadRequest(req, res);
    if (!row) return undefined;
    if (row.receiver_id !== req.user.id) return notFound(res, 'Friend request not found.');

    const updated = await userModel.respondToRequest(req.user.id, row.friendship_id, accept);
    if (!updated) return res.status(409).json({ ok: false, error: 'This friend request is no longer pending.' });

    const me = await userModel.findById(req.user.id);
    const sender = await userModel.findById(row.sender_id);
    await notifyFriendship(req, accept ? 'friend:accepted' : 'friend:declined', updated, me, sender);
    return res.json({
      ok: true,
      user: userModel.toPublic(sender),
      relation: await userModel.relationBetween(me.user_id, sender.user_id),
    });
  };
}

/* ======================================================================
   Socket.IO
   ====================================================================== */

/** Browsers always send Origin on WebSocket handshakes; reject other sites. */
function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients do not send one
  const extra = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (extra.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch (err) {
    return false;
  }
}

/**
 * Registers one socket event with: a FRESH database check of the user
 * (so deactivation takes effect at once), an argument check, and error handling.
 */
function on(socket, name, handle) {
  socket.on(name, async (payload, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    try {
      const me = await userModel.findById(socket.data.userId);
      if (!userModel.canChat(me)) {
        socket.disconnect(true);
        return reply(fail('Your session is no longer valid. Please sign in again.'));
      }
      if (!isObject(payload)) return reply(fail('Invalid request.'));
      return reply(await handle(me, payload));
    } catch (err) {
      console.error(`[socket:${name}]`, err);
      return reply(fail('Something went wrong. Please try again.'));
    }
  });
}

function registerSocketHandlers(io) {
  // Handshake: re-use the normal login session (the cookie), so there is no separate token to steal.
  io.use(async (socket, next) => {
    try {
      const req = socket.request;
      if (!isAllowedOrigin(req)) return next(new Error('forbidden'));
      const userId = req.session && req.session.userId;
      const user = userId ? await userModel.findById(userId) : null;
      if (!userModel.canChat(user)) return next(new Error('unauthorized'));
      socket.data.userId = user.user_id;
      socket.data.sid = req.sessionID;
      return next();
    } catch (err) { return next(err); }
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    socket.join(room(userId));

    // --- presence (online / offline) ---
    const sockets = online.get(userId) || new Set();
    const wasOffline = sockets.size === 0;
    sockets.add(socket.id);
    online.set(userId, sockets);
    socket.emit('presence:list', [...online.keys()]);
    if (wasOffline) io.emit('presence:update', { userId, online: true });

    socket.on('disconnect', () => {
      const set = online.get(userId);
      if (!set) return;
      set.delete(socket.id);
      if (set.size === 0) {
        online.delete(userId);
        io.emit('presence:update', { userId, online: false });
      }
    });

    // --- unread counters ---
    on(socket, 'conversation:read', async (me, { peerId, messageId }) => {
      if (!isId(peerId) || !await userModel.findById(peerId)) return fail('Invalid request.');
      if (!isId(messageId)) return fail('Invalid message.');
      if (!await messageModel.markRead(me.user_id, peerId, messageId)) return { ok: true };
      io.to(room(peerId)).emit('conversation:seen', { peerId: me.user_id, messageId });
      // Tell this person's other tabs so their badges clear too.
      io.to(room(me.user_id)).emit('conversation:read', { peerId });
      return { ok: true };
    });
  });
}

/* ======================================================================
   HTTP handlers
   ====================================================================== */
module.exports = {
  registerSocketHandlers,
  notifyBilling,
  /** How many people have at least one open chat tab right now (for the admin dashboard). */
  onlineCount: () => online.size,

  async createMessage(req, res) {
    const sender = req.user.id;
    const receiver = parseId(req.body?.recipientId);
    const text = messageModel.validateContent(req.body?.content);
    if (!text.ok) return res.status(400).json(fail(text.error));
    if (!receiver || receiver === sender) return res.status(400).json(fail('Choose someone to message.'));
    const peer = await userModel.findById(receiver);
    if (!userModel.canChat(peer)) return notFound(res, 'That person is unavailable.');
    const result = await messageModel.create(sender, receiver, text.content);
    if (!result.ok && result.reason === 'credit') {
      return res.status(402).json({ ...fail(billingModel.creditMessage(result)), balanceCents: result.balanceCents });
    }
    if (!result.ok) return res.status(403).json(fail('You must be friends to send messages.'));
    const io = req.app.get('io');
    io.to(room(sender)).to(room(receiver)).emit('message:new', result.message);
    await notifyBilling(io, sender);
    return res.status(201).json({
      ok: true,
      message: result.message,
      charge: { chars: result.charge.chars, amountCents: result.charge.cents },
      ...await billingModel.balanceOf(sender),
    });
  },

  async editMessage(req, res) {
    const id = parseId(req.params.id);
    const text = messageModel.validateContent(req.body?.content);
    if (!text.ok) return res.status(400).json(fail(text.error));
    const existing = id && await messageModel.findById(id);
    if (!existing || existing.deleted || existing.senderId !== req.user.id) return notFound(res, 'Message not found.');
    if (!userModel.canChat(await userModel.findById(existing.receiverId))) {
      return res.status(403).json(fail('This account is inactive.'));
    }
    if (existing.content === text.content) return res.json({ ok: true, message: existing });
    const result = await messageModel.update(id, req.user.id, text.content);
    if (!result.ok && result.reason === 'credit') {
      return res.status(402).json({ ...fail(billingModel.creditMessage(result)), balanceCents: result.balanceCents });
    }
    if (!result.ok) return notFound(res, 'Message not found.');
    const { message } = result;
    const io = req.app.get('io');
    io.to(room(message.senderId)).to(room(message.receiverId)).emit('message:edited', message);
    if (result.charge) await notifyBilling(io, req.user.id);
    return res.json({
      ok: true,
      message,
      charge: result.charge ? { chars: result.charge.chars, amountCents: result.charge.cents } : null,
      ...await billingModel.balanceOf(req.user.id),
    });
  },

  async deleteMessage(req, res) {
    const id = parseId(req.params.id);
    const message = id && await messageModel.findById(id);
    if (!message || !await messageModel.remove(id, req.user.id)) return notFound(res, 'Message not found.');
    const {senderId, receiverId} = message;
    req.app.get('io').to(room(senderId)).to(room(receiverId)).emit('message:deleted', {id, senderId, receiverId});
    return res.json({ ok: true });
  },

  /** GET /chat */
  async showChat(req, res) {
    res.render('chat/index', {
      title: 'Chats',
      me: req.user,
      maxLength: messageModel.MAX_LENGTH,
      billing: {
        rateCents: billingModel.RATE_CENTS_PER_CHAR,
        balanceCents: (await billingModel.balanceOf(req.user.id)).balanceCents,
      },
    });
  },

  /** GET /api/billing - what I owe, the price per character and my recent charges and payments. */
  async billing(req, res) {
    res.json({ ok: true, ...await billingModel.summaryFor(req.user.id) });
  },

  /** GET /api/me - who am I? The page uses this to notice an expired session. */
  me(req, res) {
    res.json({ ok: true, user: req.user });
  },

  /** GET /api/conversations - newest first, with unread counts and my relationship with each person. */
  async conversations(req, res) {
    const relations = await userModel.relationsFor(req.user.id);
    const none = userModel.relationFrom(req.user.id, null);
    const conversations = (await messageModel.conversationsFor(req.user.id)).map((convo) => ({
      ...convo,
      relation: relations.get(convo.peer.id) || none,
    }));
    res.json({ ok: true, conversations });
  },

  /**
   * GET /api/messages/:peerId - messages between the signed-in user and ONE other user.
   * History is always readable by its two participants; only SENDING requires friendship.
   */
  async history(req, res) {
    const peerId = parseId(req.params.peerId);
    if (!peerId) return res.status(400).json({ ok: false, error: 'Invalid user.' });

    const peer = await userModel.findById(peerId);
    if (!peer || peer.user_id === req.user.id) return notFound(res, 'That person could not be found.');

    const before = typeof req.query.before === 'string' ? parseId(req.query.before) : null;
    const { messages, hasMore } = await messageModel.history(req.user.id, peerId, { before, limit: PAGE_SIZE });
    return res.json({
      ok: true,
      peer: userModel.toPublic(peer),
      relation: await userModel.relationBetween(req.user.id, peerId),
      seenThrough: await messageModel.readPosition(peerId, req.user.id),
      messages,
      hasMore,
    });
  },

  /** GET /api/friends -> { friends, incoming, outgoing } */
  async friends(req, res) {
    res.json({ ok: true, ...await userModel.friendsOverview(req.user.id) });
  },

  /** GET /api/friends/search?q= -> active users (never me) with my relationship to each. */
  async searchPeople(req, res) {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const relations = await userModel.relationsFor(req.user.id);
    const users = (await userModel.search(req.user.id, q)).map((user) => ({
      ...user,
      relation: relations.get(user.id) || userModel.relationFrom(req.user.id, null),
    }));
    res.json({ ok: true, users });
  },

  /** POST /api/friends/requests { userId } -> creates a PENDING request. */
  async sendFriendRequest(req, res) {
    const me = await userModel.findById(req.user.id);
    const targetId = parseId(req.body && req.body.userId);
    if (!targetId) return res.status(400).json({ ok: false, error: 'Choose someone to add.' });
    if (targetId === me.user_id) {
      return res.status(400).json({ ok: false, error: 'You cannot send a friend request to yourself.' });
    }

    const target = await userModel.findById(targetId);
    if (!userModel.canChat(target)) return notFound(res, 'That person could not be found.');

    const result = await userModel.sendRequest(me.user_id, target.user_id);
    if (!result.ok) {
      const messages = {
        friends: `You and ${target.username} are already friends.`,
        outgoing: `You already sent ${target.username} a friend request.`,
        incoming: `${target.username} already sent you a friend request. Accept it instead.`,
      };
      return res.status(409).json({ ok: false, error: messages[result.relation.state], relation: result.relation });
    }

    await notifyFriendship(req, 'friend:request', result.request, me, target);
    return res.status(201).json({
      ok: true,
      user: userModel.toPublic(target),
      relation: await userModel.relationBetween(me.user_id, target.user_id),
    });
  },

  /** POST /api/friends/requests/:id/accept  -> pending becomes ACCEPTED (receiver only) */
  acceptFriendRequest: respondToRequest(true),

  /** POST /api/friends/requests/:id/decline -> pending becomes declined (receiver only) */
  declineFriendRequest: respondToRequest(false),

  /** DELETE /api/friends/requests/:id -> the SENDER withdraws a pending request */
  async unfriend(req, res) {
    const row = await loadRequest(req, res);
    if (!row) return;
    const me = req.user.id;
    if (!await userModel.unfriend(row.friendship_id, me)) {
      return res.status(409).json({ ok: false, error: 'This friendship is no longer active.' });
    }
    const other = row.sender_id === me ? row.receiver_id : row.sender_id;
    await notifyFriendship(req, 'friend:removed', row, await userModel.findById(me), await userModel.findById(other));
    return res.json({ ok: true, relation: await userModel.relationBetween(me, other) });
  },

  async cancelFriendRequest(req, res) {
    const row = await loadRequest(req, res);
    if (!row) return undefined;
    if (row.sender_id !== req.user.id) return notFound(res, 'Friend request not found.');

    const updated = await userModel.cancelRequest(req.user.id, row.friendship_id);
    if (!updated) return res.status(409).json({ ok: false, error: 'This friend request is no longer pending.' });

    const me = await userModel.findById(req.user.id);
    const receiver = await userModel.findById(row.receiver_id);
    await notifyFriendship(req, 'friend:cancelled', updated, me, receiver);
    return res.json({ ok: true, relation: await userModel.relationBetween(me.user_id, receiver.user_id) });
  },
};
