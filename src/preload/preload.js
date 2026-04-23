const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mailAPI', {
  // Account & Email Actions
  getEmails: (accountId) => ipcRenderer.invoke('get-emails', accountId),
  addService: (service) => ipcRenderer.send('add-service', service),
  openCompose: (accountId) => ipcRenderer.send('open-compose', accountId),
  sendEmail: (data) => ipcRenderer.invoke('send-email', data),
  openAddWindow: (isTutorial) => ipcRenderer.send('open-add-window', isTutorial),
  getComposeData: () => ipcRenderer.invoke('get-compose-data'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  showContextMenu: (data) => ipcRenderer.send('show-context-menu', data),
  updateAccountName: (data) => ipcRenderer.send('update-account-name', data),
  deleteAccount: (id) => ipcRenderer.send('delete-account', id),
  deleteEmail: (data) => ipcRenderer.invoke('delete-email', data),
  startOAuth: (provider) => ipcRenderer.send('start-oauth', provider),
  replyUpdate: (action) => ipcRenderer.send('update-response', action), // ADD THIS (for update.html)
  getEmails: (data) => ipcRenderer.invoke('get-emails', data),
  createFolder: (data) => ipcRenderer.invoke('create-folder', data),
  deleteFolder: (data) => ipcRenderer.invoke('delete-folder', data),
    
    // Add these two lines:
  getFolders: (accountId) => ipcRenderer.invoke('get-folders', accountId),
  syncFolder: (data) => ipcRenderer.invoke('sync-folder', data),

  // Window Controls
  closeApp: () => ipcRenderer.send('close-app'),
  minimizeApp: () => ipcRenderer.send('minimize-app'),
  maximizeApp: () => ipcRenderer.send('maximize-app'),
  
  // IPC Listeners
  onInitAccounts: (cb) => ipcRenderer.on('init-accounts', (e, accs) => cb(accs)),
  onNewAccount: (cb) => ipcRenderer.on('new-account', (e, acc) => cb(acc)),
  onAccountDeleted: (cb) => ipcRenderer.on('account-deleted', (e, id) => cb(id)),
  onAccountUpdated: (cb) => ipcRenderer.on('account-updated', (e, data) => cb(data)),
  onNewMailArrived: (cb) => ipcRenderer.on('new-mail-arrived', (e, accountId) => cb(accountId)),
})