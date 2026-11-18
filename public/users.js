// --- Users / Token Management ---

async function fetchUserList() {
    const userListEl = document.getElementById('user-list');
    if (!userListEl) return;
    userListEl.innerHTML = '<p>Loading users...</p>';
    try {
        const response = await fetch('/admin/users');
        if (!response.ok) throw new Error(`Failed to load users (${response.status})`);
        const data = await response.json();
        renderUserList(data.users || []);
    } catch (error) {
        userListEl.innerHTML = `<p class="error-message">Error loading users: ${error.message}</p>`;
    }
}

function renderUserList(users) {
    const userListEl = document.getElementById('user-list');
    if (!userListEl) return;
    if (users.length === 0) {
        userListEl.innerHTML = '<p>No users created yet.</p>';
        return;
    }
    userListEl.innerHTML = '';
    users.forEach(user => {
        const entry = document.createElement('div');
        entry.className = 'server-entry';
        // Fixed markup only; the username (free text) and token go in as text.
        entry.innerHTML = `
            <div class="server-header">
                <h3></h3>
                <button class="installer-button">Download Installer</button>
                <button class="config-button">Copy Desktop Config</button>
                <button class="delete-button">Revoke</button>
            </div>
            <div class="server-details">
                <label>Token (use in <code>?key=</code> or as a Bearer token):</label>
                <textarea rows="1" readonly class="user-token"></textarea>
                <label>Created:</label>
                <p class="user-created"></p>
            </div>
        `;
        entry.querySelector('h3').textContent = user.username;
        entry.querySelector('.installer-button').setAttribute('data-username', user.username);
        entry.querySelector('.config-button').setAttribute('data-token', user.token);
        entry.querySelector('.delete-button').setAttribute('data-username', user.username);
        const tokenBox = entry.querySelector('.user-token');
        tokenBox.value = user.token;
        tokenBox.addEventListener('click', () => tokenBox.select());
        entry.querySelector('.user-created').textContent = new Date(user.createdAt).toLocaleString();
        userListEl.appendChild(entry);
    });

    userListEl.querySelectorAll('.config-button').forEach(button => {
        button.addEventListener('click', (e) => {
            const token = e.target.getAttribute('data-token');
            copyDesktopConfig(token);
        });
    });

    userListEl.querySelectorAll('.installer-button').forEach(button => {
        button.addEventListener('click', (e) => {
            const username = e.target.getAttribute('data-username');
            const nameInput = document.getElementById('config-server-name');
            const serverName = (nameInput && nameInput.value.trim()) || window.gatewayClientName || 'patchbay';
            const href = `/admin/users/${encodeURIComponent(username)}/installer?name=${encodeURIComponent(serverName)}`;
            const a = document.createElement('a');
            a.href = href;
            document.body.appendChild(a);
            a.click();
            a.remove();
            const status = document.getElementById('config-gen-status');
            if (status) {
                status.style.color = 'green';
                status.textContent = `Building installer for "${username}"… a ~40 MB .zip download will start shortly. Send it to them, they double-click Install.bat inside.`;
            }
        });
    });

    userListEl.querySelectorAll('.delete-button').forEach(button => {
        button.addEventListener('click', async (e) => {
            const username = e.target.getAttribute('data-username');
            if (!confirm(`Revoke access for '${username}'? This immediately invalidates their token.`)) return;
            try {
                const response = await fetch(`/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
                const result = await response.json();
                if (response.ok && result.success) {
                    await fetchUserList();
                } else {
                    alert(`Failed to revoke user: ${result.error || response.statusText}`);
                }
            } catch (error) {
                alert(`Error revoking user: ${error.message}`);
            }
        });
    });
}


// mcp-remote version the generated client config pins. A bare "mcp-remote" makes
// npx check npm on every launch and update its shared cache folder in place when a
// new version is out; two servers starting at once can then leave it without its
// launcher. An exact version is reused from the cache as installed.
const MCP_REMOTE_SPEC = 'mcp-remote@0.16.0';

// Build the ready-to-paste Claude Desktop config for a given user token.
// The gateway base URL is derived from whatever address the admin is currently
// viewing this UI at (window.location) -- so as long as you browse to the admin
// UI at the same host the clients will reach, the generated URL is correct.
function generateDesktopConfig(token) {
    const nameInput = document.getElementById('config-server-name');
    const serverName = (nameInput && nameInput.value.trim()) || window.gatewayClientName || 'patchbay';
    const base = `${window.location.protocol}//${window.location.host}`;
    const url = `${base}/mcp?key=${token}`;
    const config = {
        mcpServers: {
            [serverName]: {
                command: 'npx',
                args: ['-y', MCP_REMOTE_SPEC, url, '--allow-http']
            }
        }
    };
    return JSON.stringify(config, null, 2);
}

// Copy helper that works over plain HTTP too: navigator.clipboard requires a
// secure (https) context, which this gateway is not, so we fall back to
// selecting the preview textarea and execCommand('copy'). Either way the text
// ends up visible and selected so the admin can Ctrl+C manually if needed.
function copyDesktopConfig(token) {
    const preview = document.getElementById('generated-config-preview');
    const status = document.getElementById('config-gen-status');
    if (!preview) return;
    const json = generateDesktopConfig(token);
    preview.value = json;
    preview.focus();
    preview.select();

    let copied = false;
    try { copied = document.execCommand('copy'); } catch (e) { copied = false; }

    if (status) {
        status.style.color = 'green';
        if (copied) {
            status.textContent = 'Copied to clipboard — paste into their Developer → Edit Config.';
        } else if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(json)
                .then(() => { status.textContent = 'Copied to clipboard.'; })
                .catch(() => { status.textContent = 'Generated below — select all and press Ctrl+C.'; });
        } else {
            status.textContent = 'Generated below — text is selected, press Ctrl+C to copy.';
        }
    }
    preview.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function initializeUsersSection() {
    const copyConfigButton = document.getElementById('copy-generated-config-button');
    if (copyConfigButton && !copyConfigButton.dataset.listenerAttached) {
        copyConfigButton.dataset.listenerAttached = 'true';
        copyConfigButton.addEventListener('click', () => {
            const preview = document.getElementById('generated-config-preview');
            const status = document.getElementById('config-gen-status');
            if (!preview || !preview.value) {
                if (status) { status.style.color = 'orange'; status.textContent = 'Nothing to copy yet — click "Copy Desktop Config" next to a user first.'; }
                return;
            }
            preview.focus();
            preview.select();
            let copied = false;
            try { copied = document.execCommand('copy'); } catch (e) { copied = false; }
            if (status) {
                status.style.color = 'green';
                status.textContent = copied ? 'Copied to clipboard.' : 'Text selected — press Ctrl+C to copy.';
            }
        });
    }

    const addUserForm = document.getElementById('add-user-form');
    const addUserStatus = document.getElementById('add-user-status');
    if (addUserForm && !addUserForm.dataset.listenerAttached) {
        addUserForm.dataset.listenerAttached = 'true';
        addUserForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const usernameInput = document.getElementById('new-username');
            const username = usernameInput.value.trim();
            if (!username) return;
            addUserStatus.textContent = '';
            try {
                const response = await fetch('/admin/users', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username })
                });
                const result = await response.json();
                if (response.ok && result.success) {
                    addUserStatus.style.color = 'green';
                    addUserStatus.textContent = `User '${username}' created.`;
                    usernameInput.value = '';
                    await fetchUserList();
                } else {
                    addUserStatus.style.color = 'red';
                    addUserStatus.textContent = result.error || 'Failed to create user.';
                }
            } catch (error) {
                addUserStatus.style.color = 'red';
                addUserStatus.textContent = `Network error: ${error.message}`;
            }
        });
    }
}

// --- Tool access policy (config/tool_policy.json) ---
// Raw JSON editor. The server validates and refuses anything malformed, so a
// typo here never reaches the file the gateway enforces.
const TOOL_POLICY_EXAMPLE = {
    users: { 'example-user': { allow: ['some-server/*'] } }
};

// Save replaces the whole tool_policy.json with the editor's text, so it is
// allowed only while the editor shows the result of one complete load, with that
// load's revision ("none" when no policy file exists yet). Loads can overlap, so
// each takes a generation number and only the newest may fill the editor,
// enable Save or report an error.
let toolPolicyLoadGeneration = 0;

function invalidateToolPolicySnapshot() {
    window.toolPolicyRevision = null;
    const button = document.getElementById('save-tool-policy-button');
    if (button) button.disabled = true;
}

async function loadToolPolicy() {
    const editor = document.getElementById('tool-policy-editor');
    const status = document.getElementById('tool-policy-status');
    if (!editor) return;
    const generation = ++toolPolicyLoadGeneration;
    const isCurrent = () => generation === toolPolicyLoadGeneration;
    const button = document.getElementById('save-tool-policy-button');
    invalidateToolPolicySnapshot();
    try {
        const response = await fetch('/admin/tool-policy');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        // Sent back on Save: the gateway refuses a save from an older copy (409).
        const revision = response.headers.get('X-Config-Revision');
        if (!revision) throw new Error('the gateway sent no policy revision');
        if (!isCurrent()) return; // a newer load owns the editor
        editor.value = JSON.stringify(data.exists ? data.policy : TOOL_POLICY_EXAMPLE, null, 2);
        window.toolPolicyRevision = revision;
        if (button) button.disabled = false;
        status.style.color = '';
        status.textContent = data.exists ? '' : 'No policy saved: every user has every enabled tool. Edit the example and save to restrict.';
    } catch (error) {
        if (!isCurrent()) return; // a newer load owns the editor
        invalidateToolPolicySnapshot();
        status.style.color = 'red';
        status.textContent = `Error loading policy: ${error.message}`;
    }
}

async function saveToolPolicy() {
    const editor = document.getElementById('tool-policy-editor');
    const status = document.getElementById('tool-policy-status');
    if (!window.toolPolicyRevision) {
        // A failed or unfinished load: the editor may hold an older policy, or nothing.
        status.style.color = 'red';
        status.textContent = 'Not saved: The tool policy has not loaded, so this page has nothing it can safely save. Reload the page.';
        return;
    }
    const generation = toolPolicyLoadGeneration; // a load started meanwhile owns the editor's state
    let parsed;
    try {
        parsed = JSON.parse(editor.value);
    } catch (error) {
        status.style.color = 'red';
        status.textContent = `Not valid JSON: ${error.message}`;
        return;
    }
    try {
        const headers = { 'Content-Type': 'application/json', 'X-Config-Revision': window.toolPolicyRevision };
        const response = await fetch('/admin/tool-policy', {
            method: 'POST',
            headers,
            body: JSON.stringify(parsed)
        });
        const result = await response.json();
        if (response.status === 409) {
            status.style.color = 'red';
            status.textContent = `Not saved: ${result.error}`;
            return;
        }
        if (response.ok && result.success) {
            if (generation === toolPolicyLoadGeneration) {
                window.toolPolicyRevision = response.headers.get('X-Config-Revision') || window.toolPolicyRevision;
            }
            status.style.color = 'green';
            status.textContent = 'Policy saved. It applies to the next request.';
        } else {
            status.style.color = 'red';
            status.textContent = result.error || 'Failed to save policy.';
        }
    } catch (error) {
        status.style.color = 'red';
        status.textContent = `Network error: ${error.message}`;
    }
}

async function loadUserListAndPolicy() {
    await Promise.all([fetchUserList(), loadToolPolicy()]);
}

document.getElementById('save-tool-policy-button')?.addEventListener('click', saveToolPolicy);

window.loadUserList = loadUserListAndPolicy;
window.initializeUsersSection = initializeUsersSection;
