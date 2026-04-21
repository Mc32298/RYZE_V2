// =============================================================================
// STATE
// =============================================================================
// =============================================================================
// STATE
// =============================================================================
let currentOpenEmail = null;
let isImportant = false; // <--- ADD THIS LINE HERE
let isTutorialActive = false;
// ... rest of your code
const sidebar = document.querySelector('.sidebar');
const addBtn = document.getElementById('btn-add');

// =============================================================================
// ONBOARDING
// =============================================================================

function startOnboarding() {
  isTutorialActive = true;
  document.getElementById('onboarding-overlay')?.classList.remove('onboarding-hidden');
}

function nextOnboardingStep(step) {
  const overlay = document.getElementById('onboarding-overlay');
  if(document.getElementById('step-1')) document.getElementById('step-1').style.display = 'none';
  if(document.getElementById('step-2')) document.getElementById('step-2').style.display = 'none';

  if (step === 2) {
    if(document.getElementById('step-2')) document.getElementById('step-2').style.display = 'block';
  } else if (step === 3) {
    if(document.getElementById('onboarding-card')) document.getElementById('onboarding-card').style.display = 'none';
    document.getElementById('onboarding-pointer')?.classList.remove('pointer-hidden');
    overlay?.classList.add('onboarding-passthrough');
  }
}

function showDeleteTutorial() {
  const overlay = document.getElementById('onboarding-overlay');
  overlay?.classList.remove('onboarding-passthrough');
  document.getElementById('onboarding-pointer')?.classList.add('pointer-hidden');
  if(document.getElementById('onboarding-card')) document.getElementById('onboarding-card').style.display = 'block';
  if(document.getElementById('step-1')) document.getElementById('step-1').style.display = 'none';
  if(document.getElementById('step-2')) document.getElementById('step-2').style.display = 'none';
  if(document.getElementById('step-delete')) document.getElementById('step-delete').style.display = 'block';
}

function showFinalThanks() {
  if(document.getElementById('step-delete')) document.getElementById('step-delete').style.display = 'none';
  if(document.getElementById('step-final')) document.getElementById('step-final').style.display = 'block';
}

function closeOnboarding() {
  document.getElementById('onboarding-overlay')?.classList.add('onboarding-hidden');
  isTutorialActive = false;
  const firstBtn = document.querySelector('.mail-btn');
  if (firstBtn) firstBtn.click();
}

// =============================================================================
// SIDEBAR & ACCOUNTS
// =============================================================================

function createSidebarButton(acc) {
  if (document.getElementById(acc.id)) return;

  const btn = document.createElement('button');
  btn.id = acc.id;
  btn.className = 'mail-btn';
  btn.title = acc.name;
  btn.innerHTML = `
    <span class="material-symbols-outlined">${acc.icon}</span>
    <span class="btn-label">${acc.name}</span>
  `;

  btn.addEventListener('click', () => {
    document.querySelectorAll('.sidebar button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    const calHeader = document.getElementById('calendar-account-name');
    if (calHeader) calHeader.innerText = `${acc.name}'s Calendar`;
    
    const calContent = document.getElementById('calendar-content');
    if (calContent) {
      calContent.innerHTML = `
        <div style="font-size: 13px; color: #8e8e93; text-align: center; margin-top: 20px;">
          Events for ${acc.email} will sync here.
        </div>
      `;
    }

    loadInbox(acc.id); 
  });

  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.mailAPI.showContextMenu({ id: acc.id, name: acc.name });
  });

  sidebar?.insertBefore(btn, addBtn);
  return btn;
}

// =============================================================================
// IPC LISTENERS
// =============================================================================

window.mailAPI?.onInitAccounts((accounts) => {
  if (accounts.length === 0) {
    startOnboarding();
  } else {
    accounts.forEach(acc => createSidebarButton(acc));
    const firstBtn = document.querySelector('.mail-btn');
    if (firstBtn) firstBtn.click();
  }
});

window.mailAPI?.onNewAccount((acc) => {
  const newBtn = createSidebarButton(acc);
  if (isTutorialActive) {
    showDeleteTutorial();
  } else {
    if (newBtn) newBtn.click();
  }
});

window.mailAPI?.onAccountDeleted((id) => {
  const btnToRemove = document.getElementById(id);
  if (btnToRemove) {
    const wasActive = btnToRemove.classList.contains('active');
    btnToRemove.remove();
    if (wasActive) {
      const nextBtn = document.querySelector('.mail-btn');
      if (nextBtn) nextBtn.click();
      else {
        // No accounts left, clear the screen completely
        const inboxContainer = document.getElementById('inbox-items');
        if(inboxContainer) inboxContainer.innerHTML = '';
        if(document.getElementById('reader-subject')) document.getElementById('reader-subject').innerText = "Select an email";
        if(document.getElementById('reader-sender')) document.getElementById('reader-sender').innerText = "---";
        if(document.getElementById('reader-body')) document.getElementById('reader-body').innerHTML = "";
      }
    }
  }
});

window.mailAPI?.onAccountUpdated(({ id, newName }) => {
  const btn = document.getElementById(id);
  if (btn) {
    const label = btn.querySelector('.btn-label');
    if (label) label.innerText = newName;
    btn.title = newName;
  }
});

window.mailAPI?.onNewMailArrived((accountId) => {
  const activeBtn = document.querySelector('.mail-btn.active');
  if (activeBtn && activeBtn.id === accountId) {
    loadInbox(accountId); 
  }
});

// =============================================================================
// UI EVENT LISTENERS (ARMORED)
// =============================================================================

document.getElementById('btn-add')?.addEventListener('click', () => {
  window.mailAPI.openAddWindow(isTutorialActive);
});

document.getElementById('btn-feedback')?.addEventListener('click', () => {
  window.mailAPI.openExternal('https://github.com/Mc32298/Spinophowto');
});

document.getElementById('btn-delete-email')?.addEventListener('click', async (e) => {
  if (!currentOpenEmail) return;

  const btn = e.currentTarget;
  // Visual feedback instantly
  btn.style.opacity = '0.5';
  btn.style.pointerEvents = 'none';

  const success = await window.mailAPI.deleteEmail({
    id: currentOpenEmail.id,
    account_id: currentOpenEmail.account_id,
    uid: currentOpenEmail.uid,
    folder: currentOpenEmail.folder
  });

  if (success) {
    document.getElementById('reader-subject').innerText = "Select an email";
    document.getElementById('reader-sender').innerText = "---";
    document.getElementById('reader-body').innerHTML = "";
    
    // Reset button state
    btn.style.display = 'none';
    btn.style.opacity = '1';
    btn.style.pointerEvents = 'auto';
    
    loadInbox(currentOpenEmail.account_id);
    currentOpenEmail = null;
  } else {
    btn.style.opacity = '1';
    btn.style.pointerEvents = 'auto';
  }
});

// Calendar Toggle
document.getElementById('btn-toggle-calendar')?.addEventListener('click', () => {
  const calendarSidebar = document.getElementById('calendar-sidebar');
  const btnToggleCalendar = document.getElementById('btn-toggle-calendar');
  calendarSidebar?.classList.toggle('sidebar-collapsed');
  btnToggleCalendar?.classList.toggle('active');
});

// =============================================================================
// INLINE COMPOSE LOGIC
// =============================================================================
// --- RICH TEXT FORMATTING LOGIC ---
// --- RICH TEXT FORMATTING LOGIC ---

// 1. The Format Actions
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
  // Highlight is trickier to detect natively, so we just flash it
});

document.getElementById('format-font')?.addEventListener('change', (e) => document.execCommand('fontName', false, e.target.value));
document.getElementById('format-size')?.addEventListener('change', (e) => document.execCommand('fontSize', false, e.target.value));


// 2. The State Checker (This makes the buttons light up!)
// 2. The State Checker (This makes the buttons light up!)
function updateFormatButtonsState() {
  const isBold = document.queryCommandState('bold');
  const isItalic = document.queryCommandState('italic');
  const isUnderline = document.queryCommandState('underline');

  // Highlight requires a special detective check!
  let isHighlight = false;
  const selection = window.getSelection();
  if (selection && selection.focusNode) {
    let element = selection.focusNode;
    // If the cursor is inside a raw text node, grab the span/div wrapping it
    if (element.nodeType === 3) element = element.parentNode; 
    
    // Check if it has a background color painted on it
    const bgColor = window.getComputedStyle(element).backgroundColor;
    isHighlight = (bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent');
  }

  document.getElementById('format-bold')?.classList.toggle('is-active', isBold);
  document.getElementById('format-italic')?.classList.toggle('is-active', isItalic);
  document.getElementById('format-underline')?.classList.toggle('is-active', isUnderline);
  document.getElementById('format-highlight')?.classList.toggle('is-active', isHighlight); // <--- Added!
}
// 3. Listen to the user typing or clicking around the text box
const inlineBody = document.getElementById('inline-body');
if (inlineBody) {
  inlineBody.addEventListener('keyup', updateFormatButtonsState);   // Checks when you type or use arrow keys
  inlineBody.addEventListener('mouseup', updateFormatButtonsState); // Checks when you click somewhere in the text
  inlineBody.addEventListener('click', updateFormatButtonsState);
}

document.getElementById('toggle-important')?.addEventListener('click', (e) => {
  isImportant = !isImportant;
  e.currentTarget.classList.toggle('is-active', isImportant);
});

function toggleComposeView(isComposing) {
  const readerView = document.getElementById('reader-view');
  const composeView = document.getElementById('inline-compose');
  const btnReply = document.getElementById('btn-reply-email');
  const dividerMain = document.getElementById('pill-divider-main');
  const composeBtns = document.querySelectorAll('.compose-only'); 

  if (isComposing) {
    if(readerView) readerView.style.display = 'none';
    if(composeView) composeView.style.display = 'flex';
    
    if (btnReply) btnReply.style.display = 'none';
    if (document.getElementById('btn-delete-email')) document.getElementById('btn-delete-email').style.display = 'none';
    if (dividerMain) dividerMain.style.display = 'none';
    composeBtns.forEach(el => el.style.display = 'flex');
    isImportant = false;
    document.getElementById('toggle-important')?.classList.remove('is-active');
    document.getElementById('inline-body')?.focus();
  } else {
    if(composeView) composeView.style.display = 'none';
    if(readerView) readerView.style.display = 'block';
    
    composeBtns.forEach(el => el.style.display = 'none');
    if (btnReply) btnReply.style.display = 'flex';
    if (currentOpenEmail && document.getElementById('btn-delete-email')) document.getElementById('btn-delete-email').style.display = 'flex';
    if (dividerMain) dividerMain.style.display = 'block';
  }
}

document.getElementById('btn-compose')?.addEventListener('click', () => {
  const activeBtn = document.querySelector('.sidebar button.active');
  const accountId = activeBtn ? activeBtn.id : null;
  if (!accountId) return alert("Select an account first!");

  if(document.getElementById('inline-to')) document.getElementById('inline-to').value = '';
  if(document.getElementById('inline-subject')) document.getElementById('inline-subject').value = '';
  if(document.getElementById('inline-body')) document.getElementById('inline-body').innerHTML = '';

  toggleComposeView(true);
});

document.getElementById('btn-reply-email')?.addEventListener('click', () => {
  if (!currentOpenEmail) return;

  const dateStr = new Date(currentOpenEmail.date).toLocaleString();
  const safeSender = currentOpenEmail.sender || "Unknown";
  const safeSubject = currentOpenEmail.subject || "No Subject";
  
  const quotedBody = `
    <p><br></p>
    <div style="color: #8e8e93; font-size: 13px; margin-top: 40px; margin-bottom: 8px;">
      On ${dateStr}, ${safeSender} wrote:
    </div>
    <blockquote style="border-left: 3px solid #0A84FF; margin: 0; padding-left: 12px; color: #d1d1d6; overflow: hidden;">
      ${currentOpenEmail.body_html || ""}
    </blockquote>
  `;

  const emailMatch = safeSender.match(/<([^>]+)>/);
  if(document.getElementById('inline-to')) document.getElementById('inline-to').value = emailMatch ? emailMatch[1] : safeSender;
  if(document.getElementById('inline-subject')) document.getElementById('inline-subject').value = safeSubject.startsWith('Re:') ? safeSubject : `Re: ${safeSubject}`;
  if(document.getElementById('inline-body')) document.getElementById('inline-body').innerHTML = quotedBody;

  toggleComposeView(true);
});

document.getElementById('pill-btn-cancel')?.addEventListener('click', () => toggleComposeView(false));

document.getElementById('pill-btn-send')?.addEventListener('click', async () => {
  const activeBtn = document.querySelector('.sidebar button.active');
  
  const data = {
    accountId: activeBtn?.id, 
    to: document.getElementById('inline-to')?.value,
    subject: document.getElementById('inline-subject')?.value,
    body: document.getElementById('inline-body')?.innerHTML,
    priority: isImportant ? 'high' : 'normal' // <--- ADDED THIS LINE
  };

  if (!data.to || !data.subject) return alert("Please fill in recipient and subject");

  const sendBtn = document.getElementById('pill-btn-send');
  if(sendBtn) {
    sendBtn.disabled = true;
    sendBtn.innerHTML = "Sending...";
  }

  const success = await window.mailAPI.sendEmail(data);
  
  if(sendBtn) {
    sendBtn.disabled = false;
    sendBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 16px !important; margin-right: 4px;">send</span> Send`;
  }

  if (success) {
    toggleComposeView(false); 
  } else {
    alert("Failed to send email. Check console.");
  }
});

// =============================================================================
// V2 NATIVE EMAIL ENGINE
// =============================================================================

async function loadInbox(accountId) {
  const inboxContainer = document.getElementById('inbox-items');
  if (!inboxContainer) return;

  inboxContainer.innerHTML = '<p style="color: #666; font-size: 14px; padding: 0 20px;">Syncing database...</p>';

  const emails = await window.mailAPI.getEmails(accountId);

  if (emails.length === 0) {
    inboxContainer.innerHTML = `
      <div class="inbox-empty-state">
        <span class="material-symbols-outlined">inbox</span>
        <h3>Inbox is Empty</h3>
        <p>New emails will appear here.</p>
      </div>`;
    return;
  }

  inboxContainer.innerHTML = '';

 emails.forEach(email => {
    const el = document.createElement('div');
    el.className = 'email-item';

    const safeSender = email.sender || "Unknown";
    const senderName = safeSender.split('<')[0].trim() || 'Unknown Sender';
    
    // NEW: Check priority and generate a red icon if important
    const isImportant = email.priority === 'high';
    const importantIcon = isImportant ? `<span class="material-symbols-outlined" style="color: #ff5f56; font-size: 16px !important; margin-right: 6px; vertical-align: bottom;">priority_high</span>` : '';

    el.innerHTML = `
      <div class="email-sender">${senderName}</div>
      <div class="email-subject">${importantIcon}${email.subject || '(No Subject)'}</div>
      <div class="email-snippet">${email.snippet || ''}</div>
    `;

    el.onclick = () => {
      document.querySelectorAll('.email-item').forEach(item => item.classList.remove('active'));
      el.classList.add('active');
      currentOpenEmail = email; 
      
      if(document.getElementById('btn-delete-email')) {
        const delBtn = document.getElementById('btn-delete-email');
        delBtn.style.display = 'flex';
        delBtn.style.opacity = '1';
        delBtn.style.pointerEvents = 'auto';
      }
      
      // NEW: Show the important icon in the big reader view header too!
      if(document.getElementById('reader-subject')) document.getElementById('reader-subject').innerHTML = `${importantIcon} ${email.subject || "(No Subject)"}`;
      
      if(document.getElementById('reader-sender')) document.getElementById('reader-sender').innerText = `From: ${safeSender} \nDate: ${new Date(email.date).toLocaleString()}`;
      
      const cleanHtml = window.DOMPurify ? window.DOMPurify.sanitize(email.body_html) : email.body_html;
      if(document.getElementById('reader-body')) document.getElementById('reader-body').innerHTML = cleanHtml; 
    };

    inboxContainer.appendChild(el);
  });
}

// =============================================================================
// WINDOW CONTROLS (TRAFFIC LIGHTS)
// =============================================================================
document.querySelector('.light.close')?.addEventListener('click', () => window.mailAPI.closeApp());
document.querySelector('.light.minimize')?.addEventListener('click', () => window.mailAPI.minimizeApp());
document.querySelector('.light.maximize')?.addEventListener('click', () => window.mailAPI.maximizeApp());