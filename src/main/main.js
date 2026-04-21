// src/main/main.js
const { app, BrowserWindow, session, shell, ipcMain, Menu, MenuItem, safeStorage } = require('electron');
const path = require('path');
const nodemailer = require('nodemailer');
const fs = require('fs');
const windowStateKeeper = require('electron-window-state');
const { autoUpdater } = require('electron-updater');

// 1. CRITICAL: Set the V2 data path before ANYTHING else
app.setPath('userData', path.join(app.getPath('appData'), 'RYZE_V2_Data'));

const { initDB, db } = require('./db');
const { MailEngine } = require('./imap');

// --- PERFORMANCE OPTIMIZATIONS ---
app.disableHardwareAcceleration(); 
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512'); 
app.commandLine.appendSwitch('disable-background-timer-throttling');

const SERVICE_MAP = {
  'gmail': { name: 'Gmail', icon: 'mail' },
  'outlook': { name: 'Outlook/Hotmail', icon: 'alternate_email' },
  'icloud': { name: 'iCloud', icon: 'cloud' },
};

function isTrustedSender(sender) {
  try {
    return sender.getURL().startsWith('file://');
  } catch (e) {
    return false;
  }
}

let mainWindow;
const activeEngines = new Map();

function createWindow() {
  let state = windowStateKeeper({ defaultWidth: 1200, defaultHeight: 800 });
  mainWindow = new BrowserWindow({
    x: state.x, y: state.y, width: state.width, height: state.height,
    minWidth: 800,
    minHeight: 600,
    frame: false, backgroundColor: '#1c1c1e',
    icon: path.join(__dirname, '../assets/logo.ico'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  state.manage(mainWindow);
  mainWindow.loadFile(path.join(__dirname, '../renderer/pages/index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// --- V2 DATABASE IPC HANDLERS ---

const axios = require('axios'); // Add this at the top of main.js

// YOUR MICROSOFT KEYS (From Azure Portal)
const MS_CONFIG = {
  clientId: 'b32a0e59-d61f-4655-981c-a18266e0af4f',
  clientSecret: 'lyQ8Q~CridH2pYQSsDRKRVnSHusTXlkdk-djGak0',
  authority: 'https://login.microsoftonline.com/common/oauth2/v2.0',
  redirectUri: 'http://localhost'
};

// Inside src/main/main.js
ipcMain.on('start-oauth', async (event, provider) => {
  if (provider === 'outlook') {
    const authUrl = `${MS_CONFIG.authority}/authorize?` + 
      `client_id=${MS_CONFIG.clientId}` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(MS_CONFIG.redirectUri)}` +
      `&response_mode=query` +
      `&scope=${encodeURIComponent('openid profile email offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send')}` +
      `&prompt=select_account`;

    // 1. Updated Size: 550 x 750
    const authWin = new BrowserWindow({
      width: 550, 
      height: 750,
      frame: false,           
      resizable: false,
      alwaysOnTop: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        partition: 'auth-' + Date.now()
      }
    });

    // 2. Injecting a REAL Header and Close Button
    authWin.webContents.on('did-finish-load', () => {
      // Inject Styles for the Header and Red Close Button
      authWin.webContents.insertCSS(`
        #ryze-header {
          position: fixed; top: 0; left: 0; width: 100%; height: 44px;
          background: #1c1c1e; color: #0A84FF; z-index: 99999;
          display: flex; align-items: center; justify-content: center;
          font-family: -apple-system, sans-serif; font-size: 11px;
          font-weight: 800; letter-spacing: 1.5px;
          border-bottom: 1px solid rgba(255,255,255,0.1);
          -webkit-app-region: drag; /* Makes the bar draggable */
        }
        #ryze-close {
          position: absolute; left: 14px; top: 14px;
          width: 14px; height: 14px; background: #ff5f56;
          border-radius: 50%; cursor: pointer;
          -webkit-app-region: no-drag; /* Makes the button clickable */
          display: flex; align-items: center; justify-content: center;
          transition: background 0.2s;
        }
        #ryze-close:hover { background: #ff3b30; }
        #ryze-close::after { content: '✕'; color: rgba(0,0,0,0.5); font-size: 8px; opacity: 0; }
        #ryze-close:hover::after { opacity: 1; }
        body { padding-top: 44px !important; } /* Push MS content down */
      `);

      // Inject the HTML element and the Close Logic
      authWin.webContents.executeJavaScript(`
        if (!document.getElementById('ryze-header')) {
          const header = document.createElement('div');
          header.id = 'ryze-header';
          header.innerHTML = '<div id="ryze-close"></div>RYZE V2 SECURE LOGIN';
          document.body.appendChild(header);
          document.getElementById('ryze-close').onclick = () => window.close();
        }
      `);
    });

    authWin.loadURL(authUrl);

    // Keep the keyboard shortcut as a backup
    authWin.webContents.on('before-input-event', (e, input) => {
      if (input.key === 'Escape') authWin.close();
    });

    authWin.webContents.on('will-redirect', async (e, url) => {
      if (url.startsWith(MS_CONFIG.redirectUri)) {
        e.preventDefault();
        const urlParams = new URL(url).searchParams;
        const code = urlParams.get('code');
        if (code) {
          authWin.close();
          await exchangeCodeForTokens(code);
        }
      }
    });
  }
});

async function getValidAccessToken(accountId) {
  // 1. We MUST fetch the account here too, because this is a separate function scope!
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  
  if (!acc) return null;

  // 2. Check if the token is about to expire (within 5 minutes)
  if (acc.refresh_token && Date.now() > (acc.token_expiry - 300000)) {
    console.log(`Refreshing Microsoft Token for: ${acc.email}`);
    
    try {
      const response = await axios.post(`${MS_CONFIG.authority}/token`, 
        new URLSearchParams({
          client_id: MS_CONFIG.clientId,
          client_secret: MS_CONFIG.clientSecret, 
          refresh_token: acc.refresh_token,
          grant_type: 'refresh_token'
        })
      );

      const { access_token, expires_in } = response.data;
      const newExpiry = Date.now() + (expires_in * 1000);

      // Save the fresh token so we don't have to refresh again for another hour
      db.prepare('UPDATE accounts SET access_token = ?, token_expiry = ? WHERE id = ?')
        .run(access_token, newExpiry, accountId);
        
      return access_token;
    } catch (err) {
      console.error("Failed to refresh token:", err.response?.data || err.message);
      return acc.access_token; // Fallback to old token and hope for the best
    }
  }
  
  return acc.access_token;
}

async function exchangeCodeForTokens(code) {
  try {
    const response = await axios.post(`${MS_CONFIG.authority}/token`, 
      new URLSearchParams({
        client_id: MS_CONFIG.clientId,
        client_secret: MS_CONFIG.clientSecret,
        code: code,
        redirect_uri: MS_CONFIG.redirectUri,
        grant_type: 'authorization_code'
      })
    );

    // 1. Destructure id_token (this is the key for personal accounts!)
    const { access_token, refresh_token, id_token, expires_in } = response.data;
    
    // 2. Decode the ID Token instead of the Access Token
    // Personal accounts use Opaque access tokens which can't be split
    const tokenToDecode = id_token || access_token;
    if (!tokenToDecode.includes('.')) {
      throw new Error("Received an opaque token without identity claims. Ensure 'openid' scope is present.");
    }

    const userInfo = JSON.parse(Buffer.from(tokenToDecode.split('.')[1], 'base64').toString());
    const email = userInfo.email || userInfo.upn || userInfo.preferred_username;

    // 3. Save to Database (the rest of your logic is perfect)
    const accountId = `outlook-${Date.now()}`;
    db.prepare(`
      REPLACE INTO accounts (id, email, name, provider, access_token, refresh_token, token_expiry)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      accountId, 
      email, 
      'Outlook', 
      'outlook', 
      access_token, 
      refresh_token, 
      Date.now() + (expires_in * 1000)
    );

    mainWindow.webContents.send('new-account', { id: accountId, name: 'Outlook', icon: 'alternate_email' });
    initAccountEngine(accountId);

  } catch (error) {
    console.error('OAuth Token Exchange Failed:', error.response?.data || error.message);
  }
}


ipcMain.handle('delete-email', async (event, { id, account_id, uid, folder }) => {
  if (!isTrustedSender(event.sender)) return false;
  
  try {
    // 1. Delete from local SQLite Database instantly
    db.prepare('DELETE FROM emails WHERE id = ?').run(id);

    // 2. Tell the specific IMAP engine to delete it from the cloud IN THE BACKGROUND
    const engine = activeEngines.get(account_id);
    if (engine) {
      // Fire and forget so the UI updates instantly!
      engine.deleteEmailOnServer(uid, folder).catch(console.error);
    }

    return true;
  } catch (err) {
    console.error('Delete error:', err);
    return false;
  }
});

ipcMain.handle('get-emails', async (event, accountId) => {
  if (!isTrustedSender(event.sender)) return [];
  try {
    const stmt = db.prepare('SELECT * FROM emails WHERE account_id = ? ORDER BY date DESC');
    return stmt.all(accountId);
  } catch (error) {
    // 1. Log the full error to the terminal (Main process)
    console.error('Failed to fetch emails:', error);
    // 2. ONLY return a clean, clonable value to the UI (Renderer)
    return []; 
  }
});

ipcMain.on('add-service', async (event, data) => {
  if (!isTrustedSender(event.sender)) return; 
  if (!data || typeof data !== 'object') return;
  
  const { type, name, email, password } = data;
  const accountId = `${type}-${Date.now()}`;
  const icon = SERVICE_MAP[type] ? SERVICE_MAP[type].icon : 'mail';

  try {
    const encryptedToken = safeStorage.encryptString(password).toString('base64');
    const insertStmt = db.prepare(`
      INSERT INTO accounts (id, email, name, provider, encrypted_token) 
      VALUES (?, ?, ?, ?, ?)
    `);
    insertStmt.run(accountId, email, name, type, encryptedToken);

    const isMicrosoft = (type === 'outlook' || email.includes('@hotmail') || email.includes('@live'));

    const engine = new MailEngine({
      id: accountId,
      email: email,
      type: type,
      password: password,
      // FIX: Force the modern O365 host for all Microsoft-based emails
      host: isMicrosoft ? 'outlook.office365.com' : (type === 'gmail' ? 'imap.gmail.com' : 'imap.mail.me.com'),
      port: 993
    });
    
    activeEngines.set(accountId, engine); // Don't forget to store it in our active map!

    console.log(`Connecting to new account: ${email}`);
    
    try {
      // 1. Establish the connection FIRST
      await engine.client.connect(); 
      
      // 2. Once connected, perform the initial sync
      console.log(`Starting initial sync for: ${email}`);
      await engine.syncFolder('INBOX');
      
      // 3. Start listening for new live emails
      engine.startLiveListener(mainWindow);

      // 4. Tell the UI to add the button
      mainWindow.webContents.send('new-account', { id: accountId, name: name, icon: icon });
    } catch (connErr) {
      console.error(`Failed to connect to ${email}:`, connErr.message);
      // Optional: send an error back to the UI so the user knows it failed
    }

  } catch (error) {
    console.error('Failed to add service:', error.message);
  }
});

ipcMain.on('delete-account', (event, id) => {
  if (!isTrustedSender(event.sender)) return;
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  
  // Safely log out and stop the background sync engine so it doesn't keep running!
  const engine = activeEngines.get(id);
  if (engine) {
    if (engine.client) engine.client.logout().catch(() => {});
    activeEngines.delete(id);
  }
  
  mainWindow.webContents.send('account-deleted', id);
});

ipcMain.on('update-account-name', (event, { id, newName }) => {
  if (!isTrustedSender(event.sender)) return;
  const safeName = newName.substring(0, 50);
  db.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(safeName, id);
  mainWindow.webContents.send('account-updated', { id, newName: safeName });
});

// --- EMAIL SENDING (SMTP) ---


// Add priority to the incoming arguments
ipcMain.handle('send-email', async (event, { accountId, to, subject, body, priority }) => {
  if (!isTrustedSender(event.sender)) return false;
  
  try {
    // 1. Fetch EVERYTHING we need from the database, especially the new tokens!
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!acc) throw new Error("No account found for sending");
    
    let authConfig = {};

    // 2. Determine if we use OAuth2 (Microsoft) or Password (Gmail/Legacy)
    if (acc.access_token) {
      // For Microsoft: Get a fresh token before we even try to send
      const freshToken = await getValidAccessToken(accountId);
      authConfig = {
        type: 'OAuth2',
        user: acc.email,
        clientId: MS_CONFIG.clientId,
        clientSecret: MS_CONFIG.clientSecret,
        refreshToken: acc.refresh_token,
        accessToken: freshToken
      };
    } else {
      // For Gmail/Legacy: Use the encrypted password
      const password = safeStorage.decryptString(Buffer.from(acc.encrypted_token, 'base64'));
      authConfig = {
        user: acc.email,
        pass: password
      };
    }

    // 3. Create the Transporter
    const transporter = nodemailer.createTransport({
      // Use the specific Outlook/Office365 service for Microsoft accounts
      host: (acc.provider === 'outlook') ? 'smtp.office365.com' : undefined,
      port: (acc.provider === 'outlook') ? 587 : undefined,
      secure: false, // TLS
      service: (acc.provider !== 'outlook') ? acc.provider : undefined,
      auth: authConfig,
      tls: {
        ciphers: 'SSLv3',
        rejectUnauthorized: false // Helps avoid handshake issues on some networks
      }
    });

    // 4. Send the Mail
    await transporter.sendMail({ 
      from: acc.email, 
      to, 
      subject, 
      html: body,
      priority: priority || 'normal'
    });

    console.log(`Email sent successfully from ${acc.email}`);
    return true;
  } catch (error) {
    console.error('SMTP Error:', error.message);
    return false;
  }
});

// The compose window will call this immediately when it opens
ipcMain.handle('get-compose-data', () => {
  return currentComposeData;
});



// --- UI / WINDOW CONTROLS ---

ipcMain.on('show-context-menu', (event, { id, name }) => {
  if (!isTrustedSender(event.sender)) return; 
  const template = [
    { 
      label: 'Rename Inbox', 
      click: () => {
        const win = new BrowserWindow({ width: 450, height: 360, frame: false, transparent: true, webPreferences: { preload: path.join(__dirname, '../preload/preload.js'), contextIsolation: true } });
        win.loadFile(path.join(__dirname, '../renderer/pages/rename.html'), { query: { id, name } });
      }
    },
    { type: 'separator' },
    { 
      label: 'Delete Inbox', 
      click: () => {
        const win = new BrowserWindow({ width: 450, height: 360, frame: false, transparent: true, webPreferences: { preload: path.join(__dirname, '../preload/preload.js'), contextIsolation: true } });
        win.loadFile(path.join(__dirname, '../renderer/pages/delete.html'), { query: { id, name } });
      }
    }
  ];
  Menu.buildFromTemplate(template).popup(BrowserWindow.fromWebContents(event.sender));
});

ipcMain.on('open-external', (event, url) => shell.openExternal(url));
ipcMain.on('close-app', () => app.quit());
ipcMain.on('minimize-app', () => mainWindow?.minimize());
ipcMain.on('maximize-app', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize());

ipcMain.on('open-add-window', (event, isTutorial = false) => {
  const addWin = new BrowserWindow({
    width: 450, height: 500, parent: mainWindow, modal: true, frame: false, transparent: true,
    webPreferences: { preload: path.join(__dirname, '../preload/preload.js'), contextIsolation: true }
  });
  addWin.loadFile(path.join(__dirname, '../renderer/pages/add.html'), { query: { tutorial: String(isTutorial) } });
});



// --- NEW: The Missing Engine Initializer ---
async function initAccountEngine(accountId) {
  try {
    // 1. Declare 'acc' by fetching it from the database
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    
    if (!acc) {
      console.error(`Account not found in database: ${accountId}`);
      return;
    }

    let authPayload = {};
    
    // 2. Check for OAuth (Microsoft) vs Password (Gmail)
    // We check for access_token because that's what we saved in the OAuth flow
    if (acc.access_token) {
      const token = await getValidAccessToken(accountId);
      authPayload = { access_token: token };
    } else if (acc.encrypted_token) {
      // Use the older password-based method for Gmail/iCloud
      const pass = safeStorage.decryptString(Buffer.from(acc.encrypted_token, 'base64'));
      authPayload = { password: pass };
    }

    // 3. Initialize the IMAP Engine
    const engine = new MailEngine({
      ...acc,
      ...authPayload,
      host: (acc.provider === 'outlook' || acc.email.includes('hotmail')) 
            ? 'outlook.office365.com' 
            : (acc.provider === 'gmail' ? 'imap.gmail.com' : 'imap.mail.me.com'),
      port: 993
    });

    // 4. Store in the active map so we can delete/send emails later
    activeEngines.set(accountId, engine);

    // 5. Connect and start syncing
    await engine.client.connect();
    console.log(`Successfully connected: ${acc.email}`);
    
    await engine.syncFolder('INBOX');
    engine.startLiveListener(mainWindow);

  } catch (err) {
    // This is where your current error is being logged
    console.error(`Failed to start engine for ${accountId}:`, err.message);
  }
}


// --- APP LIFECYCLE & AUTO-UPDATER ---

app.whenReady().then(() => {
  initDB();
  createWindow();

 mainWindow.webContents.on('did-finish-load', async () => {
  try {
    // 1. Get all saved accounts
    const accounts = db.prepare('SELECT id, name, provider as type, email FROM accounts').all();
    
    // 2. Map them for the Sidebar UI
    const formattedAccounts = accounts.map(account => ({
      ...account,
      icon: SERVICE_MAP[account.type]?.icon || 'mail'
    }));
    
    // 3. Send to UI
    mainWindow.webContents.send('init-accounts', formattedAccounts);

    // 4. Start the backend engines
    for (const account of accounts) {
      // Pass only the ID; the function handles the rest
      await initAccountEngine(account.id);
    }
    
  } catch (err) {
    console.error("Startup Sync Error:", err);
  }
});

  // Keep the auto-updater alive!
  autoUpdater.autoDownload = false;
  autoUpdater.checkForUpdates();
}); // Closes app.whenReady

// Auto-Updater Listeners
autoUpdater.on('update-available', (info) => showUpdateWindow('available', info.version));
autoUpdater.on('update-downloaded', () => showUpdateWindow('downloaded'));

function showUpdateWindow(state, version = '') {
  const updateWin = new BrowserWindow({ width: 450, height: 360, parent: mainWindow, modal: true, frame: false, transparent: true });
  updateWin.loadFile(path.join(__dirname, '../renderer/pages/update.html'), { query: { state, version } });
}

ipcMain.on('update-response', (event, action) => {
  if (action === 'download') autoUpdater.downloadUpdate();
  else if (action === 'restart') autoUpdater.quitAndInstall();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
