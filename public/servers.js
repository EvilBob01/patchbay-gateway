// --- DOM Elements (Assumed to be globally accessible or passed) ---
const serverListDiv = document.getElementById('server-list');
// saveConfigButton and saveStatus are obtained within initializeServerSaveListener

// --- Server Configuration Management ---
async function loadServerConfig() {
    const localSaveStatus = document.getElementById('save-status'); 
    if (!localSaveStatus || !serverListDiv) {
        console.error("loadServerConfig: Missing essential DOM elements (saveStatus or serverListDiv).");
        return; 
    }
    localSaveStatus.textContent = 'Loading server configuration...';
    try {
        const response = await fetch('/admin/config');
        if (!response.ok) throw new Error(`Failed to fetch server config: ${response.status} ${response.statusText}`);
        window.currentServerConfig = await response.json(); 
        renderServerConfig(window.currentServerConfig);
        // addInstallButtonListeners is called within renderServerConfig after rendering all entries
        localSaveStatus.textContent = 'Server configuration loaded.';
        window.isServerConfigDirty = false; // Reset dirty flag after successful load
        setTimeout(() => { if(localSaveStatus) localSaveStatus.textContent = ''; }, 3000);
    } catch (error) {
        console.error("Error loading server config:", error);
        if(localSaveStatus) localSaveStatus.textContent = `Error loading server configuration: ${error.message}`;
        if(serverListDiv) serverListDiv.innerHTML = '<p class="error-message">Could not load server configuration.</p>';
    }
}

function renderServerConfig(config) {
    if (!serverListDiv) return; 
    serverListDiv.innerHTML = '';
    if (!config || typeof config !== 'object' || !config.mcpServers) {
         serverListDiv.innerHTML = '<p class="error-message">Invalid server configuration format received.</p>';
         return;
    }
    const servers = config.mcpServers;
    Object.keys(servers).sort().forEach(key => {
         renderServerEntry(key, servers[key]);
    });
     addInstallButtonListeners(); // Ensure listeners are (re-)added after full render
     // Cosmetic: apply saved ordering/groups + search/drag toolbar (does not affect MCP).
     if (window.LayoutEnhancer) window.LayoutEnhancer.apply('servers');
     // ssh-mcp host-group filter (public/ssh-policy.js).
     if (window.SshPolicy) window.SshPolicy.afterRender(serverListDiv);
     loadBackendStatus();
}

// --- Backend state (GET /admin/server/status): a dot per backend, plus Reconnect ---
// Deliberately plain; the admin UI redesign will replace it.
async function loadBackendStatus() {
    if (!serverListDiv) return;
    let data;
    try {
        const response = await fetch('/admin/server/status');
        if (!response.ok) return;
        data = await response.json();
    } catch { return; }
    const byName = new Map((data.backends || []).map(b => [b.backend, b]));
    serverListDiv.querySelectorAll('.server-entry').forEach(entry => {
        const badge = entry.querySelector('.backend-state');
        if (!badge) return;
        const s = byName.get(entry.dataset.serverKey);
        entry.dataset.backendState = s ? s.state : 'inactive';
        badge.className = 'backend-state' + (s ? ` backend-state-${s.state}` : '');
        if (!s) { badge.textContent = ''; badge.title = ''; return; }
        badge.textContent = s.state === 'up' ? '' : s.state === 'failed' ? 'failed' : `reconnecting (attempt ${Math.max(1, s.attempt)})`;
        entry.querySelector('.server-header h3').title = badge.title = [
            `${s.state} since ${new Date(s.since).toLocaleString()}`,
            `${s.tools} tool(s)`,
            s.recentCrashes ? `${s.recentCrashes} crash(es) in the last ${data.settings?.flapWindowMin ?? '?'} min` : '',
            s.nextRetryAt ? `next try ${new Date(s.nextRetryAt).toLocaleTimeString()}` : '',
            s.lastError ? `last error: ${s.lastError}` : '',
        ].filter(Boolean).join('\n');
    });
}
window.loadBackendStatus = loadBackendStatus;

async function reconnectBackend(key, button) {
    const status = document.getElementById('save-status');
    button.disabled = true;
    if (status) status.textContent = `Reconnecting ${key}...`;
    try {
        const response = await fetch(`/admin/server/reconnect/${encodeURIComponent(key)}`, { method: 'POST' });
        const body = await response.json().catch(() => ({}));
        if (status) {
            status.textContent = body.success ? `${key} reconnected.`
                : `${key} did not reconnect: ${body.error || body.status?.lastError || response.status}. It will keep retrying.`;
        }
    } catch (error) {
        if (status) status.textContent = `Reconnect failed: ${error.message}`;
    } finally {
        button.disabled = false;
        loadBackendStatus();
    }
}

function renderServerEntry(key, serverConf, startExpanded = false) {
    if (!serverListDiv) return; 
    const entryDiv = document.createElement('div');
    entryDiv.classList.add('server-entry');
    if (!startExpanded) {
        entryDiv.classList.add('collapsed');
    }
    entryDiv.dataset.serverKey = key; 
    entryDiv.dataset.installDirManuallyEdited = 'false'; // Initialize flag

    let type = serverConf.type;
    if (!type) { // Infer type if not explicitly set (for backward compatibility or manual JSON editing)
        if (serverConf.url && !serverConf.command) type = 'sse';
        else if (serverConf.command && !serverConf.url) type = 'stdio';
        else type = 'unknown'; // Or handle as error
    }

    let displayType = 'Unknown';
    if (type === 'sse') displayType = 'SSE';
    else if (type === 'stdio') displayType = 'Stdio';
    else if (type === 'http') displayType = 'HTTP';
    else displayType = String(type).toUpperCase(); // Fallback for unknown but specified types

    entryDiv.dataset.serverType = type; // Store the actual type

    // The templates below are fixed markup only. Every config value goes in
    // afterwards through textContent / .value: an imported display name is
    // untrusted text, and it must never become HTML.
    const headerDiv = document.createElement('div');
    headerDiv.classList.add('server-header');
    // Move Active checkbox to the header, at the beginning
    headerDiv.innerHTML = `
        <label class="inline-label server-active-label" title="Activate/Deactivate Server">
            <input type="checkbox" class="server-active-input">
        </label>
        <h3><span class="server-display-name"></span> (<span class="server-type"></span>)</h3>
        <span class="backend-state" title=""></span>
        <button type="button" class="reconnect-button" title="Close this backend's connection and connect it again">Reconnect</button>
        <button class="delete-button">Delete</button>
    `;
    headerDiv.querySelector('.server-active-input').checked = serverConf.active !== false;
    headerDiv.querySelector('.server-display-name').textContent = serverConf.name || key;
    headerDiv.querySelector('.server-type').textContent = displayType;
    entryDiv.appendChild(headerDiv);

    const detailsDiv = document.createElement('div');
    detailsDiv.classList.add('server-details');

    // Remove Active checkbox from detailsHtml
    let detailsHtml = `
        <div><label>Server Key (Unique ID):</label><input type="text" class="server-key-input" required></div>
        <div><label>Display Name:</label><input type="text" class="server-name-input"></div>
        <div><label class="inline-label" title="List only an activate meta-tool for this backend until a session activates it; the gateway search_tools / call_read / call_write reach it meanwhile"><input type="checkbox" class="server-lazy-input"> Lazy: hide its tools until a session activates them</label></div>
        <div><label>Description (one line, shown in the lazy meta-tools):</label><input type="text" class="server-description-input"></div>
    `;

    let installDirValue = '';
    if (type === 'sse' || type === 'http') {
        detailsHtml += `
            <div><label>URL:</label><input type="url" class="server-url-input" required></div>
            <div><label>API Key (X-Api-Key Header):</label><input type="text" class="server-apikey-input secret-input" title="${SECRET_INPUT_HINT}"></div>
            <div><label>Bearer Token (Authorization Header):</label><input type="text" class="server-bearertoken-input secret-input" title="${SECRET_INPUT_HINT}"></div>
        `;
        // Add any type-specific fields for 'http' if they differ from 'sse' in the future
    } else if (type === 'stdio') {
        const baseInstallPath = (typeof window.effectiveToolsFolder === 'string' && window.effectiveToolsFolder.trim() !== '') ? window.effectiveToolsFolder.trim() : 'tools';
        const defaultInstallDir = `${baseInstallPath}/${key}`;
        installDirValue = String(serverConf.installDirectory !== undefined ? serverConf.installDirectory : defaultInstallDir);

        detailsHtml += `
            <div><label>Command:</label><input type="text" class="server-command-input" required></div>
            <div>
                <label>Arguments:</label> <button type="button" class="server-args-mode-button"></button>
                <textarea class="server-args-input" spellcheck="false"></textarea>
                <small class="server-args-note"></small>
            </div>
            <div>
                <label>Environment Variables:</label>
                <div class="env-vars-container"></div>
                <button type="button" class="add-env-var-button">+ Add Variable</button>
            </div>
            <hr style="margin: 10px 0;">
            <div><label>Install Directory (optional):</label><input type="text" class="server-install-dir-input"></div>
            <div><label>Install Commands (optional, one per line):</label><textarea class="server-install-cmds-input"></textarea></div>
            ${window.featureOn?.('installRunner')
                ? `<button class="install-button">Check/Run Install</button>`
                : `<p class="feature-disabled feature-disabled-message">Running install commands: <span class="feature-off-reason"></span></p>`}
            <div class="install-output" style="display: none; white-space: pre-wrap; background-color: #222; color: #eee; padding: 10px; margin-top: 10px; max-height: 300px; overflow-y: auto; font-family: monospace;"></div>
        `;
    } else {
         detailsHtml += `<p class="error-message server-unknown-type"></p>`;
    }

    detailsDiv.innerHTML = detailsHtml;
    const setValue = (selector, value) => {
        const el = detailsDiv.querySelector(selector);
        if (el) el.value = value === undefined || value === null ? '' : String(value);
    };
    setValue('.server-key-input', key);
    setValue('.server-name-input', serverConf.name);
    detailsDiv.querySelector('.server-lazy-input').checked = serverConf.lazy === true;
    setValue('.server-description-input', serverConf.description);
    if (type === 'sse' || type === 'http') {
        setValue('.server-url-input', serverConf.url);
        setValue('.server-apikey-input', serverConf.apiKey);
        setValue('.server-bearertoken-input', serverConf.bearerToken);
    } else if (type === 'stdio') {
        setValue('.server-command-input', serverConf.command);
        ServerArgs.setup(detailsDiv, Array.isArray(serverConf.args) ? serverConf.args : []);
        setValue('.server-install-dir-input', installDirValue);
        setValue('.server-install-cmds-input', (serverConf.installCommands || []).join('\n'));
        const button = detailsDiv.querySelector('.install-button');
        if (button) {
            button.dataset.serverKey = key;
            button.disabled = !installDirValue.trim();
            if (button.disabled) button.title = 'Install directory must be set to enable install button';
        }
        const reason = detailsDiv.querySelector('.feature-off-reason');
        if (reason) reason.textContent = window.featureOffMessage?.('installRunner') || 'Disabled by the administrator.';
        detailsDiv.querySelector('.install-output').id = `install-output-${key}`;
    } else {
        detailsDiv.querySelector('.server-unknown-type').textContent = `Warning: Unknown server type configuration ('${type}').`;
    }
    entryDiv.appendChild(detailsDiv);
    detailsDiv.querySelectorAll('.secret-input').forEach(selectMaskedOnFocus);

    const envVarsContainer = detailsDiv.querySelector('.env-vars-container');
    if (envVarsContainer && serverConf.env && typeof serverConf.env === 'object') {
        Object.entries(serverConf.env).forEach(([envKey, envValue]) => {
            addEnvVarRow(envVarsContainer, envKey, String(envValue));
        });
    }

    const addEnvVarButton = detailsDiv.querySelector('.add-env-var-button');
    if (addEnvVarButton) {
        addEnvVarButton.addEventListener('click', () => {
            addEnvVarRow(envVarsContainer);
            window.isServerConfigDirty = true;
        });
    }

    headerDiv.querySelector('h3').addEventListener('click', () => entryDiv.classList.toggle('collapsed'));
    headerDiv.querySelector('h3').style.cursor = 'pointer';

    headerDiv.querySelector('.reconnect-button').addEventListener('click', (e) => {
        e.stopPropagation();
        reconnectBackend(key, e.currentTarget);
    });

    headerDiv.querySelector('.delete-button').addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Are you sure you want to delete server "${serverConf.name || key}"?`)) {
            entryDiv.remove();
            window.isServerConfigDirty = true; 
        }
    });

    const installButton = detailsDiv.querySelector('.install-button');
    const installDirInput = detailsDiv.querySelector('.server-install-dir-input');

    const serverTypeFromDataset = entryDiv.dataset.serverType;
    if (serverTypeFromDataset === 'stdio' && installDirInput) {
        installDirInput.addEventListener('input', () => {
            entryDiv.dataset.installDirManuallyEdited = 'true'; // User is manually editing
            window.isServerConfigDirty = true; 
            if (installButton) {
                const hasDir = !!installDirInput.value.trim();
                installButton.disabled = !hasDir;
                installButton.title = installButton.disabled ? 'Install directory must be set to enable install button' : '';
            }
        });
    }
    
    const keyInput = detailsDiv.querySelector('.server-key-input');
    if (serverTypeFromDataset === 'stdio' && keyInput && installDirInput) {
        keyInput.addEventListener('input', () => {
            window.isServerConfigDirty = true;
            const currentKey = keyInput.value.trim();
            
            if (entryDiv.dataset.installDirManuallyEdited !== 'true') {
                if (currentKey) {
                    const currentBaseInstallPath = (typeof window.effectiveToolsFolder === 'string' && window.effectiveToolsFolder.trim() !== '') ? window.effectiveToolsFolder.trim() : 'tools';
                    const newDynamicDefaultInstallDir = `${currentBaseInstallPath}/${currentKey}`;
                    installDirInput.value = newDynamicDefaultInstallDir;
                    if (installButton) {
                         installButton.disabled = !newDynamicDefaultInstallDir.trim();
                         installButton.title = installButton.disabled ? 'Install directory must be set to enable install button' : '';
                   }
                } else { 
                    installDirInput.value = '';
                    if (installButton) {
                        installButton.disabled = true;
                        installButton.title = 'Install directory must be set to enable install button';
                    }
                }
            }
        });
    }
    
    detailsDiv.querySelectorAll('input:not(.server-key-input):not(.server-install-dir-input), textarea').forEach(input => {
        input.addEventListener('input', () => { window.isServerConfigDirty = true; });
    });
    detailsDiv.querySelectorAll('input[type="checkbox"]').forEach(input => {
        input.addEventListener('change', () => { window.isServerConfigDirty = true; });
    });
    // Server key and install dir already have specific listeners that set dirty flag

    // ssh-mcp backends: host-group badges and policy section (public/ssh-policy.js).
    if (window.SshPolicy) window.SshPolicy.decorate(entryDiv, serverConf);

    serverListDiv.appendChild(entryDiv);
}

function addInstallButtonListeners() {
    document.querySelectorAll('.install-button').forEach(button => {
        const newButton = button.cloneNode(true); 
        button.parentNode.replaceChild(newButton, button);
        newButton.addEventListener('click', () => {
            const serverKey = newButton.dataset.serverKey;
            if (serverKey) {
                handleInstallClick(serverKey); 
            } else {
                console.error("Install button clicked but serverKey is missing.");
            }
        });
    });
}

// Secrets arrive masked from GET /admin/config ("••••••abcd (40 chars)"). Saving
// a masked value unchanged keeps the stored secret; to change it, replace the
// whole value -- so focusing a masked field selects it all for overtyping.
const SECRET_INPUT_HINT = 'Masked: leave as is to keep the stored value, or replace it entirely';

function selectMaskedOnFocus(input) {
    if (!input) return;
    input.addEventListener('focus', () => { if (input.value.includes('••••••')) input.select(); });
}

// --- Arguments editor ---
// A backend's argv must survive a save exactly: an empty argument, or one with
// leading or trailing spaces, can mean something to it. So:
//  - untouched, the editor saves the very array it was rendered from;
//  - "lines" mode (one per line, trimmed, blank lines skipped) is offered only
//    for lists it can show without loss;
//  - anything else is edited as a JSON array of strings, which also carries a
//    line break inside an argument (written "\n").
// ssh-policy.js reads and rewrites args through read()/write() as well.
const ServerArgs = (() => {
    const JSON_NOTE = 'Shown as a JSON array: an argument is empty, has leading or trailing spaces, or contains a line break, which one-per-line cannot show.';
    const fitsLines = (args) => args.every(a => typeof a === 'string' && a !== '' && a.trim() === a && !/[\r\n]/.test(a));
    const format = (args, mode) => mode === 'lines' ? args.join('\n') : JSON.stringify(args, null, 2);

    function parse(ta) {
        if (ta.dataset.argsMode === 'lines') return ta.value.split(/\r?\n/).map(a => a.trim()).filter(a => a);
        let args;
        try { args = JSON.parse(ta.value.trim() || '[]'); } catch (e) { throw new Error(`must be a JSON array of strings (${e.message})`); }
        if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) throw new Error('must be a JSON array of strings');
        return args;
    }

    function show(container, args, mode) {
        const ta = container.querySelector('.server-args-input');
        ta.dataset.argsMode = mode;
        ta.value = format(args, mode);
        ta.rows = Math.min(12, Math.max(2, ta.value.split('\n').length));
        const button = container.querySelector('.server-args-mode-button');
        if (button) button.textContent = mode === 'lines' ? 'Edit as JSON' : 'Edit as lines';
        const label = button?.previousElementSibling;
        if (label) label.textContent = mode === 'lines' ? 'Arguments (one per line):' : 'Arguments (JSON array of strings):';
    }

    function note(container, text) {
        const el = container.querySelector('.server-args-note');
        if (el) el.textContent = text;
    }

    /** Fill the editor in `container` (an entry's details) with `args`. */
    function setup(container, args) {
        const ta = container.querySelector('.server-args-input');
        if (!ta) return;
        ta._originalArgs = args.slice();
        ta.dataset.argsEdited = 'false';
        const mode = fitsLines(args) ? 'lines' : 'json';
        show(container, args, mode);
        note(container, mode === 'json' ? JSON_NOTE : '');
        ta.addEventListener('input', () => { ta.dataset.argsEdited = 'true'; });
        const button = container.querySelector('.server-args-mode-button');
        if (button) button.addEventListener('click', () => {
            let args;
            try { args = parse(ta); } catch (e) { note(container, `Fix the arguments first: they ${e.message}.`); return; }
            if (ta.dataset.argsMode === 'json') {
                if (!fitsLines(args)) { note(container, JSON_NOTE); return; }
                show(container, args, 'lines');
                note(container, '');
            } else {
                show(container, args, 'json');
                note(container, '');
            }
        });
    }

    /** The entry's args: the original array if untouched, else parsed. Throws on bad JSON. */
    function read(entryDiv) {
        const ta = entryDiv.querySelector('.server-args-input');
        if (!ta) return [];
        if (ta.dataset.argsEdited !== 'true' && Array.isArray(ta._originalArgs)) return ta._originalArgs.slice();
        return parse(ta);
    }

    /** Replace the entry's args (as an edit: marks it changed). */
    function write(entryDiv, args) {
        const ta = entryDiv.querySelector('.server-args-input');
        if (!ta) return;
        const mode = ta.dataset.argsMode === 'lines' && fitsLines(args) ? 'lines' : 'json';
        show(ta.closest('.server-details') || entryDiv, args, mode);
        if (mode === 'json') note(ta.closest('.server-details') || entryDiv, JSON_NOTE);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    }

    return { setup, read, write, fitsLines };
})();
window.ServerArgs = ServerArgs;

function addEnvVarRow(container, key = '', value = '') {
    if (!container) return;
    const rowDiv = document.createElement('div');
    rowDiv.classList.add('env-var-row');
    rowDiv.innerHTML = `
        <input type="text" class="env-key-input" placeholder="Key">
        <span>=</span>
        <input type="text" class="env-value-input secret-input" placeholder="Value" title="${SECRET_INPUT_HINT}">
        <button type="button" class="delete-env-var-button">X</button>
    `;
    rowDiv.querySelector('.env-key-input').value = key;
    rowDiv.querySelector('.env-value-input').value = value;
    selectMaskedOnFocus(rowDiv.querySelector('.env-value-input'));
    rowDiv.querySelector('.delete-env-var-button').addEventListener('click', () => {
        rowDiv.remove();
        window.isServerConfigDirty = true; 
    });
    rowDiv.querySelectorAll('input').forEach(input => {
        input.addEventListener('input', () => { window.isServerConfigDirty = true; });
    });
    container.appendChild(rowDiv);
}

async function handleInstallClick(serverKey) {
    if (window.isServerConfigDirty === true) { 
        alert("Configuration has unsaved changes. Please save the server configuration before installing.");
        return;
    }

    const installButton = [...document.querySelectorAll('.install-button')].find(b => b.dataset.serverKey === serverKey);
    const outputElement = typeof window.getInstallOutputElement === 'function' ? window.getInstallOutputElement(serverKey) : document.getElementById(`install-output-${serverKey}`);

    if (!outputElement || !installButton) {
        console.error(`Could not find install button or output area for ${serverKey}`);
        return;
    }

    if (!window.adminEventSource || window.adminEventSource.readyState !== EventSource.OPEN) {
         console.log("Admin SSE not connected, attempting to connect before install...");
         if (typeof window.connectAdminSSE === 'function') {
            window.connectAdminSSE(); 
         } else {
             console.error("connectAdminSSE function not found.");
             if(typeof window.appendToInstallOutput === 'function') {
                window.appendToInstallOutput(serverKey, "Error: Cannot establish connection for live updates.\n", true);
             }
             return;
         }
    }

    outputElement.innerHTML = ''; 
    outputElement.style.display = 'block'; 
    if(typeof window.appendToInstallOutput === 'function') {
        window.appendToInstallOutput(serverKey, `Starting installation check for ${serverKey}...\n`);
    }
    installButton.disabled = true;
    installButton.textContent = 'Installing...';

    try {
        const response = await fetch(`/admin/server/install/${encodeURIComponent(serverKey)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        const result = await response.json();

        if (!response.ok || !result.success) {
            const errorMsg = `Error starting installation process: ${result.error || response.statusText}\n`;
            if(typeof window.appendToInstallOutput === 'function') window.appendToInstallOutput(serverKey, errorMsg, true);
            installButton.disabled = false; 
            installButton.textContent = 'Install Failed';
            return;
        }
        if(typeof window.appendToInstallOutput === 'function') {
            window.appendToInstallOutput(serverKey, `Installation process initiated. Waiting for live output via SSE...\n`);
        }
    } catch (error) {
        console.error(`Error initiating installation for ${serverKey}:`, error);
        const errorMsg = `Network error initiating installation: ${error.message}\n`;
        if(typeof window.appendToInstallOutput === 'function') window.appendToInstallOutput(serverKey, errorMsg, true);
        installButton.disabled = false; 
        installButton.textContent = 'Install Failed';
    }
}


function initializeServerSaveListener() {
    const localSaveConfigButton = document.getElementById('save-config-button');
    const localServerListDiv = document.getElementById('server-list');
    const localSaveStatus = document.getElementById('save-status');

    if (!localSaveConfigButton || !localServerListDiv || !localSaveStatus) {
        console.error("Save listener setup failed: Missing crucial DOM elements for servers section.");
        return;
    }

    localSaveConfigButton.addEventListener('click', async () => {
        localSaveStatus.textContent = 'Saving server configuration...';
        localSaveStatus.style.color = 'orange';
        // POST /admin/config replaces the whole file, so carry over the top-level
        // settings this tab doesn't edit (proxy retries, serverToolnameSeparator,
        // ...); only mcpServers is rebuilt from the form.
        const newConfig = { ...(window.currentServerConfig || {}), mcpServers: {} };
        const entries = localServerListDiv.querySelectorAll('.server-entry');
        let isValid = true;
        let errorMsg = '';

        entries.forEach(entryDiv => {
            if (!isValid) return;

            const newKeyInput = entryDiv.querySelector('.server-key-input');
            const newKey = newKeyInput.value.trim();

            if (!newKey) {
                isValid = false; errorMsg = 'Server Key cannot be empty.'; newKeyInput.style.border = '1px solid red'; return;
            } else { newKeyInput.style.border = ''; }

            if (newConfig.mcpServers.hasOwnProperty(newKey)) {
                 isValid = false; errorMsg = `Duplicate Server Key: "${newKey}".`; newKeyInput.style.border = '1px solid red'; return;
            }

            const nameInput = entryDiv.querySelector('.server-name-input');
            const activeInput = entryDiv.querySelector('.server-active-input');
            const urlInput = entryDiv.querySelector('.server-url-input');
            const apiKeyInput = entryDiv.querySelector('.server-apikey-input');
            const bearerTokenInput = entryDiv.querySelector('.server-bearertoken-input');
            const commandInput = entryDiv.querySelector('.server-command-input');
            const argsInput = entryDiv.querySelector('.server-args-input');
            const envVarsContainer = entryDiv.querySelector('.env-vars-container');
            const installDirInputFromForm = entryDiv.querySelector('.server-install-dir-input'); // Renamed to avoid conflict
            const installCmdsInput = entryDiv.querySelector('.server-install-cmds-input');

            const serverType = entryDiv.dataset.serverType || (urlInput ? 'sse' : (commandInput ? 'stdio' : 'unknown'));
            const serverData = {
                name: nameInput.value.trim() || undefined,
                active: activeInput.checked,
                type: serverType
            };
            // Lets the server find a renamed backend's stored secrets; not saved.
            if (entryDiv.dataset.serverKey && entryDiv.dataset.serverKey !== newKey) serverData._originalKey = entryDiv.dataset.serverKey;
            const lazyInput = entryDiv.querySelector('.server-lazy-input');
            const descriptionInput = entryDiv.querySelector('.server-description-input');
            if (lazyInput && lazyInput.checked) serverData.lazy = true;
            const description = descriptionInput ? descriptionInput.value.trim() : '';
            if (description) serverData.description = description;

            if (serverType === 'sse' || serverType === 'http') {
                serverData.url = urlInput.value.trim();
                if (!serverData.url) { isValid = false; errorMsg = `URL required for ${serverType.toUpperCase()} server "${newKey}".`; urlInput.style.border = '1px solid red'; }
                else { urlInput.style.border = ''; }
                const apiKey = apiKeyInput.value.trim();
                const bearerToken = bearerTokenInput.value.trim();
                if (apiKey) serverData.apiKey = apiKey;
                if (bearerToken) serverData.bearerToken = bearerToken;
            } else if (serverType === 'stdio') {
                serverData.command = commandInput.value.trim();
                if (!serverData.command) { isValid = false; errorMsg = `Command required for Stdio server "${newKey}".`; commandInput.style.border = '1px solid red'; }
                else { commandInput.style.border = ''; }
                // Exactly as entered, or the original array if untouched (ServerArgs above).
                try {
                    serverData.args = ServerArgs.read(entryDiv);
                    argsInput.style.border = '';
                } catch (e) {
                    isValid = false; errorMsg = `Arguments for "${newKey}" ${e.message}.`; argsInput.style.border = '1px solid red'; return;
                }
                serverData.env = {};
                if (envVarsContainer) {
                    envVarsContainer.querySelectorAll('.env-var-row').forEach(row => {
                        const envKeyInput = row.querySelector('.env-key-input');
                        const envValueInput = row.querySelector('.env-value-input');
                        const key = envKeyInput.value.trim();
                        const value = envValueInput.value; // Keep value as is, don't trim
                        if (key) {
                            if (serverData.env.hasOwnProperty(key)) {
                                isValid = false; errorMsg = `Duplicate env key "${key}" for server "${newKey}".`;
                                envKeyInput.style.border = '1px solid red';
                            } else { serverData.env[key] = value; envKeyInput.style.border = '';}
                        } else if (value) { // Only error if value is present but key is not
                             isValid = false; errorMsg = `Env key cannot be empty if value is set for server "${newKey}".`;
                             envKeyInput.style.border = '1px solid red';
                        } else {
                            envKeyInput.style.border = ''; // Clear border if both are empty
                        }
                    });
                }
                if (!isValid) return; // Exit early if env var validation failed
                if (installDirInputFromForm && installCmdsInput) {
                    const installDir = installDirInputFromForm.value.trim();
                    const installCmds = installCmdsInput.value.trim().split('\n').map(cmd => cmd.trim()).filter(cmd => cmd);
                    if (installDir) {
                         serverData.installDirectory = installDir;
                         serverData.installCommands = installCmds; // Can be empty array
                    } else if (installCmds.length > 0) { // Only error if commands exist but dir doesn't
                         isValid = false; errorMsg = `Install Directory required if Install Commands provided for "${newKey}".`;
                         installDirInputFromForm.style.border = '1px solid red';
                    } else {
                        if (installDirInputFromForm) installDirInputFromForm.style.border = ''; // Clear border if both are empty
                    }
                }
            } else {
                 isValid = false; errorMsg = `Unknown or unhandled server type "${serverType}" for server "${newKey}".`;
                 const header = entryDiv.querySelector('.server-header');
                 if(header) header.style.border = '1px solid red';
            }

            if (isValid) {
                 newConfig.mcpServers[newKey] = serverData;
                 const header = entryDiv.querySelector('.server-header');
                 if(header) header.style.border = '';
            }
        });

        if (!isValid) {
            localSaveStatus.textContent = `Error: ${errorMsg}`;
            localSaveStatus.style.color = 'red';
            setTimeout(() => { if(localSaveStatus) localSaveStatus.textContent = ''; localSaveStatus.style.color = 'green'; }, 5000);
            return;
        }

        try {
            const response = await fetch('/admin/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newConfig)
            });
            const result = await response.json();
            if (response.ok && result.success) {
                localSaveStatus.textContent = 'Server configuration saved successfully.';
                localSaveStatus.style.color = 'green';
                // The server answers with the saved config re-masked, so freshly
                // typed secrets don't stay on screen in full.
                window.currentServerConfig = result.config || newConfig;
                window.isServerConfigDirty = false; 
                renderServerConfig(window.currentServerConfig); 
                if (typeof window.triggerReload === 'function') {
                    await window.triggerReload(localSaveStatus);
                } else {
                     console.error("triggerReload function not found.");
                     localSaveStatus.textContent += ' Reload trigger function not found!';
                     localSaveStatus.style.color = 'red';
                     setTimeout(() => { if(localSaveStatus) localSaveStatus.textContent = ''; localSaveStatus.style.color = 'green'; }, 7000);
                }
            } else {
                localSaveStatus.textContent = `Error saving: ${result.error || response.statusText}`;
                localSaveStatus.style.color = 'red';
                 setTimeout(() => { if(localSaveStatus) localSaveStatus.textContent = ''; localSaveStatus.style.color = 'green'; }, 5000);
            }
        } catch (error) {
            localSaveStatus.textContent = `Network error saving: ${error.message}`;
            localSaveStatus.style.color = 'red';
             setTimeout(() => { if(localSaveStatus) localSaveStatus.textContent = ''; localSaveStatus.style.color = 'green'; }, 5000);
        }
    });
}

// Expose functions to be called from script.js
window.loadServerConfig = loadServerConfig;
window.renderServerEntry = renderServerEntry; // Keep this exposed if script.js uses it directly
window.addInstallButtonListeners = addInstallButtonListeners;
window.handleInstallClick = handleInstallClick;
window.initializeServerSaveListener = initializeServerSaveListener;

// --- Helper function to add a new server entry of a specific type ---
// This can be called by buttons in index.html (via script.js)
window.addNewServerEntry = function(type) {
    if (!serverListDiv) {
        console.error("Cannot add new server: serverListDiv not found.");
        return;
    }
    let newKeyNumber = 1;
    while (window.currentServerConfig && window.currentServerConfig.mcpServers && window.currentServerConfig.mcpServers.hasOwnProperty(`new_${type}_server_${newKeyNumber}`)) {
        newKeyNumber++;
    }
    const newKey = `new_${type}_server_${newKeyNumber}`;

    const defaultConfig = {
        name: `New ${type.toUpperCase()} Server`,
        active: true,
        type: type
    };

    if (type === 'stdio') {
        defaultConfig.command = "";
        defaultConfig.args = [];
        defaultConfig.env = {};
    } else if (type === 'sse' || type === 'http') {
        defaultConfig.url = "";
    }
    
    // Add to current config in memory (optional, but good for consistency if not saving immediately)
    if (!window.currentServerConfig) window.currentServerConfig = { mcpServers: {} };
    if (!window.currentServerConfig.mcpServers) window.currentServerConfig.mcpServers = {};
    window.currentServerConfig.mcpServers[newKey] = defaultConfig;

    renderServerEntry(newKey, defaultConfig, true); // Render expanded
    window.isServerConfigDirty = true;
    const newEntryDiv = serverListDiv.querySelector(`.server-entry[data-server-key="${newKey}"]`);
    if (newEntryDiv) {
        newEntryDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const keyInput = newEntryDiv.querySelector('.server-key-input');
        if(keyInput) keyInput.focus();
    }
}

console.log("servers.js loaded");