// --- Review tab: rug-pull protection (tool pins) ---
// Lists backend tools withheld because their definition changed (or is new),
// with an old-vs-new line diff, and approve/reject per tool or per backend.
// Self-contained on purpose so it carries over to the admin UI redesign.

/** Line diff via LCS. Returns [{op: ' ' | '-' | '+', text}]. */
function lineDiff(a, b) {
    const x = a === '' ? [] : String(a).split('\n');
    const y = b === '' ? [] : String(b).split('\n');
    const n = x.length, m = y.length;
    const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
        L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (x[i] === y[j]) { out.push({ op: ' ', text: x[i] }); i++; j++; }
        else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: '-', text: x[i++] });
        else out.push({ op: '+', text: y[j++] });
    }
    while (i < n) out.push({ op: '-', text: x[i++] });
    while (j < m) out.push({ op: '+', text: y[j++] });
    return out;
}
globalThis.lineDiff = lineDiff;

const pinText = (def) => def ? JSON.stringify({
    title: def.title, description: def.description, inputSchema: def.inputSchema,
    outputSchema: def.outputSchema, annotations: def.annotations,
}, null, 2).replace(/\\n/g, '\n') : '';

function renderDiff(oldDef, newDef) {
    const pre = document.createElement('pre');
    pre.className = 'pin-diff';
    for (const d of lineDiff(pinText(oldDef), pinText(newDef))) {
        const line = document.createElement('div');
        line.className = d.op === '+' ? 'pin-add' : d.op === '-' ? 'pin-del' : 'pin-same';
        line.textContent = `${d.op} ${d.text}`;
        pre.appendChild(line);
    }
    return pre;
}

const REASONS = {
    'changed': 'Definition changed since it was approved',
    'new-tool': 'New tool on an already-approved backend',
    'new-backend': 'New backend (review mode)',
    'pin-file-unreadable': 'Pin file unreadable: every tool is held',
};

async function pinPost(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

function updateToolPinsBadge(count) {
    const btn = document.getElementById('nav-review');
    if (btn) btn.textContent = count ? `Review (${count})` : 'Review';
}

async function loadToolPins() {
    const list = document.getElementById('tool-pins-list');
    const status = document.getElementById('tool-pins-status');
    if (!list) return;
    list.textContent = 'Loading…';
    let state;
    try {
        const res = await fetch('/admin/tool-pins');
        state = await res.json();
    } catch (e) { list.textContent = `Failed to load: ${e.message}`; return; }
    list.textContent = '';
    if (!state.enabled) { status.textContent = 'Tool pinning is off (MCP_PIN_TOOLS=false).'; updateToolPinsBadge(0); return; }
    const pinnedTotal = Object.values(state.pinned).reduce((a, b) => a + b, 0);
    const backends = Object.keys(state.pinned).length;
    status.textContent = `${state.pending.length} pending · ${pinnedTotal} tool${pinnedTotal === 1 ? '' : 's'} approved on ${backends} backend${backends === 1 ? '' : 's'} · new backends: ${state.mode}`;
    if (state.error) {
        const err = document.createElement('p');
        err.className = 'pin-error';
        err.textContent = `${state.error}`;
        list.appendChild(err);
    }
    updateToolPinsBadge(state.pending.length);
    if (!state.pending.length) {
        const p = document.createElement('p');
        p.textContent = 'Nothing to review. Every served tool matches its approved definition.';
        list.appendChild(p);
        return;
    }
    const byBackend = new Map();
    for (const p of state.pending) (byBackend.get(p.backend) || byBackend.set(p.backend, []).get(p.backend)).push(p);
    for (const [backend, items] of byBackend) {
        const group = document.createElement('section');
        group.className = 'pin-backend';
        const h = document.createElement('h3');
        h.textContent = `${backend} — ${items.length} pending`;
        const all = document.createElement('button');
        all.textContent = 'Approve all for this backend';
        all.onclick = async () => {
            if (!confirm(`Approve all ${items.length} pending tool(s) on ${backend}?`)) return;
            try { await pinPost('/admin/tool-pins/approve-backend', { backend, hashes: Object.fromEntries(items.map(p => [p.tool, p.hash])) }); }
            catch (e) { alert(e.message); }
            loadToolPins();
        };
        h.appendChild(all);
        group.appendChild(h);
        for (const p of items) {
            const card = document.createElement('div');
            card.className = 'pin-card';
            const title = document.createElement('h4');
            title.textContent = `${p.backend}/${p.tool}`;
            const meta = document.createElement('p');
            meta.className = 'pin-meta';
            meta.textContent = `${REASONS[p.reason] || p.reason} · first seen ${p.firstSeenAt}` +
                (p.oldApprovedBy ? ` · previously approved by ${p.oldApprovedBy}` : '') +
                (p.rejectedBy ? ` · rejected by ${p.rejectedBy} at ${p.rejectedAt}` : '');
            const approve = document.createElement('button');
            approve.textContent = 'Approve';
            approve.onclick = async () => {
                try { await pinPost('/admin/tool-pins/approve', { backend: p.backend, tool: p.tool, hash: p.hash }); }
                catch (e) { alert(e.message); }
                loadToolPins();
            };
            const reject = document.createElement('button');
            reject.textContent = 'Reject (keep withheld)';
            reject.onclick = async () => {
                try { await pinPost('/admin/tool-pins/reject', { backend: p.backend, tool: p.tool, hash: p.hash }); }
                catch (e) { alert(e.message); }
                loadToolPins();
            };
            card.append(title, meta, renderDiff(p.old, p.new), approve, reject);
            group.appendChild(card);
        }
        list.appendChild(group);
    }
}

function initializeToolPinsSection() {
    const btn = document.getElementById('tool-pins-recheck');
    if (btn && !btn.dataset.listenerAttached) {
        btn.dataset.listenerAttached = 'true';
        btn.onclick = async () => {
            try { await pinPost('/admin/tool-pins/recheck', {}); } catch (e) { alert(e.message); }
            loadToolPins();
        };
    }
}

if (typeof window !== 'undefined') {
    window.loadToolPins = loadToolPins;
    window.updateToolPinsBadge = updateToolPinsBadge;
    window.initializeToolPinsSection = initializeToolPinsSection;
}
