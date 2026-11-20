CREATE DATABASE IF NOT EXISTS bai_ber CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE bai_ber;

-- role: 'user' chats and is billed; 'admin' manages users and billing and never chats.
-- Admins are created from the command line only:  npm run admin:create -- <username>
CREATE TABLE IF NOT EXISTS users (
  user_id INT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(24) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  role ENUM('user','admin') NOT NULL DEFAULT 'user',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS friendships (
  friendship_id INT PRIMARY KEY AUTO_INCREMENT,
  sender_id INT NOT NULL,
  receiver_id INT NOT NULL,
  status ENUM('pending','accepted','declined','cancelled') NOT NULL DEFAULT 'pending',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  active_low INT GENERATED ALWAYS AS (IF(status IN ('pending','accepted'), LEAST(sender_id,receiver_id), NULL)) VIRTUAL,
  active_high INT GENERATED ALWAYS AS (IF(status IN ('pending','accepted'), GREATEST(sender_id,receiver_id), NULL)) VIRTUAL,
  UNIQUE KEY active_pair (active_low, active_high),
  FOREIGN KEY (sender_id) REFERENCES users(user_id),
  FOREIGN KEY (receiver_id) REFERENCES users(user_id),
  CHECK (sender_id <> receiver_id)
) ENGINE=InnoDB;

-- chars_covered: how many characters of this message are already paid for (or were sent
-- before billing started). Editing a message only bills characters beyond this number.
CREATE TABLE IF NOT EXISTS messages (
  message_id INT PRIMARY KEY AUTO_INCREMENT,
  sender_id INT NOT NULL,
  receiver_id INT NOT NULL,
  content TEXT NOT NULL,
  sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  edited_at DATETIME NULL,
  deleted_at DATETIME NULL,
  chars_covered INT NOT NULL DEFAULT 0,
  INDEX conversation (sender_id,receiver_id,message_id),
  INDEX received (receiver_id,sender_id,message_id),
  FOREIGN KEY (sender_id) REFERENCES users(user_id),
  FOREIGN KEY (receiver_id) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS conversation_reads (
  user_id INT NOT NULL,
  peer_id INT NOT NULL,
  last_read_id INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id,peer_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (peer_id) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sessions (
  sid VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  sess TEXT NOT NULL,
  expires BIGINT NOT NULL,
  user_id INT NULL,
  INDEX (expires), INDEX (user_id)
) ENGINE=InnoDB;

-- Billing ledger: one row each time a user is charged (append-only, never edited or deleted).
-- Amounts are whole cents so there is no floating-point rounding. A user's balance is always
-- SUM(charges) - SUM(payments that are not voided); no running total is stored anywhere.
CREATE TABLE IF NOT EXISTS charges (
  charge_id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  message_id INT NOT NULL,
  kind ENUM('send','edit') NOT NULL,
  chars INT NOT NULL,
  amount_cents BIGINT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX user_time (user_id, created_at),
  INDEX by_message (message_id),
  INDEX by_time (created_at),
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (message_id) REFERENCES messages(message_id),
  CHECK (chars > 0 AND amount_cents >= 0)
) ENGINE=InnoDB;

-- Cash received face to face and recorded by an administrator. Rows are never edited or
-- deleted: a mistake is voided (with a reason) and, if needed, recorded again.
-- request_key stops a double-clicked form from recording the same payment twice.
CREATE TABLE IF NOT EXISTS payments (
  payment_id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  amount_cents BIGINT NOT NULL,
  paid_at DATETIME NOT NULL,
  note VARCHAR(255) NULL,
  recorded_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  request_key CHAR(32) NULL UNIQUE,
  voided_at DATETIME NULL,
  voided_by INT NULL,
  void_reason VARCHAR(255) NULL,
  INDEX user_paid (user_id, paid_at),
  INDEX by_paid (paid_at),
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (recorded_by) REFERENCES users(user_id),
  FOREIGN KEY (voided_by) REFERENCES users(user_id),
  CHECK (amount_cents > 0)
) ENGINE=InnoDB;
