/**
 * Bai-ber chat page.
 *
 * How it fits together:
 *   - REST (fetch) READS data:  conversations, friends, people search, message history.
 *   - REST (fetch) also CHANGES friendships: send / accept / decline / cancel requests.
 *   - HTTP creates, edits and deletes messages. Socket.IO carries notifications and read receipts.
 *   - Messaging needs an accepted friendship. The server enforces it; this page only mirrors it
 *     (read-only conversation, disabled composer, contextual Add / Accept / Cancel buttons).
 *   - The chat list has an All / Unread filter built on the unread counts the server already sends.
 *   - Billing: every character sent costs money. The page shows the price of what you are typing, your
 *     running balance (updated live over Socket.IO) and your recent charges and payments in Profile.
 *   - All user text is inserted with textContent (never innerHTML), so it can never run as HTML.
 */
(function () {
  'use strict';

  const app = document.getElementById('app');
  const ME = { id: Number(app.dataset.meId), username: app.dataset.meUsername };
  const MAX_LENGTH = Number(app.dataset.maxLength) || 2000;
  const BASE_TITLE = document.title;
  const { api, toast } = window.BaiBer;
  const mobileQuery = window.matchMedia('(max-width: 991.98px)');
  const billing = {
    rateCents: Number(app.dataset.rateCents) || 100,
    balanceCents: Number(app.dataset.balanceCents) || 0,
  };
  let profileOpen = false;
  let profileModalElement = null;

  /* ------------------------------------------------------------------
     Small helpers
     ------------------------------------------------------------------ */
  const $ = (id) => document.getElementById(id);

  /** Tiny DOM builder: el('div', { class: 'x', text: 'hi', onclick: fn }, child1, child2) */
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'style') Object.assign(node.style, value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child);
    }
    return node;
  }

  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
  const shortDateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  const longDateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const daysAgo = (d) => Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  const dayKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  const oneLine = (text) => text.replace(/\s+/g, ' ').trim();

  function listTime(iso) {
    const d = new Date(iso);
    const diff = daysAgo(d);
    if (diff === 0) return timeFmt.format(d);
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return weekdayFmt.format(d);
    return shortDateFmt.format(d);
  }

  function dayLabel(iso) {
    const diff = daysAgo(new Date(iso));
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return longDateFmt.format(new Date(iso));
  }

  /* ------------------------------------------------------------------
     State
     ------------------------------------------------------------------ */
  const NO_RELATION = { state: 'none', requestId: null };

  const state = {
    tab: 'chats', // 'chats' | 'friends'
    chatFilter: 'all', // Chats tab filter: 'all' | 'unread'
    seg: 'friends', // Friends tab section: 'friends' | 'requests' | 'sent' | 'find'
    query: '',
    conversations: [],
    conversationsLoaded: false,
    conversationsError: false,
    friends: [], // accepted friendships: [{ requestId, since, user }]
    incoming: [], // requests waiting for MY answer
    outgoing: [], // requests I sent that are still pending
    friendsLoaded: false,
    friendsError: false,
    people: [], // "Find" results: users with their relation to me
    peopleLoaded: false,
    peopleQuery: null, // the search text that state.people belongs to
    busy: new Set(), // user ids with a friendship action in flight (disables their buttons)
    peer: null, // { id, username, status, relation } of the open conversation
    messages: [],
    hasMore: false,
    loadingMessages: false,
    earlierLoading: false,
    loadToken: 0, // lets us ignore answers that belong to a conversation we already left
    online: new Set(),
    editingId: null,
    sending: false,
    pendingDelete: null,
  };

  const els = {
    panelTitle: $('panelTitle'),
    panelList: $('panelList'),
    searchInput: $('searchInput'),
    searchClear: $('searchClear'),
    newChatBtn: $('newChatBtn'),
    railBadge: $('railBadge'),
    friendsBadge: $('friendsBadge'),
    friendSeg: $('friendSeg'),
    chatFilter: $('chatFilter'),
    unreadChatsCount: $('unreadChatsCount'),
    requestsCount: $('requestsCount'),
    connBanner: $('connBanner'),
    chatEmpty: $('chatEmpty'),
    chatRoom: $('chatRoom'),
    headAvatar: $('headAvatar'),
    headName: $('headName'),
    headStatus: $('headStatus'),
    messages: $('messages'),
    composer: $('composer'),
    composerInput: $('composerInput'),
    sendBtn: $('sendBtn'),
    editBar: $('editBar'),
    editPreview: $('editPreview'),
    editCancel: $('editCancel'),
    composerNote: $('composerNote'),
    composerNoteIcon: $('composerNoteIcon'),
    composerNoteText: $('composerNoteText'),
    composerNoteActions: $('composerNoteActions'),
    charCount: $('charCount'),
    costLine: $('costLine'),
    costText: $('costText'),
    balancePill: $('balancePill'),
    balanceText: $('balanceText'),
  };

  /* ------------------------------------------------------------------
     Real-time connection
     ------------------------------------------------------------------ */
  const socket = window.io({ reconnectionDelayMax: 5000 });
  let hasConnectedBefore = false;

  /* ------------------------------------------------------------------
     Avatars
     ------------------------------------------------------------------ */
  function avatar(user, size) {
    const online = state.online.has(user.id) && user.status !== 'inactive';
    return el(
      'span',
      { class: `avatar-wrap${online ? ' is-online' : ''}` },
      el('span', { class: `avatar avatar-${size || 'md'} av-${user.id % 8}`, 'aria-hidden': 'true', text: user.username.charAt(0) }),
      el('span', { class: 'presence-dot' })
    );
  }

  /* ------------------------------------------------------------------
     Left panel: conversations and users
     ------------------------------------------------------------------ */
  function skeletonRows(count) {
    const widths = [['58%', '82%'], ['44%', '70%'], ['66%', '54%'], ['50%', '76%']];
    return Array.from({ length: count }, (_, i) => {
      const [a, b] = widths[i % widths.length];
      return el(
        'div',
        { class: 'skeleton-row', 'aria-hidden': 'true' },
        el('div', { class: 'skeleton circle' }),
        el('div', { style: { flex: '1' } },
          el('div', { class: 'skeleton line', style: { width: a, marginBottom: '8px' } }),
          el('div', { class: 'skeleton line', style: { width: b } }))
      );
    });
  }

  function emptyState(icon, title, text, action) {
    return el('div', { class: 'empty-state' },
      el('div', { class: 'empty-icon' }, el('i', { class: `bi ${icon}` })),
      el('h3', { text: title }),
      el('p', { text }),
      action || null);
  }

  function sectionLabel(text) {
    return el('div', { class: 'section-label', text });
  }

  function conversationItem(convo) {
    const last = convo.lastMessage;
    const selected = state.peer && state.peer.id === convo.peer.id;
    const readOnly = convo.relation && convo.relation.state !== 'friends';
    const preview = last ? (last.senderId === ME.id ? 'You: ' : '') + oneLine(last.content) : 'No messages yet';
    return el('button', {
      type: 'button',
      class: `list-item${selected ? ' selected' : ''}${convo.unread ? ' unread' : ''}`,
      'aria-current': selected ? 'true' : null,
      onclick: () => openConversation({ ...convo.peer, relation: convo.relation }),
    },
    avatar(convo.peer, 'md'),
    el('span', { class: 'meta' },
      el('span', { class: 'li-line' },
        el('span', { class: 'name' },
          convo.peer.username,
          readOnly ? el('i', { class: 'bi bi-lock-fill read-only-icon', title: 'Read-only: you are not friends', 'aria-label': '(read-only)' }) : null),
        last ? el('span', { class: 'time', text: listTime(last.sentAt) }) : null),
      el('span', { class: 'li-line' },
        el('span', { class: `preview${last ? '' : ' draft'}`, text: preview }),
        convo.unread ? el('span', { class: 'unread-badge', text: convo.unread > 99 ? '99+' : String(convo.unread) }) : null)));
  }

  /* ------------------------------------------------------------------
     Friends: rows with contextual actions
     ------------------------------------------------------------------ */
  function presenceText(user) {
    if (user.status && user.status !== 'active') return 'Account inactive';
    return state.online.has(user.id) ? 'Online' : 'Offline';
  }

  function smallBtn(label, icon, kind, onclick, extra) {
    return el('button', {
      type: 'button',
      class: `btn btn-xs ${kind}`,
      onclick: (event) => { event.stopPropagation(); onclick(); },
      ...(extra || {}),
    }, icon ? el('i', { class: `bi ${icon}` }) : null, label);
  }

  /** Buttons that match my relationship with this person (the table from the spec). */
  function friendActions(user, relation, where) {
    const busy = state.busy.has(user.id);
    const opts = { disabled: busy || null };
    switch (relation.state) {
      case 'friends': {
        const actions = [smallBtn('Message', 'bi-chat-dots-fill', 'btn-soft', () => messageFriend(user), opts)];
        if (where === 'find') actions.unshift(el('span', { class: 'chip chip-friends' }, el('i', { class: 'bi bi-check2' }), 'Friends'));
        actions.push(smallBtn('Unfriend', null, 'btn-outline-secondary', () => unfriend(relation.requestId, user), opts));
        return actions;
      }
      case 'incoming':
        return [
          smallBtn('Accept', null, 'btn-primary', () => respondToRequest(relation.requestId, user, true), opts),
          smallBtn('Decline', null, 'btn-outline-secondary', () => respondToRequest(relation.requestId, user, false), opts),
        ];
      case 'outgoing':
        return [
          where === 'sent' ? null : el('span', { class: 'chip chip-pending' }, el('i', { class: 'bi bi-clock' }), 'Request Sent'),
          smallBtn('Cancel', null, 'btn-outline-secondary', () => confirmCancelRequest(relation.requestId, user), opts),
        ];
      default:
        return [smallBtn('Add Friend', 'bi-person-plus-fill', 'btn-primary', () => sendFriendRequest(user), opts)];
    }
  }

  function subText(user, relation, where) {
    if (where === 'requests') return 'New request';
    if (where === 'sent') return 'Pending';
    if (relation.state === 'friends') return presenceText(user);
    if (relation.state === 'incoming') return 'Requested you';
    if (relation.state === 'outgoing') return 'Request sent';
    return 'Not friends yet';
  }

  function friendRow(user, relation, where) {
    const sub = subText(user, relation, where);
    return el('div', { class: 'list-item friend-row', dataset: { userId: String(user.id) } },
      avatar(user, 'md'),
      el('span', { class: 'meta' },
        el('span', { class: 'li-line' }, el('span', { class: 'name', text: user.username })),
        el('span', { class: 'li-line' },
          el('span', { class: `preview${where === 'sent' ? ' pending-text' : ''}${sub === 'Online' ? ' online-text' : ''}`, text: sub }))),
      el('span', { class: 'friend-actions' }, friendActions(user, relation, where)));
  }

  /** The relation I currently know for a user (friends list first, then requests, then search results). */
  function relationOf(userId) {
    const friend = state.friends.find((f) => f.user.id === userId);
    if (friend) return { state: 'friends', requestId: friend.requestId };
    const incoming = state.incoming.find((r) => r.user.id === userId);
    if (incoming) return { state: 'incoming', requestId: incoming.requestId };
    const outgoing = state.outgoing.find((r) => r.user.id === userId);
    if (outgoing) return { state: 'outgoing', requestId: outgoing.requestId };
    return NO_RELATION;
  }

  function renderFriendsPanel(frag, query) {
    const q = query.toLowerCase();
    const match = (entry) => !q || entry.user.username.toLowerCase().includes(q);

    if (state.seg === 'find') {
      if (!state.peopleLoaded || state.peopleQuery !== query.trim()) {
        frag.append(...skeletonRows(5));
      } else if (!state.people.length) {
        frag.append(emptyState('bi-search', 'No people found',
          query ? `Nobody on Bai-ber matches "${query}". Check the spelling and try again.` : 'When other people register, they will show up here.'));
      } else {
        frag.append(sectionLabel(query ? 'Search results' : 'People on Bai-ber'));
        state.people.forEach((u) => frag.append(friendRow(u, u.relation || NO_RELATION, 'find')));
      }
      return;
    }

    if (!state.friendsLoaded && !state.friendsError) {
      frag.append(...skeletonRows(5));
      return;
    }
    if (state.friendsError && !state.friendsLoaded) {
      frag.append(emptyState('bi-wifi-off', "Couldn't load friends", 'Check your connection and try again.',
        el('button', { type: 'button', class: 'btn btn-soft btn-sm', text: 'Try again', onclick: loadFriends })));
      return;
    }

    const findButton = el('button', { type: 'button', class: 'btn btn-primary btn-sm px-3', onclick: () => setSeg('find', true) },
      el('i', { class: 'bi bi-person-plus-fill me-2' }), 'Find friends');

    if (state.seg === 'friends') {
      const list = state.friends.filter(match);
      if (!state.friends.length) {
        frag.append(emptyState('bi-people', 'No friends yet', 'Search for people and send your first friend request.', findButton));
      } else if (!list.length) {
        frag.append(emptyState('bi-search', 'No matches', `None of your friends match "${query}".`));
      } else {
        const online = list.filter((f) => state.online.has(f.user.id) && f.user.status === 'active');
        const offline = list.filter((f) => !online.includes(f));
        if (online.length) {
          frag.append(sectionLabel(`Online - ${online.length}`));
          online.forEach((f) => frag.append(friendRow(f.user, { state: 'friends', requestId: f.requestId }, 'friends')));
        }
        if (offline.length) {
          frag.append(sectionLabel(`${online.length ? 'Offline' : 'All friends'} - ${offline.length}`));
          offline.forEach((f) => frag.append(friendRow(f.user, { state: 'friends', requestId: f.requestId }, 'friends')));
        }
      }
    } else if (state.seg === 'requests') {
      const list = state.incoming.filter(match);
      if (!state.incoming.length) {
        frag.append(emptyState('bi-inbox', 'No pending friend requests', 'When someone wants to be your friend, their request will appear here.'));
      } else if (!list.length) {
        frag.append(emptyState('bi-search', 'No matches', `No requests match "${query}".`));
      } else {
        frag.append(sectionLabel(`Friend requests - ${list.length}`));
        list.forEach((r) => frag.append(friendRow(r.user, { state: 'incoming', requestId: r.requestId }, 'requests')));
      }
    } else {
      const list = state.outgoing.filter(match);
      if (!state.outgoing.length) {
        frag.append(emptyState('bi-send', 'No sent requests', 'Your sent friend requests will appear here.', findButton));
      } else if (!list.length) {
        frag.append(emptyState('bi-search', 'No matches', `No sent requests match "${query}".`));
      } else {
        frag.append(sectionLabel(`Awaiting response - ${list.length}`));
        list.forEach((r) => frag.append(friendRow(r.user, { state: 'outgoing', requestId: r.requestId }, 'sent')));
      }
    }
  }

  function renderPanel() {
    const list = els.panelList;
    const top = list.scrollTop;
    const query = state.query.trim();
    const q = query.toLowerCase();
    const frag = document.createDocumentFragment();

    if (state.tab === 'chats') {
      els.panelTitle.textContent = 'Chats';

      // A friend you just picked but have not written to yet appears at the top as a draft (All view only).
      const unreadOnly = state.chatFilter === 'unread';
      const hasConvo = state.peer && state.conversations.some((c) => c.peer.id === state.peer.id);
      const draft = state.peer && !hasConvo && !unreadOnly
        ? [{ peer: state.peer, lastMessage: null, unread: 0, relation: state.peer.relation }] : [];
      let items = draft.concat(state.conversations);
      // Unread view: only conversations with unread INCOMING messages (the server's unread count).
      if (unreadOnly) items = items.filter((c) => c.unread > 0);
      if (q) {
        items = items.filter((c) => c.peer.username.toLowerCase().includes(q)
          || (c.lastMessage && c.lastMessage.content.toLowerCase().includes(q)));
      }

      if (!state.conversationsLoaded && !state.conversationsError) {
        frag.append(...skeletonRows(6));
      } else if (state.conversationsError) {
        frag.append(emptyState('bi-wifi-off', "Couldn't load chats", 'Check your connection and try again.',
          el('button', { type: 'button', class: 'btn btn-soft btn-sm', text: 'Try again', onclick: loadConversations })));
      } else {
        items.forEach((c) => frag.append(conversationItem(c)));

        if (unreadOnly) {
          if (!items.length) {
            frag.append(emptyState('bi-check2-circle', "You're all caught up",
              q ? `No unread chats match "${query}".` : 'There are no unread messages. New ones will show up here.'));
          }
        } else if (q) {
          // Friends you have not talked to yet can be found from the Chats search too.
          const known = new Set(draft.concat(state.conversations).map((c) => c.peer.id));
          const others = state.friends.filter((f) => !known.has(f.user.id) && f.user.username.toLowerCase().includes(q));
          if (others.length) {
            frag.append(sectionLabel('Friends'));
            others.forEach((f) => frag.append(friendRow(f.user, { state: 'friends', requestId: f.requestId }, 'chats')));
          }
          if (!items.length && !others.length) {
            frag.append(emptyState('bi-search', 'No matches', `No chats or friends match "${query}".`,
              el('button', { type: 'button', class: 'btn btn-soft btn-sm', text: 'Search all people', onclick: () => findPeople(query) })));
          }
        } else if (!items.length) {
          frag.append(emptyState('bi-chat-heart', 'No conversations yet',
            state.friends.length ? 'Pick a friend and send your first message.' : 'Add friends to start chatting. Messages are only possible between friends.',
            el('button', { type: 'button', class: 'btn btn-primary btn-sm px-3', text: state.friends.length ? 'Message a friend' : 'Find friends', onclick: startNewConversation })));
        }
      }
    } else {
      els.panelTitle.textContent = 'Friends';
      renderFriendsPanel(frag, query);
    }

    list.replaceChildren(frag);
    list.scrollTop = top;
  }

  function updateUnreadIndicators() {
    const total = state.conversations.reduce((sum, c) => sum + c.unread, 0);
    els.railBadge.hidden = total === 0;
    els.railBadge.textContent = total > 99 ? '99+' : String(total);
    const unreadChats = state.conversations.filter((c) => c.unread > 0).length;
    els.unreadChatsCount.hidden = unreadChats === 0;
    els.unreadChatsCount.textContent = unreadChats > 99 ? '99+' : String(unreadChats);
    const requests = state.incoming.length;
    els.friendsBadge.hidden = requests === 0;
    els.friendsBadge.textContent = requests > 99 ? '99+' : String(requests);
    els.requestsCount.hidden = requests === 0;
    els.requestsCount.textContent = String(requests);
    const count = total + requests;
    document.title = (count ? `(${count}) ` : '') + BASE_TITLE;
  }

  /** Copies a relation the server just told us about into everything that shows this person. */
  function applyRelation(userId, relation) {
    const rel = relation || NO_RELATION;
    state.people.forEach((u) => { if (u.id === userId) u.relation = rel; });
    state.conversations.forEach((c) => { if (c.peer.id === userId) c.relation = rel; });
    if (state.peer && state.peer.id === userId) {
      state.peer.relation = rel;
      renderHeader();
      updateComposerState();
    }
  }

  async function loadConversations() {
    try {
      const data = await api('/api/conversations');
      state.conversations = data.conversations;
      state.conversationsLoaded = true;
      state.conversationsError = false;

      // Keep the open chat's status (active / inactive) and friendship in sync with the server.
      if (state.peer) {
        const match = state.conversations.find((c) => c.peer.id === state.peer.id);
        if (match && (match.peer.status !== state.peer.status || match.relation.state !== state.peer.relation.state)) {
          state.peer.status = match.peer.status;
          state.peer.relation = match.relation;
          renderHeader();
          updateComposerState();
        }
        // The open chat is on screen, so it cannot stay unread (covers a list fetched just before the read was saved).
        if (match && match.unread && chatVisible()) markReadIfVisible();
      }
    } catch (err) {
      if (!state.conversationsLoaded) state.conversationsError = true;
    }
    renderPanel();
    updateUnreadIndicators();
  }

  // Several events can arrive together; refresh the list once.
  let refreshTimer = null;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(loadConversations, 120);
  }

  /** Friends, incoming requests and sent requests, always re-read from the database. */
  async function loadFriends() {
    try {
      const data = await api('/api/friends');
      state.friends = data.friends;
      state.incoming = data.incoming;
      state.outgoing = data.outgoing;
      state.friendsLoaded = true;
      state.friendsError = false;
      if (state.peer) applyRelation(state.peer.id, relationOf(state.peer.id));
    } catch (err) {
      state.friendsError = true;
    }
    renderPanel();
    updateUnreadIndicators();
  }

  let friendsTimer = null;
  function scheduleFriendsRefresh() {
    clearTimeout(friendsTimer);
    friendsTimer = setTimeout(() => {
      loadFriends();
      if (state.tab === 'friends' && state.seg === 'find') loadPeople();
    }, 120);
  }

  let searchTimer = null;
  let searchSeq = 0;
  async function loadPeople() {
    const seq = ++searchSeq;
    const query = state.query.trim();
    try {
      const data = await api(`/api/friends/search?q=${encodeURIComponent(query)}`);
      if (seq !== searchSeq) return;
      state.people = data.users;
    } catch (err) {
      if (seq !== searchSeq) return;
      state.people = [];
      toast(err.message, 'error');
    }
    state.peopleLoaded = true;
    state.peopleQuery = query;
    renderPanel();
  }

  function onSearchInput() {
    state.query = els.searchInput.value;
    els.searchClear.hidden = !state.query;
    clearTimeout(searchTimer);
    renderPanel();
    if (state.tab === 'friends' && state.seg === 'find') {
      searchTimer = setTimeout(loadPeople, 200);
    }
  }

  const SEARCH_PLACEHOLDERS = {
    chats: 'Search chats and friends',
    friends: 'Search your friends',
    requests: 'Search friend requests',
    sent: 'Search sent requests',
    find: 'Search people by username',
  };

  function updateSearchPlaceholder() {
    const text = SEARCH_PLACEHOLDERS[state.tab === 'chats' ? 'chats' : state.seg];
    els.searchInput.placeholder = text;
    els.searchInput.setAttribute('aria-label', text);
  }

  function clearQuery() {
    state.query = '';
    els.searchInput.value = '';
    els.searchClear.hidden = true;
  }

  function setSeg(seg, focusSearch) {
    state.seg = seg;
    /** All / Unread above the chat list. Only changes what is shown; the data stays the same. */
  function setChatFilter(filter) {
    state.chatFilter = filter;
    els.chatFilter.querySelectorAll('.seg-btn').forEach((button) => {
      const active = button.dataset.filter === filter;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    renderPanel();
  }

  els.chatFilter.querySelectorAll('.seg-btn').forEach((button) => {
    button.addEventListener('click', () => setChatFilter(button.dataset.filter));
  });

  els.friendSeg.querySelectorAll('.seg-btn').forEach((button) => {
      const active = button.dataset.seg === seg;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    clearQuery();
    updateSearchPlaceholder();
    if (seg === 'find') loadPeople();
    renderPanel();
    if (focusSearch) els.searchInput.focus();
  }

  function setTab(tab, options) {
    state.tab = tab;
    document.querySelectorAll('.rail-btn[data-tab]').forEach((button) => {
      const active = button.dataset.tab === tab;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (!(options && options.keepQuery)) clearQuery();
    els.friendSeg.hidden = tab !== 'friends';
    els.chatFilter.hidden = tab !== 'chats';
    if (tab === 'chats') markReadIfVisible();

    // The header button starts a new chat on the Chats tab and finds people on the Friends tab.
    const onFriends = tab === 'friends';
    els.newChatBtn.replaceChildren(el('i', { class: `bi ${onFriends ? 'bi-person-plus-fill' : 'bi-pencil-square'}` }));
    els.newChatBtn.title = onFriends ? 'Add friend' : 'New conversation';
    els.newChatBtn.setAttribute('aria-label', els.newChatBtn.title);

    updateSearchPlaceholder();
    if (onFriends) {
      loadFriends();
      if (state.seg === 'find') loadPeople();
    }
    renderPanel();
  }

  /** "New conversation": only accepted friends can be messaged, so it opens the friends list. */
  function startNewConversation() {
    setView('list');
    if (state.tab !== 'friends') setTab('friends');
    setSeg(state.friends.length ? 'friends' : 'find', true);
  }

  function findPeople(query) {
    setTab('friends');
    setSeg('find');
    els.searchInput.value = query || '';
    onSearchInput();
    els.searchInput.focus();
  }

  function messageFriend(user) {
    openConversation({ ...user, relation: relationOf(user.id) });
  }

  /* ------------------------------------------------------------------
     Friendship actions (HTTP). The server pushes the result to both people too.
     ------------------------------------------------------------------ */
  async function friendAction(user, work, success) {
    if (state.busy.has(user.id)) return;
    state.busy.add(user.id);
    renderPanel();
    updateComposerState();
    try {
      const result = await work();
      if (result && result.relation) applyRelation(user.id, result.relation);
      if (success) toast(success, 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      state.busy.delete(user.id);
      await loadFriends();
      if (state.tab === 'friends' && state.seg === 'find') loadPeople();
      updateComposerState();
    }
  }

  function sendFriendRequest(user) {
    return friendAction(user,
      () => api('/api/friends/requests', { method: 'POST', body: { userId: user.id } }),
      `Friend request sent to ${user.username}.`);
  }

  function respondToRequest(requestId, user, accept) {
    return friendAction(user,
      () => api(`/api/friends/requests/${requestId}/${accept ? 'accept' : 'decline'}`, { method: 'POST', body: {} }),
      accept ? `You and ${user.username} are now friends.` : `Friend request from ${user.username} declined.`);
  }

  async function unfriend(id, user) {
    if (await confirmDialog({ title: 'Unfriend ' + user.username + '?', user,
      text: 'Your chat history will stay visible. Add each other again to send new messages.',
      confirmLabel: 'Unfriend', keepLabel: 'Keep friend' })) {
      await friendAction(user, () => api('/api/friends/' + id, { method: 'DELETE' }), 'Friend removed.');
    }
  }

  async function confirmCancelRequest(requestId, user) {
    const ok = await confirmDialog({
      title: 'Cancel friend request?',
      user,
      text: `${user.username} will no longer be able to accept this request. You can send a new one later.`,
      confirmLabel: 'Cancel request',
      keepLabel: 'Keep request',
    });
    if (!ok) return;
    friendAction(user, () => api(`/api/friends/requests/${requestId}`, { method: 'DELETE' }), 'Friend request cancelled.');
  }

  /* ------------------------------------------------------------------
     Views (desktop shows everything; small screens show list OR chat)
     ------------------------------------------------------------------ */
  function setView(view) {
    app.classList.toggle('view-chat', view === 'chat');
    app.classList.toggle('view-list', view === 'list');
  }

  function showRoom(show) {
    els.chatRoom.hidden = !show;
    els.chatEmpty.hidden = show;
  }

  /* ------------------------------------------------------------------
     Open conversation
     ------------------------------------------------------------------ */
  function renderHeader() {
    if (!state.peer) return;
    const inactive = state.peer.status !== 'active';
    const online = !inactive && state.online.has(state.peer.id);
    const friends = state.peer.relation && state.peer.relation.state === 'friends';
    els.headAvatar.replaceChildren(avatar(state.peer, 'md'));
    els.headName.textContent = state.peer.username;
    const parts = [el('span', { class: inactive ? 'inactive' : (online ? 'online' : null), text: inactive ? 'Account inactive' : (online ? 'Online' : 'Offline') })];
    if (!inactive && !friends) parts.push(el('span', { class: 'head-note' }, el('i', { class: 'bi bi-lock-fill' }), 'Not friends · read-only'));
    els.headStatus.replaceChildren(...parts); // (replaceChildren would print a null argument as text)
    els.headStatus.className = 'head-status';
  }

  /** Friends can send; anyone else (or an inactive account) gets a read-only conversation. */
  function canMessage() {
    return Boolean(state.peer) && state.peer.status === 'active'
      && Boolean(state.peer.relation) && state.peer.relation.state === 'friends';
  }

  function messageEl(message, first) {
    const mine = message.senderId === ME.id;
    const bubble = el('div', { class: 'bubble' },
      el('div', { class: 'text', text: message.content }),
      el('div', { class: 'meta' },
        message.editedAt ? el('span', { class: 'edited', text: 'Edited', title: `Edited ${fullFmt.format(new Date(message.editedAt))}` }) : null,
        el('time', {
          datetime: message.sentAt,
          title: fullFmt.format(new Date(message.sentAt)),
          text: timeFmt.format(new Date(message.sentAt)),
        })));
    if (mine && message.id === state.seenThrough) bubble.append(el('small', { class: 'seen-label', text: 'Seen' }));
    const wrap = el('div', { class: 'bubble-wrap' }, bubble);

    if (mine && !message.deleted) {
      wrap.append(el('button', {
        type: 'button',
        class: 'msg-menu-btn',
        'aria-label': 'Message options',
        'aria-haspopup': 'menu',
        onclick: (event) => { event.stopPropagation(); openMenu(message, event.currentTarget, null); },
      }, el('i', { class: 'bi bi-chevron-down' })));
    }

    const row = el('div', { class: `msg ${mine ? 'out' : 'in'}${first ? ' first' : ''}`, dataset: { id: String(message.id) } }, wrap);
    if (mine && !message.deleted) {
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        openMenu(message, null, event);
      });
    }
    return row;
  }

  /**
   * Redraws the whole thread (it is small, and this keeps the logic simple and bug-free).
   * mode: 'bottom' = jump to newest, 'auto' = follow new messages only if already at the bottom,
   *       'keep' = stay where you are, 'prepend' = keep the view steady after loading older messages.
   */
  function renderMessages(mode) {
    const box = els.messages;
    const prevTop = box.scrollTop;
    const prevHeight = box.scrollHeight;
    const nearBottom = prevHeight - prevTop - box.clientHeight < 140;
    const frag = document.createDocumentFragment();

    if (state.loadingMessages) {
      frag.append(el('div', { class: 'messages-loading' },
        el('span', { class: 'spinner-border spinner-border-sm', 'aria-hidden': 'true' }), 'Loading messages...'));
    } else if (!state.messages.length) {
      const friends = canMessage();
      frag.append(el('div', { class: 'messages-empty' },
        el('div', { class: 'empty-icon' }, el('i', { class: `bi ${friends ? 'bi-chat-heart' : 'bi-lock'}` })),
        el('strong', { text: state.peer ? (friends ? `Say hi to ${state.peer.username}` : `No messages with ${state.peer.username}`) : '' }),
        el('p', { class: 'mt-1 mb-0', text: friends ? 'No messages yet. Send the first one below.' : 'You must be friends to send messages.' })));
    } else {
      if (state.hasMore) {
        frag.append(el('button', { type: 'button', class: 'btn btn-soft btn-sm load-earlier', text: 'Load earlier messages', onclick: loadEarlier }));
      }
      let previous = null;
      for (const message of state.messages) {
        const sameDay = previous && dayKey(previous.sentAt) === dayKey(message.sentAt);
        if (!sameDay) frag.append(el('div', { class: 'day-divider', text: dayLabel(message.sentAt) }));
        const first = !previous || !sameDay || previous.senderId !== message.senderId
          || new Date(message.sentAt) - new Date(previous.sentAt) > 5 * 60 * 1000;
        frag.append(messageEl(message, first));
        previous = message;
      }
    }

    box.replaceChildren(frag);
    if (mode === 'bottom' || (mode === 'auto' && nearBottom)) box.scrollTop = box.scrollHeight;
    else if (mode === 'prepend') box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
    else box.scrollTop = prevTop;
  }

  async function openConversation(peer) {
    const token = ++state.loadToken;
    state.seenThrough = 0;
    state.reportedRead = 0;
    state.peer = {
      id: peer.id,
      username: peer.username,
      status: peer.status || 'active',
      relation: peer.relation || relationOf(peer.id),
    };
    state.messages = [];
    state.hasMore = false;
    state.loadingMessages = true;
    cancelEdit(true);
    closeMenu();
    els.composerInput.value = '';

    showRoom(true);
    setView('chat');
    autosize(); // must run after the room is visible, otherwise scrollHeight is 0 and the box collapses
    renderHeader();
    renderMessages('bottom');
    updateComposerState();
    if (state.tab !== 'chats' || state.query) setTab('chats');
    else renderPanel();

    await loadHistory(token, false);
  }

  /** Fetches the saved history from the database. Used on open AND after every reconnect so nothing is missed. */
  async function loadHistory(token, silent) {
    const peerId = state.peer.id;
    try {
      const data = await api(`/api/messages/${peerId}`);
      if (token !== state.loadToken) return;
      state.peer = { id: data.peer.id, username: data.peer.username, status: data.peer.status, relation: data.relation };
      state.seenThrough = Math.max(state.seenThrough, data.seenThrough);
      state.reportedRead = 0;
      state.messages = data.messages;
      state.hasMore = data.hasMore;
      state.loadingMessages = false;
      renderHeader();
      updateComposerState();
      renderMessages(silent ? 'auto' : 'bottom');
      markReadIfVisible();
      if (!silent && !mobileQuery.matches && !els.composerInput.disabled) els.composerInput.focus();
    } catch (err) {
      if (token !== state.loadToken || silent) return;
      state.loadingMessages = false;
      toast(err.message, 'error');
      closeConversation();
    }
  }

  async function loadEarlier() {
    if (!state.hasMore || state.earlierLoading || !state.messages.length || !state.peer) return;
    state.earlierLoading = true;
    const token = state.loadToken;
    try {
      const data = await api(`/api/messages/${state.peer.id}?before=${state.messages[0].id}`);
      if (token !== state.loadToken) return;
      state.messages = data.messages.concat(state.messages);
      state.hasMore = data.hasMore;
      renderMessages('prepend');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      state.earlierLoading = false;
    }
  }

  function closeConversation() {
    state.loadToken += 1; // forget any answer still on its way
    state.peer = null;
    state.messages = [];
    state.loadingMessages = false;
    cancelEdit(true);
    closeMenu();
    showRoom(false);
    setView('list');
    renderPanel();
  }

  /* ------------------------------------------------------------------
     Reading status
     ------------------------------------------------------------------ */
  function chatVisible() {
    const listOnly = mobileQuery.matches && app.classList.contains('view-list');
    return Boolean(state.peer) && state.tab === 'chats' && !listOnly && document.visibilityState === 'visible' && document.hasFocus();
  }

  /**
   * Called whenever the open chat may be on screen. Clears its badge right away (so in the Unread
   * view it leaves the list while the chat itself stays open) and tells the server, which saves
   * the read position and tells my other tabs.
   */
  function markReadIfVisible() {
    if (!chatVisible() || !socket.connected) return;
    if (state.loadingMessages) return;
    const bounds = els.messages.getBoundingClientRect();
    const rows = els.messages.querySelectorAll('.msg.in');
    for (let i = rows.length - 1; i >= 0; i--) {
      const id = Number(rows[i].dataset.id);
      if (id <= state.reportedRead) return;
      const row = rows[i].getBoundingClientRect();
      if (row.top >= bounds.bottom || row.bottom <= bounds.top) continue;
      state.reportedRead = id;
      const peerId = state.peer.id;
      socket.emit('conversation:read', { peerId, messageId: id }, reply => {
        if (!reply?.ok && state.peer?.id === peerId && state.reportedRead === id) state.reportedRead = 0;
      });
      return;
    }
  }

  /* ------------------------------------------------------------------
     Live updates (what the server pushes to us)
     ------------------------------------------------------------------ */
  function applyNew(message) {
    const peerId = message.senderId === ME.id ? message.receiverId : message.senderId;
    if (state.peer && state.peer.id === peerId) {
      if (!state.messages.some((m) => m.id === message.id)) {
        state.messages.push(message);
        renderMessages(message.senderId === ME.id ? 'bottom' : 'auto');
      }
      if (message.senderId !== ME.id) markReadIfVisible();
    }
    scheduleRefresh();
  }

  function applyEdited(message) {
    const index = state.messages.findIndex((m) => m.id === message.id);
    if (index !== -1) {
      state.messages[index] = message;
      renderMessages('keep');
    }
    scheduleRefresh();
  }

  function applyDeleted(id) {
    const message = state.messages.find(m => m.id === id);
    if (message) Object.assign(message, { content: 'Message deleted', editedAt: null, deleted: true });
    if (state.editingId === id) {
      cancelEdit();
      toast('The message you were editing was deleted.', 'info');
    }
    if (message) renderMessages('keep');
    scheduleRefresh();
  }

  socket.on('connect', () => {
    els.connBanner.hidden = true;
    if (hasConnectedBefore) {
      // We may have missed things while offline: reload from the database.
      loadConversations();
      loadFriends(); // friendships may have changed while we were offline
      if (state.peer) loadHistory(state.loadToken, true);
      if (state.tab === 'friends' && state.seg === 'find') loadPeople();
      loadBilling(); // a payment may have been recorded while we were offline
    }
    hasConnectedBefore = true;
  });

  // The server tells every open tab what you owe after a charge or when an admin records a payment.
  socket.on('billing:updated', ({ balanceCents }) => {
    setBalance(balanceCents);
    if (profileOpen) loadBilling(true);
  });

  socket.on('disconnect', (reason) => {
    els.connBanner.hidden = false;
    if (reason === 'io server disconnect') {
      // The server closed the connection (logout elsewhere, deactivation...). Find out why.
      const retry = () => api('/api/me').then(() => socket.connect()).catch(() => setTimeout(retry, 3000));
      retry();
    }
  });

  socket.on('connect_error', (err) => {
    els.connBanner.hidden = false;
    if (err && err.message === 'unauthorized') window.location.href = '/login';
  });

  socket.on('presence:list', (ids) => {
    state.online = new Set(ids);
    renderHeader();
    renderPanel();
  });

  socket.on('presence:update', ({ userId, online }) => {
    if (online) state.online.add(userId);
    else state.online.delete(userId);
    renderHeader();
    renderPanel();
  });

  socket.on('message:new', applyNew);
  socket.on('message:edited', applyEdited);
  socket.on('message:deleted', ({ id }) => applyDeleted(id));

  socket.on('conversation:seen', ({ peerId, messageId }) => {
    if (state.peer?.id === peerId && messageId > state.seenThrough) {
      state.seenThrough = messageId;
      renderMessages('keep');
    }
  });
  socket.on('conversation:read', scheduleRefresh);

  /*
   * Friendship changes. The server sends each person the OTHER user plus the new relation from
   * their own point of view, to every tab they have open. "byMe" is true in the tabs of the person
   * who made the change (the tab that clicked already showed its own toast).
   */
  function onFriendEvent(event) {
    return ({ user, relation, byMe }) => {
      if (!user) return;
      applyRelation(user.id, relation);
      if (!byMe) {
        if (event === 'friend:request') toast(`${user.username} sent you a friend request.`, 'info');
        else if (event === 'friend:accepted') toast(`${user.username} accepted your friend request. You can now chat.`, 'success');
        else if (event === 'friend:declined') toast(`${user.username} declined your friend request.`, 'info');
      }
      renderPanel();
      scheduleRefresh();
    };
  }

  ['friend:request', 'friend:accepted', 'friend:declined', 'friend:cancelled', 'friend:removed']
    .forEach((event) => socket.on(event, onFriendEvent(event)));
  socket.on('friends:updated', scheduleFriendsRefresh);

  /* ------------------------------------------------------------------
     Composer: send and edit
     ------------------------------------------------------------------ */
  function autosize() {
    const box = els.composerInput;
    box.style.height = 'auto';
    const borders = box.offsetHeight - box.clientHeight; // border-box sizing: scrollHeight excludes the borders
    box.style.height = `${Math.min(box.scrollHeight + borders, 140)}px`;
  }

  function updateSendState() {
    const empty = !els.composerInput.value.trim();
    // Editing your own earlier message stays possible in a read-only conversation; sending new ones does not.
    const editing = state.editingId !== null;
    const blocked = !state.peer || (editing ? state.peer.status !== 'active' : !canMessage());
    els.sendBtn.disabled = state.sending || empty || blocked;

    const length = els.composerInput.value.length;
    const showCount = length >= MAX_LENGTH * 0.8;
    els.charCount.hidden = !showCount;
    els.charCount.textContent = `${length}/${MAX_LENGTH}`;
    els.charCount.classList.toggle('warn', length >= MAX_LENGTH * 0.95);
    updateCostLine();
  }

  function updateSendIcon() {
    const editing = state.editingId !== null;
    els.sendBtn.replaceChildren(el('i', { class: `bi ${editing ? 'bi-check-lg' : 'bi-send-fill'}` }));
    els.sendBtn.setAttribute('aria-label', editing ? 'Save edited message' : 'Send message');
  }

  /** The note above the composer explains why it is disabled and offers the next step. */
  function renderComposerNote(inactive, readOnly) {
    const note = els.composerNote;
    if (!state.peer || (!inactive && !readOnly)) {
      note.hidden = true;
      els.composerNoteActions.replaceChildren();
      return;
    }
    const peer = state.peer;
    const relation = peer.relation || NO_RELATION;
    const opts = { disabled: state.busy.has(peer.id) || null };
    let icon = 'bi-lock-fill';
    let text;
    let actions = [];

    if (inactive) {
      icon = 'bi-slash-circle';
      text = "This account is inactive, so you can't send new messages.";
    } else if (relation.state === 'outgoing') {
      icon = 'bi-clock';
      text = `Friend request sent. You can message ${peer.username} once they accept.`;
      actions = [smallBtn('Cancel request', null, 'btn-outline-secondary', () => confirmCancelRequest(relation.requestId, peer), opts)];
    } else if (relation.state === 'incoming') {
      icon = 'bi-person-plus';
      text = `${peer.username} sent you a friend request. Accept it to chat.`;
      actions = [
        smallBtn('Accept', null, 'btn-primary', () => respondToRequest(relation.requestId, peer, true), opts),
        smallBtn('Decline', null, 'btn-outline-secondary', () => respondToRequest(relation.requestId, peer, false), opts),
      ];
    } else {
      text = 'You must be friends to send messages.';
      actions = [smallBtn('Add Friend', 'bi-person-plus-fill', 'btn-primary', () => sendFriendRequest(peer), opts)];
    }

    els.composerNoteIcon.className = `bi ${icon}`;
    els.composerNoteText.textContent = text;
    els.composerNoteActions.replaceChildren(...actions);
    note.classList.toggle('warn', inactive);
    note.hidden = false;
  }

  function updateComposerState() {
    const hasPeer = Boolean(state.peer);
    const inactive = hasPeer && state.peer.status !== 'active';
    const readOnly = hasPeer && !inactive && !canMessage();
    const editing = state.editingId !== null;
    if (inactive) cancelEdit();

    els.composerInput.disabled = inactive || (readOnly && !editing);
    let placeholder = 'Type a message';
    if (inactive) placeholder = 'This account is inactive';
    else if (readOnly && !editing) placeholder = 'You must be friends to send messages';
    els.composerInput.placeholder = placeholder;
    renderComposerNote(inactive, readOnly);
    updateSendState();
  }

  function startEdit(message) {
    state.editingId = message.id;
    state.editingChars = countChars(message.content);
    els.editPreview.textContent = oneLine(message.content).slice(0, 120);
    els.editBar.hidden = false;
    els.composerInput.value = message.content;
    updateComposerState(); // re-enables the input for the edit, even in a read-only conversation
    autosize();
    updateSendIcon();
    els.composerInput.focus();
    els.composerInput.setSelectionRange(message.content.length, message.content.length);
  }

  function cancelEdit(keepText) {
    if (state.editingId === null) return;
    state.editingId = null;
    els.editBar.hidden = true;
    if (!keepText) {
      els.composerInput.value = '';
      autosize();
    }
    updateSendIcon();
    updateComposerState(); // a read-only conversation locks the input again
  }

  async function submitComposer() {
    if (!state.peer || state.sending || state.peer.status !== 'active') return;
    if (state.editingId === null && !canMessage()) return; // the server would refuse it anyway
    const content = els.composerInput.value.trim();
    if (!content) return;

    state.sending = true;
    updateSendState();
    try {
      if (state.editingId !== null) {
        const result = await api('/api/messages/' + state.editingId, { method: 'PUT', body: {content} });
        applyEdited(result.message);
        cancelEdit();
        setBalance(result.balanceCents);
        if (result.charge) toast(`Edit added ${result.charge.chars} character${result.charge.chars === 1 ? '' : 's'}: ${money(result.charge.amountCents)}.`, 'info');
      } else {
        const result = await api('/api/messages', { method: 'POST', body: {recipientId: state.peer.id, content} });
        if (els.composerInput.value.trim() === content) {
          els.composerInput.value = '';
          autosize();
        }
        applyNew(result.message);
        setBalance(result.balanceCents);
      }
    } catch (err) {
      toast(err.message, 'error');
      if (err.status === 402) loadBilling(); // refused by the credit limit: show the true balance
      // Editing something that no longer exists: leave edit mode.
      if (state.editingId !== null && !state.messages.some((m) => m.id === state.editingId)) cancelEdit();
      // Refused because the friendship just ended: re-read it so the composer locks.
      if (/friends/i.test(err.message)) loadFriends();
    } finally {
      state.sending = false;
      updateSendState();
      if (!els.composerInput.disabled) els.composerInput.focus();
    }
  }

  els.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    submitComposer();
  });

  els.composerInput.addEventListener('input', () => {
    autosize();
    updateSendState();
  });

  els.composerInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault(); // Enter sends; Shift + Enter inserts a new line
      submitComposer();
    } else if (event.key === 'Escape' && state.editingId !== null) {
      cancelEdit();
    }
  });

  els.editCancel.addEventListener('click', () => {
    cancelEdit();
    els.composerInput.focus();
  });

  /* ------------------------------------------------------------------
     Contextual message menu (Edit / Delete) and delete confirmation
     ------------------------------------------------------------------ */
  let menuMessageId = null;
  const menu = el('div', { class: 'ctx-menu', role: 'menu', hidden: true, 'aria-label': 'Message options' },
    el('button', { type: 'button', class: 'ctx-item', role: 'menuitem', onclick: () => menuAction('edit') },
      el('i', { class: 'bi bi-pencil' }), 'Edit'),
    el('button', { type: 'button', class: 'ctx-item danger', role: 'menuitem', onclick: () => menuAction('delete') },
      el('i', { class: 'bi bi-trash3' }), 'Delete'));
  document.body.append(menu);

  function openMenu(message, anchor, mouseEvent) {
    closeMenu();
    menuMessageId = message.id;
    menu.hidden = false;
    if (anchor) anchor.classList.add('open');

    const rect = anchor ? anchor.getBoundingClientRect() : null;
    let x = mouseEvent ? mouseEvent.clientX : rect.left;
    let y = mouseEvent ? mouseEvent.clientY : rect.bottom + 4;
    x = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.querySelector('.ctx-item').focus();
  }

  function closeMenu() {
    menu.hidden = true;
    menuMessageId = null;
    document.querySelectorAll('.msg-menu-btn.open').forEach((button) => button.classList.remove('open'));
  }

  function menuAction(action) {
    const message = state.messages.find((m) => m.id === menuMessageId);
    closeMenu();
    if (!message) return;
    if (action === 'edit') startEdit(message);
    else askDelete(message);
  }

  menu.addEventListener('keydown', (event) => {
    const items = [...menu.querySelectorAll('.ctx-item')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length].focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length].focus(); }
    else if (event.key === 'Tab') closeMenu();
  });
  document.addEventListener('click', (event) => { if (!menu.hidden && !menu.contains(event.target)) closeMenu(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !menu.hidden) closeMenu(); });
  els.messages.addEventListener('scroll', closeMenu, { passive: true });
  window.addEventListener('resize', closeMenu);

  const deleteModal = new window.bootstrap.Modal($('deleteModal'));
  const confirmDeleteBtn = $('confirmDeleteBtn');

  function askDelete(message) {
    state.pendingDelete = message.id;
    $('deletePreview').textContent = message.content.length > 160 ? `${message.content.slice(0, 160)}...` : message.content;
    $('deleteText').textContent = `This message will be removed for you and ${state.peer ? state.peer.username : 'the other person'}. This can't be undone.`;
    deleteModal.show();
  }

  confirmDeleteBtn.addEventListener('click', async () => {
    const id = state.pendingDelete;
    if (id === null) return;
    confirmDeleteBtn.disabled = true;
    try {
      await api('/api/messages/' + id, { method: 'DELETE' });
      applyDeleted(id);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      confirmDeleteBtn.disabled = false;
      state.pendingDelete = null;
      deleteModal.hide();
    }
  });

  /* ------------------------------------------------------------------
     Styled confirmation (cancel request): resolves true / false
     ------------------------------------------------------------------ */
  const confirmModalEl = $('confirmModal');
  const confirmModal = new window.bootstrap.Modal(confirmModalEl);
  let confirmResolve = null;

  function confirmDialog({ title, text, user, confirmLabel, keepLabel }) {
    if (confirmResolve) confirmResolve(false); // a dialog was still open: treat it as "no"
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('confirmOkBtn').textContent = confirmLabel || 'Confirm';
    $('confirmCancelBtn').textContent = keepLabel || 'Keep';
    $('confirmPerson').replaceChildren(...(user
      ? [avatar(user, 'sm'), el('strong', { text: user.username })]
      : []));
    $('confirmPerson').hidden = !user;
    return new Promise((resolve) => {
      confirmResolve = resolve;
      confirmModal.show();
    });
  }

  $('confirmOkBtn').addEventListener('click', () => {
    const resolve = confirmResolve;
    confirmResolve = null;
    confirmModal.hide();
    if (resolve) resolve(true);
  });
  confirmModalEl.addEventListener('hidden.bs.modal', () => {
    const resolve = confirmResolve;
    confirmResolve = null;
    if (resolve) resolve(false);
  });

  /* ------------------------------------------------------------------
     Billing: price of what you type, running balance, recent charges and payments
     ------------------------------------------------------------------ */
  function money(cents) {
    const abs = Math.abs(cents);
    const text = `$${Math.floor(abs / 100).toLocaleString('en-US')}${abs % 100 ? `.${String(abs % 100).padStart(2, '0')}` : ''}`;
    return cents < 0 ? `-${text}` : text;
  }

  /** Characters as the server counts them: after trimming, an emoji is one character. */
  const countChars = (text) => Array.from(text.trim()).length;

  /** The price line under the message box while you type (the server's count is the one that is billed). */
  function updateCostLine() {
    const chars = countChars(els.composerInput.value);
    const editing = state.editingId !== null;
    let text = '';
    if (chars > 0 && !els.composerInput.disabled) {
      if (!editing) {
        text = `This message costs ${money(chars * billing.rateCents)} (${chars.toLocaleString('en-US')} character${chars === 1 ? '' : 's'} at ${money(billing.rateCents)} each)`;
      } else {
        const extra = Math.max(0, chars - (state.editingChars || 0));
        text = extra
          ? `Editing: ${extra.toLocaleString('en-US')} extra character${extra === 1 ? '' : 's'} will cost ${money(extra * billing.rateCents)}`
          : 'Editing: no extra charge (only added characters are billed, nothing is refunded)';
      }
    }
    els.costText.textContent = text;
    els.costLine.hidden = !text;
  }

  /** The balance chip next to "Chats": amber when you owe, green when you have credit. */
  function renderBalance() {
    const cents = billing.balanceCents;
    els.balanceText.textContent = cents < 0 ? `${money(-cents)} credit` : money(cents);
    els.balancePill.classList.toggle('owes', cents > 0);
    els.balancePill.classList.toggle('credit', cents < 0);
    els.balancePill.setAttribute('aria-label',
      cents > 0 ? `You owe ${money(cents)}. Open billing details.` : cents < 0 ? `You have ${money(-cents)} in credit. Open billing details.` : 'You owe nothing. Open billing details.');
    const big = $('billingBalance');
    if (big) {
      big.textContent = cents < 0 ? `${money(-cents)} credit` : money(cents);
      big.classList.toggle('owes', cents > 0);
      big.classList.toggle('credit', cents < 0);
    }
  }

  function setBalance(cents) {
    if (!Number.isFinite(cents)) return;
    billing.balanceCents = cents;
    renderBalance();
  }

  function billingRow(main, sub, amount, kind) {
    return el('li', { class: `billing-row ${kind}` },
      el('div', {}, el('div', { class: 'billing-main', text: main }), el('small', { text: sub })),
      el('strong', { text: amount }));
  }

  function renderBillingDetails(data) {
    $('billingCharged').textContent = money(data.chargedCents);
    $('billingPaid').textContent = money(data.paidCents);
    $('billingRate').textContent = `1 character sent = ${money(data.rateCents)}`;
    const limit = $('billingLimit');
    limit.hidden = data.creditLimitCents === null;
    if (data.creditLimitCents !== null) {
      limit.textContent = data.creditLimitCents === 0
        ? 'You need credit before you can send: pay at the counter first.'
        : `You can owe up to ${money(data.creditLimitCents)} before you need to pay.`;
    }
    $('billingPayments').replaceChildren(...(data.payments.length
      ? data.payments.map((p) => billingRow(p.receiptNo, fullFmt.format(new Date(p.paidAt)), `-${money(p.amountCents)}`, 'paid'))
      : [el('li', { class: 'billing-empty', text: 'No payments recorded yet.' })]));
    $('billingCharges').replaceChildren(...(data.charges.length
      ? data.charges.map((c) => billingRow(
        c.kind === 'send' ? 'Message sent' : 'Edit added characters',
        `${fullFmt.format(new Date(c.at))} \u00B7 ${c.chars.toLocaleString('en-US')} character${c.chars === 1 ? '' : 's'}`,
        money(c.amountCents), 'charged'))
      : [el('li', { class: 'billing-empty', text: 'Nothing has been charged yet.' })]));
  }

  async function loadBilling(withDetails) {
    try {
      const data = await api('/api/billing');
      billing.rateCents = data.rateCents;
      setBalance(data.balanceCents);
      if (withDetails || profileOpen) renderBillingDetails(data);
    } catch (err) {
      // The balance chip simply keeps its last value; the Profile dialog shows nothing new.
    }
  }

  /* ------------------------------------------------------------------
     Profile dialog (billing + change password)
     ------------------------------------------------------------------ */
  const profileModal = new window.bootstrap.Modal($('profileModal'));
  profileModalElement = $('profileModal');
  profileModalElement.addEventListener('show.bs.modal', () => { profileOpen = true; loadBilling(true); });
  profileModalElement.addEventListener('hidden.bs.modal', () => { profileOpen = false; });
  const pwFields = {
    currentPassword: { input: $('pwCurrent'), error: $('pwCurrentError') },
    newPassword: { input: $('pwNew'), error: $('pwNewError') },
    confirmPassword: { input: $('pwConfirm'), error: $('pwConfirmError') },
  };

  const usernameInput = $('profileUsername');
  function updateOwnName(username) {
    ME.username = username;
    app.dataset.meUsername = username;
    usernameInput.value = username;
    document.querySelector('.profile-name').textContent = username;
    document.querySelector('#chatEmpty h2').textContent = 'Welcome to Bai-ber, ' + username;
    $('railAvatar').title = username;
    $('railAvatar').setAttribute('aria-label', 'Your profile (' + username + ')');
    document.querySelectorAll('#railAvatar .avatar, .profile-card .avatar').forEach(a => a.textContent = username.charAt(0));
  }
  socket.on('profile:renamed', ({ id, username }) => {
    if (id === ME.id) updateOwnName(username);
    if (state.peer?.id === id) { state.peer.username = username; renderHeader(); updateComposerState(); }
    scheduleRefresh();
    scheduleFriendsRefresh();
  });
  usernameInput.addEventListener('input', () => usernameInput.classList.remove('is-invalid'));
  $('usernameForm').addEventListener('submit', async event => {
    event.preventDefault();
    const username = usernameInput.value.trim();
    try {
      if (username !== ME.username && username.length < 6) throw new Error('Username must be at least 6 characters.');
      const data = await api('/api/profile/username', { method: 'POST', body: { username } });
      updateOwnName(data.username);
      usernameInput.classList.remove('is-invalid');
      toast('Username saved.', 'success');
    } catch (err) {
      $('renameError').textContent = err.message;
      usernameInput.classList.add('is-invalid');
    }
  });

  function resetPasswordForm() {
    $('passwordForm').reset();
    $('passwordError').hidden = true;
    $('passwordSuccess').hidden = true;
    Object.values(pwFields).forEach(({ input, error }) => { input.classList.remove('is-invalid'); error.textContent = ''; });
  }

  function showFieldErrors(errors) {
    Object.entries(errors).forEach(([name, message]) => {
      const field = pwFields[name];
      if (!field) return;
      field.input.classList.add('is-invalid');
      field.error.textContent = message;
    });
  }

  $('passwordForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('passwordError').hidden = true;
    $('passwordSuccess').hidden = true;
    Object.values(pwFields).forEach(({ input, error }) => { input.classList.remove('is-invalid'); error.textContent = ''; });

    const body = {
      currentPassword: pwFields.currentPassword.input.value,
      newPassword: pwFields.newPassword.input.value,
      confirmPassword: pwFields.confirmPassword.input.value,
    };
    const problems = {};
    if (!body.currentPassword) problems.currentPassword = 'Enter your current password.';
    if (body.newPassword.length < 8) problems.newPassword = 'Password must be at least 8 characters.';
    else if (body.newPassword !== body.confirmPassword) problems.confirmPassword = 'Passwords do not match.';
    if (Object.keys(problems).length) return showFieldErrors(problems);

    const submit = $('pwSubmit');
    submit.disabled = true;
    try {
      const result = await api('/api/profile/password', { method: 'POST', body });
      $('passwordForm').reset();
      $('passwordSuccess').textContent = result.message || 'Password updated.';
      $('passwordSuccess').hidden = false;
    } catch (err) {
      if (err.errors) showFieldErrors(err.errors);
      else {
        $('passwordError').textContent = err.message;
        $('passwordError').hidden = false;
      }
    } finally {
      submit.disabled = false;
    }
    return undefined;
  });

  $('profileModal').addEventListener('hidden.bs.modal', resetPasswordForm);
  $('railAvatar').addEventListener('click', () => profileModal.show());
  els.balancePill.addEventListener('click', () => profileModal.show());

  /* ------------------------------------------------------------------
     Wiring
     ------------------------------------------------------------------ */
  document.querySelectorAll('.rail-btn[data-tab]').forEach((button) => {
    button.addEventListener('click', () => setTab(button.dataset.tab));
  });

  els.friendSeg.querySelectorAll('.seg-btn').forEach((button) => {
    button.addEventListener('click', () => setSeg(button.dataset.seg, button.dataset.seg === 'find'));
  });

  els.newChatBtn.addEventListener('click', () => {
    if (state.tab === 'friends') setSeg('find', true); // "Add friend"
    else startNewConversation();
  });
  $('emptyStartBtn').addEventListener('click', startNewConversation);
  $('backBtn').addEventListener('click', () => setView('list'));

  els.searchInput.addEventListener('input', onSearchInput);
  els.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && els.searchInput.value) {
      els.searchInput.value = '';
      onSearchInput();
    }
  });
  els.searchClear.addEventListener('click', () => {
    els.searchInput.value = '';
    onSearchInput();
    els.searchInput.focus();
  });

  els.messages.addEventListener('scroll', markReadIfVisible, { passive: true });
  window.addEventListener('focus', markReadIfVisible);
  document.addEventListener('visibilitychange', markReadIfVisible);

  /* ------------------------------------------------------------------
     Start
     ------------------------------------------------------------------ */
  updateSendIcon();
  renderBalance();
  renderPanel(); // shows loading placeholders
  loadConversations();
  loadFriends(); // friends list, request badge, and who can be messaged
})();
