// --- Mailboxes (imap-mcp accounts) ---
// Passwords are write-only in this UI: the server never sends a stored password
// back, so the password fields always start blank. Leaving them blank on Save
// keeps whatever password is already stored for that account.

async function loadMailAccountList() {
    const listEl = document.getElementById('mail-account-list');
    if (!listEl) return;
    listEl.innerHTML = '<p>Loading mailboxes...</p>';
    try {
        const response = await fetch('/admin/mail-accounts');
        if (!response.ok) throw new Error(`Failed to load mailboxes (${response.status})`);
        const data = await response.json();
        renderMailAccountList(data.accounts || []);
    } catch (error) {
        listEl.innerHTML = `<p class="error-message">Error loading mailboxes: ${error.message}</p>`;
    }
}

function renderMailAccountList(accounts) {
    const listEl = document.getElementById('mail-account-list');
    if (!listEl) return;
    if (accounts.length === 0) {
        listEl.innerHTML = '<p>No mailboxes configured yet -- add one below.</p>';
        return;
    }
    listEl.innerHTML = '';
    accounts.forEach(acct => {
        const entry = document.createElement('div');
        entry.className = 'server-entry';
        entry.innerHTML = `
            <div class="server-header">
                <h3>${escapeHtml(acct.name)}</h3>
                <button class="edit-button" data-name="${escapeHtml(acct.name)}">Edit</button>
                <button class="delete-button" data-name="${escapeHtml(acct.name)}">Delete</button>
            </div>
            <div class="server-details">
                <label>IMAP:</label>
                <p>${escapeHtml(acct.user)} @ ${escapeHtml(acct.imapHost)}:${acct.imapPort}${acct.imapSecure ? ' (TLS)' : ''}${acct.imapAllowInsecureTLS ? ' -- certificate NOT verified' : ''}</p>
                <label>Sending:</label>
                <p>${acct.smtpHost ? `Enabled via ${escapeHtml(acct.smtpHost)}:${acct.smtpPort}` : 'Disabled (no SMTP host set)'}</p>
                <label>Updated:</label>
                <p>${new Date(acct.updatedAt).toLocaleString()}</p>
            </div>
        `;
        listEl.appendChild(entry);
    });

    listEl.querySelectorAll('.edit-button').forEach(button => {
        button.addEventListener('click', (e) => {
            const name = e.target.getAttribute('data-name');
            const acct = accounts.find(a => a.name === name);
            if (acct) populateMailAccountForm(acct);
        });
    });

    listEl.querySelectorAll('.delete-button').forEach(button => {
        button.addEventListener('click', async (e) => {
            const name = e.target.getAttribute('data-name');
            if (!confirm(`Delete mailbox '${name}'? Claude will lose access to it until you re-add it.`)) return;
            try {
                const response = await fetch(`/admin/mail-accounts/${encodeURIComponent(name)}`, { method: 'DELETE' });
                const result = await response.json();
                if (response.ok && result.success) {
                    if (result.connectionWarning) alert(`Deleted, but: ${result.connectionWarning}`);
                    await loadMailAccountList();
                } else {
                    alert(`Failed to delete mailbox: ${result.error || response.statusText}`);
                }
            } catch (error) {
                alert(`Error deleting mailbox: ${error.message}`);
            }
        });
    });
}

function populateMailAccountForm(acct) {
    document.getElementById('mail-account-name').value = acct.name;
    document.getElementById('mail-account-name').readOnly = true;
    document.getElementById('mail-imap-host').value = acct.imapHost || '';
    document.getElementById('mail-imap-port').value = acct.imapPort || 993;
    document.getElementById('mail-imap-secure').checked = acct.imapSecure !== false;
    document.getElementById('mail-imap-insecure-tls').checked = !!acct.imapAllowInsecureTLS;
    document.getElementById('mail-user').value = acct.user || '';
    document.getElementById('mail-password').value = '';
    document.getElementById('mail-password').placeholder = acct.hasPassword ? 'Leave blank to keep the current password' : 'Required';
    document.getElementById('mail-smtp-host').value = acct.smtpHost || '';
    document.getElementById('mail-smtp-port').value = acct.smtpPort || 587;
    document.getElementById('mail-smtp-secure').checked = !!acct.smtpSecure;
    document.getElementById('mail-smtp-insecure-tls').checked = !!acct.smtpAllowInsecureTLS;
    document.getElementById('mail-smtp-user').value = acct.smtpUser || '';
    document.getElementById('mail-smtp-password').value = '';
    document.getElementById('mail-smtp-password').placeholder = acct.hasSmtpPassword ? 'Leave blank to keep the current password' : '(defaults to the IMAP password)';
    document.getElementById('mail-from').value = acct.mailFrom || '';
    document.getElementById('mail-account-form-title').textContent = `Editing '${acct.name}'`;
    document.getElementById('mail-account-cancel-edit').style.display = 'inline-block';
    document.getElementById('mail-account-test-status').textContent = '';
    document.getElementById('mail-account-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function resetMailAccountForm() {
    const form = document.getElementById('mail-account-form');
    if (form) form.reset();
    document.getElementById('mail-account-name').readOnly = false;
    document.getElementById('mail-password').placeholder = 'Required';
    document.getElementById('mail-smtp-password').placeholder = '(defaults to the IMAP password)';
    document.getElementById('mail-account-form-title').textContent = 'Add a mailbox';
    document.getElementById('mail-account-cancel-edit').style.display = 'none';
    document.getElementById('mail-account-status').textContent = '';
    document.getElementById('mail-account-test-status').textContent = '';
}

function readMailAccountForm() {
    return {
        name: document.getElementById('mail-account-name').value.trim(),
        imapHost: document.getElementById('mail-imap-host').value.trim(),
        imapPort: parseInt(document.getElementById('mail-imap-port').value, 10) || 993,
        imapSecure: document.getElementById('mail-imap-secure').checked,
        imapAllowInsecureTLS: document.getElementById('mail-imap-insecure-tls').checked,
        user: document.getElementById('mail-user').value.trim(),
        password: document.getElementById('mail-password').value,
        smtpHost: document.getElementById('mail-smtp-host').value.trim(),
        smtpPort: parseInt(document.getElementById('mail-smtp-port').value, 10) || 587,
        smtpSecure: document.getElementById('mail-smtp-secure').checked,
        smtpAllowInsecureTLS: document.getElementById('mail-smtp-insecure-tls').checked,
        smtpUser: document.getElementById('mail-smtp-user').value.trim(),
        smtpPassword: document.getElementById('mail-smtp-password').value,
        mailFrom: document.getElementById('mail-from').value.trim(),
    };
}

function initializeMailAccountsSection() {
    const form = document.getElementById('mail-account-form');
    const status = document.getElementById('mail-account-status');
    const testStatus = document.getElementById('mail-account-test-status');

    if (form && !form.dataset.listenerAttached) {
        form.dataset.listenerAttached = 'true';
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const values = readMailAccountForm();
            if (!values.name) { status.style.color = 'red'; status.textContent = 'Name is required.'; return; }
            status.style.color = '';
            status.textContent = 'Saving...';
            try {
                const response = await fetch(`/admin/mail-accounts`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(values),
                });
                const result = await response.json();
                if (response.ok && result.success) {
                    status.style.color = 'green';
                    status.textContent = result.connectionWarning
                        ? `Saved, but the connector had trouble starting: ${result.connectionWarning}`
                        : `Mailbox '${values.name}' saved and live.`;
                    resetMailAccountForm();
                    await loadMailAccountList();
                } else {
                    status.style.color = 'red';
                    status.textContent = result.error || 'Failed to save mailbox.';
                }
            } catch (error) {
                status.style.color = 'red';
                status.textContent = `Network error: ${error.message}`;
            }
        });
    }

    const testButton = document.getElementById('mail-account-test-button');
    if (testButton && !testButton.dataset.listenerAttached) {
        testButton.dataset.listenerAttached = 'true';
        testButton.addEventListener('click', async () => {
            const values = readMailAccountForm();
            if (!values.imapHost || !values.user) {
                testStatus.style.color = 'red';
                testStatus.textContent = 'Fill in at least IMAP host and user first.';
                return;
            }
            if (!values.password) {
                testStatus.style.color = 'red';
                testStatus.textContent = 'Enter the password to test a live connection (it is not sent anywhere except this one-off check).';
                return;
            }
            testStatus.style.color = '';
            testStatus.textContent = 'Connecting...';
            try {
                const response = await fetch('/admin/mail-accounts/test', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(values),
                });
                const result = await response.json();
                if (result.ok) {
                    testStatus.style.color = 'green';
                    testStatus.textContent = 'Connected successfully.';
                } else {
                    testStatus.style.color = 'red';
                    testStatus.textContent = `Failed: ${result.error}`;
                }
            } catch (error) {
                testStatus.style.color = 'red';
                testStatus.textContent = `Network error: ${error.message}`;
            }
        });
    }

    const cancelButton = document.getElementById('mail-account-cancel-edit');
    if (cancelButton && !cancelButton.dataset.listenerAttached) {
        cancelButton.dataset.listenerAttached = 'true';
        cancelButton.addEventListener('click', () => resetMailAccountForm());
    }
}

window.loadMailAccountList = loadMailAccountList;
window.initializeMailAccountsSection = initializeMailAccountsSection;
