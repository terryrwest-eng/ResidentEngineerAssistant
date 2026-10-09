// PMWeb Auto-Fill - side panel
//
// Everything the toolbar popup does, built into the PMWeb page as a
// full-height panel down the right side. Claude in Chrome works inside the
// page - it reads what is on it, clicks and types - and cannot press the
// extension's toolbar button or see the popup that button opens. The panel is
// ordinary page content, so it can. Terry, 2026-10-09: "it cant press the
// extension button".
//
// Built for that operator:
//   - No browser dialogs. alert(), confirm() and prompt() freeze the page for
//     Claude. Messages show in the panel's status line, and a confirmation is a
//     second button.
//   - Every control has a visible text label and a fixed id starting "pmwap-".
//   - The status line says what the page is doing and how the last step ended,
//     from the events injected.js announces.
//
// Closed, the panel is hidden completely (Terry: "can close to be invisible").
// Alt+Shift+P, or "Show the side panel" in the toolbar popup, brings it back.
// Open or closed is remembered, and applies to every PMWeb tab.
//
// The logic is in core.js, shared with the popup, so the two never drift.

(function () {
    if (window.top !== window) return;                    // the top page only
    if (document.getElementById('pmwap-root')) return;    // already built

    const P = 'pmwap';
    const WIDTH = 380;

    const S = {
        apiBase: null,
        connecting: false,
        connected: false,
        reports: [],
        filter: '',
        selectedId: null,
        queue: { items: [] },
        open: true,
    };

    // ── Small helpers ────────────────────────────────────────────────────────

    function $(name) { return document.getElementById(`${P}-${name}`); }

    /** An element, with attributes and children. Text goes in as text, never as HTML. */
    function el(tag, attrs, ...children) {
        const node = document.createElement(tag);
        Object.entries(attrs || {}).forEach(([k, v]) => {
            if (v === null || v === undefined || v === false) return;
            if (k === 'className') node.className = v;
            else if (k === 'text') node.textContent = v;
            else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
            else node.setAttribute(k, v === true ? '' : String(v));
        });
        children.flat().forEach((c) => {
            if (c === null || c === undefined || c === false) return;
            node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        });
        return node;
    }

    function button(name, label, cls, onclick) {
        return el('button', { id: `${P}-${name}`, type: 'button', className: `${P}-btn ${cls || ''}`, onclick }, label);
    }

    /** A report id made safe for use inside an element id. */
    function safeId(id) { return String(id).replace(/[^A-Za-z0-9_-]/g, '_'); }

    function clock() {
        return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    }

    function show(name, visible) {
        const node = $(name);
        if (node) node.style.display = visible ? '' : 'none';
    }

    function reportById(id) { return S.reports.find((r) => r.id === id) || null; }

    function reportLabel(report) {
        if (!report) return '';
        const shift = PMCore.fmtShift(report);
        return PMCore.fmtPickerDate(report.report_date) + (shift ? `, ${shift}` : '');
    }

    // ── The status line ──────────────────────────────────────────────────────
    //
    // One line everyone reads: what is happening now, or how the last thing
    // ended, with the time it was said.

    function setStatus(text, kind) {
        const box = $('status');
        if (!box) return;
        box.className = `${P}-status ${P}-status-${kind || 'info'}`;
        $('status-text').textContent = text;
        $('status-time').textContent = clock();
        console.log(`[side panel] ${text}`);
    }

    function onUnauthorized() {
        show('signin', true);
        setStatus('The app refused the request: the extension needs your sign-in. See "Sign-in needed" above.', 'error');
    }

    /** Disable a button and say it is working, until the work is done. */
    async function busy(name, workingLabel, work) {
        const btn = $(name);
        const label = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = workingLabel; }
        try {
            return await work();
        } catch (e) {
            console.error('[side panel]', e);
            setStatus(`${label} failed: ${e.message}`, 'error');
            return null;
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = label; }
        }
    }

    // ── Reaching the page script (injected.js) ───────────────────────────────

    /** True when injected.js answers on this page. */
    function pagePing() {
        return new Promise((resolve) => {
            let done = false;
            const finish = (ok) => {
                if (done) return;
                done = true;
                window.removeEventListener('PMWEB_PONG', onPong);
                resolve(ok);
            };
            const onPong = () => finish(true);
            window.addEventListener('PMWEB_PONG', onPong);
            window.dispatchEvent(new CustomEvent('PMWEB_PING'));
            setTimeout(() => finish(false), 1000);
        });
    }

    /**
     * Make sure injected.js is on the page, loading it again if it is not.
     * content.js loads it when the page loads; injectWorker is content.js's.
     */
    async function pageReady() {
        if (await pagePing()) return true;
        if (typeof injectWorker === 'function') {
            injectWorker();
            await new Promise((r) => setTimeout(r, 1500));
            if (await pagePing()) return true;
        }
        setStatus('The PMWeb page script did not load. Reload this PMWeb page, then try again.', 'error');
        return false;
    }

    function sendToPage(name, detail) {
        window.dispatchEvent(new CustomEvent(name, { detail }));
    }

    // ── Connecting to the app ────────────────────────────────────────────────

    async function connect() {
        if (S.connecting) return;
        S.connecting = true;
        $('connection').textContent = 'Connecting to the app...';
        try {
            S.apiBase = await PMCore.getApiBase();
            if (!S.apiBase) {
                S.connected = false;
                $('connection').textContent = 'Not connected to the app';
                show('setup', true);
                setStatus('Could not reach the Daily Reporter app. Type its address under "App address" and press Connect.', 'error');
                return;
            }
            S.connected = true;
            show('setup', false);
            $('connection').textContent = 'Connected: ' + S.apiBase.replace(/^https?:\/\//, '').split('.')[0];
            if (!(await PMCore.getAuthToken())) show('signin', true);
            await loadReports();
        } finally {
            S.connecting = false;
        }
    }

    async function saveApiUrl() {
        const url = ($('api-url').value || '').trim().replace(/\/$/, '');
        if (!url) { setStatus('Type the app address first, for example https://your-app.up.railway.app', 'warn'); return; }
        await chrome.storage.local.set({ apiBase: url });
        await connect();
    }

    async function saveToken() {
        const token = ($('token').value || '').trim();
        if (!token) { setStatus('Paste the access token first.', 'warn'); return; }
        await chrome.storage.local.set({ apiToken: token });
        $('token').value = '';
        show('signin', false);
        setStatus('Access token saved.', 'ok');
        if (S.connected) await loadReports();
    }

    // ── Reports ──────────────────────────────────────────────────────────────

    async function loadReports() {
        if (!S.apiBase) return;
        const list = $('report-list');
        list.replaceChildren(el('li', { className: `${P}-empty`, text: 'Loading reports...' }));
        try {
            const loaded = await PMCore.loadReports(S.apiBase, onUnauthorized);
            S.reports = loaded.reports;
            const active = await PMCore.getContextReportId(S.apiBase, onUnauthorized);
            if (active) {
                S.selectedId = active;
                await chrome.storage.local.set({ selectedReportId: active });
            }
            renderSelected();
            renderReportList();
            renderRowsInfo();
        } catch (e) {
            console.error('[side panel] reports', e);
            list.replaceChildren(el('li', { className: `${P}-empty`, text: `Could not load reports: ${e.message}` }));
        }
    }

    async function selectReport(id) {
        await PMCore.setContextReport(S.apiBase, id, onUnauthorized);
        S.selectedId = id;
        renderSelected();
        renderReportList();
        renderRowsInfo();
        setStatus(`Selected the report for ${reportLabel(reportById(id)) || id}.`, 'ok');
    }

    function renderSelected() {
        const r = reportById(S.selectedId);
        $('selected-date').textContent = r ? reportLabel(r) : 'No report selected';
        $('selected-acts').textContent = r
            ? ((r.activities && r.activities.length) ? r.activities.join('; ') : 'No activities on this report')
            : 'Pick one in the list below.';
    }

    function renderReportList() {
        const list = $('report-list');
        if (!S.reports.length) {
            list.replaceChildren(el('li', { className: `${P}-empty`, text: S.connected ? 'No reports found' : 'Not connected to the app' }));
            $('report-count').textContent = '';
            return;
        }
        // Matches on date, project or any activity name, so "8/14", "tecolote"
        // and "blow-off" all find the report.
        const q = (S.filter || '').trim().toLowerCase();
        const shown = !q ? S.reports : S.reports.filter((r) => [
            r.report_date || '', PMCore.fmtPickerDate(r.report_date) || '',
            r.project_name || '', (r.activities || []).join(' '),
        ].join(' ').toLowerCase().includes(q));

        $('report-count').textContent = q
            ? `${shown.length} of ${S.reports.length} reports`
            : `${S.reports.length} report${S.reports.length === 1 ? '' : 's'}`;

        if (!shown.length) {
            list.replaceChildren(el('li', { className: `${P}-empty`, text: 'No reports match that search' }));
            return;
        }

        list.replaceChildren(...shown.map((r) => {
            const sid = safeId(r.id);
            const selected = r.id === S.selectedId;
            const inQueue = PMCore.queueHas(S.queue, r.id);
            const label = reportLabel(r) + (r.status === 'draft' ? ' (draft)' : '');
            return el('li', { className: `${P}-report${selected ? ` ${P}-report-selected` : ''}` },
                el('div', { className: `${P}-report-main` },
                    el('button', {
                        id: `${P}-report-${sid}`, type: 'button', className: `${P}-report-pick`,
                        'aria-pressed': selected ? 'true' : 'false',
                        'aria-label': `Select the report for ${label}`,
                        onclick: () => busy(`report-${sid}`, 'Selecting...', () => selectReport(r.id)),
                    }, label),
                    el('label', { className: `${P}-check`, for: `${P}-queue-toggle-${sid}` },
                        el('input', {
                            id: `${P}-queue-toggle-${sid}`, type: 'checkbox',
                            checked: inQueue,
                            'aria-label': `Put the report for ${label} in the queue`,
                            onchange: () => toggleQueue(r),
                        }),
                        'Queue')),
                el('div', { className: `${P}-report-acts`,
                    text: (r.activities || []).join('; ') || 'No activities' }));
        }));
    }

    // ── The queue ────────────────────────────────────────────────────────────

    async function saveQueue() {
        await PMCore.saveQueue(S.queue);
    }

    async function toggleQueue(report) {
        PMCore.toggleQueueItem(S.queue, report, $('mode').value);
        await saveQueue();
        renderQueue();
        renderReportList();
    }

    const STATUS_TEXT = { pending: 'Waiting', sent: 'Running', done: 'Done', problems: 'Check it' };

    function renderQueue() {
        $('queue-count').textContent = String(S.queue.items.length);
        show('queue-empty', !S.queue.items.length);

        const list = $('queue-list');
        list.replaceChildren(...S.queue.items.map((item) => {
            const sid = safeId(item.id);
            const date = item.date || '(no date)';
            const shift = el('select', { id: `${P}-q-shift-${sid}`, 'aria-label': `Shift for ${date}`,
                onchange: (e) => { item.shift = e.target.value; saveQueue(); updateQueueButtons(); } },
                el('option', { value: 'Day', text: 'Day' }),
                el('option', { value: 'Evening', text: 'Evening' }),
                el('option', { value: 'Night', text: 'Night' }));
            shift.value = item.shift || 'Day';
            const mode = el('select', { id: `${P}-q-mode-${sid}`, 'aria-label': `Resource rows for ${date}`,
                onchange: (e) => { item.mode = e.target.value; saveQueue(); } },
                el('option', { value: 'add', text: 'Add' }),
                el('option', { value: 'fill', text: 'Fill' }));
            mode.value = item.mode || 'add';
            return el('li', { className: `${P}-q-item ${P}-q-${item.status || 'pending'}` },
                el('div', { className: `${P}-q-head` },
                    el('span', { className: `${P}-q-date`, text: date }),
                    el('span', { id: `${P}-q-status-${sid}`, className: `${P}-q-status`,
                        text: STATUS_TEXT[item.status] || 'Waiting' })),
                el('div', { className: `${P}-q-fields` },
                    el('input', { id: `${P}-q-record-${sid}`, type: 'text', value: item.record || '',
                        placeholder: 'Record #', 'aria-label': `Record number for ${date}`,
                        oninput: (e) => { item.record = e.target.value.trim(); saveQueue(); updateQueueButtons(); } }),
                    shift, mode),
                (item.problems && item.problems.length)
                    ? el('ul', { className: `${P}-q-problems` }, item.problems.map((p) => el('li', { text: p })))
                    : null,
                el('div', { className: `${P}-q-actions` },
                    el('button', { id: `${P}-q-reset-${sid}`, type: 'button', className: `${P}-btn ${P}-btn-small`,
                        onclick: () => { item.status = 'pending'; item.problems = []; saveQueue(); renderQueue(); } },
                        'Set back to waiting'),
                    el('button', { id: `${P}-q-remove-${sid}`, type: 'button', className: `${P}-btn ${P}-btn-small`,
                        onclick: () => {
                            S.queue.items = S.queue.items.filter((i) => i !== item);
                            saveQueue(); renderQueue(); renderReportList();
                        } },
                        'Remove')));
        }));
        updateQueueButtons();
    }

    function updateQueueButtons() {
        const next = PMCore.nextInQueue(S.queue);
        const left = S.queue.items.filter((i) => i.status === 'pending').length;
        $('queue-skip').disabled = !next;
        const run = $('queue-run');
        if (!next) {
            run.disabled = true;
            run.textContent = S.queue.items.length ? 'Nothing left to run' : 'Run the next one';
            $('queue-msg').textContent = S.queue.items.length
                ? 'Every report in the queue has been run. "Check it" entries list what did not go in.'
                : 'Tick "Queue" beside reports in the list above.';
            return;
        }
        run.disabled = !next.record;
        run.textContent = next.record
            ? `Run ${next.date} (#${next.record} ${next.shift})`
            : `Type a record # for ${next.date}`;
        $('queue-msg').textContent = `${left} to go. Open ${next.date}'s record in PMWeb, then press Run. `
            + 'The queue sets the report, its record number, its shift and the resource mode.';
    }

    async function runQueueNext() {
        const item = PMCore.nextInQueue(S.queue);
        if (!item) { setStatus('Nothing in the queue is waiting.', 'info'); return; }
        if (!item.record) { setStatus(`${item.date} has no record number yet. Type it in the queue first.`, 'warn'); return; }

        await selectReport(item.id);                 // the app's context follows the queue
        $('record').value = item.record;
        $('shift').value = item.shift || 'Day';
        $('mode').value = item.mode || 'add';

        item.status = 'sent';
        item.problems = [];
        await saveQueue();
        renderQueue();

        let sent = false;
        try {
            sent = await autoFillEverything({ record: item.record, shift: item.shift || 'Day', mode: item.mode || 'add' });
        } finally {
            if (!sent) {
                // Nothing reached the page, so the entry is still waiting, not running.
                item.status = 'pending';
                await saveQueue();
                renderQueue();
            }
        }
    }

    function skipQueueNext() {
        const next = PMCore.nextInQueue(S.queue);
        if (!next) return;
        next.status = 'done';
        next.problems = ['skipped by hand'];
        saveQueue();
        renderQueue();
        setStatus(`Skipped ${next.date}.`, 'info');
    }

    function clearQueue(confirmed) {
        if (!S.queue.items.length) { setStatus('The queue is already empty.', 'info'); return; }
        if (!confirmed) { show('queue-clear-confirm', true); return; }
        show('queue-clear-confirm', false);
        const n = S.queue.items.length;
        S.queue.items = [];
        saveQueue();
        renderQueue();
        renderReportList();
        setStatus(`Emptied the queue (${n} report${n === 1 ? '' : 's'}). Nothing already in PMWeb was touched.`, 'ok');
    }

    // ── Auto-Fill Everything ─────────────────────────────────────────────────

    /** Sends the whole report to the page. Returns true when it was sent. */
    async function autoFillEverything(opts) {
        const record = ((opts && opts.record) || $('record').value || '').trim();
        const shift = (opts && opts.shift) || $('shift').value;
        const mode = (opts && opts.mode) || $('mode').value;
        if (!record) { setStatus('Type a record number first.', 'warn'); return false; }
        if (!S.apiBase) { setStatus('Not connected to the app.', 'error'); return false; }
        await chrome.storage.local.set({ resourceMode: mode });

        const reportId = await PMCore.getContextReportId(S.apiBase, onUnauthorized);
        if (!reportId) { setStatus('No report selected. Pick one in the Report list.', 'warn'); return false; }

        setStatus('Getting the report from the app...', 'busy');
        const fullData = await PMCore.fetchFullData(S.apiBase, reportId, onUnauthorized);
        if (!(await pageReady())) return false;

        const stored = await chrome.storage.local.get(['selectedReportId']);
        const payload = PMCore.buildFullPayload(fullData, {
            recordNum: record, shift: shift, resourceMode: mode,
            reportId: stored.selectedReportId || null,
        });
        sendToPage('PMWEB_FILL_EVERYTHING', payload);
        await chrome.storage.local.set({ lastRecordNumber: parseInt(record, 10) });
        setStatus(`Auto-Fill Everything started: ${payload.reportDate}, record ${payload.recordCode}. `
            + 'This line follows each phase.', 'busy');
        return true;
    }

    // ── One step at a time ───────────────────────────────────────────────────

    async function renderRowsInfo() {
        const st = await chrome.storage.local.get(['pmwebRows', 'pmwebRowsMeta', 'selectedReportId', 'pmwebActivities']);
        const rows = st.pmwebRows || [];
        if (!rows.length) {
            $('rows-info').textContent = 'No resource rows fetched yet.';
        } else {
            const info = PMCore.describeRows(st.pmwebRowsMeta, st.selectedReportId);
            $('rows-info').textContent = `${rows.length} resource row(s) fetched`
                + (info.stale ? `. Check: ${info.reason}.` : `: ${info.label}.`);
        }
        const acts = st.pmwebActivities || [];
        $('acts-info').textContent = acts.length
            ? `${acts.length} activity row(s) fetched.`
            : 'No activity rows fetched yet.';
    }

    async function selectedOrSay() {
        const id = await PMCore.getContextReportId(S.apiBase, onUnauthorized);
        if (!id) setStatus('No report selected. Pick one in the Report list.', 'warn');
        return id;
    }

    async function fetchResources() {
        if (!S.apiBase) { setStatus('Not connected to the app.', 'error'); return; }
        const id = await selectedOrSay();
        if (!id) return;
        const rows = await PMCore.fetchResourceRows(S.apiBase, id, onUnauthorized);
        const r = reportById(id);
        await PMCore.storeResourceRows(rows, id, (r && r.report_date) || '');
        await renderRowsInfo();
        setStatus(`Fetched ${rows.length} resource row(s) for ${reportLabel(r) || 'the selected report'}.`, 'ok');
    }

    async function fillResources(force) {
        const st = await chrome.storage.local.get(['pmwebRows', 'pmwebRowsMeta', 'selectedReportId']);
        const rows = st.pmwebRows || [];
        if (!rows.length) { setStatus('No resource rows fetched yet. Press "Fetch resources" first.', 'warn'); return; }
        const info = PMCore.describeRows(st.pmwebRowsMeta, st.selectedReportId);
        if (info.stale && !force) {
            // A second button instead of confirm(): a dialog freezes the page.
            $('fill-resources-reason').textContent = `These rows may be wrong: ${info.reason}. `
                + 'Press "Fetch resources" to refresh them, or fill them anyway.';
            show('fill-resources-confirm', true);
            return;
        }
        show('fill-resources-confirm', false);
        if (!(await pageReady())) return;
        const mode = $('mode').value;
        sendToPage('PMWEB_FILL_TRIGGER', { rows: rows, mode: mode });
        setStatus(`Filling ${rows.length} Labor and Equipment row(s), "${mode}" mode. `
            + 'This line says when it finishes.', 'busy');
    }

    async function fetchActivities() {
        if (!S.apiBase) { setStatus('Not connected to the app.', 'error'); return; }
        const id = await selectedOrSay();
        if (!id) return;
        const rows = await PMCore.fetchActivityRows(S.apiBase, id, onUnauthorized);
        await chrome.storage.local.set({ pmwebActivities: rows });
        await renderRowsInfo();
        setStatus(`Fetched ${rows.length} activity row(s) for ${reportLabel(reportById(id)) || 'the selected report'}.`, 'ok');
    }

    async function fillActivities() {
        const st = await chrome.storage.local.get(['pmwebActivities']);
        const rows = st.pmwebActivities || [];
        if (!rows.length) { setStatus('No activity rows fetched yet. Press "Fetch activities" first.', 'warn'); return; }
        if (!(await pageReady())) return;
        sendToPage('PMWEB_FILL_ACTIVITIES_TRIGGER', rows);
        setStatus(`Filling ${rows.length} activity row(s). This line says when it finishes.`, 'busy');
    }

    async function fillNotes() {
        if (!S.apiBase) { setStatus('Not connected to the app.', 'error'); return; }
        const id = await selectedOrSay();
        if (!id) return;
        const data = await PMCore.fetchFullData(S.apiBase, id, onUnauthorized);
        if (!data.notes_html) { setStatus('This report has no note text to write.', 'warn'); return; }
        if (!(await pageReady())) return;
        sendToPage('PMWEB_FILL_NOTE_TRIGGER', data.notes_html);
        setStatus('Writing the note on the Notes tab. This line says when it finishes.', 'busy');
    }

    function clearData(confirmed) {
        if (!confirmed) { show('clear-confirm', true); return; }
        show('clear-confirm', false);
        const n = PMCore.clearTimesheetFields();
        setStatus(`Cleared ${n} timesheet field(s) on this page.`, 'ok');
    }

    // Reads every Labor and Equipment resource PMWeb offers and saves the list
    // to the app, so new PMWeb resources can be mapped there.
    async function findResources() {
        if (!S.apiBase) { setStatus('Not connected to the app.', 'error'); return; }
        if (!(await pageReady())) return;
        setStatus('Reading the resources PMWeb offers...', 'busy');
        const result = await new Promise((resolve) => {
            const timer = setTimeout(() => { window.removeEventListener('PMWEB_SYNC_RESULT', on); resolve(null); }, 90000);
            function on(e) { clearTimeout(timer); window.removeEventListener('PMWEB_SYNC_RESULT', on); resolve(e.detail || {}); }
            window.addEventListener('PMWEB_SYNC_RESULT', on);
            sendToPage('PMWEB_SYNC_TRIGGER', null);
        });
        if (!result) { setStatus('PMWeb did not answer within 90 seconds. Open a daily report timesheet and try again.', 'error'); return; }
        if (result.error) { setStatus(`Could not read PMWeb's resources: ${result.error}`, 'error'); return; }

        const resp = await PMCore.apiFetch(`${S.apiBase}/api/settings/sync-pmweb-resources`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resources: result.resources }),
        }, onUnauthorized);
        if (!resp.ok) throw new Error(`the app answered ${resp.status}`);
        const data = await resp.json();
        setStatus(`Saved PMWeb's resources to the app: ${data.counts.labor} labor, ${data.counts.equipment} equipment.`, 'ok');
    }

    // Everything the Word export has except the consolidated resource table,
    // as both HTML and plain text, so it pastes well anywhere.
    async function copyReport() {
        if (!S.apiBase) { setStatus('Not connected to the app.', 'error'); return; }
        const id = await selectedOrSay();
        if (!id) return;
        const resp = await PMCore.apiFetch(`${S.apiBase}/api/export/${id}/notes-html`, {}, onUnauthorized);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const { html } = await resp.json();
        if (!html) throw new Error('the report came back empty');
        const plain = PMCore.htmlToPlainText(html);
        if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
            await navigator.clipboard.write([new ClipboardItem({
                'text/html': new Blob([html], { type: 'text/html' }),
                'text/plain': new Blob([plain], { type: 'text/plain' }),
            })]);
        } else {
            await navigator.clipboard.writeText(plain);
        }
        const lines = plain.split('\n').filter(Boolean).length;
        setStatus(`Copied the report (${lines} lines). Paste it where it goes.`, 'ok');
    }

    function stopRun() {
        sendToPage('PMWEB_STOP', null);
        setStatus('Stop sent. The run stops at its next check.', 'warn');
    }

    // ── What the page says back ──────────────────────────────────────────────

    window.addEventListener('PMWEB_RUN_PROGRESS', (e) => {
        const d = e.detail || {};
        setStatus(`Auto-Fill Everything: phase ${d.phase} of ${d.total || 5}, ${d.label}.`, 'busy');
    });

    window.addEventListener('PMWEB_RUN_RESULT', async (e) => {
        const run = e.detail || {};
        const problems = run.problems || [];
        const what = `${run.reportDate || 'the report'}${run.recordCode ? `, record ${run.recordCode}` : ''}`;
        if (problems.length) {
            setStatus(`Auto-Fill Everything finished ${what}, but ${problems.length} thing(s) did not go in: `
                + problems.join('; '), 'error');
        } else {
            setStatus(`Auto-Fill Everything finished ${what}. Everything went in.`, 'ok');
        }
        // content.js also saves this for the popup; the popup finds the entry
        // already marked and simply clears the saved copy.
        if (PMCore.applyRunResult(S.queue, run)) {
            await saveQueue();
            renderQueue();
        }
    });

    const STEP_NAMES = { resources: 'Labor and Equipment', activities: 'Activities', notes: 'Notes' };
    window.addEventListener('PMWEB_STEP_RESULT', (e) => {
        const d = e.detail || {};
        const name = STEP_NAMES[d.step] || d.step;
        setStatus(`${name}: ${d.message}`, d.ok ? 'ok' : 'error');
    });

    // ── Opening and closing ──────────────────────────────────────────────────

    function setOpen(open, remember) {
        S.open = open;
        $('root').style.display = open ? 'flex' : 'none';
        if (remember) chrome.storage.local.set({ pmwebPanelOpen: open });
        if (open && !S.connected && !S.connecting) connect();
    }

    // Alt+Shift+P. Handled by the page, not by Chrome, so Claude in Chrome can
    // press it too; an extension shortcut is caught by Chrome before the page.
    window.addEventListener('keydown', (e) => {
        if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyP') {
            e.preventDefault();
            e.stopPropagation();
            setOpen(!S.open, true);
        }
    }, true);

    // The popup and other PMWeb tabs share these settings; follow them.
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.pmwebPanelOpen) setOpen(changes.pmwebPanelOpen.newValue !== false, false);
        if (changes.pmwebQueue) {
            const incoming = changes.pmwebQueue.newValue || { items: [] };
            // Our own saves come back here too; re-drawing on those would pull
            // the cursor out of the record box mid-typing.
            if (JSON.stringify(incoming) !== JSON.stringify(S.queue)) {
                S.queue = incoming;
                renderQueue();
                renderReportList();
            }
        }
        if (changes.selectedReportId && changes.selectedReportId.newValue !== S.selectedId) {
            S.selectedId = changes.selectedReportId.newValue || null;
            renderSelected();
            renderReportList();
        }
        if (changes.resourceMode && changes.resourceMode.newValue) $('mode').value = changes.resourceMode.newValue;
        if (changes.pmwebRows || changes.pmwebRowsMeta || changes.pmwebActivities || changes.selectedReportId) {
            renderRowsInfo();
        }
        if (changes.apiToken && changes.apiToken.newValue) {
            show('signin', false);
            if (S.connected) loadReports();
        }
    });

    // ── Building it ──────────────────────────────────────────────────────────

    function section(title, ...children) {
        return el('section', { className: `${P}-section` }, el('h2', { className: `${P}-h2`, text: title }), ...children);
    }

    function field(name, label, control) {
        return el('div', { className: `${P}-field` }, el('label', { for: `${P}-${name}`, text: label }), control);
    }

    function select(name, options) {
        return el('select', { id: `${P}-${name}` }, options.map(([v, t]) => el('option', { value: v, text: t })));
    }

    function build() {
        const style = el('style', { id: `${P}-style` });
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);

        const root = el('aside', {
            id: `${P}-root`, role: 'complementary', 'aria-label': 'PMWeb Auto-Fill side panel',
        },
            el('header', { className: `${P}-header` },
                el('div', {},
                    el('h1', { className: `${P}-h1`, text: 'PMWeb Auto-Fill' }),
                    el('div', { id: `${P}-connection`, className: `${P}-muted`, text: 'Not connected yet' })),
                button('close', 'Close', `${P}-btn-quiet`, () => setOpen(false, true))),

            el('div', { id: `${P}-status`, className: `${P}-status ${P}-status-info`, role: 'status', 'aria-live': 'polite' },
                el('div', { id: `${P}-status-text`, text: 'Ready.' }),
                el('div', { className: `${P}-status-foot` },
                    el('span', { id: `${P}-status-time`, className: `${P}-muted` }),
                    button('stop', 'Stop the run', `${P}-btn-danger ${P}-btn-small`, stopRun))),

            el('div', { className: `${P}-body` },
                el('div', { id: `${P}-setup`, className: `${P}-callout`, style: 'display:none' },
                    el('strong', { text: 'App address' }),
                    el('p', { text: 'The Daily Reporter app did not answer at its usual addresses. Type its address and press Connect.' }),
                    field('api-url', 'Address', el('input', { id: `${P}-api-url`, type: 'text', placeholder: 'https://your-app.up.railway.app' })),
                    button('api-save', 'Connect', `${P}-btn-primary`, () => busy('api-save', 'Connecting...', saveApiUrl))),

                el('div', { id: `${P}-signin`, className: `${P}-callout`, style: 'display:none' },
                    el('strong', { text: 'Sign-in needed' }),
                    el('p', { text: 'Open the Daily Reporter app in this browser and sign in; the extension picks the sign-in up by itself. '
                        + 'Or, in the app, go to Settings, press "Copy access token" and paste it here.' }),
                    field('token', 'Access token', el('input', { id: `${P}-token`, type: 'password', placeholder: 'Paste the access token' })),
                    button('token-save', 'Save token', `${P}-btn-primary`, () => busy('token-save', 'Saving...', saveToken))),

                section('Report',
                    el('div', { className: `${P}-selected` },
                        el('div', { id: `${P}-selected-date`, className: `${P}-selected-date`, text: 'No report selected' }),
                        el('div', { id: `${P}-selected-acts`, className: `${P}-muted`, text: 'Pick one in the list below.' })),
                    el('div', { className: `${P}-row` },
                        el('label', { for: `${P}-search`, className: `${P}-visually-hidden`, text: 'Search reports' }),
                        el('input', { id: `${P}-search`, type: 'search', placeholder: 'Search date, project or activity',
                            oninput: (e) => { S.filter = e.target.value; renderReportList(); } }),
                        button('refresh', 'Refresh list', '', () => busy('refresh', 'Loading...', async () => {
                            if (!S.connected) await connect(); else await loadReports();
                        }))),
                    el('div', { id: `${P}-report-count`, className: `${P}-muted` }),
                    el('ul', { id: `${P}-report-list`, className: `${P}-report-list` },
                        el('li', { className: `${P}-empty`, text: 'Not connected yet' })),
                    button('copy', 'Copy the report for pasting', '', () => busy('copy', 'Copying...', copyReport))),

                section('Queue',
                    el('div', { className: `${P}-muted` }, 'Reports in the queue: ', el('span', { id: `${P}-queue-count`, text: '0' })),
                    el('div', { id: `${P}-queue-empty`, className: `${P}-muted`, text: 'Tick "Queue" beside reports in the list above.' }),
                    el('ul', { id: `${P}-queue-list`, className: `${P}-queue-list` }),
                    el('div', { className: `${P}-row` },
                        // busy() puts back the label it found; the queue then says what is next.
                        button('queue-run', 'Run the next one', `${P}-btn-primary ${P}-grow`,
                            () => busy('queue-run', 'Starting...', runQueueNext).then(updateQueueButtons)),
                        button('queue-skip', 'Skip', '', skipQueueNext),
                        button('queue-clear', 'Clear', '', () => clearQueue(false))),
                    el('div', { id: `${P}-queue-clear-confirm`, className: `${P}-confirm`, style: 'display:none' },
                        el('span', { text: 'Empty the queue? Nothing already in PMWeb is touched.' }),
                        button('queue-clear-yes', 'Yes, empty it', `${P}-btn-danger`, () => clearQueue(true)),
                        button('queue-clear-no', 'No', '', () => show('queue-clear-confirm', false))),
                    el('p', { id: `${P}-queue-msg`, className: `${P}-muted` })),

                section('Auto-Fill Everything',
                    el('p', { id: `${P}-monday`, className: `${P}-note`, style: 'display:none',
                        text: 'It is Monday: check the starting record number.' }),
                    el('div', { className: `${P}-row` },
                        field('record', 'Record #', el('input', { id: `${P}-record`, type: 'text', inputmode: 'numeric', placeholder: 'e.g. 1470' })),
                        field('shift', 'Shift', select('shift', [['Day', 'Day'], ['Evening', 'Evening'], ['Night', 'Night']]))),
                    field('mode', 'Rows already on Labor and Equipment',
                        select('mode', [['add', 'Add to what is there'], ['fill', 'Fill the rows already there']])),
                    button('autofill', 'Auto-Fill Everything', `${P}-btn-primary ${P}-btn-block`,
                        () => busy('autofill', 'Starting...', () => autoFillEverything(null)))),

                section('One step at a time',
                    el('h3', { className: `${P}-h3`, text: 'Labor and Equipment' }),
                    el('p', { id: `${P}-rows-info`, className: `${P}-muted`, text: 'No resource rows fetched yet.' }),
                    el('div', { className: `${P}-row` },
                        button('fetch-resources', 'Fetch resources', '', () => busy('fetch-resources', 'Fetching...', fetchResources)),
                        button('fill-resources', 'Fill Labor and Equipment', `${P}-btn-primary`, () => busy('fill-resources', 'Sending...', () => fillResources(false)))),
                    el('div', { id: `${P}-fill-resources-confirm`, className: `${P}-confirm`, style: 'display:none' },
                        el('span', { id: `${P}-fill-resources-reason` }),
                        button('fill-resources-yes', 'Fill them anyway', `${P}-btn-danger`, () => busy('fill-resources-yes', 'Sending...', () => fillResources(true))),
                        button('fill-resources-no', 'Cancel', '', () => show('fill-resources-confirm', false))),

                    el('h3', { className: `${P}-h3`, text: 'Activities' }),
                    el('p', { id: `${P}-acts-info`, className: `${P}-muted`, text: 'No activity rows fetched yet.' }),
                    el('div', { className: `${P}-row` },
                        button('fetch-activities', 'Fetch activities', '', () => busy('fetch-activities', 'Fetching...', fetchActivities)),
                        button('fill-activities', 'Fill activities', `${P}-btn-primary`, () => busy('fill-activities', 'Sending...', fillActivities))),

                    el('h3', { className: `${P}-h3`, text: 'Notes' }),
                    button('fill-notes', 'Fill notes', `${P}-btn-primary`, () => busy('fill-notes', 'Sending...', fillNotes)),

                    el('h3', { className: `${P}-h3`, text: 'Clear' }),
                    button('clear', 'Clear all timesheet data on this page', `${P}-btn-danger`, () => clearData(false)),
                    el('div', { id: `${P}-clear-confirm`, className: `${P}-confirm`, style: 'display:none' },
                        el('span', { text: 'Clear every visible timesheet field on this page? This cannot be undone.' }),
                        button('clear-yes', 'Yes, clear them', `${P}-btn-danger`, () => clearData(true)),
                        button('clear-no', 'No', '', () => show('clear-confirm', false)))),

                section('PMWeb resources',
                    el('p', { className: `${P}-muted`, text: 'Reads every resource PMWeb offers and saves the list to the app.' }),
                    button('find-resources', 'Find new PMWeb resources', '', () => busy('find-resources', 'Reading...', findResources))),

                el('p', { className: `${P}-footer`, text: 'Alt+Shift+P opens and closes this panel.' })));

        document.body.appendChild(root);
    }

    // Every rule is scoped to the panel, so nothing here restyles PMWeb, and
    // the reset keeps PMWeb's own styles out of the panel.
    const CSS = `
#pmwap-root { all: initial; position: fixed; top: 0; right: 0; bottom: 0; width: ${WIDTH}px;
  z-index: 2147483000; display: flex; flex-direction: column; background: #ffffff; color: #1b1f24;
  border-left: 1px solid #d5dae1; box-shadow: -8px 0 24px rgba(16, 24, 40, 0.10);
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
#pmwap-root * { box-sizing: border-box; font-family: inherit; letter-spacing: normal; text-transform: none; }
#pmwap-root .pmwap-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;
  padding: 14px 16px 10px; border-bottom: 1px solid #e6e9ee; }
#pmwap-root .pmwap-h1 { margin: 0; font-size: 16px; font-weight: 700; color: #1b1f24; }
#pmwap-root .pmwap-h2 { margin: 0 0 8px; font-size: 11px; font-weight: 700; color: #5d6673;
  text-transform: uppercase; letter-spacing: 0.06em; }
#pmwap-root .pmwap-h3 { margin: 12px 0 4px; font-size: 13px; font-weight: 700; color: #1b1f24; }
#pmwap-root .pmwap-muted { color: #5d6673; font-size: 12px; }
#pmwap-root p { margin: 4px 0 8px; }
#pmwap-root .pmwap-status { margin: 10px 16px; padding: 10px 12px; border-radius: 6px; border: 1px solid #d5dae1;
  background: #f4f6f8; font-size: 12.5px; }
#pmwap-root .pmwap-status-busy { background: #fff8e6; border-color: #f0c36d; }
#pmwap-root .pmwap-status-ok { background: #ecfdf3; border-color: #7fd3a3; }
#pmwap-root .pmwap-status-warn { background: #fff8e6; border-color: #f0c36d; }
#pmwap-root .pmwap-status-error { background: #fef3f2; border-color: #f2a39a; }
#pmwap-root .pmwap-status-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; }
#pmwap-root .pmwap-body { flex: 1; overflow-y: auto; padding: 0 16px 16px; }
#pmwap-root .pmwap-section { padding: 14px 0; border-top: 1px solid #e6e9ee; }
#pmwap-root .pmwap-callout { margin: 8px 0; padding: 10px 12px; border: 1px solid #f0c36d; background: #fff8e6; border-radius: 6px; }
#pmwap-root .pmwap-row { display: flex; align-items: flex-end; gap: 6px; margin: 6px 0; flex-wrap: wrap; }
#pmwap-root .pmwap-grow { flex: 1; }
#pmwap-root .pmwap-field { display: flex; flex-direction: column; gap: 3px; margin: 6px 0; flex: 1; min-width: 0; }
#pmwap-root .pmwap-field label { font-size: 12px; color: #5d6673; }
#pmwap-root input[type=text], #pmwap-root input[type=search], #pmwap-root input[type=password], #pmwap-root select {
  height: 32px; padding: 4px 8px; border: 1px solid #c9d0d8; border-radius: 5px; background: #fff; color: #1b1f24;
  font-size: 13px; min-width: 0; }
#pmwap-root input[type=search] { flex: 1; }
#pmwap-root input:focus, #pmwap-root select:focus, #pmwap-root button:focus-visible {
  outline: 2px solid #2f6fdb; outline-offset: 1px; }
#pmwap-root .pmwap-btn { min-height: 32px; padding: 5px 12px; border: 1px solid #c9d0d8; border-radius: 5px;
  background: #fff; color: #1b1f24; font-size: 13px; font-weight: 600; cursor: pointer; }
#pmwap-root .pmwap-btn:hover { background: #f4f6f8; }
#pmwap-root .pmwap-btn:disabled { opacity: 0.5; cursor: default; }
#pmwap-root .pmwap-btn-primary { background: #1b1f24; border-color: #1b1f24; color: #fff; }
#pmwap-root .pmwap-btn-primary:hover { background: #343a42; }
#pmwap-root .pmwap-btn-danger { color: #b42318; border-color: #f2a39a; }
#pmwap-root .pmwap-btn-quiet { border-color: transparent; color: #5d6673; }
#pmwap-root .pmwap-btn-small { min-height: 26px; padding: 2px 8px; font-size: 12px; }
#pmwap-root .pmwap-btn-block { width: 100%; margin-top: 6px; }
#pmwap-root .pmwap-selected { padding: 8px 10px; border: 1px solid #d5dae1; border-radius: 6px; background: #f8f9fb; margin-bottom: 6px; }
#pmwap-root .pmwap-selected-date { font-weight: 700; }
#pmwap-root .pmwap-report-list, #pmwap-root .pmwap-queue-list { list-style: none; margin: 6px 0; padding: 0;
  border: 1px solid #e6e9ee; border-radius: 6px; max-height: 300px; overflow-y: auto; }
#pmwap-root .pmwap-report { padding: 6px 8px; border-bottom: 1px solid #eef0f3; }
#pmwap-root .pmwap-report-selected { background: #eef4ff; box-shadow: inset 3px 0 0 #2f6fdb; }
#pmwap-root .pmwap-report-main { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
#pmwap-root .pmwap-report-pick { flex: 1; text-align: left; border: none; background: none; padding: 2px 0;
  font-size: 13px; font-weight: 700; color: #1b1f24; cursor: pointer; }
#pmwap-root .pmwap-report-acts { font-size: 11.5px; color: #5d6673; }
#pmwap-root .pmwap-check { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #5d6673; cursor: pointer; }
#pmwap-root .pmwap-empty { padding: 10px; color: #5d6673; text-align: center; }
#pmwap-root .pmwap-q-item { padding: 8px; border-bottom: 1px solid #eef0f3; }
#pmwap-root .pmwap-q-head { display: flex; justify-content: space-between; font-weight: 700; }
#pmwap-root .pmwap-q-status { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #5d6673; }
#pmwap-root .pmwap-q-sent .pmwap-q-status { color: #9a6700; }
#pmwap-root .pmwap-q-done .pmwap-q-status { color: #167a3e; }
#pmwap-root .pmwap-q-problems .pmwap-q-status { color: #b42318; }
#pmwap-root .pmwap-q-fields { display: flex; gap: 4px; margin: 6px 0 4px; }
#pmwap-root .pmwap-q-fields input { flex: 1; }
#pmwap-root ul.pmwap-q-problems { margin: 4px 0; padding-left: 16px; color: #b42318; font-size: 11.5px; list-style: disc; }
#pmwap-root .pmwap-q-actions { display: flex; gap: 4px; }
#pmwap-root .pmwap-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 6px 0; padding: 8px;
  border: 1px solid #f2a39a; background: #fef3f2; border-radius: 6px; font-size: 12px; }
#pmwap-root .pmwap-note { padding: 6px 8px; background: #fff8e6; border-radius: 5px; font-size: 12px; }
#pmwap-root .pmwap-footer { margin-top: 12px; color: #5d6673; font-size: 11.5px; text-align: center; }
#pmwap-root .pmwap-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
`;

    // ── Start ────────────────────────────────────────────────────────────────

    async function init() {
        build();
        const st = await chrome.storage.local.get(['pmwebPanelOpen', 'resourceMode', 'lastRecordNumber', 'selectedReportId']);
        if (st.resourceMode) $('mode').value = st.resourceMode;
        if (st.lastRecordNumber) $('record').value = String(st.lastRecordNumber + 1);
        S.selectedId = st.selectedReportId || null;
        if (new Date().getDay() === 1) show('monday', true);

        S.queue = await PMCore.loadQueue();
        await PMCore.applyStoredLastRun(S.queue);
        renderQueue();
        renderRowsInfo();

        // Open unless it was closed; connecting waits until it is open, so a
        // closed panel makes no requests.
        setOpen(st.pmwebPanelOpen !== false, false);
    }

    init().catch((e) => console.error('[side panel] could not start', e));
})();
