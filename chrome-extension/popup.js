// PMWeb Auto-Fill Extension - Popup Script

let rowsData = [];
let activitiesData = []; // Activities (OnSite) rows
let fullData = null; // Full PMWeb data bundle from /pmweb-full
let API_BASE = ''; // Will be set from storage or detected

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
            const contextResp = await fetch(`${API_BASE}/api/extension/context`);
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
            alert('No active report found!\n\nPlease open "Display Combined" in the Report App first.');
            fetchBtn.textContent = '📥 Fetch Data from App';
            fetchBtn.disabled = false;
            return;
        }

        const dataResp = await fetch(`${API_BASE}/api/reports/${reportId}/consolidated`);
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
            const contextResp = await fetch(`${API_BASE}/api/extension/context`);
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
            alert('No active report found!\n\nPlease open "Display Combined" in the Report App first.');
            fetchBtn.textContent = '📥 Fetch Activities';
            fetchBtn.disabled = false;
            return;
        }

        const dataResp = await fetch(`${API_BASE}/api/reports/${reportId}/activities-consolidated`);
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
                    const response = await fetch(`${API_BASE}/api/settings/sync-pmweb-resources`, {
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
        const contextResp = await fetch(`${API_BASE}/api/extension/context`);
        if (contextResp.ok) {
            const context = await contextResp.json();
            if (context.report_id) reportId = context.report_id;
        }
    } catch (e) {
        console.log("Context check failed.", e);
    }

    if (!reportId) {
        alert('No active report found!\n\nPlease open "Display Combined" in the Report App first.');
        return null;
    }

    const resp = await fetch(`${API_BASE}/api/export/${reportId}/pmweb-full`);
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

// Initialize on popup open
document.addEventListener('DOMContentLoaded', () => {
    checkConnection().then(connected => {
        if (connected) {
            const autoBtn = document.getElementById('autoFillBtn');
            if (autoBtn) autoBtn.disabled = false;
        }
    });
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
