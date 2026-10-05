// layout.js — cosmetic organization for the Servers and Tools lists:
// live search, collapsible groups, and drag-and-drop reordering / grouping.
// Purely a display layer: it rearranges the DOM the existing renderers produce
// and persists order+groups to /admin/ui-layout. It never changes mcp_server.json,
// tool_config.json, or any MCP behaviour — the Save buttons still read every
// entry via querySelectorAll regardless of how they're grouped here.

(function () {
    const PAGES = {
        servers: { container: '#server-list', entry: '.server-entry', keyAttr: 'serverKey', noun: 'server' },
        tools:   { container: '#tool-list',   entry: '.tool-entry',   keyAttr: 'toolKey',   noun: 'tool'   },
    };

    let layoutCache = null;            // { servers: {...}, tools: {...} }
    const applying = { servers: false, tools: false };

    async function ensureLayout() {
        if (layoutCache) return layoutCache;
        try {
            const r = await fetch('/admin/ui-layout');
            layoutCache = r.ok ? (await r.json()) : {};
        } catch (e) { layoutCache = {}; }
        if (!layoutCache || typeof layoutCache !== 'object') layoutCache = {};
        return layoutCache;
    }

    function pageLayout(pageKey) {
        const l = layoutCache[pageKey];
        if (l && Array.isArray(l.groups)) return l;
        return { groups: [], ungrouped: [] };
    }

    // Clean a possibly-polluted model: drop stray "Ungrouped" pseudo-groups (an old
    // bug persisted them), collapse them into the single ungrouped list, and dedupe
    // any key that ended up in more than one place. If anything changed, persist the
    // cleaned version so the saved file self-heals on next load.
    function normalizeModel(model, pageKey) {
        const rawGroups = Array.isArray(model.groups) ? model.groups : [];
        const seen = new Set();
        const groups = [];
        const ungrouped = [];
        rawGroups.forEach(g => {
            const keys = (g.keys || []).filter(k => !seen.has(k) && (seen.add(k), true));
            if ((g.name || '') === 'Ungrouped') {
                ungrouped.push(...keys); // fold pseudo-group back into the bucket
            } else {
                groups.push({ name: g.name || 'Group', collapsed: !!g.collapsed, keys });
            }
        });
        (model.ungrouped || []).forEach(k => { if (!seen.has(k)) { seen.add(k); ungrouped.push(k); } });
        const cleaned = { groups, ungrouped };
        const changed = JSON.stringify(cleaned) !== JSON.stringify({
            groups: rawGroups.map(g => ({ name: g.name || 'Group', collapsed: !!g.collapsed, keys: g.keys || [] })),
            ungrouped: model.ungrouped || [],
        });
        if (changed) save(pageKey, cleaned);
        return cleaned;
    }

    async function save(pageKey, model) {
        layoutCache[pageKey] = model;
        try {
            await fetch('/admin/ui-layout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(layoutCache),
            });
        } catch (e) { console.warn('Failed to save UI layout', e); }
    }

    function entryKey(el, cfg) { return el.dataset[cfg.keyAttr]; }
    function entryLabel(el) {
        const h3 = el.querySelector('h3');
        return (h3 ? h3.textContent : '') || '';
    }

    // ---- serialize current DOM back into the layout model ----
    function serialize(container, cfg) {
        const groups = [];
        // IMPORTANT: exclude the Ungrouped bucket — it also carries the .layout-group
        // class, and capturing it here as a real group is what caused duplicate
        // "Ungrouped" sections to pile up on every save/reload.
        container.querySelectorAll(':scope > .layout-group:not(.layout-ungrouped)').forEach(sec => {
            const keys = [];
            sec.querySelectorAll(':scope > .layout-group-body > ' + cfg.entry).forEach(e => keys.push(entryKey(e, cfg)));
            groups.push({
                name: sec.dataset.groupName || 'Group',
                collapsed: sec.classList.contains('collapsed'),
                keys,
            });
        });
        const ungrouped = [];
        const ub = container.querySelector(':scope > .layout-ungrouped > .layout-group-body') ||
                   container.querySelector(':scope > .layout-flat');
        if (ub) ub.querySelectorAll(':scope > ' + cfg.entry).forEach(e => ungrouped.push(entryKey(e, cfg)));
        else container.querySelectorAll(':scope > ' + cfg.entry).forEach(e => ungrouped.push(entryKey(e, cfg)));
        return { groups, ungrouped };
    }

    function persist(pageKey, container, cfg) {
        save(pageKey, serialize(container, cfg));
    }

    // ---- drag and drop ----
    let dragged = null;
    function getDropTarget(body, y, cfg) {
        const els = [...body.querySelectorAll(':scope > ' + cfg.entry + ':not(.dragging)')];
        let closest = null, closestOffset = -Infinity;
        for (const el of els) {
            const box = el.getBoundingClientRect();
            const offset = y - box.top - box.height / 2;
            if (offset < 0 && offset > closestOffset) { closestOffset = offset; closest = el; }
        }
        return closest;
    }
    function wireDropZone(body, pageKey, container, cfg) {
        body.addEventListener('dragover', (e) => {
            if (!dragged) return;
            e.preventDefault();
            body.classList.add('drop-active');
            const after = getDropTarget(body, e.clientY, cfg);
            if (after == null) body.appendChild(dragged);
            else body.insertBefore(dragged, after);
        });
        body.addEventListener('dragleave', () => body.classList.remove('drop-active'));
        body.addEventListener('drop', (e) => {
            e.preventDefault();
            body.classList.remove('drop-active');
            updateCounts(container, cfg);
            persist(pageKey, container, cfg);
        });
    }
    function enhanceEntry(entry, cfg, pageKey) {
        const header = entry.querySelector('.server-header, .tool-header') || entry;
        if (header.querySelector(':scope > .drag-grip')) return; // already enhanced

        // drag handle
        const grip = document.createElement('span');
        grip.className = 'drag-grip';
        grip.title = 'Drag to reorder / move between groups';
        grip.textContent = '⠿';
        grip.setAttribute('draggable', 'true');
        grip.addEventListener('dragstart', (e) => {
            dragged = entry;
            entry.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', entryKey(entry, cfg)); } catch (_) {}
            if (e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(entry, 20, 16);
        });
        grip.addEventListener('dragend', () => { entry.classList.remove('dragging'); dragged = null; });
        grip.addEventListener('click', (e) => e.stopPropagation());
        header.insertBefore(grip, header.firstChild);

        // "Move ▾" group picker button
        const moveBtn = document.createElement('button');
        moveBtn.type = 'button';
        moveBtn.className = 'layout-move-btn';
        moveBtn.title = 'Move to group';
        moveBtn.innerHTML = 'Move <span class="layout-move-caret">▾</span>';
        moveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openMoveMenu(entry, cfg, pageKey, moveBtn);
        });
        const anchor = header.querySelector('.delete-button, .reset-tool-overrides-button');
        if (anchor) header.insertBefore(moveBtn, anchor); else header.appendChild(moveBtn);
    }

    function currentGroupOf(entry) {
        const sec = entry.closest('.layout-group');
        if (!sec) return ''; // flat / ungrouped
        if (sec.classList.contains('layout-ungrouped')) return '';
        return sec.dataset.groupName || '';
    }

    // Move-to-group works on the model, then re-applies — same path as drag/drop.
    function moveEntryToGroup(pageKey, cfg, key, targetName) {
        const container = document.querySelector(cfg.container);
        if (!container) return;
        const model = serialize(container, cfg);
        model.groups.forEach(g => { g.keys = (g.keys || []).filter(k => k !== key); });
        model.ungrouped = (model.ungrouped || []).filter(k => k !== key);
        if (targetName === '') {
            model.ungrouped.push(key);
        } else {
            let g = model.groups.find(g => g.name === targetName);
            if (!g) { g = { name: targetName, collapsed: false, keys: [] }; model.groups.push(g); }
            g.keys.push(key);
        }
        save(pageKey, model);
        apply(pageKey);
    }

    let openMenuEl = null;
    function closeMoveMenu() {
        if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; }
        document.removeEventListener('click', closeMoveMenu);
        document.removeEventListener('keydown', onMenuKey);
    }
    function onMenuKey(e) { if (e.key === 'Escape') closeMoveMenu(); }

    function openMoveMenu(entry, cfg, pageKey, anchorBtn) {
        closeMoveMenu();
        const container = document.querySelector(cfg.container);
        const key = entryKey(entry, cfg);
        const current = currentGroupOf(entry);
        const groupNames = [...container.querySelectorAll(':scope > .layout-group:not(.layout-ungrouped)')]
            .map(s => s.dataset.groupName);

        const menu = document.createElement('div');
        menu.className = 'layout-move-menu';
        const addItem = (label, handler, checked, extraClass) => {
            const it = document.createElement('button');
            it.type = 'button';
            it.className = 'layout-move-item' + (extraClass ? ' ' + extraClass : '');
            it.innerHTML = `<span class="chk">${checked ? '✓' : ''}</span><span class="lbl"></span>`;
            it.querySelector('.lbl').textContent = label;
            it.addEventListener('click', (e) => { e.stopPropagation(); closeMoveMenu(); handler(); });
            menu.appendChild(it);
        };

        groupNames.forEach(name => addItem(name, () => moveEntryToGroup(pageKey, cfg, key, name), name === current));
        addItem('Ungrouped', () => moveEntryToGroup(pageKey, cfg, key, ''), current === '');
        const div = document.createElement('div'); div.className = 'layout-move-sep'; menu.appendChild(div);
        addItem('New group…', () => {
            const n = prompt('New group name:');
            if (n && n.trim()) moveEntryToGroup(pageKey, cfg, key, n.trim());
        }, false, 'newgroup');

        document.body.appendChild(menu);
        const r = anchorBtn.getBoundingClientRect();
        menu.style.top = (window.scrollY + r.bottom + 4) + 'px';
        // keep it on-screen horizontally
        const left = Math.min(window.scrollX + r.left, window.scrollX + document.documentElement.clientWidth - menu.offsetWidth - 12);
        menu.style.left = Math.max(8, left) + 'px';
        openMenuEl = menu;
        // defer so this click doesn't immediately close it
        setTimeout(() => {
            document.addEventListener('click', closeMoveMenu);
            document.addEventListener('keydown', onMenuKey);
        }, 0);
    }

    // ---- group section builder ----
    function makeGroupSection(pageKey, container, cfg, name, collapsed) {
        const sec = document.createElement('div');
        sec.className = 'layout-group' + (collapsed ? ' collapsed' : '');
        sec.dataset.groupName = name;

        const header = document.createElement('div');
        header.className = 'layout-group-header';
        header.innerHTML = `
            <span class="layout-caret">▾</span>
            <span class="layout-group-title"></span>
            <span class="layout-group-count"></span>
            <span class="layout-group-actions">
                <button class="layout-mini rename" title="Rename group">Rename</button>
                <button class="layout-mini delete" title="Delete group (moves its items to Ungrouped)">Delete</button>
            </span>`;
        header.querySelector('.layout-group-title').textContent = name;

        const body = document.createElement('div');
        body.className = 'layout-group-body';

        header.querySelector('.layout-caret').addEventListener('click', () => {
            sec.classList.toggle('collapsed');
            persist(pageKey, container, cfg);
        });
        header.querySelector('.layout-group-title').addEventListener('click', () => {
            sec.classList.toggle('collapsed');
            persist(pageKey, container, cfg);
        });
        header.querySelector('.rename').addEventListener('click', () => {
            const n = prompt('Rename group:', sec.dataset.groupName);
            if (n && n.trim()) {
                sec.dataset.groupName = n.trim();
                header.querySelector('.layout-group-title').textContent = n.trim();
                persist(pageKey, container, cfg);
            }
        });
        header.querySelector('.delete').addEventListener('click', () => {
            if (!confirm(`Delete group "${sec.dataset.groupName}"? Its items move to Ungrouped.`)) return;
            const ungrouped = ensureUngrouped(pageKey, container, cfg);
            body.querySelectorAll(':scope > ' + cfg.entry).forEach(e => ungrouped.appendChild(e));
            sec.remove();
            persist(pageKey, container, cfg);
        });

        wireDropZone(body, pageKey, container, cfg);
        sec.appendChild(header);
        sec.appendChild(body);
        return sec;
    }

    function updateCounts(container, cfg) {
        container.querySelectorAll(':scope > .layout-group').forEach(sec => {
            const n = sec.querySelectorAll(':scope > .layout-group-body > ' + cfg.entry).length;
            const c = sec.querySelector('.layout-group-count');
            if (c) c.textContent = n === 1 ? '1 item' : n + ' items';
        });
    }

    function ensureUngrouped(pageKey, container, cfg) {
        let sec = container.querySelector(':scope > .layout-ungrouped');
        if (!sec) {
            sec = document.createElement('div');
            sec.className = 'layout-group layout-ungrouped';
            sec.dataset.groupName = 'Ungrouped';
            const header = document.createElement('div');
            header.className = 'layout-group-header';
            header.innerHTML = `<span class="layout-caret">▾</span><span class="layout-group-title">Ungrouped</span><span class="layout-group-count"></span>`;
            const body = document.createElement('div');
            body.className = 'layout-group-body';
            header.querySelector('.layout-caret').addEventListener('click', () => { sec.classList.toggle('collapsed'); persist(pageKey, container, cfg); });
            header.querySelector('.layout-group-title').addEventListener('click', () => { sec.classList.toggle('collapsed'); persist(pageKey, container, cfg); });
            wireDropZone(body, pageKey, container, cfg);
            sec.appendChild(header); sec.appendChild(body);
            container.appendChild(sec);
        }
        return sec.querySelector(':scope > .layout-group-body');
    }

    // ---- toolbar ----
    function buildToolbar(pageKey, container, cfg, hasGroups) {
        const bar = document.createElement('div');
        bar.className = 'layout-toolbar';
        bar.innerHTML = `
            <input type="search" class="layout-search" placeholder="Search ${cfg.noun}s…" autocomplete="off">
            <span class="layout-toolbar-spacer"></span>
            <button class="layout-btn new-group">+ New group</button>
            <button class="layout-btn autogroup" title="Bucket items by the first part of their name">Auto-group</button>
            <button class="layout-btn expand-all">Expand all</button>
            <button class="layout-btn collapse-all">Collapse all</button>`;

        const search = bar.querySelector('.layout-search');
        search.addEventListener('input', () => applySearch(container, cfg, search.value));

        bar.querySelector('.new-group').addEventListener('click', () => {
            const n = prompt('New group name:');
            if (!n || !n.trim()) return;
            const sec = makeGroupSection(pageKey, container, cfg, n.trim(), false);
            const ung = container.querySelector(':scope > .layout-ungrouped');
            if (ung) container.insertBefore(sec, ung); else container.appendChild(sec);
            promoteFlatToUngrouped(pageKey, container, cfg);
            updateCounts(container, cfg);
            persist(pageKey, container, cfg);
        });
        bar.querySelector('.autogroup').addEventListener('click', () => {
            if (!confirm('Auto-group by name prefix? This replaces your current groups on this page.')) return;
            autoGroup(pageKey, container, cfg);
        });
        bar.querySelector('.expand-all').addEventListener('click', () => {
            container.querySelectorAll(':scope > .layout-group').forEach(s => s.classList.remove('collapsed'));
            persist(pageKey, container, cfg);
        });
        bar.querySelector('.collapse-all').addEventListener('click', () => {
            container.querySelectorAll(':scope > .layout-group').forEach(s => s.classList.add('collapsed'));
            persist(pageKey, container, cfg);
        });
        return bar;
    }

    function applySearch(container, cfg, term) {
        term = (term || '').trim().toLowerCase();
        const entries = container.querySelectorAll(cfg.entry);
        entries.forEach(e => {
            const hay = (entryKey(e, cfg) + ' ' + entryLabel(e)).toLowerCase();
            e.style.display = (!term || hay.includes(term)) ? '' : 'none';
        });
        // hide empty groups while searching; force-expand groups with matches
        container.querySelectorAll(':scope > .layout-group').forEach(sec => {
            const body = sec.querySelector(':scope > .layout-group-body');
            const visible = [...body.querySelectorAll(':scope > ' + cfg.entry)].some(e => e.style.display !== 'none');
            sec.style.display = (!term || visible) ? '' : 'none';
            if (term && visible) sec.classList.remove('collapsed');
        });
    }

    // When groups exist, loose entries live in an "Ungrouped" bucket.
    function promoteFlatToUngrouped(pageKey, container, cfg) {
        const loose = container.querySelectorAll(':scope > ' + cfg.entry);
        if (loose.length === 0) return;
        const ub = ensureUngrouped(pageKey, container, cfg);
        loose.forEach(e => ub.appendChild(e));
    }

    function autoGroup(pageKey, container, cfg) {
        // collect all entries (flatten current structure)
        const all = [...container.querySelectorAll(cfg.entry)];
        const prefixOf = (k) => {
            const m = String(k).split(/__|[-_.\/ ]/)[0];
            return m || k;
        };
        const byPrefix = {};
        all.forEach(e => { const p = prefixOf(entryKey(e, cfg)); (byPrefix[p] = byPrefix[p] || []).push(e); });

        // wipe current structure
        container.querySelectorAll(':scope > .layout-group').forEach(s => s.remove());

        const prefixes = Object.keys(byPrefix).sort();
        const leftovers = [];
        prefixes.forEach(p => {
            if (byPrefix[p].length >= 2) {
                const sec = makeGroupSection(pageKey, container, cfg, p, false);
                const body = sec.querySelector(':scope > .layout-group-body');
                byPrefix[p].forEach(e => body.appendChild(e));
                const ung = container.querySelector(':scope > .layout-ungrouped');
                if (ung) container.insertBefore(sec, ung); else container.appendChild(sec);
            } else {
                leftovers.push(...byPrefix[p]);
            }
        });
        if (leftovers.length) {
            const ub = ensureUngrouped(pageKey, container, cfg);
            leftovers.forEach(e => ub.appendChild(e));
        }
        updateCounts(container, cfg);
        persist(pageKey, container, cfg);
    }

    // ---- main entry point: rearrange the freshly-rendered flat list ----
    async function apply(pageKey) {
        const cfg = PAGES[pageKey];
        if (!cfg) return;
        const container = document.querySelector(cfg.container);
        if (!container) return;
        if (applying[pageKey]) return;
        applying[pageKey] = true;
        try {
            await ensureLayout();
            const model = normalizeModel(pageLayout(pageKey), pageKey);

            // detach every entry, key them
            const map = new Map();
            container.querySelectorAll(cfg.entry).forEach(e => {
                enhanceEntry(e, cfg, pageKey);
                map.set(entryKey(e, cfg), e);
            });
            if (map.size === 0) { applying[pageKey] = false; return; }

            container.innerHTML = '';
            container.appendChild(buildToolbar(pageKey, container, cfg, model.groups.length > 0));

            const placed = new Set();
            const hasGroups = model.groups.length > 0;

            if (hasGroups) {
                model.groups.forEach(g => {
                    const sec = makeGroupSection(pageKey, container, cfg, g.name || 'Group', !!g.collapsed);
                    const body = sec.querySelector(':scope > .layout-group-body');
                    (g.keys || []).forEach(k => {
                        const el = map.get(k);
                        if (el && !placed.has(k)) { body.appendChild(el); placed.add(k); }
                    });
                    container.appendChild(sec);
                });
                // ungrouped bucket
                const ub = ensureUngrouped(pageKey, container, cfg);
                (model.ungrouped || []).forEach(k => {
                    const el = map.get(k);
                    if (el && !placed.has(k)) { ub.appendChild(el); placed.add(k); }
                });
                map.forEach((el, k) => { if (!placed.has(k)) { ub.appendChild(el); placed.add(k); } });
            } else {
                // no groups: flat list (keeps the clean original look), still draggable/searchable
                const flat = document.createElement('div');
                flat.className = 'layout-flat';
                wireDropZone(flat, pageKey, container, cfg);
                (model.ungrouped || []).forEach(k => {
                    const el = map.get(k);
                    if (el && !placed.has(k)) { flat.appendChild(el); placed.add(k); }
                });
                map.forEach((el, k) => { if (!placed.has(k)) { flat.appendChild(el); placed.add(k); } });
                container.appendChild(flat);
            }
            updateCounts(container, cfg);
        } finally {
            applying[pageKey] = false;
        }
    }

    window.LayoutEnhancer = { apply, preload: ensureLayout };
})();
