// src/main/main.js
// =============================================================================
// SECURITY HARDENED - See SECURITY.md for a full list of fixes applied
// =============================================================================

require('dotenv').config();
const {
  app, BrowserWindow, shell, ipcMain, Menu, safeStorage
} = require('electron');
const path    = require('path');
const crypto  = require('crypto');   // Built-in Node module — used for PKCE
const fs      = require('fs');
const nodemailer = require('nodemailer');
const windowStateKeeper = require('electron-window-state');
const { autoUpdater }   = require('electron-updater');
const axios             = require('axios');

// ─── IMPORTANT: jwks-rsa and jsonwebtoken must be installed ──────────────────
// Run:  npm install jwks-rsa jsonwebtoken
// ─────────────────────────────────────────────────────────────────────────────
const jwksClient = require('jwks-rsa');
const jwt        = require('jsonwebtoken');

// 1. Set the userData path BEFORE anything else touches the filesystem
app.setPath('userData', path.join(app.getPath('appData'), 'RYZE_V2_Data'));

const { initDB, db } = require('./db');
const { MailEngine } = require('./imap');

// --- Performance switches ---
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// =============================================================================
// CONSTANTS
// =============================================================================

const SERVICE_MAP = {
  gmail:   { name: 'Gmail',            icon: 'mail'            },
  outlook: { name: 'Outlook/Hotmail',  icon: 'alternate_email' },
  icloud:  { name: 'iCloud',           icon: 'cloud'           },
};

// Shared webPreferences applied to EVERY popup window (rename, delete, add, update).
// sandbox: true is now consistent across the whole app.
const POPUP_WEB_PREFS = {
  preload:          path.join(__dirname, '../preload/preload.js'),
  contextIsolation: true,
  sandbox:          true,
  nodeIntegration:  false,
};

// =============================================================================
// SECURITY HELPER — isTrustedSender
// Rejects any IPC message that did not originate from our own file:// pages.
// This prevents a hypothetical compromised third-party web page (loaded in a
// BrowserView etc.) from invoking privileged main-process actions.
// =============================================================================
function isTrustedSender(sender) {
  try {
    return sender.getURL().startsWith('file://');
  } catch {
    return false;
  }
}

// =============================================================================
// MICROSOFT OAUTH 2.0  +  PKCE
// =============================================================================
// WHY NO CLIENT SECRET?
//   Desktop apps are "public clients" — the binary is on the user's machine,
//   so any secret embedded in it can be extracted.  Microsoft requires PKCE
//   for public clients instead of a client secret.
//   Azure portal: set "Mobile and desktop applications" as platform type.
//
// HOW PKCE WORKS (short version):
//   1. We generate a random `code_verifier` (lives in memory only).
//   2. We hash it → `code_challenge` and include it in the auth URL.
//   3. Microsoft stores the challenge.
//   4. We send the verifier (not the challenge) during token exchange.
//   5. Microsoft re-hashes it and checks it matches — proving WE started the flow.
//   No secret ever leaves memory or hits the database.
// =============================================================================

const MS_CONFIG = {
  // Only the client ID is needed — NO client secret
  clientId:    process.env.AZURE_CLIENT_ID,
  authority:   'https://login.microsoftonline.com/common/oauth2/v2.0',
  redirectUri: 'http://localhost',
};

// Held in memory only for the duration of a single OAuth round-trip
let pkceVerifier = null;

/** Generates a PKCE verifier + SHA-256 challenge pair. */
function generatePKCE() {
  const verifier  = crypto.randomBytes(64).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// =============================================================================
// JWT VERIFICATION — Microsoft ID Tokens
// =============================================================================
// Why verify?  An attacker who can intercept the redirect could theoretically
// craft a token with a different email address.  Signature verification using
// Microsoft's published public keys (JWKS) closes that door.
// =============================================================================

const msJwksClient = jwksClient({
  jwksUri:     'https://login.microsoftonline.com/common/discovery/v2.0/keys',
  cache:       true,
  cacheMaxAge: 86_400_000, // 24 hours — refreshes daily so key rotations are picked up
});

function getSigningKey(header) {
  return new Promise((resolve, reject) => {
    msJwksClient.getSigningKey(header.kid, (err, key) => {
      if (err) return reject(new Error(`JWKS lookup failed: ${err.message}`));
      resolve(key.getPublicKey());
    });
  });
}

/** Verifies a Microsoft-issued ID token; returns the decoded payload or throws. */
async function verifyMicrosoftIdToken(idToken) {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded) throw new Error('Cannot decode ID token');

  const publicKey = await getSigningKey(decoded.header);

  // jwt.verify throws if signature, expiry, issuer, or audience checks fail
  return jwt.verify(idToken, publicKey, {
    algorithms: ['RS256'],
    audience:   MS_CONFIG.clientId,
    // Microsoft uses different issuer formats for personal vs work accounts
    issuer: [
      `https://login.microsoftonline.com/${decoded.payload.tid}/v2.0`,
      `https://sts.windows.net/${decoded.payload.tid}/`,
    ],
  });
}

// =============================================================================
// OAUTH IPC HANDLER
// =============================================================================
ipcMain.on('start-oauth', (event, provider) => {
  if (!isTrustedSender(event.sender)) return; // FIX: was missing

  if (provider === 'outlook') {
    const { verifier, challenge } = generatePKCE();
    pkceVerifier = verifier; // Memory only — never written to disk

    const authUrl =
      `${MS_CONFIG.authority}/authorize?` +
      `client_id=${MS_CONFIG.clientId}` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(MS_CONFIG.redirectUri)}` +
      `&response_mode=query` +
      `&scope=${encodeURIComponent('openid profile email offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send')}` +
      `&code_challenge=${challenge}` +       // PKCE
      `&code_challenge_method=S256` +        // PKCE
      `&prompt=select_account`;

    // FIX: Use a plain framed window — no executeJavaScript injection into
    //      Microsoft's login page.  The OS window chrome is trusted enough.
    const authWin = new BrowserWindow({
      width:      550,
      height:     750,
      resizable:  false,
      alwaysOnTop: true,
      title:      'RYZE V2 — Sign in with Microsoft',
      backgroundColor: '#ffffff',
      webPreferences: {
        // Isolated session so the Microsoft cookie stays separate from the app
        partition:        `auth-${Date.now()}`,
        contextIsolation: true,
        sandbox:          true,
        nodeIntegration:  false,
      },
    });

    authWin.setMenu(null); // No menu bar needed in a login popup

    authWin.webContents.on('before-input-event', (_e, input) => {
      if (input.key === 'Escape') authWin.close();
    });

    authWin.webContents.on('will-redirect', async (_e, url) => {
      if (url.startsWith(MS_CONFIG.redirectUri)) {
        _e.preventDefault();
        const code = new URL(url).searchParams.get('code');
        if (code) {
          authWin.close();
          await exchangeCodeForTokens(code);
        }
      }
    });

    authWin.loadURL(authUrl);
  }
});

// =============================================================================
// TOKEN EXCHANGE
// =============================================================================
async function exchangeCodeForTokens(code) {
  try {
    // PKCE: send code_verifier in place of client_secret
    const response = await axios.post(
      `${MS_CONFIG.authority}/token`,
      new URLSearchParams({
        client_id:     MS_CONFIG.clientId,
        code,
        redirect_uri:  MS_CONFIG.redirectUri,
        grant_type:    'authorization_code',
        code_verifier: pkceVerifier, // Proves we initiated this flow
      })
    );

    pkceVerifier = null; // Clear immediately after single use

    const { access_token, refresh_token, id_token, expires_in } = response.data;

    // FIX: Verify the ID token's cryptographic signature before trusting its claims
    const userInfo = await verifyMicrosoftIdToken(id_token);
    const email = userInfo.email || userInfo.upn || userInfo.preferred_username;
    if (!email) throw new Error('Verified token contains no email claim');

    // FIX: Encrypt BOTH tokens with safeStorage before writing to the database.
    //      Previously only Gmail passwords were encrypted; OAuth tokens were plain text.
    const encryptedAccess  = safeStorage.encryptString(access_token).toString('base64');
    const encryptedRefresh = safeStorage.encryptString(refresh_token).toString('base64');

    const accountId = `outlook-${Date.now()}`;
    db.prepare(`
      REPLACE INTO accounts (id, email, name, provider, access_token, refresh_token, token_expiry)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      accountId,
      email,
      'Outlook',
      'outlook',
      encryptedAccess,
      encryptedRefresh,
      Date.now() + expires_in * 1000
    );

    mainWindow?.webContents.send('new-account', {
      id:   String(accountId),
      name: 'Outlook',
      icon: 'alternate_email',
    });
    initAccountEngine(accountId);

  } catch (error) {
    const msg = error.response?.data
      ? JSON.stringify(error.response.data)
      : error.message;
    console.error('OAuth Token Exchange Failed:', msg);
    mainWindow?.webContents.send('oauth-error', 'Failed to sign in with Microsoft.');
  }
}

// =============================================================================
// TOKEN REFRESH
// =============================================================================
async function getValidAccessToken(accountId) {
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!acc) return null;

  // Refresh if the token expires in less than 5 minutes
  if (acc.refresh_token && Date.now() > acc.token_expiry - 300_000) {
    console.log(`Refreshing Microsoft token for: ${acc.email}`);
    try {
      // FIX: Decrypt the stored refresh token before sending it
      const refreshToken = safeStorage.decryptString(
        Buffer.from(acc.refresh_token, 'base64')
      );

      const response = await axios.post(
        `${MS_CONFIG.authority}/token`,
        new URLSearchParams({
          client_id:     MS_CONFIG.clientId,  // No client_secret — PKCE app
          refresh_token: refreshToken,
          grant_type:    'refresh_token',
        })
      );

      const { access_token, expires_in } = response.data;
      const newExpiry = Date.now() + expires_in * 1000;

      // FIX: Encrypt the new access token before storing
      const encryptedAccess = safeStorage.encryptString(access_token).toString('base64');
      db.prepare('UPDATE accounts SET access_token = ?, token_expiry = ? WHERE id = ?')
        .run(encryptedAccess, newExpiry, accountId);

      return access_token; // Return the plain token for in-memory use this session

    } catch (err) {
      console.error('Token refresh failed:', err.response?.data || err.message);
      // Fall through: try to decrypt and use the existing token
    }
  }

  // Decrypt the stored token for use
  try {
    return safeStorage.decryptString(Buffer.from(acc.access_token, 'base64'));
  } catch {
    console.error(`Failed to decrypt access token for account ${accountId}`);
    return null;
  }
}

// =============================================================================
// EMAIL IPC HANDLERS
// =============================================================================

ipcMain.handle('get-emails', async (event, accountId) => {
  if (!isTrustedSender(event.sender)) return [];
  try {
    return db
      .prepare('SELECT * FROM emails WHERE account_id = ? ORDER BY date DESC')
      .all(accountId)
      .map(row => ({ ...row }));
  } catch (err) {
    console.error('Failed to fetch emails:', err);
    return [];
  }
});

ipcMain.handle('delete-email', async (event, { id, account_id, uid, folder }) => {
  if (!isTrustedSender(event.sender)) return false;
  try {
    db.prepare('DELETE FROM emails WHERE id = ?').run(id);
    const engine = activeEngines.get(account_id);
    if (engine) engine.deleteEmailOnServer(uid, folder).catch(console.error);
    return true;
  } catch (err) {
    console.error('Delete error:', err);
    return false;
  }
});

ipcMain.on('add-service', async (event, data) => {
  if (!isTrustedSender(event.sender)) return;
  if (!data || typeof data !== 'object') return;

  const { type, name, email, password } = data;

  // Basic input sanity checks before touching the database
  if (!type || !email || !password) return;
  if (!SERVICE_MAP[type]) return; // Reject unknown provider types

  const accountId = `${type}-${Date.now()}`;
  const icon      = SERVICE_MAP[type].icon;

  try {
    const encryptedToken = safeStorage.encryptString(password).toString('base64');
    db.prepare(
      'INSERT INTO accounts (id, email, name, provider, encrypted_token) VALUES (?, ?, ?, ?, ?)'
    ).run(accountId, email, name, type, encryptedToken);

    const isMicrosoft = type === 'outlook' || email.includes('@hotmail') || email.includes('@live');
    const engine = new MailEngine({
      id: accountId, email, type, password,
      host: isMicrosoft
        ? 'outlook.office365.com'
        : type === 'gmail'
          ? 'imap.gmail.com'
          : 'imap.mail.me.com',
      port: 993,
    });

    activeEngines.set(accountId, engine);
    await engine.client.connect();
    await engine.syncFolder('INBOX');
    engine.startLiveListener(mainWindow);
    mainWindow?.webContents.send('new-account', { id: accountId, name, icon });

  } catch (err) {
    console.error('Failed to add service:', err.message);
  }
});

ipcMain.on('delete-account', (event, id) => {
  if (!isTrustedSender(event.sender)) return;
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  const engine = activeEngines.get(id);
  if (engine) {
    engine.client?.logout().catch(() => {});
    activeEngines.delete(id);
  }
  mainWindow?.webContents.send('account-deleted', id);
});

ipcMain.on('update-account-name', (event, { id, newName }) => {
  if (!isTrustedSender(event.sender)) return;
  // Trim and strip any HTML characters to prevent stored XSS in the sidebar label
  const safeName = (newName || '').replace(/[<>"'&]/g, '').substring(0, 50);
  db.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(safeName, id);
  mainWindow?.webContents.send('account-updated', { id, newName: safeName });
});

// =============================================================================
// EMAIL SENDING (SMTP)
// =============================================================================
ipcMain.handle('send-email', async (event, { accountId, to, subject, body, priority }) => {
  if (!isTrustedSender(event.sender)) return false;

  try {
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!acc) throw new Error('No account found for sending');

    let authConfig;

    if (acc.access_token) {
      // Microsoft — get a (possibly refreshed + decrypted) token
      const freshToken = await getValidAccessToken(accountId);
      authConfig = {
        type:     'OAuth2',
        user:     acc.email,
        clientId: MS_CONFIG.clientId,
        // FIX: No clientSecret — PKCE public clients don't use one
        accessToken: freshToken,
      };
    } else {
      // Gmail / iCloud — decrypt stored app password
      const password = safeStorage.decryptString(
        Buffer.from(acc.encrypted_token, 'base64')
      );
      authConfig = { user: acc.email, pass: password };
    }

    const transporter = nodemailer.createTransport({
      host:    acc.provider === 'outlook' ? 'smtp.office365.com' : undefined,
      port:    acc.provider === 'outlook' ? 587 : undefined,
      secure:  false,
      service: acc.provider !== 'outlook' ? acc.provider : undefined,
      auth:    authConfig,
      // FIX: Removed rejectUnauthorized:false (allowed MitM attacks) and
      //      the broken SSLv3 cipher string.  TLS 1.2+ only.
      tls: {
        minVersion:           'TLSv1.2',
        rejectUnauthorized:   true, // Always validate the server's certificate
      },
    });

    await transporter.sendMail({
      from:     acc.email,
      to,
      subject,
      html:     body,
      priority: priority || 'normal',
    });

    console.log(`Email sent from ${acc.email}`);
    return true;

  } catch (err) {
    console.error('Send email error:', err.message);
    return false; // FIX: Single return — removed unreachable duplicate
  }
});

ipcMain.handle('get-compose-data', () => currentComposeData);

// =============================================================================
// UI / WINDOW CONTROLS
// =============================================================================

ipcMain.on('show-context-menu', (event, { id, name }) => {
  if (!isTrustedSender(event.sender)) return;
  const template = [
    {
      label: 'Rename Inbox',
      click: () => {
        const win = new BrowserWindow({ width: 450, height: 360, frame: false, transparent: true, webPreferences: POPUP_WEB_PREFS });
        win.loadFile(path.join(__dirname, '../renderer/pages/rename.html'), { query: { id, name } });
      },
    },
    { type: 'separator' },
    {
      label: 'Delete Inbox',
      click: () => {
        const win = new BrowserWindow({ width: 450, height: 360, frame: false, transparent: true, webPreferences: POPUP_WEB_PREFS });
        win.loadFile(path.join(__dirname, '../renderer/pages/delete.html'), { query: { id, name } });
      },
    },
  ];
  Menu.buildFromTemplate(template).popup(BrowserWindow.fromWebContents(event.sender));
});

// FIX: Validate that the URL uses http(s) before handing it to the OS.
//      Without this, a crafted message could pass a file:// path or a
//      custom protocol handler to shell.openExternal().
ipcMain.on('open-external', (event, url) => {
  if (!isTrustedSender(event.sender)) return;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      shell.openExternal(url);
    } else {
      console.warn('open-external: blocked non-http URL:', url);
    }
  } catch {
    console.warn('open-external: blocked invalid URL:', url);
  }
});

// FIX: isTrustedSender added to all window control handlers (was missing)
ipcMain.on('close-app',    (event) => { if (!isTrustedSender(event.sender)) return; app.quit(); });
ipcMain.on('minimize-app', (event) => { if (!isTrustedSender(event.sender)) return; mainWindow?.minimize(); });
ipcMain.on('maximize-app', (event) => {
  if (!isTrustedSender(event.sender)) return;
  mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize();
});

ipcMain.on('open-add-window', (event, isTutorial = false) => {
  if (!isTrustedSender(event.sender)) return; // FIX: was missing
  const addWin = new BrowserWindow({
    width: 450, height: 500, parent: mainWindow, modal: true,
    frame: false, transparent: true,
    webPreferences: POPUP_WEB_PREFS, // FIX: uses shared secure prefs (sandbox: true)
  });
  addWin.loadFile(
    path.join(__dirname, '../renderer/pages/add.html'),
    { query: { tutorial: String(isTutorial) } }
  );
});

// FIX: isTrustedSender added; was missing
ipcMain.on('update-response', (event, action) => {
  if (!isTrustedSender(event.sender)) return;
  if (action === 'download') autoUpdater.downloadUpdate();
  else if (action === 'restart') autoUpdater.quitAndInstall();
});

// =============================================================================
// ACCOUNT ENGINE INITIALIZER
// =============================================================================
let mainWindow;
const activeEngines = new Map();

async function initAccountEngine(accountId) {
  try {
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!acc) { console.error(`Account not found: ${accountId}`); return; }

    let authPayload = {};
    if (acc.access_token) {
      // getValidAccessToken handles decryption + optional refresh
      const token = await getValidAccessToken(accountId);
      authPayload = { access_token: token };
    } else if (acc.encrypted_token) {
      const pass = safeStorage.decryptString(Buffer.from(acc.encrypted_token, 'base64'));
      authPayload = { password: pass };
    }

    const engine = new MailEngine({
      ...acc,
      ...authPayload,
      host: acc.provider === 'outlook' || acc.email.includes('hotmail')
            ? 'outlook.office365.com'
            : acc.provider === 'gmail'
              ? 'imap.gmail.com'
              : 'imap.mail.me.com',
      port: 993,
    });

    activeEngines.set(accountId, engine);
    await engine.client.connect();
    console.log(`Connected: ${acc.email}`);
    await engine.syncFolder('INBOX');
    engine.startLiveListener(mainWindow);

  } catch (err) {
    console.error(`Failed to start engine for ${accountId}:`, err.message);
  }
}

function createWindow() {
  const state = windowStateKeeper({ defaultWidth: 1200, defaultHeight: 800 });
  mainWindow = new BrowserWindow({
    x: state.x, y: state.y,
    width:  state.width,
    height: state.height,
    minWidth:  800,
    minHeight: 600,
    frame: false,
    backgroundColor: '#1c1c1e',
    icon: path.join(__dirname, '../assets/logo.ico'),
    webPreferences: {
      preload:          path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox:          true,
      nodeIntegration:  false,
    },
  });

  state.manage(mainWindow);
  mainWindow.loadFile(path.join(__dirname, '../renderer/pages/index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// =============================================================================
// APP LIFECYCLE & AUTO-UPDATER
// =============================================================================
app.whenReady().then(() => {
  initDB();
  createWindow();

  mainWindow.webContents.on('did-finish-load', async () => {
    try {
      const accounts = db
        .prepare('SELECT id, name, provider as type, email FROM accounts')
        .all();

      const formattedAccounts = accounts.map(account => ({
        ...account,
        icon: SERVICE_MAP[account.type]?.icon || 'mail',
      }));

      mainWindow.webContents.send('init-accounts', formattedAccounts);

      for (const account of accounts) {
        await initAccountEngine(account.id);
      }
    } catch (err) {
      console.error('Startup Sync Error:', err);
    }
  });

  autoUpdater.autoDownload = false;
  autoUpdater.checkForUpdates();
});

autoUpdater.on('update-available',  (info) => showUpdateWindow('available', info.version));
autoUpdater.on('update-downloaded', ()     => showUpdateWindow('downloaded'));

function showUpdateWindow(state, version = '') {
  // FIX: Previously had no webPreferences at all — window.mailAPI would be
  //      undefined so the buttons in update.html would silently fail.
  const updateWin = new BrowserWindow({
    width: 450, height: 360, parent: mainWindow, modal: true,
    frame: false, transparent: true,
    webPreferences: POPUP_WEB_PREFS, // FIX: includes preload + sandbox
  });
  updateWin.loadFile(
    path.join(__dirname, '../renderer/pages/update.html'),
    { query: { state, version } }
  );
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});