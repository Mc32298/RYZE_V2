// src/main/imap.js
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { db } = require('./db');

class MailEngine {
  constructor(account) {
    this.account = account;
    
    // --- NEW: Queue System State ---
    this.actionQueue = [];
    this.isProcessingQueue = false;
    
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

  // --- NEW: The Queue Processor ---
  async processQueue() {
    // If we are already chewing through the queue, don't start a duplicate loop
    if (this.isProcessingQueue) return; 
    this.isProcessingQueue = true;

    while (this.actionQueue.length > 0) {
      try {
        // 1. SELF-HEALING: If the server kicked us, reconnect before trying the next action!
        if (!this.client.usable) {
          console.log(`Connection dropped for ${this.account.email}. Reconnecting...`);
          await this.client.connect();
        }

        // 2. Peek at the first action (Notice we use [0] instead of .shift()!)
        const action = this.actionQueue[0];
        
        // 3. Attempt the action
        await action();

        // 4. SUCCESS! Now we can safely remove it from the line
        this.actionQueue.shift();
        
        // 5. Increased cooldown to 500ms to be even gentler on strict servers
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (err) {
        console.error("Queue action failed or dropped:", err.message);
        
        // FAILURE! The server is angry or disconnected. 
        // We DO NOT shift() the array, meaning this exact email will be retried.
        // Wait 2 full seconds to let the server cool down before the loop restarts.
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Queue is empty, go back to sleep
    this.isProcessingQueue = false;
  }

  async syncFolder(folderName = 'INBOX') {
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
          this.saveEmailToDb(message.uid, parsed, folderName, message.flags); 
        }
      }
    } finally {
      lock.release();
    }
  }

  async startLiveListener(mainWindow) {
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
    const provider = this.account.provider || this.account.type;
    switch (provider) {
      case 'gmail':
        return '[Gmail]/Trash';
      case 'outlook':
        return 'Deleted Items';
      case 'icloud':
        return 'Deleted Messages';
      default:
        return 'Trash'; 
    }
  }

  // --- UPGRADED: Propagates connection errors so the queue can retry ---
  deleteEmailOnServer(uid, folder = 'INBOX') {
    const deleteAction = async () => {
      const trashFolder = this.getTrashFolderName();
      
      // If the connection is dead, this will immediately throw an error up to the queue
      let lock = await this.client.getMailboxLock(folder);
      
      try {
        await this.client.messageMove(uid, trashFolder, { uid: true });
        console.log(`Moved email UID ${uid} from '${folder}' to '${trashFolder}'.`);
      } catch (moveErr) {
        // CRITICAL: If it's a network drop, THROW it so the queue knows to pause and retry!
        if (moveErr.message.includes('Connection') || !this.client.usable) {
          throw moveErr; 
        }
        
        // If it's just a missing folder error, use the fallback flag
        console.log(`Trash folder missing, falling back to IMAP \\Deleted flag.`);
        await this.client.messageFlagsAdd(uid, ['\\Deleted'], { uid: true });
      } finally {
        lock.release(); // Always release the folder lock!
      }
    };

    // Add it to the back of the line
    this.actionQueue.push(deleteAction);
    
    // Kick off the processor
    this.processQueue();
  }

  saveEmailToDb(uid, parsedEmail, folder, flags = []) {
    const checkStmt = db.prepare('SELECT id FROM emails WHERE account_id = ? AND uid = ? AND folder = ?');
    if (checkStmt.get(this.account.id, uid, folder)) return;

    let emailPriority = parsedEmail.priority || 'normal';
    
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