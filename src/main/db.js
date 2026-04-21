const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs'); // <-- Add the file system module
const { app } = require('electron');

// 1. Get the path we set in main.js
const userDataPath = app.getPath('userData');

// 2. CRITICAL FIX: Create the directory if it doesn't exist yet!
if (!fs.existsSync(userDataPath)) {
  fs.mkdirSync(userDataPath, { recursive: true });
}

// 3. Now it is safe to create the database file
const dbPath = path.join(userDataPath, 'ryze_v2.db');
const db = new Database(dbPath);

function initDB() {
  db.pragma('journal_mode = WAL');

  // 1. Create the tables if they are totally missing
  db.prepare(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      provider TEXT,
      encrypted_token TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // 2. MIGRATION: Add the OAuth columns if they don't exist yet
  const columnsToAdd = [
    "ALTER TABLE accounts ADD COLUMN access_token TEXT",
    "ALTER TABLE accounts ADD COLUMN refresh_token TEXT",
    "ALTER TABLE accounts ADD COLUMN token_expiry INTEGER"
  ];

  columnsToAdd.forEach(cmd => {
    try {
      db.prepare(cmd).run();
    } catch (err) {
      // If column already exists, SQLite throws an error. We just ignore it!
    }
  });

  // 3. Create/Update Emails Table
  db.prepare(`
    CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      uid INTEGER NOT NULL,
      subject TEXT,
      sender TEXT,
      recipient TEXT,
      date DATETIME,
      snippet TEXT,
      body_html TEXT,
      folder TEXT DEFAULT 'INBOX',
      priority TEXT DEFAULT 'normal',
      is_read INTEGER DEFAULT 0,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    )
  `).run();

  console.log('RYZE V2 Database initialized and migrated.');
}

module.exports = { initDB, db };