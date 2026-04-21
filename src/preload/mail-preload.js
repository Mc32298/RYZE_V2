// src/preload/mail-preload.js

const { contextBridge, ipcRenderer } = require('electron');

// Expose only necessary functions to the mail view renderer
contextBridge.exposeInMainWorld('mailAPI', {
  // Wraps the custom hover link IPC for consistent API exposure
  sendHoverLink: (url) => ipcRenderer.send('custom-hover-link', url)
});

// Internal event listeners for link hovering behavior
document.addEventListener('mouseover', (event) => {
  const link = event.target.closest('a');
  if (link && link.href) {
    ipcRenderer.send('custom-hover-link', link.href);
  }
});

document.addEventListener('mouseout', (event) => {
  const link = event.target.closest('a');
  if (link) {
    ipcRenderer.send('custom-hover-link', '');
  }
});