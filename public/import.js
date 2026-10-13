// "Import from client config" modal on the Servers tab.
//
// Step 1 posts the pasted/uploaded file to /admin/import/preview, which returns
// each entry with its secrets masked plus a previewId. Step 2 posts the chosen
// entries (by id, with the backend name to use) to /admin/import/apply; the
// gateway writes mcp_server.json from its own unmasked copy and reloads. The
// real secret values are never sent back to this page.
(function () {
    const $ = (id) => document.getElementById(id);
    let previewId = null;
    let entries = [];

    function el(tag, attrs = {}, ...children) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === 'className') node.className = v;
            else if (k === 'text') node.textContent = v;
            else node.setAttribute(k, v);
        }
        for (const c of children) if (c) node.append(c);
        return node;
    }

    function setMessage(error, status) {
        $('import-error').textContent = error || '';
        const s = $('import-status');
        s.textContent = status || '';
        s.style.color = '';
    }

    function open() {
        if (window.isServerConfigDirty &&
            !confirm('You have unsaved changes on the Servers tab. Importing reloads the list from the saved config and discards them. Continue?')) {
            return;
        }
        previewId = null;
        entries = [];
        $('import-text').value = '';
        $('import-file').value = '';
        showStep('input');
        setMessage();
        $('import-modal').style.display = 'block';
    }

    function close() {
        $('import-modal').style.display = 'none';
        $('import-text').value = '';
        previewId = null;
        entries = [];
    }

    function showStep(step) {
        $('import-step-input').style.display = step === 'input' ? '' : 'none';
        $('import-step-preview').style.display = step === 'preview' ? '' : 'none';
    }

    async function postJson(url, body) {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(body),
        });
        let data = {};
        try { data = await res.json(); } catch { /* non-JSON error page */ }
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        return data;
    }

    async function preview() {
        setMessage();
        const text = $('import-text').value;
        if (!text.trim()) { setMessage('Paste a config or choose a file first.'); return; }
        $('import-preview-button').disabled = true;
        try {
            const data = await postJson('/admin/import/preview', { text });
            previewId = data.previewId;
            entries = data.entries;
            // The textarea held the raw secrets; clear it now that the server has them.
            $('import-text').value = '';
            renderPreview(data.format);
            showStep('preview');
        } catch (e) {
            setMessage(e.message);
        } finally {
            $('import-preview-button').disabled = false;
        }
    }

    const FORMAT_NAMES = {
        mcpServers: '"mcpServers" format (Claude Desktop, Claude Code, Cursor, Windsurf)',
        vscode: 'VS Code "servers" format',
    };

    function renderPreview(format) {
        const container = $('import-entries');
        container.replaceChildren();
        const runnable = entries.filter(e => e.importable).length;
        $('import-summary').textContent =
            `${entries.length} server(s) found in ${FORMAT_NAMES[format] || format}; ${runnable} can run on this gateway. ` +
            'Tick the ones to import. Imported servers connect right away; if new-backend review is on (MCP_PIN_NEW_BACKENDS=review), their tools wait in the Review tab.';

        for (const entry of entries) {
            const checkbox = el('input', { type: 'checkbox', 'data-id': entry.id, className: 'import-select' });
            checkbox.checked = entry.importable;
            checkbox.disabled = !entry.importable;

            const keyInput = el('input', { type: 'text', className: 'import-key', value: entry.key, maxlength: '64', 'aria-label': 'Backend name' });
            const head = el('div', { className: 'import-entry-head' },
                checkbox,
                el('strong', { text: entry.sourceName }),
                el('span', { className: 'import-type', text: entry.type }),
                el('span', { className: 'import-arrow', text: '→ backend' }),
                keyInput);

            const card = el('div', { className: 'import-entry' + (entry.importable ? '' : ' import-blocked') }, head);

            if (entry.clash) {
                const replace = el('input', { type: 'checkbox', className: 'import-replace' });
                replace.addEventListener('change', () => {
                    keyInput.value = replace.checked ? entry.clashKey : entry.key;
                    keyInput.disabled = replace.checked;
                });
                card.append(el('label', { className: 'import-replace-label' }, replace,
                    ` Replace the existing backend "${entry.clashKey}" instead`));
            }

            const details = el('dl', { className: 'import-details' });
            const row = (label, value) => details.append(el('dt', { text: label }), el('dd', {}, el('code', { text: value })));
            if (entry.type === 'stdio') {
                row('Command', [entry.command, ...(entry.args || [])].join(' '));
                for (const env of entry.env || []) row(`env ${env.name}`, env.value);
            } else {
                row('URL', entry.url);
                if (entry.auth) row(entry.auth.kind === 'bearer' ? 'Bearer token' : 'X-Api-Key', entry.auth.value);
            }
            if (!entry.active && entry.importable) row('Status', 'inactive (disabled in the client)');
            card.append(details);

            if (entry.issues.length) {
                const list = el('ul', { className: 'import-issues' });
                for (const issue of entry.issues) list.append(el('li', { className: `import-issue-${issue.level}`, text: issue.message }));
                card.append(list);
            }
            card.dataset.id = entry.id;
            container.append(card);
        }
    }

    async function apply() {
        setMessage();
        const selections = [];
        for (const card of $('import-entries').querySelectorAll('.import-entry')) {
            const checkbox = card.querySelector('.import-select');
            if (!checkbox.checked) continue;
            const replace = card.querySelector('.import-replace');
            selections.push({
                id: card.dataset.id,
                key: card.querySelector('.import-key').value.trim(),
                replace: !!(replace && replace.checked),
            });
        }
        if (!selections.length) { setMessage('Nothing selected.'); return; }
        $('import-apply-button').disabled = true;
        setMessage('', 'Importing and reloading (connecting to the new backends can take a few seconds)…');
        try {
            const data = await postJson('/admin/import/apply', { previewId, selections });
            const s = $('import-status');
            s.textContent = data.reloaded
                ? `Imported and running: ${data.imported.join(', ')}.`
                : `Imported ${data.imported.join(', ')}. ${data.error || ''}`;
            s.style.color = data.reloaded ? 'green' : 'orange';
            previewId = null;
            window.isServerConfigDirty = false;
            if (typeof window.loadServerConfig === 'function') await window.loadServerConfig();
            setTimeout(close, data.reloaded ? 1500 : 6000);
        } catch (e) {
            setMessage(e.message);
        } finally {
            $('import-apply-button').disabled = false;
        }
    }

    function readFile(event) {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        if (file.size > 90 * 1024) { setMessage('That file is larger than 90 KB; is it really an MCP client config?'); return; }
        const reader = new FileReader();
        reader.onload = () => { $('import-text').value = String(reader.result || ''); preview(); };
        reader.onerror = () => setMessage('Could not read the file.');
        reader.readAsText(file);
    }

    document.addEventListener('DOMContentLoaded', () => {
        if (!$('import-modal')) return;
        $('open-import-button').addEventListener('click', open);
        $('import-close').addEventListener('click', close);
        $('import-preview-button').addEventListener('click', preview);
        $('import-back-button').addEventListener('click', () => { showStep('input'); setMessage(); });
        $('import-apply-button').addEventListener('click', apply);
        $('import-file').addEventListener('change', readFile);
    });
})();
