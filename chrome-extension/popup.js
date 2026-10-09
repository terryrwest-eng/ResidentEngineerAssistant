// PMWeb Auto-Fill Extension - Popup Script

let rowsData = [];
let activitiesData = []; // Activities (OnSite) rows
let fullData = null; // Full PMWeb data bundle from /pmweb-full
let API_BASE = ''; // Will be set from storage or detected

// ── Signing requests ─────────────────────────────────────────────────────────
//
// Reports are per-user now, so every endpoint except /api/health requires a
// signed-in user. The extension is a separate origin with no session of its
// own, so it carries an access token the user pastes in once — copy it from
// Settings in the app ("Copy access token").
//
// apiFetch attaches it to every call. The token is stored alongside apiBase in
// chrome.storage.local, which is per-profile and not readable by pages.
//
// The logic itself is in core.js, shared with the side panel on PMWeb pages.

async function getAuthToken() {
    return PMCore.getAuthToken();
}

/** fetch() with the stored access token attached; a 401 or 403 opens the token box. */
async function apiFetch(url, options = {}) {
    return PMCore.apiFetch(url, options, showTokenPrompt);
}

const fmtPickerDate = PMCore.fmtPickerDate;
const fmtShift = PMCore.fmtShift;
const htmlToPlainText = PMCore.htmlToPlainText;

/** Tell the user the extension needs a token, without wiping the popup. */
function showTokenPrompt() {
    const el = document.getElementById('tokenPrompt');
    if (el) el.style.display = 'block';
}

/** Wire up the token box. Called once the popup DOM exists. */
function initTokenBox() {
    const input = document.getElementById('tokenInput');
    const button = document.getElementById('saveTokenBtn');
    const message = document.getElementById('tokenMsg');
    if (!input || !button) return;

    button.addEventListener('click', async () => {
        const token = (input.value || '').trim();
        if (!token) {
            if (message) message.textContent = 'Paste the token first.';
            return;
        }
        await chrome.storage.local.set({ apiToken: token });
        input.value = '';
        if (message) message.textContent = 'Saved. Try that again.';
        const prompt = document.getElementById('tokenPrompt');
        if (prompt) setTimeout(() => { prompt.style.display = 'none'; }, 1500);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') button.click();
    });

    // Say so up front when there is no token at all, rather than waiting for
    // the first request to fail and look like a connection problem.
    getAuthToken().then(token => { if (!token) showTokenPrompt(); });
}

document.addEventListener('DOMContentLoaded', initTokenBox);


// Get saved API URL or detect it (core.js)
async function getApiBase() {
    return PMCore.getApiBase();
}

// Check connection to app
async function checkConnection() {
    const statusDiv = document.getElementById('status');
    statusDiv.textContent = 'Checking connection...';

    API_BASE = await getApiBase();

    if (API_BASE) {
        statusDiv.className = 'status connected';
        statusDiv.textContent = `✓ Connected: ${API_BASE.replace('https://', '').replace('http://', '').split('.')[0]}`;
        return true;
    }

    statusDiv.className = 'status disconnected';
    statusDiv.innerHTML = '✗ Not connected. <a href="#" id="setUrlLink" style="color:#fff">Set URL</a>';
    document.getElementById('setUrlLink')?.addEventListener('click', promptForUrl);
    return false;
}

// Let user set custom URL
async function promptForUrl() {
    const url = prompt('Enter your Railway app URL (e.g., https://your-app.up.railway.app):');
    if (url) {
        await chrome.storage.local.set({ apiBase: url.replace(/\/$/, '') });
        checkConnection();
    }
}

// Fetch report data from app (Resources)
async function fetchData() {
    const fetchBtn = document.getElementById('fetchBtn');
    const fillBtn = document.getElementById('fillBtn');

    if (!API_BASE) {
        alert('Not connected to app! Click the status to set URL.');
        return;
    }

    fetchBtn.textContent = '⏳ Fetching...';
    fetchBtn.disabled = true;

    try {
        // 1. Check for specific "Active" context first (set by "Combined View")
        let reportId = null;
        try {
            const contextResp = await apiFetch(`${API_BASE}/api/extension/context`);
            if (contextResp.ok) {
                const context = await contextResp.json();
                if (context.report_id) {
                    reportId = context.report_id;
                    console.log("Using Active Context Report:", reportId);
                }
            }
        } catch (e) {
            console.log("Context check failed, falling back to latest.", e);
        }

        // 2. STRICT MODE: Only proceed if Combined View is open
        if (!reportId) {
            alert('No report selected.\n\nPick one from the Report list at the top of this popup.');
            fetchBtn.textContent = '📥 Fetch Data from App';
            fetchBtn.disabled = false;
            return;
        }

        const dataResp = await apiFetch(`${API_BASE}/api/reports/${reportId}/consolidated`);
        rowsData = await dataResp.json();

        // Stamped with WHICH report and WHEN, for the side panel's Fill step.
        const picked = pickerReports.find(r => r.id === reportId);
        await PMCore.storeResourceRows(rowsData, reportId, (picked && picked.report_date) || '');

        const container = document.getElementById('rowCountContainer');
        const msg = document.getElementById('rowCountMsg');

        container.style.display = 'block';
        msg.innerHTML = `Found <strong>${rowsData.length}</strong> items.<br>Bot will click Add > Fill > Save for each.`;

        fillBtn.disabled = false;

        fetchBtn.textContent = '✓ Data Fetched';
    } catch (e) {
        console.error('Fetch error:', e);
        alert(`Error fetching data: ${e.message}`);
        fetchBtn.textContent = '📥 Fetch Data from App';
    } finally {
        fetchBtn.disabled = false;
    }
}

// Send fill command — injects worker directly then triggers fill
async function fillPMWeb() {
    const fillBtn = document.getElementById('fillBtn');
    fillBtn.textContent = '⏳ Filling...';
    fillBtn.disabled = true;

    try {
        // Get current tab
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab.url.includes('pmweb.com')) {
            alert('Please navigate to PMWeb first!');
            fillBtn.textContent = '⚡ Fill PMWeb Rows';
            fillBtn.disabled = false;
            return;
        }

        // Step 1: Ensure injected.js is loaded in the MAIN world
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['injected.js'],
            world: 'MAIN'
        });
        console.log('injected.js loaded into MAIN world');

        // Step 2: Trigger fill in the MAIN world
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (rows, mode) => {
                console.log('PMWeb Auto-Fill: Dispatching', rows.length, 'rows to worker, mode', mode);
                window.pmwebAutoFillData = rows;
                window.dispatchEvent(new CustomEvent('PMWEB_FILL_TRIGGER', {
                    detail: { rows: rows, mode: mode }
                }));
            },
            args: [rowsData, getResourceMode()],
            world: 'MAIN'
        });

        fillBtn.textContent = '✓ Sent!';
        setTimeout(() => {
            fillBtn.textContent = '⚡ Fill PMWeb Rows';
            fillBtn.disabled = false;
        }, 2000);
    } catch (e) {
        console.error('Fill error:', e);
        alert(`Error: ${e.message}`);
        fillBtn.textContent = '⚡ Fill PMWeb Rows';
        fillBtn.disabled = false;
    }
}

// Clear all data from PMWeb rows
async function clearPMWeb() {
    const clearBtn = document.getElementById('clearBtn');

    if (!confirm('⚠️ Are you sure you want to clear ALL data from the PMWeb timesheet?\n\nThis cannot be undone.')) {
        return;
    }

    clearBtn.textContent = '⏳ Clearing...';
    clearBtn.disabled = true;

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab.url.includes('pmweb.com')) {
            alert('Please navigate to PMWeb first!');
            clearBtn.textContent = '🗑️ Clear All Data';
            clearBtn.disabled = false;
            return;
        }

        // Execute clear script in the page (core.js, shared with the side panel)
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: PMCore.clearTimesheetFields
        });
        const cleared = results && results[0] ? results[0].result : 0;
        alert('✅ Cleared ' + cleared + ' fields!');

        clearBtn.textContent = '✓ Cleared!';
        setTimeout(() => {
            clearBtn.textContent = '🗑️ Clear All Data';
            clearBtn.disabled = false;
        }, 2000);
    } catch (e) {
        console.error('Clear error:', e);
        alert(`Error: ${e.message}`);
        clearBtn.textContent = '🗑️ Clear All Data';
        clearBtn.disabled = false;
    }
}

// ============================================
// Activities (OnSite) — Fetch & Fill
// ============================================

async function fetchActivities() {
    const fetchBtn = document.getElementById('fetchActBtn');
    const fillBtn = document.getElementById('fillActBtn');

    if (!API_BASE) {
        alert('Not connected to app! Click the status to set URL.');
        return;
    }

    fetchBtn.textContent = '⏳ Fetching...';
    fetchBtn.disabled = true;

    try {
        // Get active report context
        let reportId = null;
        try {
            const contextResp = await apiFetch(`${API_BASE}/api/extension/context`);
            if (contextResp.ok) {
                const context = await contextResp.json();
                if (context.report_id) {
                    reportId = context.report_id;
                    console.log("Activities: Using Active Context Report:", reportId);
                }
            }
        } catch (e) {
            console.log("Activities: Context check failed.", e);
        }

        if (!reportId) {
            alert('No report selected.\n\nPick one from the Report list at the top of this popup.');
            fetchBtn.textContent = '📥 Fetch Activities';
            fetchBtn.disabled = false;
            return;
        }

        const dataResp = await apiFetch(`${API_BASE}/api/reports/${reportId}/activities-consolidated`);
        activitiesData = await dataResp.json();

        // Store in extension storage
        chrome.storage.local.set({ pmwebActivities: activitiesData });

        const container = document.getElementById('actRowCountContainer');
        const msg = document.getElementById('actRowCountMsg');

        container.style.display = 'block';
        msg.innerHTML = `Found <strong>${activitiesData.length}</strong> activities.<br>Bot will click Add > Fill > Save for each.`;

        fillBtn.disabled = false;
        fetchBtn.textContent = '✓ Fetched';
    } catch (e) {
        console.error('Fetch activities error:', e);
        alert(`Error fetching activities: ${e.message}`);
        fetchBtn.textContent = '📥 Fetch Activities';
    } finally {
        fetchBtn.disabled = false;
    }
}

async function fillActivities() {
    const fillBtn = document.getElementById('fillActBtn');
    fillBtn.textContent = '⏳ Filling...';
    fillBtn.disabled = true;

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab.url.includes('pmweb.com')) {
            alert('Please navigate to PMWeb first!');
            fillBtn.textContent = '⚡ Fill Activities';
            fillBtn.disabled = false;
            return;
        }

        // Ensure injected.js is loaded
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['injected.js'],
            world: 'MAIN'
        });

        // Dispatch activities fill event
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (rows) => {
                console.log('PMWeb Auto-Fill: Dispatching', rows.length, 'activities to worker');
                window.pmwebActivitiesData = rows;
                window.dispatchEvent(new CustomEvent('PMWEB_FILL_ACTIVITIES_TRIGGER', { detail: rows }));
            },
            args: [activitiesData],
            world: 'MAIN'
        });

        fillBtn.textContent = '✓ Sent!';
        setTimeout(() => {
            fillBtn.textContent = '⚡ Fill Activities';
            fillBtn.disabled = false;
        }, 2000);
    } catch (e) {
        console.error('Fill activities error:', e);
        alert(`Error: ${e.message}`);
        fillBtn.textContent = '⚡ Fill Activities';
        fillBtn.disabled = false;
    }
}

// The Notes tab on its own. Same shape as fillActivities, except there is
// nothing to fetch first - the note text arrives with the report.
async function fillNotesOnly() {
    const btn = document.getElementById('fillNotesBtn');
    btn.textContent = '⏳ Filling...';
    btn.disabled = true;

    try {
        const data = await fetchFullData();
        if (!data) return;                       // fetchFullData has already said why
        if (!data.notes_html) {
            alert('This report has no note text to write.');
            return;
        }

        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab.url.includes('pmweb.com')) {
            alert('Please navigate to PMWeb first!');
            return;
        }

        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['injected.js'],
            world: 'MAIN'
        });

        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (html) => {
                console.log('PMWeb Auto-Fill: dispatching the note to the worker');
                window.dispatchEvent(new CustomEvent('PMWEB_FILL_NOTE_TRIGGER', { detail: html }));
            },
            args: [data.notes_html],
            world: 'MAIN'
        });

        btn.textContent = '✓ Sent!';
    } catch (e) {
        console.error('Fill notes error:', e);
        alert(`Error: ${e.message}`);
    } finally {
        setTimeout(() => {
            btn.textContent = '📝 Fill Notes';
            btn.disabled = false;
        }, 2000);
    }
}

// Sync PMWeb Resources
async function syncPMWebResources() {
    const syncBtn = document.getElementById('syncResourcesBtn');
    syncBtn.textContent = '⏳ Finding Resources...';
    syncBtn.disabled = true;

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab.url.includes('pmweb.com')) {
            alert('Please navigate to PMWeb first!');
            syncBtn.textContent = '🔍 Find New PMWeb Resources';
            syncBtn.disabled = false;
            return;
        }

        // Ensure injected.js is loaded
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['injected.js'],
            world: 'MAIN'
        });

        // Add one-time listener for the result
        const listener = async (message) => {
            if (message.type === 'PMWEB_SYNC_RESULT') {
                chrome.runtime.onMessage.removeListener(listener);
                
                if (message.data.error) {
                    alert(`Sync Error: ${message.data.error}`);
                    syncBtn.textContent = '🔍 Find New PMWeb Resources';
                    syncBtn.disabled = false;
                    return;
                }

                try {
                    syncBtn.textContent = '⏳ Saving to App...';
                    const response = await apiFetch(`${API_BASE}/api/settings/sync-pmweb-resources`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ resources: message.data.resources })
                    });
                    
                    if (!response.ok) throw new Error('API failed to save');
                    const data = await response.json();
                    
                    syncBtn.textContent = `✓ Synced! (${data.counts.labor} L, ${data.counts.equipment} E)`;
                    setTimeout(() => {
                        syncBtn.textContent = '🔍 Find New PMWeb Resources';
                        syncBtn.disabled = false;
                    }, 3000);
                } catch (e) {
                    console.error('API Save Error:', e);
                    alert(`Failed to save resources to app: ${e.message}`);
                    syncBtn.textContent = '🔍 Find New PMWeb Resources';
                    syncBtn.disabled = false;
                }
            }
        };
        chrome.runtime.onMessage.addListener(listener);

        // Trigger extraction in MAIN world
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                window.dispatchEvent(new CustomEvent('PMWEB_SYNC_TRIGGER'));
            },
            world: 'MAIN'
        });

    } catch (e) {
        console.error('Sync error:', e);
        alert(`Error: ${e.message}`);
        syncBtn.textContent = '🔍 Find New PMWeb Resources';
        syncBtn.disabled = false;
    }
}

// ============================================
// FULL AUTOMATION — Auto-Fill Everything
// ============================================

async function fetchFullData() {
    if (!API_BASE) {
        alert('Not connected to app! Click the status to set URL.');
        return null;
    }

    // Get active report context
    let reportId = null;
    try {
        const contextResp = await apiFetch(`${API_BASE}/api/extension/context`);
        if (contextResp.ok) {
            const context = await contextResp.json();
            if (context.report_id) reportId = context.report_id;
        }
    } catch (e) {
        console.log("Context check failed.", e);
    }

    if (!reportId) {
        alert('No report selected.\n\nPick one from the Report list at the top of this popup.');
        return null;
    }

    const resp = await apiFetch(`${API_BASE}/api/export/${reportId}/pmweb-full`);
    if (!resp.ok) throw new Error(`API returned ${resp.status}`);
    return await resp.json();
}

function updateProgress(phase, total, label) {
    const progressBar = document.getElementById('progressBar');
    const progressLabel = document.getElementById('progressLabel');
    const progressFill = document.getElementById('progressFill');
    progressBar.style.display = 'block';
    progressLabel.textContent = `Phase ${phase}/${total}: ${label}`;
    progressFill.style.width = `${(phase / total) * 100}%`;
}

async function autoFillEverything() {
    const btn = document.getElementById('autoFillBtn');
    const recordNum = document.getElementById('recordNumInput').value.trim();
    const shift = document.getElementById('shiftSelect').value;
    // What Phase 3 does with rows already on the Labor and Equipment tab.
    // 'add' leaves them and adds beside them; 'fill' writes into them and
    // creates only the shortfall. Terry, 2026-09-27: "NO IT ADDS MORE ON TOP
    // TO ADD TO NOT WRITE OVER".
    const resourceMode = getResourceMode();
    chrome.storage.local.set({ resourceMode: resourceMode });

    if (!recordNum) {
        alert('Please enter a Record #');
        return;
    }

    btn.textContent = '⏳ Working...';
    btn.disabled = true;

    try {
        // Fetch all data
        updateProgress(0, 5, 'Fetching data...');
        fullData = await fetchFullData();
        if (!fullData) {
            btn.textContent = '🚀 Auto-Fill Everything';
            btn.disabled = false;
            return;
        }

        // Bundle everything for injected.js. core.js builds it - the short
        // location, the military times, the shift value - so the side panel
        // sends exactly the same thing.
        const payload = PMCore.buildFullPayload(fullData, {
            recordNum: recordNum,
            shift: shift,
            resourceMode: resourceMode,
            reportId: (await chrome.storage.local.get(['selectedReportId'])).selectedReportId || null
        });

        // Get current tab
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab.url.includes('pmweb.com')) {
            alert('Please navigate to PMWeb first!');
            btn.textContent = '🚀 Auto-Fill Everything';
            btn.disabled = false;
            return;
        }

        // Inject and run
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['injected.js'],
            world: 'MAIN'
        });

        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (data) => {
                console.log('🚀 FULL AUTO-FILL: Dispatching payload');
                window.dispatchEvent(new CustomEvent('PMWEB_FILL_EVERYTHING', { detail: data }));
            },
            args: [payload],
            world: 'MAIN'
        });

        // Save record number for next time
        await chrome.storage.local.set({ lastRecordNumber: parseInt(recordNum) });

        btn.textContent = '✓ Sent! Watch PMWeb...';
        updateProgress(1, 5, 'Filling Main Tab...');

    } catch (e) {
        console.error('Auto-fill error:', e);
        alert(`Error: ${e.message}`);
        btn.textContent = '🚀 Auto-Fill Everything';
        btn.disabled = false;
    }
}

// What Phase 3 does with rows already on the Labor and Equipment tab. The choice
// appears twice - once in Full Automation, once beside "Fill PMWeb Rows" in
// Individual Controls, because that section is collapsed by default and the
// control up top did not look as though it governed the button down here.
// Terry, 2026-09-27: "i dont have that option when using the fill resources. its
// only when i use fill all". One value, two controls, kept in step.
function resourceModeEls() {
    return ['resourceModeSelect', 'resourceModeSelect2']
        .map((id) => document.getElementById(id))
        .filter(Boolean);
}

function getResourceMode() {
    const el = resourceModeEls()[0];
    return (el && el.value) || 'add';
}

async function initResourceMode() {
    const els = resourceModeEls();
    if (!els.length) return;
    chrome.storage.local.get(['resourceMode'], (stored) => {
        if (stored.resourceMode) els.forEach((e) => { e.value = stored.resourceMode; });
    });
    els.forEach((el) => {
        el.addEventListener('change', () => {
            els.forEach((other) => { other.value = el.value; });
            chrome.storage.local.set({ resourceMode: el.value });
        });
    });
}

async function initRecordNumber() {
    // Load last used record number
    const stored = await chrome.storage.local.get(['lastRecordNumber']);
    const recordInput = document.getElementById('recordNumInput');
    if (stored.lastRecordNumber) {
        recordInput.value = String(stored.lastRecordNumber + 1);
    }
}

async function checkMonday() {
    // If we have data, check if it's Monday
    const banner = document.getElementById('mondayBanner');
    const today = new Date();
    if (today.getDay() === 1) { // Monday
        banner.style.display = 'block';
    }
}

// ============================================
// REPORT PICKER
// ============================================
// WHY: the extension used to depend on a single "active report" pointer that
// the web app set on the server. In production the API runs two uvicorn
// workers, each holding its own copy of that pointer in memory, so a read had
// roughly a 50% chance of returning a stale report from the other worker —
// which is why PMWeb was being filled from the wrong day. Picking the report
// here is explicit, and it also saves navigating back into the app to switch
// days.

let pickerFilter = '';
let pickerTotal = 0;
let pickerReports = [];

function renderActiveReport(report) {
    const dateEl = document.getElementById('activeReportDate');
    const actsEl = document.getElementById('activeReportActs');
    if (!dateEl || !actsEl) return;

    if (!report) {
        dateEl.textContent = 'No report selected';
        actsEl.textContent = 'Pick one below';
        return;
    }
    const shift = fmtShift(report);
    dateEl.textContent = fmtPickerDate(report.report_date) + (shift ? `  ·  ${shift}` : '');
    actsEl.textContent = report.activities && report.activities.length
        ? report.activities.join(' • ')
        : 'No activities on this report';
}

async function selectReport(reportId) {
    const report = pickerReports.find(r => r.id === reportId);
    try {
        // Points the app's context at the report and drops rows fetched for a
        // different one (core.js, shared with the side panel).
        await PMCore.setContextReport(API_BASE, reportId, showTokenPrompt);
        renderActiveReport(report);
        renderReportList();
        console.log('[picker] Selected report', reportId);
    } catch (e) {
        console.error('[picker] Could not select report', e);
    }
}

function renderReportList() {
    const list = document.getElementById('reportList');
    if (!list) return;

    if (!pickerReports.length) {
        list.innerHTML = '<div style="padding:12px; text-align:center; font-size:12px; color:rgba(255,255,255,0.5);">No reports found</div>';
        return;
    }

    // Matches on date, project or any activity name, so "8/14", "tecolote" and
    // "blow-off" all find the report. Typing is far quicker than scrolling a
    // year of reports.
    const q = (pickerFilter || '').trim().toLowerCase();
    const shown = !q ? pickerReports : pickerReports.filter((r) => {
        const hay = [
            r.report_date || '',
            fmtPickerDate(r.report_date) || '',
            r.project_name || '',
            (r.activities || []).join(' '),
        ].join(' ').toLowerCase();
        return hay.includes(q);
    });

    const countEl = document.getElementById('reportCount');
    if (countEl) {
        countEl.textContent = q
            ? `${shown.length} of ${pickerReports.length}`
            : `${pickerReports.length} report${pickerReports.length === 1 ? '' : 's'}`;
    }

    if (!shown.length) {
        list.innerHTML = '<div style="padding:12px; text-align:center; font-size:12px; color:rgba(255,255,255,0.5);">No reports match that</div>';
        return;
    }

    chrome.storage.local.get(['selectedReportId'], (stored) => {
        const selectedId = stored.selectedReportId;
        list.innerHTML = '';

        shown.forEach((r) => {
            const isSel = r.id === selectedId;
            const row = document.createElement('div');
            row.style.cssText = `
                padding: 8px 10px;
                border-bottom: 1px solid rgba(255,255,255,0.07);
                cursor: pointer;
                background: ${isSel ? 'rgba(167,139,250,0.22)' : 'transparent'};
                border-left: 3px solid ${isSel ? '#a78bfa' : 'transparent'};
            `;
            row.addEventListener('mouseenter', () => {
                if (!isSel) row.style.background = 'rgba(255,255,255,0.06)';
            });
            row.addEventListener('mouseleave', () => {
                if (!isSel) row.style.background = 'transparent';
            });
            row.addEventListener('click', () => selectReport(r.id));

            const shift = fmtShift(r);
            const acts = (r.activities || []).join(' • ') || 'No activities';
            const draft = r.status === 'draft'
                ? ' <span style="font-size:9px; text-transform:uppercase; letter-spacing:0.06em; color:#ffc107;">draft</span>'
                : '';

            // The checkbox puts the report in the queue; the rest of the row
            // still selects it. Two different jobs, so the click does not carry
            // from one to the other.
            row.innerHTML = `
                <div style="display:flex; align-items:flex-start; gap:8px;">
                    <input type="checkbox" class="queuePick" ${queueHas(r.id) ? 'checked' : ''}
                           title="Put this report in the queue"
                           style="margin-top:3px; cursor:pointer; flex:0 0 auto;">
                    <div style="flex:1; min-width:0;">
                        <div style="display:flex; align-items:baseline; gap:6px;">
                            <span style="font-size:12px; font-weight:700; color:#fff;">${fmtPickerDate(r.report_date)}</span>
                            ${shift ? `<span style="font-size:10px; color:rgba(255,255,255,0.55);">${shift}</span>` : ''}
                            ${draft}
                        </div>
                        <div style="font-size:10.5px; color:rgba(255,255,255,0.6); margin-top:2px; line-height:1.35;">${acts}</div>
                    </div>
                </div>
            `;
            const pick = row.querySelector('input.queuePick');
            if (pick) {
                pick.addEventListener('click', (ev) => {
                    ev.stopPropagation();          // not a report selection
                    toggleQueue(r);
                });
            }
            list.appendChild(row);
        });
    });
}

// ============================================
// THE QUEUE
// ============================================
// One entry per report, each carrying the record number and shift PMWeb needs.
// Held in chrome.storage so it survives the popup closing - which it does every
// time Terry clicks into the PMWeb page - and so the side panel shows the same
// queue. The queue logic is in core.js; this file only draws it.
//
// status: 'pending' -> 'sent' (the run was started) -> 'done' or 'problems',
// the last two set from what the page reports back when it finishes.

let queue = { items: [] };

async function loadQueue() {
    queue = await PMCore.loadQueue();
    await applyLastRun();
    renderQueue();
}

async function saveQueue() {
    await PMCore.saveQueue(queue);
}

function queueHas(id) {
    return PMCore.queueHas(queue, id);
}

function toggleQueue(report) {
    PMCore.toggleQueueItem(queue, report, getResourceMode());
    saveQueue();
    renderQueue();
    renderReportList();
}

// What the page said when it finished. injected.js raises PMWEB_RUN_RESULT,
// content.js writes it to storage; the popup is usually shut by then.
async function applyLastRun() {
    await PMCore.applyStoredLastRun(queue);
}

function nextInQueue() {
    return PMCore.nextInQueue(queue);
}

function renderQueue() {
    const list = document.getElementById('queueList');
    const empty = document.getElementById('queueEmpty');
    const count = document.getElementById('queueCount');
    const runBtn = document.getElementById('queueRunBtn');
    const skipBtn = document.getElementById('queueSkipBtn');
    if (!list || !runBtn) return;

    if (count) count.textContent = String(queue.items.length);
    if (empty) empty.style.display = queue.items.length ? 'none' : 'block';

    const CHIP = {
        pending: ['waiting', 'rgba(255,255,255,0.5)'],
        sent: ['running', '#ffc107'],
        done: ['done', '#4ade80'],
        problems: ['check it', '#ff6b6b'],
    };

    list.innerHTML = '';
    queue.items.forEach((item, idx) => {
        const [label, colour] = CHIP[item.status] || CHIP.pending;
        const row = document.createElement('div');
        row.style.cssText = 'padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.07);';
        row.innerHTML = `
            <div style="display:flex; align-items:center; gap:6px;">
                <span style="font-size:11.5px; font-weight:700; color:#fff; flex:1; min-width:0;">
                    ${item.date || '(no date)'}
                </span>
                <span class="qChip" title="Click to put it back to waiting"
                      style="font-size:9.5px; text-transform:uppercase; letter-spacing:0.05em;
                             color:${colour}; cursor:pointer;">
                    ${label}
                </span>
                <span class="qDrop" title="Take it out of the queue"
                      style="cursor:pointer; color:rgba(255,255,255,0.45); font-size:13px; padding:0 2px;">✕</span>
            </div>
            <div style="display:flex; align-items:center; gap:4px; margin-top:4px;">
                <input class="qRecord" type="text" value="${item.record || ''}" placeholder="Record #"
                       style="flex:1; min-width:0; padding:4px 6px; font-size:11.5px; font-weight:600; color:#fff;
                              background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2);
                              border-radius:5px;">
                <select class="qShift" style="padding:4px; font-size:11px; color:#fff;
                              background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2);
                              border-radius:5px;">
                    <option value="Day">☀️ Day</option>
                    <option value="Evening">🌙 Evening</option>
                    <option value="Night">🌑 Night</option>
                </select>
                <select class="qMode" title="What to do with resource rows already there"
                        style="padding:4px; font-size:11px; color:#fff;
                               background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2);
                               border-radius:5px;">
                    <option value="add">add</option>
                    <option value="fill">fill</option>
                </select>
            </div>
            ${(item.problems && item.problems.length)
                ? `<div style="font-size:10px; color:#ff9b9b; margin-top:3px; line-height:1.35;">
                       ${item.problems.map((p) => '• ' + p).join('<br>')}
                   </div>`
                : ''}
        `;
        const rec = row.querySelector('.qRecord');
        const shift = row.querySelector('.qShift');
        const mode = row.querySelector('.qMode');
        shift.value = item.shift || 'Day';
        mode.value = item.mode || 'add';
        rec.addEventListener('input', () => {
            queue.items[idx].record = rec.value.trim();
            saveQueue();
            updateQueueButtons();
        });
        shift.addEventListener('change', () => { queue.items[idx].shift = shift.value; saveQueue(); });
        mode.addEventListener('change', () => { queue.items[idx].mode = mode.value; saveQueue(); });
        // A run that died part-way leaves its entry marked running, and nothing
        // else would ever move it. Clicking the chip puts it back to waiting.
        row.querySelector('.qChip').addEventListener('click', () => {
            queue.items[idx].status = 'pending';
            queue.items[idx].problems = [];
            saveQueue();
            renderQueue();
        });
        row.querySelector('.qDrop').addEventListener('click', () => {
            queue.items.splice(idx, 1);
            saveQueue();
            renderQueue();
            renderReportList();
        });
        list.appendChild(row);
    });

    updateQueueButtons();
}

function updateQueueButtons() {
    const runBtn = document.getElementById('queueRunBtn');
    const skipBtn = document.getElementById('queueSkipBtn');
    const msg = document.getElementById('queueMsg');
    if (!runBtn) return;

    const next = nextInQueue();
    const left = queue.items.filter((i) => i.status === 'pending').length;
    if (skipBtn) skipBtn.disabled = !next;

    if (!next) {
        runBtn.disabled = true;
        runBtn.textContent = queue.items.length ? '✓ Nothing left to run' : '▶ Run the next one';
        if (msg) {
            msg.textContent = queue.items.length
                ? 'Every report in the queue has been run. Anything marked "check it" has '
                  + 'a note under it saying what did not go in.'
                : '';
        }
        return;
    }

    runBtn.disabled = !next.record;
    runBtn.textContent = next.record
        ? `▶ Run ${next.date} (#${next.record} ${next.shift})`
        : `▶ Type a record # for ${next.date}`;
    if (msg) {
        msg.textContent = `${left} to go. Open ${next.date}'s record in PMWeb, then press Run - `
            + 'the queue sets the report, its record number, its shift and the resource mode for you. '
            + 'Opening the next record is still by hand until the list page has been read.';
    }
}

// Runs the next report by driving the controls the proven path already uses,
// rather than building a second copy of the payload. One path, so a fix to it
// fixes both.
async function runQueueNext() {
    const item = nextInQueue();
    if (!item) return;
    if (!item.record) {
        alert(`${item.date} has no record number yet.`);
        return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.includes('pmweb.com')) {
        alert('Open the PMWeb record for ' + item.date + ' first, then press Run.');
        return;
    }

    await selectReport(item.id);                       // the app's context follows the queue
    const recordInput = document.getElementById('recordNumInput');
    const shiftSelect = document.getElementById('shiftSelect');
    if (recordInput) recordInput.value = item.record;
    if (shiftSelect) shiftSelect.value = item.shift || 'Day';
    resourceModeEls().forEach((el) => { el.value = item.mode || 'add'; });

    item.status = 'sent';
    item.problems = [];
    await saveQueue();
    renderQueue();

    await autoFillEverything();
}

function wireQueue() {
    const run = document.getElementById('queueRunBtn');
    const skip = document.getElementById('queueSkipBtn');
    const clear = document.getElementById('queueClearBtn');
    if (run && !run.dataset.wired) {
        run.dataset.wired = '1';
        run.addEventListener('click', runQueueNext);
    }
    if (skip && !skip.dataset.wired) {
        skip.dataset.wired = '1';
        skip.addEventListener('click', () => {
            const next = nextInQueue();
            if (!next) return;
            next.status = 'done';
            next.problems = ['skipped by hand'];
            saveQueue();
            renderQueue();
        });
    }
    if (clear && !clear.dataset.wired) {
        clear.dataset.wired = '1';
        clear.addEventListener('click', () => {
            if (!queue.items.length) return;
            if (!confirm(`Empty the queue? ${queue.items.length} report(s) come out of it. `
                + 'Nothing already written to PMWeb is touched.')) return;
            queue.items = [];
            saveQueue();
            renderQueue();
            renderReportList();
        });
    }
}

function wireReportSearch() {
    const box = document.getElementById('reportSearch');
    if (!box || box.dataset.wired) return;
    box.dataset.wired = '1';
    box.addEventListener('input', () => {
        pickerFilter = box.value;
        renderReportList();
    });
}

async function loadReportPicker() {
    wireReportSearch();
    const list = document.getElementById('reportList');
    if (!API_BASE) {
        if (list) list.innerHTML = '<div style="padding:12px; text-align:center; font-size:12px; color:rgba(255,255,255,0.5);">Not connected to the app</div>';
        return;
    }
    try {
        // Every report, every page (core.js, shared with the side panel).
        const loaded = await PMCore.loadReports(API_BASE, showTokenPrompt);
        pickerReports = loaded.reports;
        pickerTotal = loaded.total;

        // Show whichever report is currently active, so the popup opens
        // reflecting reality rather than a guess.
        const activeId = await PMCore.getContextReportId(API_BASE, showTokenPrompt);

        if (activeId) chrome.storage.local.set({ selectedReportId: activeId });
        renderActiveReport(pickerReports.find(r => r.id === activeId) || null);
        renderReportList();
    } catch (e) {
        console.error('[picker] Load failed', e);
        if (list) list.innerHTML = '<div style="padding:12px; text-align:center; font-size:12px; color:#ff6b6b;">Could not load reports</div>';
    }
}

// ============================================
// COPY REPORT FOR PASTING
// ============================================
// Copies the report body — everything the Word export contains EXCEPT the
// consolidated resource table at the end. That is exactly what
// /api/export/{id}/notes-html already produces ("Same content as Word doc
// Page 1 — NO tables, NO consolidated resources"), so there is no second
// formatter to keep in step with the Word one.
//
// Written to the clipboard as BOTH text/html and text/plain: pasting into a
// rich editor (PMWeb Notes, Word, Outlook) keeps the bold labels and bullets,
// and pasting into a plain text field still gives readable text rather than
// raw markup.

function showCopyMsg(text, isError) {
    const el = document.getElementById('copyReportMsg');
    if (!el) return;
    el.style.display = 'block';
    el.style.color = isError ? '#ff8f8f' : '#7ee2a8';
    el.textContent = text;
    setTimeout(() => { el.style.display = 'none'; }, 4000);
}

async function copyReportForPasting() {
    const btn = document.getElementById('copyReportBtn');
    const original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Copying…'; }

    try {
        const reportId = await getActiveReportId();
        if (!reportId) return;   // getActiveReportId already told the user

        const resp = await apiFetch(`${API_BASE}/api/export/${reportId}/notes-html`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const { html } = await resp.json();
        if (!html) throw new Error('The report came back empty');

        const plain = htmlToPlainText(html);

        // Rich + plain flavours. Falls back to plain text where ClipboardItem
        // is unavailable, so the button still does something useful.
        if (window.ClipboardItem && navigator.clipboard?.write) {
            await navigator.clipboard.write([
                new ClipboardItem({
                    'text/html': new Blob([html], { type: 'text/html' }),
                    'text/plain': new Blob([plain], { type: 'text/plain' }),
                }),
            ]);
        } else {
            await navigator.clipboard.writeText(plain);
        }

        const lines = plain.split('\n').filter(Boolean).length;
        showCopyMsg(`Copied — ${lines} lines. Paste anywhere.`, false);
        console.log('[copy] Report copied,', plain.length, 'chars');
    } catch (e) {
        console.error('[copy] Failed', e);
        showCopyMsg(`Copy failed: ${e.message}`, true);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = original || '📋 Copy Report for Pasting'; }
    }
}

/** The selected report, or null after telling the user why not. */
async function getActiveReportId() {
    try {
        const resp = await apiFetch(`${API_BASE}/api/extension/context`);
        const { report_id } = await resp.json();
        if (report_id) return report_id;
    } catch (e) {
        console.warn('[copy] Context lookup failed', e);
    }
    showCopyMsg('No report selected — pick one from the list above.', true);
    return null;
}

// Initialize on popup open
document.addEventListener('DOMContentLoaded', () => {
    checkConnection().then(connected => {
        if (connected) {
            const autoBtn = document.getElementById('autoFillBtn');
            if (autoBtn) autoBtn.disabled = false;
        }
        // Needs API_BASE, which checkConnection resolves.
        loadReportPicker();
    });
    const refreshBtn = document.getElementById('refreshReportsBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', loadReportPicker);
    const copyBtn = document.getElementById('copyReportBtn');
    if (copyBtn) copyBtn.addEventListener('click', copyReportForPasting);
    initRecordNumber();
    checkMonday();
    const autoFillBtn = document.getElementById('autoFillBtn');
    if(autoFillBtn) autoFillBtn.addEventListener('click', autoFillEverything);
    initResourceMode();
    wireQueue();
    loadQueue();
    document.getElementById('fetchBtn').addEventListener('click', fetchData);
    document.getElementById('fillBtn').addEventListener('click', fillPMWeb);
    document.getElementById('clearBtn').addEventListener('click', clearPMWeb);
    document.getElementById('fetchActBtn').addEventListener('click', fetchActivities);
    document.getElementById('fillActBtn').addEventListener('click', fillActivities);
    document.getElementById('fillNotesBtn').addEventListener('click', fillNotesOnly);
    document.getElementById('syncResourcesBtn').addEventListener('click', syncPMWebResources);
    // The side panel watches this setting on every PMWeb tab and opens.
    const showPanelBtn = document.getElementById('showPanelBtn');
    if (showPanelBtn) {
        showPanelBtn.addEventListener('click', async () => {
            await chrome.storage.local.set({ pmwebPanelOpen: true });
            showPanelBtn.textContent = 'Side panel shown on PMWeb tabs';
        });
    }
});
