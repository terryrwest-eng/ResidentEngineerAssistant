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

async function getAuthToken() {
    const stored = await chrome.storage.local.get(['apiToken']);
    return stored.apiToken || '';
}

/** fetch() with the stored access token attached. */
async function apiFetch(url, options = {}) {
    const token = await getAuthToken();
    const headers = Object.assign({}, options.headers || {});
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const resp = await fetch(url, Object.assign({}, options, { headers }));
    if (resp.status === 401 || resp.status === 403) {
        // Distinguishable from "the server is down", which is the other way
        // these calls fail and needs an entirely different fix from the user.
        showTokenPrompt();
    }
    return resp;
}

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


// Get saved API URL or detect it
async function getApiBase() {
    // Check storage first
    const stored = await chrome.storage.local.get(['apiBase']);
    if (stored.apiBase) {
        // Validate cached URL is still reachable
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);
            const resp = await fetch(`${stored.apiBase}/api/health`, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (resp.ok) return stored.apiBase;
        } catch (e) { /* cached URL unreachable, clear and re-discover */ }
        await chrome.storage.local.remove(['apiBase']);
        console.log('Cleared stale apiBase, re-discovering...');
    }

    // Try Railway URL first — V3 is the active deployment
    const railwayUrls = [
        'https://residentengineerassistant-production.up.railway.app',
        'https://daily-observation-application-production.up.railway.app',
        'https://daily-reporting-app-main-production.up.railway.app',
        'https://daily-reporting-app.up.railway.app'
    ];

    for (const url of railwayUrls) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);

            const resp = await fetch(`${url}/api/health`, {
                method: 'GET',
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (resp.ok) {
                await chrome.storage.local.set({ apiBase: url });
                return url;
            }
        } catch (e) { }
    }

    // Try localhost as fallback
    for (const port of [8000, 3001, 5000, 8080]) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);

            const resp = await fetch(`http://localhost:${port}/api/health`, {
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (resp.ok) {
                const url = `http://localhost:${port}`;
                await chrome.storage.local.set({ apiBase: url });
                return url;
            }
        } catch (e) { }
    }

    return null;
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

        // Store in extension storage for content script
        chrome.storage.local.set({ pmwebRows: rowsData });

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
            func: (rows) => {
                console.log('PMWeb Auto-Fill: Dispatching', rows.length, 'rows to worker');
                window.pmwebAutoFillData = rows;
                window.dispatchEvent(new CustomEvent('PMWEB_FILL_TRIGGER', { detail: rows }));
            },
            args: [rowsData],
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

        // Execute clear script in the page
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: injectClearScript
        });

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

// This function runs in the PMWeb page context to clear rows
function injectClearScript() {
    console.log('🗑️ PMWeb Clear: Starting...');

    // Find all editable text inputs in the grid and clear them
    const inputs = document.querySelectorAll('input[type="text"][id*="DailyReportTimesheet"]');
    let clearedCount = 0;

    inputs.forEach(inp => {
        if (inp.offsetParent !== null && inp.value && !inp.id.includes('Filter')) {
            inp.focus();
            inp.value = '';
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            inp.dispatchEvent(new Event('blur', { bubbles: true }));
            clearedCount++;
        }
    });

    // Clear checkboxes
    const checkboxes = document.querySelectorAll('input[type="checkbox"][id*="DailyReportTimesheet"]');
    checkboxes.forEach(chk => {
        if (chk.offsetParent !== null && chk.checked) {
            chk.click();
            clearedCount++;
        }
    });

    // Clear textareas (Remarks/Memo fields)
    const textareas = document.querySelectorAll('textarea[id*="DailyReportTimesheet"], textarea[id*="txtMemo"]');
    textareas.forEach(ta => {
        if (ta.offsetParent !== null && ta.value) {
            ta.focus();
            ta.value = '';
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
            ta.dispatchEvent(new Event('blur', { bubbles: true }));
            clearedCount++;
        }
    });

    console.log('✅ Cleared ' + clearedCount + ' fields');
    alert('✅ Cleared ' + clearedCount + ' fields!');
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

        // Build the record code: "1470 Day"
        const recordCode = `${recordNum} ${shift}`;

        // Determine shift emoji for PMWeb dropdown
        const shiftEmojis = {
            'Day': '☀️ Day',
            'Evening': '🌙 Evening',
            'Night': '🌑 Night'
        };
        const shiftValue = shiftEmojis[shift] || `☀️ ${shift}`;

        // Determine working day value
        const dayTypeValue = fullData.general.is_working_day
            ? '1 -Working Day'
            : '2 -Non-Working Day';

        // Bundle everything for injected.js
        const payload = {
            // Phase 1: Main Tab
            reportDate: fullData.general.report_date,
            recordCode: recordCode,
            location: fullData.general.project_location,
            weatherConditions: fullData.general.sky_conditions_pmweb,
            temperature: fullData.general.temperature_avg != null
                ? String(fullData.general.temperature_avg)
                : '',
            precipAmount: '0.00',
            startTimeMilitary: fullData.general.start_time_military,
            endTimeMilitary: fullData.general.end_time_military,
            shiftValue: shiftValue,
            // Phase 2: Activities
            activities: fullData.activities,
            // Phase 3: Resources
            resources: fullData.resources,
            // Phase 4: Additional Info
            dayTypeValue: dayTypeValue,
            // Phase 5: Notes
            notesHtml: fullData.notes_html
        };

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

function fmtPickerDate(iso) {
    if (!iso) return 'No date';
    const d = new Date(`${iso}T12:00:00`);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    });
}

function fmtShift(report) {
    const a = report.start_time || '';
    const b = report.end_time || '';
    if (!a && !b) return '';
    return `${a}${a && b ? '–' : ''}${b}`;
}

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
        await apiFetch(`${API_BASE}/api/extension/context`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ report_id: reportId }),
        });
        chrome.storage.local.set({ selectedReportId: reportId });
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

            row.innerHTML = `
                <div style="display:flex; align-items:baseline; gap:6px;">
                    <span style="font-size:12px; font-weight:700; color:#fff;">${fmtPickerDate(r.report_date)}</span>
                    ${shift ? `<span style="font-size:10px; color:rgba(255,255,255,0.55);">${shift}</span>` : ''}
                    ${draft}
                </div>
                <div style="font-size:10.5px; color:rgba(255,255,255,0.6); margin-top:2px; line-height:1.35;">${acts}</div>
            `;
            list.appendChild(row);
        });
    });
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
        // Walk every page. The endpoint pages because it reads each report to
        // get its activity names; asking for one huge page just moves the cost
        // rather than removing it. The ceiling is a runaway guard, not a limit
        // on what can be shown - it is far above any real report count.
        pickerReports = [];
        let total = 0;
        for (let offset = 0; offset < 20000; offset += 200) {
            const resp = await apiFetch(
                `${API_BASE}/api/extension/reports?limit=200&offset=${offset}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const page = data.reports || [];
            pickerReports = pickerReports.concat(page);
            total = data.total || pickerReports.length;
            if (page.length === 0 || pickerReports.length >= total) break;
        }
        pickerTotal = total;

        // Show whichever report is currently active, so the popup opens
        // reflecting reality rather than a guess.
        let activeId = null;
        try {
            const ctx = await apiFetch(`${API_BASE}/api/extension/context`);
            activeId = (await ctx.json()).report_id || null;
        } catch (e) { /* non-fatal */ }

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

function htmlToPlainText(html) {
    const el = document.createElement('div');
    el.innerHTML = html
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n');
    const text = el.textContent || '';
    return text
        .split('\n')
        .map(line => line.trim())
        .filter((line, i, arr) => line || (arr[i - 1] || '').trim())  // collapse blank runs
        .join('\n')
        .trim();
}

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
    document.getElementById('fetchBtn').addEventListener('click', fetchData);
    document.getElementById('fillBtn').addEventListener('click', fillPMWeb);
    document.getElementById('clearBtn').addEventListener('click', clearPMWeb);
    document.getElementById('fetchActBtn').addEventListener('click', fetchActivities);
    document.getElementById('fillActBtn').addEventListener('click', fillActivities);
    document.getElementById('syncResourcesBtn').addEventListener('click', syncPMWebResources);
});
