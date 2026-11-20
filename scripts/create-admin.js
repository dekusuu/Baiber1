/**
 * Creates an administrator account. Administrators are never created from the website.
 *
 *   npm run admin:create -- <username>
 *
 * The password is typed at a hidden prompt. For scripted use you can set ADMIN_PASSWORD instead.
 * An administrator manages users and billing; it cannot chat and never appears in friend search.
 * To make a new admin you always create a NEW account (an existing chat account is never converted,
 * so its friends and message history are not affected).
 */
require('dotenv').config({ quiet: true });
const readline = require('node:readline');
const { Writable } = require('node:stream');
const bcrypt = require('bcryptjs');
const pool = require('../database');
const userModel = require('../models/userModel');

const ROUNDS = Math.min(Math.max(Number(process.env.BCRYPT_ROUNDS) || 10, 4), 15);

/** Asks one question; with { hidden: true } the typed characters are not echoed. */
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    let muted = false;
    // readline needs a real stream here (in a terminal it subscribes to its events), so use a Writable
    // that forwards everything to the screen except while a password is being typed.
    const output = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) process.stdout.write(chunk, encoding);
        callback();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
    let answered = false;
    rl.once('close', () => { if (!answered) resolve(''); }); // input ended (Ctrl+D / closed pipe): do not hang
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
    muted = hidden; // set after the question text has been written
  });
}

async function main() {
  const username = (process.argv[2] || '').trim();
  if (!username) {
    console.error('Usage: npm run admin:create -- <username>');
    process.exitCode = 1;
    return;
  }

  const usernameError = userModel.validateUsername(username);
  if (usernameError) throw new Error(usernameError);
  if (await userModel.findByUsername(username)) throw new Error(`The username "${username}" is already taken.`);

  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = await ask('Password (hidden): ', { hidden: true });
    const confirm = await ask('Confirm password: ', { hidden: true });
    if (password !== confirm) throw new Error('Passwords do not match.');
  }
  const passwordError = userModel.validatePassword(password);
  if (passwordError) throw new Error(passwordError);

  await userModel.create({
    username,
    passwordHash: await bcrypt.hash(password, ROUNDS),
    role: 'admin',
  });
  console.log(`Administrator "${username}" created. Sign in at /login; you will land on /admin.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
}).finally(() => pool.end());
