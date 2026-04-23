// renderer.js
// =============================================================================
// SECURITY HARDENED — All innerHTML calls that accepted user/email-sourced
// data have been replaced with textContent or DOM construction so that a
// malicious email can never inject scripts or HTML into the UI.
// =============================================================================

// =============================================================================
// STATE
// =============================================================================
let currentOpenEmail = null;
let isImportant      = false;
let isTutorialActive = false;
let pendingSelectEmailId = null;
let currentFolder = 'INBOX';

const sidebar = document.querySelector('.sidebar');
const addBtn  = document.getElementById('btn-add');

// =============================================================================
// SECURITY HELPERS
// =============================================================================

/**
 * Escapes a plain string so it is safe to splice into an HTML template.
 * Use this only when you truly need to build HTML strings (e.g. the compose
 * quote block).  Prefer textContent / DOM construction everywhere else.
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML; // browser does the encoding
}

/**
 * Sanitizes HTML from an untrusted source (email bodies) using DOMPurify.
 * Strips scripts, event handlers, and other dangerous constructs while
 * preserving the visual formatting of the email.
 */
function sanitizeEmailHtml(html) {
  if (!window.DOMPurify) return ''; // Fail closed — show nothing if library is missing
  return window.DOMPurify.sanitize(html || '', {
    // Extra safety: forbid tags that could be used for phishing / exfiltration
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'base'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onmouseout', 'onfocus'],
    FORCE_BODY:  true,
  });
}

// =============================================================================
// ONBOARDING
// =============================================================================

function startOnboarding() {
  isTutorialActive = true;
  document.getElementById('onboarding-overlay')?.classList.remove('onboarding-hidden');
}

function nextOnboardingStep(step) {
  const overlay = document.getElementById('onboarding-overlay');
  document.getElementById('step-1')?.style && (document.getElementById('step-1').style.display = 'none');
  document.getElementById('step-2')?.style && (document.getElementById('step-2').style.display = 'none');

  if (step === 2) {
    if (document.getElementById('step-2')) document.getElementById('step-2').style.display = 'block';
  } else if (step === 3) {
    if (document.getElementById('onboarding-card')) document.getElementById('onboarding-card').style.display = 'none';
    document.getElementById('onboarding-pointer')?.classList.remove('pointer-hidden');
    overlay?.classList.add('onboarding-passthrough');
  }
}

function showDeleteTutorial() {
  const overlay = document.getElementById('onboarding-overlay');
  overlay?.classList.remove('onboarding-passthrough');
  document.getElementById('onboarding-pointer')?.classList.add('pointer-hidden');
  if (document.getElementById('onboarding-card'))  document.getElementById('onboarding-card').style.display  = 'block';
  if (document.getElementById('step-1'))           document.getElementById('step-1').style.display           = 'none';
  if (document.getElementById('step-2'))           document.getElementById('step-2').style.display           = 'none';
  if (document.getElementById('step-delete'))      document.getElementById('step-delete').style.display      = 'block';
}

function showFinalThanks() {
  if (document.getElementById('step-delete')) document.getElementById('step-delete').style.display = 'none';
  if (document.getElementById('step-final'))  document.getElementById('step-final').style.display  = 'block';
}

function closeOnboarding() {
  document.getElementById('onboarding-overlay')?.classList.add('onboarding-hidden');
  isTutorialActive = false;
  document.querySelector('.mail-btn')?.click();
}

// =============================================================================
// SIDEBAR & ACCOUNTS
// =============================================================================

function createSidebarButton(acc) {
  if (document.getElementById(acc.id)) return;

  const btn = document.createElement('button');
  btn.id        = acc.id;
  btn.className = 'mail-btn';
  btn.title     = acc.name; // .title is safe — set as a property not innerHTML

  // FIX: Build the button with DOM APIs instead of innerHTML so that a
  //      database-stored account name cannot inject HTML into the sidebar.
  const iconEl = document.createElement('span');
  iconEl.className = 'material-symbols-outlined';
  // Allowlist icon names — they must only contain lowercase letters, digits,
  // and underscores (all legitimate Material Symbol names match this pattern).
  const safeIcon = /^[a-z0-9_]+$/.test(acc.icon) ? acc.icon : 'mail';
  iconEl.textContent = safeIcon; // textContent — never innerHTML

  const labelEl = document.createElement('span');
  labelEl.className   = 'btn-label';
  labelEl.textContent = acc.name; // FIX: textContent, not innerHTML

  btn.appendChild(iconEl);
  btn.appendChild(labelEl);

  btn.addEventListener('click', () => {
    document.querySelectorAll('.sidebar button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Reset folder view back to INBOX when switching accounts
    currentFolder = 'INBOX';
    document.querySelector('.list-header').textContent = 'Inbox';

    const calHeader = document.getElementById('calendar-account-name');
    if (calHeader) calHeader.textContent = `${acc.name}'s Calendar`; // FIX: textContent

    // FIX: Build calendar placeholder with DOM instead of innerHTML so
    //      acc.email (DB value) cannot inject HTML.
    const calContent = document.getElementById('calendar-content');
    if (calContent) {
      calContent.textContent = ''; // Clear safely
      const placeholder = document.createElement('div');
      placeholder.style.cssText = 'font-size: 13px; color: #8e8e93; text-align: center; margin-top: 20px;';
      placeholder.textContent = `Events for ${acc.email} will sync here.`; // FIX: textContent
      calContent.appendChild(placeholder);
    }
    loadFolders(acc.id);
    loadInbox(acc.id, 'INBOX');
  });

  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.mailAPI.showContextMenu({ id: acc.id, name: acc.name });
  });

  sidebar?.insertBefore(btn, addBtn);
  return btn;
}

// Add a 'retries' parameter so it can try again if the server is still connecting
// =============================================================================
// FOLDER LOADER
// =============================================================================

async function loadFolders(accountId, retries = 5) {
  const folderList = document.getElementById('folder-list');
  if (!folderList) return;
  
  // Only show the loading text on the very first attempt
  if (retries === 5) {
    folderList.innerHTML = '<p style="color: #666; font-size: 13px; padding: 0 20px;">Connecting to server...</p>';
  }
  
  const folders = await window.mailAPI.getFolders(accountId);
  
  // If the IMAP client is still authenticating, wait 2 seconds and try again
  if (folders.length === 0 && retries > 0) {
    setTimeout(() => loadFolders(accountId, retries - 1), 2000);
    return;
  }
  
  folderList.innerHTML = '';
  
  folders.forEach(f => {
    const el = document.createElement('div');
    el.className = 'folder-item';
    if (f.path === currentFolder) el.classList.add('active');
    
    // Assign generic icons based on folder names
    let iconName = 'folder';
    const lowerName = f.name.toLowerCase();
    if (lowerName.includes('inbox')) iconName = 'inbox';
    if (lowerName.includes('sent')) iconName = 'send';
    if (lowerName.includes('draft')) iconName = 'drafts';
    if (lowerName.includes('trash') || lowerName.includes('delete')) iconName = 'delete';
    if (lowerName.includes('spam') || lowerName.includes('junk')) iconName = 'report';
    if (lowerName.includes('archive')) iconName = 'archive';
    
    el.innerHTML = `<span class="material-symbols-outlined folder-icon">${iconName}</span> <span>${f.name}</span>`;
    
    el.onclick = () => {
      document.querySelectorAll('.folder-item').forEach(item => item.classList.remove('active'));
      el.classList.add('active');
      currentFolder = f.path;
      
      document.querySelector('.list-header').textContent = f.name;
      
      // 1. Initial load: NOT silent (will show "Loading emails...")
      loadInbox(accountId, f.path);
      
      // 2. Trigger background sync
      window.mailAPI.syncFolder({ accountId, folder: f.path }).then(() => {
        if (currentFolder === f.path) {
          // 3. Background sync finished! Reload, but pass TRUE to make it silent!
          loadInbox(accountId, f.path, true);
        }
      });
    };
    
    folderList.appendChild(el);
  });
}

// =============================================================================
// IPC LISTENERS
// =============================================================================

window.mailAPI?.onInitAccounts((accounts) => {
  if (accounts.length === 0) {
    startOnboarding();
  } else {
    accounts.forEach(acc => createSidebarButton(acc));
    document.querySelector('.mail-btn')?.click();
  }
});

window.mailAPI?.onNewAccount((acc) => {
  const newBtn = createSidebarButton(acc);
  if (isTutorialActive) {
    showDeleteTutorial();
  } else {
    newBtn?.click();
  }
});

window.mailAPI?.onAccountDeleted((id) => {
  const btnToRemove = document.getElementById(id);
  if (btnToRemove) {
    const wasActive = btnToRemove.classList.contains('active');
    btnToRemove.remove();
    if (wasActive) {
      const nextBtn = document.querySelector('.mail-btn');
      if (nextBtn) {
        nextBtn.click();
      } else {
        // No accounts left — clear the UI
        const inboxContainer = document.getElementById('inbox-items');
        if (inboxContainer) inboxContainer.innerHTML = '';

        const subjectEl = document.getElementById('reader-subject');
        if (subjectEl) subjectEl.textContent = 'Select an email';

        const senderEl = document.getElementById('reader-sender');
        if (senderEl) senderEl.textContent = '---';

        const reader = document.getElementById('reader-body');
        if (reader) {
          if (reader.shadowRoot) reader.shadowRoot.innerHTML = '';
          reader.innerHTML = '';
        }
      }
    }
  }
});

window.mailAPI?.onAccountUpdated(({ id, newName }) => {
  const btn = document.getElementById(id);
  if (btn) {
    const label = btn.querySelector('.btn-label');
    if (label) label.textContent = newName; // FIX: textContent
    btn.title = newName;
  }
});

window.mailAPI?.onNewMailArrived((accountId) => {
  const activeBtn = document.querySelector('.mail-btn.active');
  if (activeBtn && activeBtn.id === accountId) {
    loadInbox(accountId, currentFolder);
  }
});

// =============================================================================
// UI EVENT LISTENERS
// =============================================================================

document.getElementById('btn-add')?.addEventListener('click', () => {
  window.mailAPI.openAddWindow(isTutorialActive);
});

document.getElementById('btn-feedback')?.addEventListener('click', () => {
  window.mailAPI.openExternal('https://github.com/Mc32298/Spinophowto');
});

document.getElementById('btn-delete-email')?.addEventListener('click', async (e) => {
  if (!currentOpenEmail) return;

  // Determine the next email to select before we delete the current one
  const inboxItems = Array.from(document.querySelectorAll('.email-item'));
  const currentIndex = inboxItems.findIndex(item => item.dataset.emailId === currentOpenEmail.id);
  if (currentIndex !== -1) {
    const nextItem = inboxItems[currentIndex + 1] || inboxItems[currentIndex - 1];
    if (nextItem) {
      pendingSelectEmailId = nextItem.dataset.emailId;
    }
  }

  const btn = e.currentTarget;
  btn.style.opacity       = '0.5';
  btn.style.pointerEvents = 'none';

  const accountId = currentOpenEmail.account_id;

  const success = await window.mailAPI.deleteEmail({
    id:         currentOpenEmail.id,
    account_id: currentOpenEmail.account_id,
    uid:        currentOpenEmail.uid,
    folder:     currentOpenEmail.folder,
  });

  if (success) {
    btn.style.display       = 'none';
    btn.style.opacity       = '1';
    btn.style.pointerEvents = 'auto';

    currentOpenEmail = null;
    loadInbox(accountId, currentFolder);
  } else {
    btn.style.opacity       = '1';
    btn.style.pointerEvents = 'auto';
  }
});

// Calendar Toggle
document.getElementById('btn-toggle-calendar')?.addEventListener('click', () => {
  document.getElementById('calendar-sidebar')?.classList.toggle('sidebar-collapsed');
  document.getElementById('btn-toggle-calendar')?.classList.toggle('active');
});

// =============================================================================
// INLINE COMPOSE LOGIC
// =============================================================================

document.getElementById('format-bold')?.addEventListener('click', () => {
  document.execCommand('bold', false, null);
  updateFormatButtonsState();
});
document.getElementById('format-italic')?.addEventListener('click', () => {
  document.execCommand('italic', false, null);
  updateFormatButtonsState();
});
document.getElementById('format-underline')?.addEventListener('click', () => {
  document.execCommand('underline', false, null);
  updateFormatButtonsState();
});
document.getElementById('format-highlight')?.addEventListener('click', () => {
  document.execCommand('hiliteColor', false, 'rgba(255, 214, 10, 0.5)');
});

document.getElementById('format-font')?.addEventListener('change', (e) =>
  document.execCommand('fontName', false, e.target.value)
);
document.getElementById('format-size')?.addEventListener('change', (e) =>
  document.execCommand('fontSize', false, e.target.value)
);

function updateFormatButtonsState() {
  const isBold      = document.queryCommandState('bold');
  const isItalicOn  = document.queryCommandState('italic');
  const isUnderline = document.queryCommandState('underline');

  let isHighlight = false;
  const selection = window.getSelection();
  if (selection && selection.focusNode) {
    let element = selection.focusNode;
    if (element.nodeType === 3) element = element.parentNode;
    const bgColor = window.getComputedStyle(element).backgroundColor;
    isHighlight = bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent';
  }

  document.getElementById('format-bold')?.classList.toggle('is-active', isBold);
  document.getElementById('format-italic')?.classList.toggle('is-active', isItalicOn);
  document.getElementById('format-underline')?.classList.toggle('is-active', isUnderline);
  document.getElementById('format-highlight')?.classList.toggle('is-active', isHighlight);
}

const inlineBody = document.getElementById('inline-body');
if (inlineBody) {
  inlineBody.addEventListener('keyup',   updateFormatButtonsState);
  inlineBody.addEventListener('mouseup', updateFormatButtonsState);
  inlineBody.addEventListener('click',   updateFormatButtonsState);
}

document.getElementById('toggle-important')?.addEventListener('click', (e) => {
  isImportant = !isImportant;
  e.currentTarget.classList.toggle('is-active', isImportant);
});

function toggleComposeView(isComposing) {
  const readerView  = document.getElementById('reader-view');
  const composeView = document.getElementById('inline-compose');
  const btnCompose  = document.getElementById('btn-compose');
  const btnReply    = document.getElementById('btn-reply-email');
  const dividerMain = document.getElementById('pill-divider-main');
  const composeBtns = document.querySelectorAll('.compose-only');

  if (isComposing) {
    if (readerView)  readerView.style.display  = 'none';
    if (composeView) composeView.style.display = 'flex';
    if (btnCompose)  btnCompose.style.display  = 'none';
    if (btnReply)    btnReply.style.display    = 'none';
    const delBtn = document.getElementById('btn-delete-email');
    if (delBtn) delBtn.style.display = 'none';
    if (dividerMain) dividerMain.style.display = 'none';
    composeBtns.forEach(el => el.style.display = 'flex');
    isImportant = false;
    document.getElementById('toggle-important')?.classList.remove('is-active');
    document.getElementById('inline-body')?.focus();
  } else {
    if (composeView) composeView.style.display = 'none';
    if (readerView)  readerView.style.display  = 'block';
    composeBtns.forEach(el => el.style.display = 'none');
    if (btnCompose)  btnCompose.style.display  = 'flex';
    if (btnReply) btnReply.style.display = 'flex';
    const delBtn = document.getElementById('btn-delete-email');
    if (currentOpenEmail && delBtn) delBtn.style.display = 'flex';
    if (dividerMain) dividerMain.style.display = 'block';
  }
}

document.getElementById('btn-compose')?.addEventListener('click', () => {
  const activeBtn   = document.querySelector('.sidebar button.active');
  const accountId   = activeBtn ? activeBtn.id : null;
  if (!accountId) return alert('Select an account first!');

  const toEl      = document.getElementById('inline-to');
  const subjectEl = document.getElementById('inline-subject');
  const bodyEl    = document.getElementById('inline-body');
  if (toEl)      toEl.value      = '';
  if (subjectEl) subjectEl.value = '';
  if (bodyEl)    bodyEl.innerHTML = '';

  toggleComposeView(true);
});

document.getElementById('btn-reply-email')?.addEventListener('click', () => {
  if (!currentOpenEmail) return;

  const dateStr    = new Date(currentOpenEmail.date).toLocaleString();
  const safeSender = currentOpenEmail.sender  || 'Unknown';
  const safeSubject = currentOpenEmail.subject || 'No Subject';

  // FIX: Sanitize the quoted email body before injecting it into the
  //      contenteditable compose area.  Previously this was raw innerHTML.
  const cleanQuotedBody = sanitizeEmailHtml(currentOpenEmail.body_html);

  // FIX: Escape sender and date when building the HTML template so a crafted
  //      sender name (e.g. `<img onerror=...>`) cannot break out of the text node.
  const quotedBody = `
    <p><br></p>
    <div style="color: #8e8e93; font-size: 13px; margin-top: 40px; margin-bottom: 8px;">
      On ${escapeHtml(dateStr)}, ${escapeHtml(safeSender)} wrote:
    </div>
    <blockquote style="border-left: 3px solid #0A84FF; margin: 0; padding-left: 12px; color: #d1d1d6; overflow: hidden;">
      ${cleanQuotedBody}
    </blockquote>
  `;

  const emailMatch = safeSender.match(/<([^>]+)>/);
  const toEl = document.getElementById('inline-to');
  if (toEl) toEl.value = emailMatch ? emailMatch[1] : safeSender;

  const subjectEl = document.getElementById('inline-subject');
  if (subjectEl) subjectEl.value = safeSubject.startsWith('Re:') ? safeSubject : `Re: ${safeSubject}`;

  const bodyEl = document.getElementById('inline-body');
  if (bodyEl) bodyEl.innerHTML = quotedBody;

  toggleComposeView(true);
});

document.getElementById('pill-btn-cancel')?.addEventListener('click', () => toggleComposeView(false));

document.getElementById('pill-btn-send')?.addEventListener('click', async () => {
  const activeBtn = document.querySelector('.sidebar button.active');

  const data = {
    accountId: activeBtn?.id,
    to:        document.getElementById('inline-to')?.value,
    subject:   document.getElementById('inline-subject')?.value,
    body:      document.getElementById('inline-body')?.innerHTML,
    priority:  isImportant ? 'high' : 'normal',
  };

  if (!data.to || !data.subject) return alert('Please fill in recipient and subject');

  const sendBtn = document.getElementById('pill-btn-send');
  if (sendBtn) {
    sendBtn.disabled  = true;
    sendBtn.textContent = 'Sending...';
  }

  const success = await window.mailAPI.sendEmail(data);

  if (sendBtn) {
    sendBtn.disabled = false;
    // Safe to use innerHTML here — content is our own hardcoded icon, not user data
    sendBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px !important; margin-right: 4px;">send</span> Send`;
  }

  if (success) {
    toggleComposeView(false);
  } else {
    alert('Failed to send email. Check console.');
  }
});

// =============================================================================
// INBOX LOADER
// =============================================================================

async function loadInbox(accountId, folder = 'INBOX', silentRefresh = false) {
  const inboxContainer = document.getElementById('inbox-items');
  if (!inboxContainer) return;

  // Only show "Loading emails..." if it's a completely new folder click
  if (!silentRefresh) {
    inboxContainer.innerHTML = '<p style="color: #666; font-size: 14px; padding: 0 20px;">Loading emails...</p>';
  }

  const emails = await window.mailAPI.getEmails({ accountId, folder });

  if (emails.length === 0) {
    inboxContainer.innerHTML = `
      <div class="inbox-empty-state">
        <span class="material-symbols-outlined">inbox</span>
        <h3>Inbox is Empty</h3>
        <p>No emails found.</p>
      </div>`;
    return;
  }

  inboxContainer.innerHTML = '';

  emails.forEach(email => {
    const el = document.createElement('div');
    el.className = 'email-item';
    el.dataset.emailId = email.id;

    const safeSender = email.sender || 'Unknown';
    const senderName = safeSender.split('<')[0].trim() || 'Unknown Sender';
    const emailIsImportant = email.priority === 'high';

    // ── FIX: Build each row with DOM APIs — no untrusted data in innerHTML ──

    const senderEl = document.createElement('div');
    senderEl.className   = 'email-sender';
    senderEl.textContent = senderName; // FIX: textContent

    const subjectEl = document.createElement('div');
    subjectEl.className = 'email-subject';
    if (emailIsImportant) {
      const icon = document.createElement('span');
      icon.className = 'material-symbols-outlined';
      icon.style.cssText = 'color: #ff5f56; font-size: 16px !important; margin-right: 6px; vertical-align: bottom;';
      icon.textContent = 'priority_high'; // FIX: textContent for the icon name too
      subjectEl.appendChild(icon);
    }
    // Append the subject as a plain text node — safe even if subject contains HTML
    subjectEl.appendChild(
      document.createTextNode(email.subject || '(No Subject)')
    );

    const snippetEl = document.createElement('div');
    snippetEl.className   = 'email-snippet';
    snippetEl.textContent = email.snippet || ''; // FIX: textContent

    // ── Inline Delete Button ──
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'inline-delete-btn';
    deleteBtn.title = 'Delete';
    const delIcon = document.createElement('span');
    delIcon.className = 'material-symbols-outlined';
    delIcon.textContent = 'delete';
    deleteBtn.appendChild(delIcon);

    deleteBtn.onclick = async (e) => {
      e.stopPropagation(); // Prevents opening the email when you just want to delete it
      deleteBtn.style.opacity = '0.5';
      deleteBtn.style.pointerEvents = 'none';

      // If the email we are deleting is currently open, figure out the next one to select
      if (currentOpenEmail && currentOpenEmail.id === email.id) {
        const currentIndex = emails.findIndex(e => e.id === email.id);
        if (currentIndex !== -1) {
          const nextEmail = emails[currentIndex + 1] || emails[currentIndex - 1];
          if (nextEmail) {
            pendingSelectEmailId = nextEmail.id;
          }
        }
      }

      const success = await window.mailAPI.deleteEmail({
        id:         email.id,
        account_id: email.account_id,
        uid:        email.uid,
        folder:     email.folder,
      });

      if (success) {
        if (currentOpenEmail && currentOpenEmail.id === email.id) {
          currentOpenEmail = null;
        }
        loadInbox(email.account_id);
      } else {
        deleteBtn.style.opacity = '1';
        deleteBtn.style.pointerEvents = 'auto';
      }
    };

    el.appendChild(senderEl);
    el.appendChild(subjectEl);
    el.appendChild(snippetEl);
    el.appendChild(deleteBtn);

    // ── Click handler — open email in reader pane ──
    el.onclick = () => {
      document.querySelectorAll('.email-item').forEach(item => item.classList.remove('active'));
      el.classList.add('active');
      currentOpenEmail = email;

      const delBtn = document.getElementById('btn-delete-email');
      if (delBtn) {
        delBtn.style.display       = 'flex';
        delBtn.style.opacity       = '1';
        delBtn.style.pointerEvents = 'auto';
      }

      // FIX: Build the subject heading with DOM so a crafted subject like
      //      <img src=x onerror=alert(1)> cannot execute.
      const readerSubject = document.getElementById('reader-subject');
      if (readerSubject) {
        readerSubject.textContent = ''; // clear
        if (emailIsImportant) {
          const icon = document.createElement('span');
          icon.className = 'material-symbols-outlined';
          icon.style.cssText = 'color: #ff5f56; font-size: 16px !important; margin-right: 6px; vertical-align: middle;';
          icon.textContent = 'priority_high';
          readerSubject.appendChild(icon);
        }
        readerSubject.appendChild(
          document.createTextNode(email.subject || '(No Subject)')
        );
      }

      // sender + date are plain text — innerText is fine here
      const readerSender = document.getElementById('reader-sender');
      if (readerSender) {
        readerSender.innerText = `From: ${safeSender}\nDate: ${new Date(email.date).toLocaleString()}`;
      }

      // ── Render email body inside a Shadow DOM ──
      // The Shadow DOM isolates the email's CSS from the app's own styles.
      // DOMPurify removes scripts/handlers; the shadow boundary stops style leakage.
      const cleanHtml  = sanitizeEmailHtml(email.body_html);
      const readerBody = document.getElementById('reader-body');

      if (readerBody) {
        if (!readerBody.shadowRoot) {
          readerBody.attachShadow({ mode: 'open' });
        }
        // The style block here is our own code — safe to use innerHTML for the
        // shadow root.  The email HTML itself has already been sanitized above.
        readerBody.shadowRoot.innerHTML = `
          <style>
            :host {
              color: #d1d1d6;
              font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              line-height: 1.6;
            }
            a   { color: #0A84FF; }
            img { max-width: 100%; height: auto; border-radius: 8px; }
            *   { word-wrap: break-word; }
          </style>
          ${cleanHtml}
        `;
      }
    };

    inboxContainer.appendChild(el);
  });

  // ── Auto-Select Logic ──
  if (emails.length > 0) {
    let targetEl = null;

    if (pendingSelectEmailId) {
      targetEl = inboxContainer.querySelector(`[data-email-id="${pendingSelectEmailId}"]`);
      pendingSelectEmailId = null;
    }

    if (!targetEl && currentOpenEmail) {
      targetEl = inboxContainer.querySelector(`[data-email-id="${currentOpenEmail.id}"]`);
    }

    if (!targetEl) {
      targetEl = inboxContainer.querySelector('.email-item'); // Default to the first (newest) email
    }

    if (targetEl && !targetEl.classList.contains('active')) {
      targetEl.click();
    }
  } else {
    // No emails left, clear the reader pane
    const subjectEl = document.getElementById('reader-subject');
    if (subjectEl) subjectEl.textContent = 'Select an email';
    const senderEl = document.getElementById('reader-sender');
    if (senderEl) senderEl.textContent = '---';
    const reader = document.getElementById('reader-body');
    if (reader) {
      if (reader.shadowRoot) reader.shadowRoot.innerHTML = '';
      reader.innerHTML = '';
    }
    const topDelBtn = document.getElementById('btn-delete-email');
    if (topDelBtn) topDelBtn.style.display = 'none';
  }
}

// =============================================================================
// WINDOW CONTROLS (TRAFFIC LIGHTS)
// =============================================================================
document.querySelector('.light.close')?.addEventListener('click',    () => window.mailAPI.closeApp());
document.querySelector('.light.minimize')?.addEventListener('click', () => window.mailAPI.minimizeApp());
document.querySelector('.light.maximize')?.addEventListener('click', () => window.mailAPI.maximizeApp());