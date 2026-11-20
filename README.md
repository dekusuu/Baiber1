# Bai-ber

A desktop-first, real-time one-to-one messaging web app with a purple, Viber-inspired interface.
People find each other, send **friend requests**, and can message each other only once a request is accepted.
Every character sent costs money (**1 character = ₱1**), paid face to face and recorded by an **administrator**.

**Stack:** Node.js, Express, EJS, Bootstrap 5, vanilla JavaScript, Socket.IO, MySQL (`mysql2/promise`), `express-session`, `bcryptjs`, `dotenv`.

> Bai-ber is a standard web messaging app. Messages are stored in the server's database and are **not** end-to-end encrypted.

---

## Setup on Windows

1. Install Node.js 22.13 or later and start MySQL Server 8.0.16 or later.
2. **New installation:** open MySQL Workbench, connect to your local server, open `schema.sql` from this folder and execute the whole script. It creates the `bai_ber` database and its tables.
   **Existing installation (you already have a `bai_ber` database from before billing):** do not run `schema.sql`. Run `npm run migrate` in step 5 instead.
3. Edit the included `.env`. Set `DB_HOST`, `DB_PORT`, `DB_USER` and `DB_PASSWORD` to match your MySQL connection. For a fresh checkout copy `.env.example` to `.env` first. Add the new billing settings from `.env.example` (see [Settings](#settings)); at least set `ADMIN_UTC_OFFSET_MINUTES=480` for Manila time.
   The account running the app needs SELECT, INSERT, UPDATE and DELETE on `bai_ber`. `npm run migrate` also needs CREATE and ALTER.
4. Open a terminal in this folder and run `npm install`.
5. Prepare the data:
   - Fresh installation with the supplied accounts and chats: run `npm run import:sqlite` once.
   - Fresh installation without them: skip this.
   - Existing installation: run `npm run migrate` (safe to run again; it says "Nothing to do" when finished).
6. Create the administrator: `npm run admin:create -- yourname` (you are asked for a password).
7. Run `npm start` and open http://localhost:3000. Set `PORT` in `.env` to change the port.

The importer reads the bundled SQLite database (including its WAL), checks the row counts and commits one MySQL transaction. It preserves IDs, password hashes, friendship states, messages and read positions. It refuses to merge into populated application tables. To import another copy, run `npm run import:sqlite -- "path/to/messaging.db"`. Keep any matching WAL and SHM files beside it. Users sign in again after import. Imported messages are **free**: billing only counts messages sent after go-live.

## Accounts and roles

There are two roles.

| Role | Created by | Signs in to | Can do |
| --- | --- | --- | --- |
| **user** | Registration page (always a regular, active user; a `role` or `status` sent in the form is ignored) | `/chat` | Friends, messaging, sees their own balance and charges |
| **admin** | The command `npm run admin:create -- <username>` only | `/admin` | Dashboard, Users, Billing / Payment |

- An admin **cannot chat, has no friends and cannot read anyone's messages.** The admin pages show counts, characters and money, never message text.
- Admin accounts never appear in friend search; people who talked to an old admin account see it as inactive.
- `npm run admin:create` always creates a **new** account. It refuses a username that exists and never turns an existing chat account into an admin. The password is typed hidden, or set `ADMIN_PASSWORD` in the environment for scripted setup.
- A signed-in user who is not an admin gets a 404 at `/admin` (signed-out visitors are sent to the login page). An admin who opens `/chat` is sent back to `/admin`.
- Databases from the older version that had `legacy_admin = 1` accounts: `npm run migrate` turns them into `admin` accounts. Check that you still want that.

## Billing

**Rule: 1 character sent = ₱1.** Customers pay in person; the admin records it. Nothing is paid online.

- Every character counts, spaces and line breaks included. An emoji counts as 1.
- Charges are **postpaid**: sending a message adds to the person's balance, and a recorded payment reduces it. `balance = total charged - total paid`. A positive balance is what the person owes; a negative one is credit.
- **Edit:** editing a message bills only the extra characters beyond what was already paid for. Making it shorter bills nothing and refunds nothing.
- **Delete:** deleting a message never refunds it.
- **Old messages are free.** Messages that exist when billing goes live are marked as already covered. Editing one of them bills only the characters you add to it.
- **Optional credit limit** (`BILLING_CREDIT_LIMIT`, off by default). When set, a message that would push the unpaid balance over the limit is refused with a clear message ("402") and the person is told to pay at the counter. `0` makes it fully prepaid.
- Money is kept as whole cents. The rate comes from `BILLING_RATE_CENTS` (100 = ₱1).
- The charge and the message are saved in the same database transaction, so a message is never sent without its charge or charged without being sent.

**What users see:** a balance pill at the top of the chat list (tap it for details), a live "This message costs ₱N (N characters at ₱1 each)" line above the composer, and a Billing section in Profile & settings with their balance, total charged and paid, recent payments and recent charges. The balance updates instantly across their open tabs.

**What the admin does:** when someone pays, open **Billing / Payment -> Record payment**, pick the person, enter the amount, and save. A printable receipt (`OR-000001`, `OR-000002`, ...) opens straight away. A payment cannot be edited. If it was entered wrong, **void** it (a reason of 3-255 characters is required) and record it again. Voided payments stay in the list for the audit trail and do not count toward the balance.

## Admin area

| Section | Route | What it shows |
| --- | --- | --- |
| **Dashboard** | `/admin` | Outstanding, collected and billed totals; users, online now, messages and characters (all with a "today" figure); characters billed per day for 14 days (chart with a "View as table" toggle); biggest balances; recent payments |
| **Users** | `/admin/users`, `/admin/users/:id` | Searchable, filterable, sortable user list. A user page shows balance, activity, payments and charges, and lets you **deactivate / reactivate** the account (deactivating signs the person out of every device immediately) |
| **Billing / Payment** | `/admin/billing` | Balances tab (who owes what, with a **Record payment** button on each row) and Payments tab (searchable, filterable by date and voided, **Export CSV**, receipts, void) |

Notes:
- "Today" and the daily chart use the time zone set by `ADMIN_UTC_OFFSET_MINUTES` (Manila = 480).
- "Date received" on a payment defaults to now. You may choose an earlier day (up to 366 days back); future dates are refused.
- Submitting the payment form twice (double click, refresh) records it once.
- The CSV export neutralises spreadsheet formulas, so it is safe to open in Excel.

## Settings

All settings live in `.env` (see `.env.example`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `BILLING_RATE_CENTS` | `100` | Price of one character in cents (₱1) |
| `BILLING_CREDIT_LIMIT` | unset | Maximum unpaid balance in pesos. Unset = no limit, `0` = prepaid |
| `ADMIN_UTC_OFFSET_MINUTES` | `0` | Your time zone in minutes ahead of UTC (Manila = `480`) |
| `SESSION_SECRET` | none, required | Signs the session cookie |
| `SESSION_DAYS`, `BCRYPT_ROUNDS`, `REGISTER_LIMIT_PER_HOUR`, `TRUST_PROXY`, `COOKIE_SECURE`, `ALLOWED_ORIGINS` | see `.env.example` | Optional hardening and deployment settings |

If you change `BILLING_RATE_CENTS` later, only **new** charges use the new rate; past charges keep the amount they were recorded at.

## Message CRUD

| Action | Express endpoint | Database operation |
| --- | --- | --- |
| Send | POST /api/messages | INSERT for an accepted friendship + INSERT of the charge (one transaction) |
| Open conversation | GET /api/messages/:peerId | SELECT the two users' messages |
| Edit | PUT /api/messages/:id | UPDATE the sender's message and edit timestamp + INSERT of a charge for any added characters |
| Delete | DELETE /api/messages/:id | UPDATE the sender's message to a deleted placeholder (no refund) |
| My balance | GET /api/billing | SELECT totals, recent payments and charges |

The browser calls these routes from `public/js/chat.js`. Express routes in `server.js` call `controllers/chatController.js`; the SQL lives in `models/messageModel.js` and `models/billingModel.js`. After a successful write, Socket.IO pushes the change to the two participants, and `billing:updated` refreshes the sender's balance. Unfriend uses a SQL DELETE on the accepted relationship.

## Project layout (billing and admin parts)

```
schema.sql                      all tables, including users.role, charges and payments
scripts/migrate.js              upgrades an existing database (npm run migrate)
scripts/create-admin.js         creates an administrator (npm run admin:create)
models/billingModel.js          rates, charges, payments, balances, credit limit
models/adminModel.js            read-only queries behind the admin pages
controllers/adminController.js  Dashboard, Users, Billing / Payment, receipts, CSV
views/admin/                    admin pages (EJS)
public/css/admin.css            admin styles
public/js/admin.js              payment modal, void modal, chart tooltip, table toggle
tests/                          unit and integration tests
```

## Tests

```
npm test
```

This runs the unit tests (no database needed). The integration tests drive the real app against MySQL and are **off by default** because they create and drop a database:

```
set BAIBER_INTEGRATION=1        (Windows cmd)   |   $env:BAIBER_INTEGRATION=1   (PowerShell)
npm test
```

Use a MySQL account that may create databases (for example `root` on your own machine) in `.env`. They run on their own database, `bai_ber_test`, and refuse any database name that does not end in `_test`, so your real `bai_ber` is never touched. They cover charging, edits, deletes, credit limits (including simultaneous sends), payments, voids, receipts, CSV export, access control and the admin pages.

## Features

Navigation rail (a bottom bar on phones): **Chats**, **Friends** (with a badge counting incoming requests), **Profile / Settings**, **Log out**.

**Accounts**
- Register with a unique 6–24 character username. Rename it in Profile & settings. Existing accounts with shorter names can still sign in.
- Profile dialog with change-password (other devices are signed out) and the Billing section.

**Friends**
- Four sections, switched with a segmented control under the search box:
  - **Friends**: accepted friends grouped by online/offline, each with **Message** and **Unfriend**.
  - **Requests**: incoming requests with **Accept** / **Decline**.
  - **Sent**: your pending requests with **Cancel**.
  - **Find**: search every registered user by username. Each result shows the action that fits:

    | Relationship | Action shown |
    | --- | --- |
    | none | Add Friend |
    | you sent a request | Request Sent / Cancel |
    | they sent you a request | Accept / Decline |
    | friends | Friends / Message / Unfriend |
- You never appear in your own search results, you cannot befriend yourself, and duplicate requests or friendships are refused (in either direction).
- Cancelling a request asks for confirmation in a styled dialog (no browser `confirm()`).
- After a request is declined or cancelled, **either** person can send a new one.
- Everything updates live in both people's open tabs over the existing Socket.IO connection: request received / accepted / declined / cancelled and badge counts. If a request is accepted while the other person has that chat open, their composer unlocks without a refresh.
- Empty states for no friends, no incoming requests, no sent requests and no search results.

**Messaging (real time over Socket.IO)**
- **Only accepted friends can send each other messages.** The server checks this on every send; it is not only hidden in the page.
- One-to-one conversations, newest first, with last message, time and unread badges. Chat search matches conversations, message text and friends you have not written to yet.
- **All / Unread** filter above the chat list (All by default). Unread shows only conversations with unread incoming messages (it reuses the existing unread counts) and says "You're all caught up" when there are none. It stays in sync with new messages and read events: opening an unread chat clears its badge and removes it from the Unread list while the chat stays open (also with the phone list-to-chat navigation).
- "New conversation" opens your friends list: only friends can be picked.
- Send, **edit** (shows an "Edited" label) and **delete** your own messages; changes appear instantly on both sides. Deleted messages show “Message deleted”. A Seen label tracks the most recent outgoing message viewed by the recipient.
- **Conversations from before the friends feature** are kept: they stay in the list (with a lock icon) and their history stays readable for both people. They are **not** turned into friendships automatically. The composer is disabled with "You must be friends to send messages." and a contextual **Add Friend**, **Cancel request** or **Accept / Decline** button; once a request is accepted it unlocks and the old history is still there. You can still edit or delete your own earlier messages.
- Enter sends, Shift+Enter inserts a new line. Message limit: 2000 characters.
- Online/offline status, empty states, loading skeletons and toast notifications.
- Conversations, friends and history are re-fetched from the database after a reconnect, so nothing is missed.
- Desktop layout has three sections (navigation rail, list panel, chat). On small screens the list and the chat become separate views with a bottom navigation bar.
