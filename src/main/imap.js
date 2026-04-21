// src/main/imap.js
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { db } = require('./db');

class MailEngine {
  constructor(account) {
    this.account = account;
    
    const authConfig = account.access_token 
      ? { user: account.email, accessToken: account.access_token } // OAuth Mode
      : { user: account.email, pass: account.password };           // Password Mode

    this.client = new ImapFlow({
      host: account.host,
      port: 993,
      secure: true,
      auth: authConfig,
      logger: false
    });
  }

  async syncFolder(folderName = 'INBOX') {
  // NEW: Safety check to prevent "Command failed" on an unready connection
  if (!this.client.authenticated) {
    console.log(`Postponing sync for ${this.account.email}: Not yet authenticated.`);
    return;
  }
    
    let lock = await this.client.getMailboxLock(folderName);
    try {
      let totalMessages = this.client.mailbox.exists;
      if (totalMessages > 0) {
        let startSeq = Math.max(1, totalMessages - 29); 
        const messages = this.client.fetch(`${startSeq}:*`, { source: true, uid: true });

        for await (let message of messages) {
          const parsed = await simpleParser(message.source);
          // Pass message.flags as a new 4th argument
          this.saveEmailToDb(message.uid, parsed, folderName, message.flags); 
        }
      }
    } finally {
      lock.release();
    }
  }

  async startLiveListener(mainWindow) {
    // REMOVED: The connect check here as well
    
    this.client.on('exists', async (data) => {
      console.log(`New mail detected! Total: ${data.count}`);
      let lock = await this.client.getMailboxLock('INBOX');
      try {
        const message = await this.client.fetchOne(data.count, { source: true, uid: true });
        const parsed = await simpleParser(message.source);
        this.saveEmailToDb(message.uid, parsed, 'INBOX');
        
        if (mainWindow) {
          mainWindow.webContents.send('new-mail-arrived', this.account.id);
        }
      } finally {
        lock.release();
      }
    });

    try {
        await this.client.idle();
    } catch (e) {
        console.error("IDLE Error:", e.message);
    }
  }

  getTrashFolderName() {
    // The account object has `provider` from DB or `type` from initial creation
    const provider = this.account.provider || this.account.type;
    switch (provider) {
      case 'gmail':
        return '[Gmail]/Trash';
      case 'outlook':
        return 'Deleted Items';
      case 'icloud':
        return 'Deleted Messages';
      default:
        return 'Trash'; // A common default that works for many others
    }
  }

  async deleteEmailOnServer(uid, folder = 'INBOX') {
    if (!this.client.authenticated) return;
    try {
      const trashFolder = this.getTrashFolderName();

      // Ensure we are operating on the correct folder before moving
      let lock = await this.client.getMailboxLock(folder);
      try {
        // Use messageMove to move the email to the trash folder
        await this.client.messageMove(uid, trashFolder, { uid: true });
        console.log(`Moved email UID ${uid} from '${folder}' to '${trashFolder}'.`);
      } catch (moveErr) {
        // The ultimate safety net: If trash folder is missing, force the deletion flag
        console.log(`Trash folder missing, falling back to IMAP \\Deleted flag.`);
        await this.client.messageFlagsAdd(uid, ['\\Deleted'], { uid: true });
      } finally {
        lock.release();
      }
    } catch (err) {
      console.error(`Failed to delete email UID ${uid}:`, err.message);
    }
  }

    saveEmailToDb(uid, parsedEmail, folder, flags = []) {
    const checkStmt = db.prepare('SELECT id FROM emails WHERE account_id = ? AND uid = ? AND folder = ?');
    if (checkStmt.get(this.account.id, uid, folder)) return;

    // Check standard headers (Outlook/iCloud) OR Gmail's internal flag
    let emailPriority = parsedEmail.priority || 'normal';
    
    // If the server tells us it has the "Important" flag, force the UI to show it
    if (flags.includes('\\Important') || flags.includes('Important')) {
      emailPriority = 'high';
    }

    const insertStmt = db.prepare(`
      INSERT INTO emails (id, account_id, uid, subject, sender, recipient, date, snippet, body_html, folder, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const emailId = `${this.account.id}-${folder}-${uid}`;
    insertStmt.run(
      emailId, 
      this.account.id, 
      uid, 
      parsedEmail.subject || '(No Subject)', 
      parsedEmail.from?.text || 'Unknown', 
      parsedEmail.to?.text || 'Unknown', 
      parsedEmail.date?.toISOString() || new Date().toISOString(), 
      parsedEmail.text?.substring(0, 100) || '', 
      parsedEmail.html || parsedEmail.textAsHtml || parsedEmail.text || '',
      folder,
      emailPriority 
    );
  }
}

module.exports = { MailEngine };