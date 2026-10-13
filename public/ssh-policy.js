// --- ssh-mcp policy (host group + approval) for the Servers tab ---
// Self-contained: servers.js calls SshPolicy.decorate(entryDiv, serverConf) per
// entry and SshPolicy.afterRender(listDiv) once per render; everything else
// lives here, so it can move into another layout as one piece.
//
// ssh-mcp authorizes every command against a role x host-group matrix (its
// README, "Policy Engine"). Quick-start backends (--host/--user) take the group
// from --group=, which must be prod, staging or dev; no --group means prod, on
// purpose. --config=<file>.toml backends keep a group per profile in the file,
// which the gateway reads for us (GET /admin/ssh-policy: names and groups only).
(function (root) {
    const GROUPS = ['prod', 'staging', 'dev'];
    const GROUP_FLAG = /^--group(=|$)/;
    const APPROVAL_FLAG = /^--disableApproval(=|$)/;

    // ---------- pure helpers (unit-tested in test/ssh-policy.test.mjs) ----------

    /** Same match as the gateway's backendKind: the package as a path or spec segment. */
    function isSshMcp(conf) {
        if (!conf || typeof conf !== 'object') return false;
        const words = [conf.command, ...(Array.isArray(conf.args) ? conf.args : [])].filter(w => typeof w === 'string');
        return words.some(w => /(^|[/\\@])ssh-mcp($|[/\\@])/.test(w));
    }

    /** ssh-mcp's parseArgv: `--name=value`, bare `--name` is null, last one wins. */
    function parseFlags(args) {
        const flags = {};
        for (const a of args || []) {
            if (typeof a !== 'string' || !a.startsWith('--')) continue;
            const eq = a.indexOf('=');
            if (eq === -1) flags[a.slice(2)] = null; else flags[a.slice(2, eq)] = a.slice(eq + 1);
        }
        return flags;
    }

    /** ssh-mcp's flagEnabled: present and not false/0/no/off. */
    function flagEnabled(flags, name) {
        if (!(name in flags)) return false;
        const v = flags[name];
        if (v === null || v === '') return true;
        return !['false', '0', 'no', 'off'].includes(String(v).toLowerCase());
    }

    /**
     * What ssh-mcp makes of these args.
     *   mode 'cli'            quick start; group + groupSource explicit|default|invalid
     *   mode 'toml'           --config=<file>; groups live in the file
     *   mode 'default-config' neither; ssh-mcp reads its own default config file
     */
    function describe(args) {
        const flags = parseFlags(args);
        const disableApproval = flagEnabled(flags, 'disableApproval');
        if ('config' in flags) return { mode: 'toml', configPath: flags.config || '', disableApproval };
        if (!('host' in flags) && !('user' in flags)) return { mode: 'default-config', disableApproval };
        const g = flags.group;
        if (g === undefined || g === null) return { mode: 'cli', group: 'prod', groupSource: 'default', disableApproval };
        if (GROUPS.includes(g)) return { mode: 'cli', group: g, groupSource: 'explicit', disableApproval };
        return { mode: 'cli', group: g, groupSource: 'invalid', disableApproval };
    }

    // Replace the first matching arg in place, drop the rest; append if none.
    // `value` null removes every match. Every other arg is kept as-is, in order.
    function replaceFlag(args, pattern, value) {
        const out = [];
        let placed = false;
        for (const a of args || []) {
            if (typeof a === 'string' && pattern.test(a)) {
                if (value !== null && !placed) { out.push(value); placed = true; }
                continue;
            }
            out.push(a);
        }
        if (value !== null && !placed) out.push(value);
        return out;
    }

    /** Set (prod/staging/dev) or remove (null/'') the --group flag. */
    function setGroup(args, group) {
        if (group && !GROUPS.includes(group)) throw new Error(`ssh-mcp accepts only ${GROUPS.join(', ')} for --group`);
        return replaceFlag(args, GROUP_FLAG, group ? `--group=${group}` : null);
    }

    /** Add or remove --disableApproval (and any --disableApproval=… spelling). */
    function setDisableApproval(args, on) {
        return replaceFlag(args, APPROVAL_FLAG, on ? '--disableApproval' : null);
    }

    /** Filter tokens for one backend: groups plus default / invalid / custom / toml / unknown / none. */
    function filterTokens(conf, toml) {
        if (!isSshMcp(conf)) return ['none'];
        const d = describe(conf.args);
        if (d.mode === 'cli') {
            if (d.groupSource === 'invalid') return ['invalid'];
            return d.groupSource === 'default' ? ['prod', 'default'] : [d.group];
        }
        if (d.mode === 'default-config') return ['unknown'];
        const t = ['toml'];
        for (const p of (toml && toml.profiles) || []) {
            t.push(p.group);
            if (!GROUPS.includes(p.group)) t.push('custom');
            if (p.source === 'inferred' && p.group === 'prod') t.push('default');
        }
        if (!toml || toml.error) t.push('unknown');
        return [...new Set(t)];
    }

    // ---------- DOM ----------

    let tomlCache = {};
    let filterValue = 'all';

    const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const MATRIX_HELP = `ssh-mcp checks every command against a role &times; host-group matrix. This
        gateway starts it as <strong>admin</strong>: on <strong>dev</strong> and <strong>staging</strong> admin may run
        every command class, including sudo (<code>privileged-command</code>); on <strong>prod</strong> admin gets
        read-only, safe and destructive commands but <strong>no sudo</strong>. A missing <code>--group</code> means
        prod, deliberately, so an unlabelled host gets the strictest tier. With approval on, destructive and
        sudo commands ask for confirmation through the MCP client (a client that cannot ask gets a refusal);
        <code>--disableApproval</code> runs them without asking. Source: ssh-mcp README, “Policy Engine” and “CLI Flags”.`;

    const DEFAULT_PROD_TITLE = 'No --group: ssh-mcp treats this host as prod, the strictest tier. admin gets no sudo (privileged-command) here.';

    function argsOf(entryDiv, conf) {
        const fallback = Array.isArray(conf.args) ? conf.args : [];
        if (!entryDiv.querySelector('.server-args-input') || !root.ServerArgs) return fallback;
        // What the Save handler in servers.js would save; while the JSON is
        // being typed and doesn't parse, the last saved args.
        try { return root.ServerArgs.read(entryDiv); } catch (_) { return fallback; }
    }

    function badge(text, cls, title) {
        return `<span class="ssh-badge ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
    }

    function badgesHtml(d, toml) {
        if (d.mode === 'cli') {
            let g;
            if (d.groupSource === 'default') g = badge('prod · default ⚠', 'warn', DEFAULT_PROD_TITLE);
            else if (d.groupSource === 'invalid') g = badge(`group "${d.group}" invalid`, 'danger', 'ssh-mcp accepts only prod, staging or dev for --group and refuses to start otherwise.');
            else g = badge(d.group, `g-${d.group}`, `ssh-mcp host group (--group=${d.group})`);
            const a = d.disableApproval
                ? badge('approval off', 'muted', '--disableApproval: destructive and sudo commands run without a confirmation prompt')
                : badge('approval on', 'muted', 'Destructive and sudo commands ask for confirmation through the MCP client');
            return g + a;
        }
        if (d.mode === 'default-config') return badge('ssh-mcp default config', 'muted', 'No --host/--user and no --config: ssh-mcp reads its own default config file, which the gateway does not inspect.');
        if (!toml) return badge('toml', 'muted', 'Reading profile groups…');
        if (toml.error) return badge('toml unreadable', 'danger', `Could not read ${toml.configPath || '(empty --config)'}: ${toml.error}`);
        const groups = [...new Set(toml.profiles.map(p => p.group))];
        const inferredProd = toml.profiles.some(p => p.source === 'inferred' && p.group === 'prod');
        const n = toml.profiles.length;
        return badge(`toml · ${n} profile${n === 1 ? '' : 's'}${groups.length ? ' · ' + groups.join(', ') : ''}${inferredProd ? ' ⚠' : ''}`,
            inferredProd ? 'warn' : 'muted',
            inferredProd ? 'A profile has no group and an unrecognised name, so ssh-mcp treats it as prod.' : `Groups from ${toml.configPath}`);
    }

    function cliSectionHtml(d) {
        const opt = (v, label) => `<option value="${v}"${d.groupSource !== 'invalid' && ((v === '' && d.groupSource === 'default') || (v && v === d.group && d.groupSource === 'explicit')) ? ' selected' : ''}>${label}</option>`;
        const invalid = d.groupSource === 'invalid'
            ? `<option value="__invalid" selected disabled>"${esc(d.group)}" (invalid; pick one)</option>` : '';
        const warn = d.groupSource === 'default'
            ? `<p class="ssh-policy-note warn">⚠ No <code>--group</code>: this host runs as <strong>prod</strong>, so sudo is refused. Pick its real tier.</p>`
            : d.groupSource === 'invalid'
                ? `<p class="ssh-policy-note danger">ssh-mcp only accepts prod, staging or dev for <code>--group</code> and will refuse to start with "${esc(d.group)}". Custom groups need a TOML profile with <code>[policy.roleBindings]</code>.</p>`
                : '';
        return `
            <div><label>Host group:</label>
                <select class="ssh-group-select">${invalid}${opt('', 'Not set (ssh-mcp uses prod)')}${opt('dev', 'dev')}${opt('staging', 'staging')}${opt('prod', 'prod')}</select></div>
            ${warn}
            <div><label class="inline-label"><input type="checkbox" class="ssh-approval-input"${d.disableApproval ? ' checked' : ''}>
                Disable approval (<code>--disableApproval</code>): run destructive and sudo commands without a confirmation prompt</label></div>`;
    }

    function tomlSectionHtml(d, toml) {
        const where = esc(d.configPath || '(empty --config)');
        if (!toml) return `<p class="ssh-policy-note">Reading profile groups from <code>${where}</code>…</p>`;
        if (toml.error) return `<p class="ssh-policy-note danger">Could not read <code>${where}</code> (${esc(toml.error)}).</p>`;
        const rows = toml.profiles.map(p => `<tr><td>${esc(p.name)}</td><td>${esc(p.group)}${GROUPS.includes(p.group) ? '' : ' (custom)'}</td><td>${p.source === 'inferred' ? 'inferred from the profile name' + (p.group === 'prod' ? ' ⚠' : '') : 'set in file'}</td></tr>`).join('');
        return `
            <table class="ssh-policy-table"><thead><tr><th>Profile</th><th>Host group</th><th></th></tr></thead>
                <tbody>${rows || '<tr><td colspan="3">No [[profiles]] found.</td></tr>'}</tbody></table>
            <p class="ssh-policy-note">Read-only here. To change a group, edit <code>group = "…"</code> under the profile in
                <code>${where}</code> on the gateway. Reload only reconnects servers whose entry here changed, so
                then untick Active, Save &amp; Reload, tick it again and Save &amp; Reload (or restart the gateway). A profile with no <code>group</code> gets one from its
                name (prod / staging / dev, local, test, sandbox) and otherwise prod. Custom groups need matching
                <code>[policy.roleBindings]</code>. Approval is set per profile there too (<code>approvalPolicy</code>).</p>`;
    }

    function render(entryDiv) {
        const conf = entryDiv._sshConf;
        const d = describe(argsOf(entryDiv, conf));
        const key = entryDiv.dataset.serverKey;
        const toml = d.mode === 'toml' ? tomlCache[key] : undefined;

        entryDiv.dataset.sshFilter = filterTokens({ ...conf, args: argsOf(entryDiv, conf) }, toml).join(' ');

        let badges = entryDiv.querySelector('.ssh-badges');
        if (!badges) {
            badges = document.createElement('span');
            badges.className = 'ssh-badges';
            const h3 = entryDiv.querySelector('.server-header h3');
            if (h3) h3.after(badges);
        }
        badges.innerHTML = badgesHtml(d, toml);

        const section = entryDiv.querySelector('.ssh-policy');
        if (!section) return;
        section.querySelector('.ssh-policy-body').innerHTML =
            d.mode === 'cli' ? cliSectionHtml(d)
                : d.mode === 'toml' ? tomlSectionHtml(d, toml)
                    : `<p class="ssh-policy-note">No <code>--host</code>/<code>--user</code> and no <code>--config</code>: ssh-mcp reads its own default config file, which the gateway does not inspect.</p>`;
    }

    function rewriteArgs(entryDiv, fn) {
        if (!entryDiv.querySelector('.server-args-input') || !root.ServerArgs) return;
        // write() fires an input event: marks the config dirty, re-renders.
        root.ServerArgs.write(entryDiv, fn(argsOf(entryDiv, entryDiv._sshConf)));
    }

    /** Called by servers.js for every rendered entry. */
    function decorate(entryDiv, conf) {
        if (!entryDiv || !isSshMcp(conf)) { if (entryDiv) entryDiv.dataset.sshFilter = 'none'; return; }
        entryDiv._sshConf = conf;
        const ta = entryDiv.querySelector('.server-args-input');
        if (ta && !entryDiv.querySelector('.ssh-policy')) {
            const section = document.createElement('fieldset');
            section.className = 'ssh-policy';
            section.innerHTML = `<legend>ssh-mcp policy</legend><div class="ssh-policy-body"></div>
                <details class="ssh-policy-help"><summary>What do host groups mean?</summary><p>${MATRIX_HELP}</p></details>`;
            ta.closest('div').after(section);
            section.addEventListener('change', (e) => {
                if (e.target.classList.contains('ssh-group-select')) {
                    rewriteArgs(entryDiv, args => setGroup(args, e.target.value || null));
                } else if (e.target.classList.contains('ssh-approval-input')) {
                    rewriteArgs(entryDiv, args => setDisableApproval(args, e.target.checked));
                }
            });
            ta.addEventListener('input', () => { render(entryDiv); applyFilter(); });
        }
        render(entryDiv);
    }

    // ---------- bulk view: filter by group ----------

    const FILTERS = [
        ['all', 'All servers'], ['prod', 'prod'], ['staging', 'staging'], ['dev', 'dev'],
        ['default', '⚠ prod by default (no group)'], ['invalid', 'invalid group'], ['custom', 'custom group (TOML)'],
        ['toml', 'TOML-configured'], ['unknown', 'group unknown'], ['none', 'not ssh-mcp'],
    ];

    function entries(listDiv) { return [...listDiv.querySelectorAll('.server-entry')]; }

    function applyFilter() {
        const listDiv = document.getElementById('server-list');
        if (!listDiv) return;
        entries(listDiv).forEach(e => {
            const tokens = (e.dataset.sshFilter || 'none').split(' ');
            e.classList.toggle('ssh-filter-hidden', filterValue !== 'all' && !tokens.includes(filterValue));
        });
        updateFilterCounts(listDiv);
    }

    function updateFilterCounts(listDiv) {
        const sel = document.getElementById('ssh-group-filter');
        if (!sel) return;
        const all = entries(listDiv);
        const count = (v) => v === 'all' ? all.length : all.filter(e => (e.dataset.sshFilter || 'none').split(' ').includes(v)).length;
        [...sel.options].forEach(o => {
            const label = FILTERS.find(f => f[0] === o.value)[1];
            const n = count(o.value);
            o.textContent = `${label} (${n})`;
            // Keep the menu short: hide empty buckets except the one selected and "all".
            o.hidden = n === 0 && o.value !== 'all' && o.value !== filterValue;
        });
    }

    function ensureFilterBar(listDiv) {
        if (document.getElementById('ssh-group-filter')) return;
        const bar = document.createElement('div');
        bar.className = 'ssh-filter-bar';
        bar.innerHTML = `<label for="ssh-group-filter">ssh-mcp host group:</label>
            <select id="ssh-group-filter">${FILTERS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>`;
        listDiv.before(bar);
        bar.querySelector('select').addEventListener('change', (e) => { filterValue = e.target.value; applyFilter(); });
    }

    async function loadToml() {
        try {
            const r = await fetch('/admin/ssh-policy');
            if (!r.ok) return;
            tomlCache = (await r.json()).toml || {};
        } catch (_) { return; }
        const listDiv = document.getElementById('server-list');
        if (!listDiv) return;
        entries(listDiv).forEach(e => { if (e._sshConf) render(e); });
        applyFilter();
    }

    /** Called by servers.js once a full render is done. */
    function afterRender(listDiv) {
        if (!listDiv) return;
        ensureFilterBar(listDiv);
        applyFilter();
        // Only worth a request if some backend is TOML-configured.
        if (entries(listDiv).some(e => (e.dataset.sshFilter || '').split(' ').includes('toml'))) loadToml();
    }

    root.SshPolicy = { GROUPS, isSshMcp, parseFlags, flagEnabled, describe, setGroup, setDisableApproval, filterTokens, decorate, afterRender };
})(typeof window !== 'undefined' ? window : globalThis);
