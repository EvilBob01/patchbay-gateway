// --- Add Server wizard ---
// Guided flow that builds a server config entry, optionally deploys the gateway's
// SSH key to the target host, then hands off to the existing renderServerEntry +
// Save & Reload machinery in servers.js.
(function () {
    let step = 1;
    const TOTAL = 4;

    const $ = (id) => document.getElementById(id);
    const modal = () => $('wizard-modal');

    function wzType() {
        const r = document.querySelector('input[name="wz-type"]:checked');
        return r ? r.value : 'ssh';
    }
    function isSsh() { return wzType() === 'ssh'; }
    function isNpm() { return wzType() === 'npm'; }

    function setError(msg) {
        const e = $('wizard-error');
        if (e) e.textContent = msg || '';
    }

    function showPane(n) {
        document.querySelectorAll('.wizard-pane').forEach(p => {
            p.style.display = (Number(p.dataset.pane) === n) ? 'block' : 'none';
        });
        document.querySelectorAll('.wstep').forEach(s => {
            const sn = Number(s.dataset.step);
            s.classList.toggle('active', sn === n);
            s.classList.toggle('done', sn < n);
        });
        // Back button
        $('wz-back').style.visibility = (n === 1) ? 'hidden' : 'visible';
        // Next vs Finish
        $('wz-next').style.display = (n === TOTAL) ? 'none' : 'inline-flex';
        $('wz-finish').style.display = (n === TOTAL) ? 'inline-flex' : 'none';
    }

    // Toggle field groups on step 2/3 based on chosen type.
    function syncTypeFields() {
        const ssh = isSsh(), npm = isNpm();
        const url = !ssh && !npm; // sse / http
        document.querySelectorAll('.wz-ssh-fields').forEach(el => el.style.display = ssh ? 'block' : 'none');
        document.querySelectorAll('.wz-npm-fields').forEach(el => el.style.display = npm ? 'block' : 'none');
        document.querySelectorAll('.wz-url-fields').forEach(el => el.style.display = url ? 'block' : 'none');
        document.querySelectorAll('.wz-ssh-access').forEach(el => el.style.display = ssh ? 'block' : 'none');
        document.querySelectorAll('.wz-url-access').forEach(el => el.style.display = ssh ? 'none' : 'block');
    }

    function validate(n) {
        setError('');
        if (n === 1) {
            const name = $('wz-name').value.trim();
            if (!name) { setError('Give the server a name.'); return false; }
            if (!/^[a-zA-Z0-9._-]+$/.test(name)) { setError('Name can only use letters, numbers, dot, dash, underscore (no spaces).'); return false; }
            return true;
        }
        if (n === 2) {
            if (isSsh()) {
                if (!$('wz-host').value.trim()) { setError('Enter the host / IP.'); return false; }
                if (!$('wz-user').value.trim()) { setError('Enter the SSH username.'); return false; }
                if (!$('wz-key').value.trim()) { setError('Enter the SSH key path.'); return false; }
            } else if (isNpm()) {
                if (!$('wz-npm-package').value.trim()) { setError('Enter the npm package name.'); return false; }
            } else {
                if (!$('wz-url').value.trim()) { setError('Enter the server URL.'); return false; }
            }
            return true;
        }
        return true;
    }

    // Build { key, conf } from the current inputs.
    function buildConfig() {
        const key = $('wz-name').value.trim();
        if (isSsh()) {
            const host = $('wz-host').value.trim();
            const port = ($('wz-port').value.trim() || '22');
            const user = $('wz-user').value.trim();
            const keyPath = $('wz-key').value.trim();
            return {
                key,
                conf: {
                    type: 'stdio',
                    name: key,
                    active: true,
                    command: 'npx',
                    args: ['ssh-mcp', '-y', '--', `--host=${host}`, `--port=${port}`, `--user=${user}`, `--key=${keyPath}`, '--maxChars=none', '--timeout=600000'],
                    env: {},
                    installDirectory: '' // ssh-mcp needs no install dir; keep config clean
                }
            };
        }
        if (isNpm()) {
            const pkg = $('wz-npm-package').value.trim();
            const extra = $('wz-npm-args').value.trim() ? $('wz-npm-args').value.trim().split(/\s+/) : [];
            const env = {};
            $('wz-npm-env').value.split('\n').forEach(line => {
                const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
                if (m) env[m[1]] = m[2];
            });
            return {
                key,
                conf: {
                    type: 'stdio', name: key, active: true,
                    command: 'npx', args: ['-y', pkg, ...extra],
                    env, installDirectory: ''
                }
            };
        }
        const conf = { type: wzType(), name: key, active: true, url: $('wz-url').value.trim() };
        const bearer = $('wz-bearer').value.trim();
        if (bearer) conf.bearerToken = bearer;
        return { key, conf };
    }

    function updateReview() {
        const { key, conf } = buildConfig();
        $('wz-review').value = JSON.stringify({ [key]: conf }, null, 2);
    }

    function goStep(n) {
        if (n > step && !validate(step)) return;   // validate when advancing
        step = Math.max(1, Math.min(TOTAL, n));
        if (step === 2 || step === 3) syncTypeFields();
        if (step === 3 && !isSsh()) { /* url: nothing to do */ }
        if (step === 4) updateReview();
        showPane(step);
    }

    function openWizard() {
        step = 1;
        setError('');
        // reset fields
        ['wz-name', 'wz-host', 'wz-user', 'wz-url', 'wz-bearer', 'wz-password', 'wz-npm-package', 'wz-npm-args', 'wz-npm-env'].forEach(id => { const el = $(id); if (el) el.value = ''; });
        $('wz-port').value = '22';
        $('wz-key').value = window.gatewaySshKeyPath || '';
        const sshRadio = document.querySelector('input[name="wz-type"][value="ssh"]');
        if (sshRadio) sshRadio.checked = true;
        const trustYes = document.querySelector('input[name="wz-trust"][value="yes"]');
        if (trustYes) trustYes.checked = true;
        $('wz-deploy-fields').style.display = 'none';
        $('wz-deploy-status').textContent = '';
        syncTypeFields();
        showPane(1);
        modal().style.display = 'flex';
        $('wz-name').focus();
    }
    function closeWizard() { modal().style.display = 'none'; }

    async function runDeployKey() {
        const host = $('wz-host').value.trim();
        const port = $('wz-port').value.trim() || '22';
        const username = $('wz-user').value.trim();
        const password = $('wz-password').value;
        const status = $('wz-deploy-status');
        if (!password) { status.style.color = 'var(--danger)'; status.textContent = 'Enter the password first.'; return; }
        status.style.color = 'var(--warning)';
        status.textContent = `Installing key on ${username}@${host}…`;
        try {
            const res = await fetch('/admin/deploy-key', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host, port, username, password })
            });
            const result = await res.json();
            if (res.ok && result.success) {
                status.style.color = 'var(--success)';
                status.textContent = '✓ ' + (result.message || 'Key installed.');
                $('wz-password').value = '';
            } else {
                status.style.color = 'var(--danger)';
                status.textContent = 'Failed: ' + (result.error || res.statusText);
            }
        } catch (e) {
            status.style.color = 'var(--danger)';
            status.textContent = 'Network error: ' + e.message;
        }
    }

    async function finish() {
        const { key, conf } = buildConfig();
        if (typeof window.renderServerEntry !== 'function') { setError('Internal error: server list not ready.'); return; }
        // Guard against clobbering an existing server key.
        const existing = document.querySelector(`.server-entry .server-key-input[value="${key}"]`);
        if (existing) { setError(`A server named "${key}" already exists — pick another name.`); goStep(1); return; }
        window.renderServerEntry(key, conf, true);
        if (typeof window.addInstallButtonListeners === 'function') window.addInstallButtonListeners();
        window.isServerConfigDirty = true;
        closeWizard();
        // Hand off to the existing Save & Reload flow.
        const saveBtn = document.getElementById('save-config-button');
        if (saveBtn) saveBtn.click();
    }

    // Open the wizard pre-filled for a catalog (npm) entry, landing on step 2 so
    // the admin can set any required options (a path, an API token) before saving.
    function openWizardWithPackage(entry) {
        openWizard();
        if (entry.installType === 'sse' || entry.installType === 'http') {
            const radio = document.querySelector('input[name="wz-type"][value="' + entry.installType + '"]');
            if (radio) radio.checked = true;
            $('wz-name').value = entry.name || '';
            $('wz-url').value = entry.url || '';
            syncTypeFields();
            goStep(2);
            return;
        }
        const npmRadio = document.querySelector('input[name="wz-type"][value="npm"]');
        if (npmRadio) npmRadio.checked = true;
        $('wz-name').value = entry.name || (entry.package || '').split('/').pop();
        $('wz-npm-package').value = entry.package || '';
        $('wz-npm-args').value = (entry.args || []).join(' ');
        $('wz-npm-env').value = (entry.env || []).map(e => (typeof e === 'string' ? e : e.key) + '=').join('\n');
        syncTypeFields();
        goStep(2);
    }

    // --- Catalog (full page: official registry + npm, cached icons) ---
    function escapeHtmlW(s) { const d = document.createElement('div'); d.textContent = (s == null ? '' : s); return d.innerHTML; }

    const catState = { curated: [], external: [], page: 0, perPage: 24 };

    // Self-contained letter-avatar (no external image) — used as the fallback.
    function letterIconEl(label, seed) {
        const ch = ((label || '?').trim()[0] || '?').toUpperCase();
        let h = 0; const s = seed || label || '';
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
        const d = document.createElement('div');
        d.className = 'catalog-icon';
        d.style.background = 'hsl(' + (Math.abs(h) % 360) + ' 52% 46%)';
        d.textContent = ch;
        return d;
    }
    // Cached GitHub-avatar icon served same-origin; falls back to the letter tile.
    function iconEl(entry) {
        const label = entry.name || entry.package || '?';
        const seed = entry.package || entry.url || label;
        if (entry.repoOwner) {
            const img = document.createElement('img');
            img.className = 'catalog-icon';
            img.loading = 'lazy';
            img.alt = '';
            img.src = '/admin/catalog/icon/' + encodeURIComponent(entry.repoOwner);
            img.addEventListener('error', () => img.replaceWith(letterIconEl(label, seed)));
            return img;
        }
        return letterIconEl(label, seed);
    }

    async function loadCatalog(force) {
        const status = $('catalog-status');
        if (status) { status.style.color = ''; status.textContent = 'Loading from the official registry + npm…'; }
        try {
            const res = await fetch('/admin/catalog' + (force ? '?refresh=1' : ''));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            catState.curated = data.curated || [];
            catState.external = data.external || [];
            catState.page = 0;
            renderCatalog();
        } catch (e) {
            if (status) { status.style.color = 'var(--danger)'; status.textContent = 'Failed to load catalog: ' + e.message; }
        }
    }

    function filteredCatalog() {
        const q = ($('catalog-search') && $('catalog-search').value.trim().toLowerCase()) || '';
        const src = ($('catalog-filter') && $('catalog-filter').value) || 'all';
        let items = [];
        if (src === 'all' || src === 'curated') items = items.concat(catState.curated.map(e => ({ e, kind: 'curated' })));
        if (src !== 'curated') {
            let ext = catState.external;
            if (src === 'registry') ext = ext.filter(e => e.source === 'registry');
            else if (src === 'npm') ext = ext.filter(e => e.source === 'npm');
            items = items.concat(ext.map(e => ({ e, kind: 'external' })));
        }
        if (q) items = items.filter(({ e }) => (e.name + ' ' + e.package + ' ' + e.description).toLowerCase().includes(q));
        return items;
    }

    function renderCatalog() {
        const grid = $('catalog-grid'); const pager = $('catalog-pager'); const status = $('catalog-status');
        if (!grid) return;
        const items = filteredCatalog();
        const pages = Math.max(1, Math.ceil(items.length / catState.perPage));
        if (catState.page >= pages) catState.page = 0;
        const start = catState.page * catState.perPage;
        const pageItems = items.slice(start, start + catState.perPage);
        grid.innerHTML = '';
        if (!pageItems.length) grid.innerHTML = '<p class="wizard-hint">No connectors match.</p>';
        pageItems.forEach(({ e, kind }) => grid.appendChild(catalogCard(e, kind)));
        if (status) { status.style.color = ''; status.textContent = items.length + ' connector' + (items.length === 1 ? '' : 's') + ' shown (' + catState.curated.length + ' curated · ' + catState.external.length + ' external available)'; }
        pager.innerHTML = '';
        if (pages > 1) {
            const mk = (label, disabled, fn) => { const b = document.createElement('button'); b.className = 'add-button'; b.textContent = label; b.disabled = disabled; if (!disabled) b.addEventListener('click', fn); return b; };
            pager.appendChild(mk('← Prev', catState.page === 0, () => { catState.page--; renderCatalog(); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
            const info = document.createElement('span'); info.className = 'catalog-pageinfo'; info.textContent = 'Page ' + (catState.page + 1) + ' / ' + pages; pager.appendChild(info);
            pager.appendChild(mk('Next →', catState.page >= pages - 1, () => { catState.page++; renderCatalog(); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
        }
    }

    function catalogCard(entry, kind) {
        const card = document.createElement('div');
        card.className = 'catalog-card';
        const srcBadge = kind === 'external' ? ' <span class="catalog-badge ext">' + escapeHtmlW(entry.source || 'external') + '</span>' : '';
        const typeBadge = (entry.installType && entry.installType !== 'npm') ? ' <span class="catalog-badge">' + escapeHtmlW(entry.installType) + '</span>' : '';
        const actions = kind === 'curated'
            ? '<div class="catalog-actions"><button class="add-button catalog-add">Add</button><button class="delete-button catalog-remove" title="Remove from the curated list">Remove</button></div>'
            : '<button class="add-button catalog-add">Approve &amp; add</button>';
        card.innerHTML =
            '<div class="catalog-info">' +
            '<div class="catalog-name">' + escapeHtmlW(entry.name || entry.package || entry.url) +
            (entry.needsConfig ? ' <span class="catalog-badge">needs setup</span>' : '') + srcBadge + typeBadge + '</div>' +
            '<div class="catalog-desc">' + escapeHtmlW(entry.description || '') + '</div>' +
            '<code class="catalog-pkg">' + escapeHtmlW(entry.package || entry.url || '') + '</code>' +
            '</div>' + actions;
        card.insertBefore(iconEl(entry), card.firstChild);

        card.querySelector('.catalog-add').addEventListener('click', async (ev) => {
            const btn = ev.currentTarget;
            if (kind === 'external') {
                btn.disabled = true; btn.textContent = 'Adding…';
                try {
                    const r = await fetch('/admin/catalog/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) });
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    await loadCatalog();
                } catch (err) { btn.disabled = false; btn.textContent = 'Approve & add'; alert('Failed to add: ' + err.message); }
                return;
            }
            openWizardWithPackage(entry); // curated → install via wizard
        });
        const rm = card.querySelector('.catalog-remove');
        if (rm) rm.addEventListener('click', async () => {
            if (!confirm('Remove "' + (entry.name || entry.package) + '" from the curated catalog? (Only removes it from the list — does not uninstall a running server.)')) return;
            rm.disabled = true; rm.textContent = 'Removing…';
            try {
                const r = await fetch('/admin/catalog/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ package: entry.package, name: entry.name }) });
                if (!r.ok) throw new Error('HTTP ' + r.status);
                await loadCatalog();
            } catch (err) { rm.disabled = false; rm.textContent = 'Remove'; alert('Failed to remove: ' + err.message); }
        });
        return card;
    }

    // --- Connector requests (admin review) ---
    async function loadConnectorRequests() {
        const list = $('requests-list');
        if (!list) return;
        list.innerHTML = '<p class="wizard-hint">Loading…</p>';
        try {
            const res = await fetch('/admin/requests');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            renderRequests(data.requests || []);
        } catch (e) {
            list.innerHTML = '<p class="error-message">Failed to load requests: ' + e.message + '</p>';
        }
    }
    function renderRequests(items) {
        const list = $('requests-list');
        const pending = items.filter(r => r.status === 'pending');
        const decided = items.filter(r => r.status !== 'pending').slice(-10).reverse();
        list.innerHTML = '';
        if (!pending.length) { const p = document.createElement('p'); p.className = 'wizard-hint'; p.textContent = 'No pending requests.'; list.appendChild(p); }
        pending.forEach(r => list.appendChild(requestCard(r, true)));
        if (decided.length) {
            const h = document.createElement('div'); h.className = 'catalog-section'; h.innerHTML = '<h4>Recently decided</h4>'; list.appendChild(h);
            decided.forEach(r => list.appendChild(requestCard(r, false)));
        }
    }
    function requestCard(r, actionable) {
        const card = document.createElement('div');
        card.className = 'catalog-card';
        let meta = escapeHtmlW(r.package);
        if (r.requester) meta += ' · by ' + escapeHtmlW(r.requester);
        card.innerHTML =
            '<div class="catalog-info">' +
            '<div class="catalog-name">' + escapeHtmlW(r.name || r.package) +
            (!actionable ? ' <span class="catalog-badge">' + escapeHtmlW(r.status) + '</span>' : '') + '</div>' +
            (r.reason ? '<div class="catalog-desc">“' + escapeHtmlW(r.reason) + '”</div>' : '') +
            '<code class="catalog-pkg">' + meta + '</code>' +
            '</div>' +
            (actionable
                ? '<div class="req-actions"><button class="installer-button req-approve">Approve</button><button class="delete-button req-deny">Deny</button></div>'
                : '');
        if (actionable) {
            card.querySelector('.req-approve').addEventListener('click', () => decideRequest(r.id, 'approve'));
            card.querySelector('.req-deny').addEventListener('click', () => decideRequest(r.id, 'deny'));
        }
        return card;
    }
    async function decideRequest(id, decision) {
        try {
            const res = await fetch('/admin/requests/' + encodeURIComponent(id) + '/' + decision, { method: 'POST' });
            const result = await res.json();
            if (res.ok && result.success) {
                loadConnectorRequests();
            } else {
                alert('Failed: ' + (result.error || res.statusText));
            }
        } catch (e) { alert('Error: ' + e.message); }
    }

    function init() {
        const openBtn = $('open-wizard-button');
        if (openBtn) openBtn.addEventListener('click', openWizard);
        const searchInput = $('catalog-search');
        if (searchInput) searchInput.addEventListener('input', () => { catState.page = 0; renderCatalog(); });
        const filterSel = $('catalog-filter');
        if (filterSel) filterSel.addEventListener('change', () => { catState.page = 0; renderCatalog(); });
        const catRefresh = $('catalog-refresh');
        if (catRefresh) catRefresh.addEventListener('click', () => loadCatalog(true));
        const refreshReq = $('refresh-requests-button');
        if (refreshReq) refreshReq.addEventListener('click', loadConnectorRequests);
        $('wizard-close').addEventListener('click', closeWizard);
        $('wz-next').addEventListener('click', () => goStep(step + 1));
        $('wz-back').addEventListener('click', () => goStep(step - 1));
        $('wz-finish').addEventListener('click', finish);
        $('wz-deploy-run').addEventListener('click', runDeployKey);

        document.querySelectorAll('input[name="wz-type"]').forEach(r => r.addEventListener('change', syncTypeFields));
        document.querySelectorAll('input[name="wz-trust"]').forEach(r => r.addEventListener('change', () => {
            const no = document.querySelector('input[name="wz-trust"]:checked').value === 'no';
            $('wz-deploy-fields').style.display = no ? 'block' : 'none';
            $('wz-deploy-who').textContent = ($('wz-user').value.trim() || 'the account') + '@' + ($('wz-host').value.trim() || 'host');
        }));
        // close on backdrop click
        modal().addEventListener('click', (e) => { if (e.target === modal()) closeWizard(); });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    window.openWizard = openWizard;
    window.openWizardWithPackage = openWizardWithPackage;
    window.loadConnectorRequests = loadConnectorRequests;
    window.loadCatalog = loadCatalog;
})();
