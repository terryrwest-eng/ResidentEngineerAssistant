// PMWeb Auto-Fill Extension - Content Script
// Bridges the gap between Extension and Page by injecting the worker script

console.log('🚀 PMWeb Auto-Fill Extension loaded (Content Bridge)');

function injectWorker() {
    // Inject the script file (declared in web_accessible_resources)
    // Add cache buster to force Chrome to load fresh version after extension reload
    const scriptPath = chrome.runtime.getURL('injected.js') + '?v=' + Date.now();
    console.log('💉 Attempting to inject worker from:', scriptPath);

    const script = document.createElement('script');
    script.src = scriptPath;

    script.onload = function () {
        console.log('✅ Worker script loaded successfully into page');
        this.remove();
    };

    script.onerror = function (e) {
        console.error('❌ Worker script failed to load', e);
        console.error('  - Is manifest.json "web_accessible_resources" correct?');
        console.error('  - Is "injected.js" present in the extension folder?');
    };

    (document.head || document.documentElement).appendChild(script);
}

// Inject immediately on load
injectWorker();

// Listen for messages from Popups/Background and forward to Page
window.addEventListener('pmweb-autofill-start', (event) => {
    // Forward to the Main World (injected.js)
    window.dispatchEvent(new CustomEvent('PMWEB_FILL_TRIGGER', { detail: event.detail }));
});

// Listen for sync results from Main World and forward to Popup
window.addEventListener('PMWEB_SYNC_RESULT', (event) => {
    chrome.runtime.sendMessage({ type: 'PMWEB_SYNC_RESULT', data: event.detail });
});

// UI Helper: Floating Button
chrome.storage.local.get(['pmwebRows', 'pmwebRowsMeta', 'selectedReportId'], (result) => {
    if (result.pmwebRows && result.pmwebRows.length > 0) {
        addFloatingButton(result.pmwebRows, result.pmwebRowsMeta, result.selectedReportId);
    }
});

/**
 * What these rows are, so the button is never an anonymous "Fill 40 Rows".
 *
 * These rows are read from storage and filled straight into PMWeb without
 * being re-fetched, so they can be any age and can belong to a report other
 * than the one now selected. Filling PMWeb with last week's crew is not
 * something you notice until somebody reconciles the timesheets.
 */
function describeRows(meta, selectedReportId) {
    if (!meta) return { label: '', stale: true, reason: 'fetched before this version - re-fetch to be sure' };

    const hours = (Date.now() - (meta.fetchedAt || 0)) / 36e5;
    const age = hours < 1 ? 'just now'
        : hours < 24 ? `${Math.round(hours)}h ago`
        : `${Math.round(hours / 24)}d ago`;

    if (selectedReportId && meta.reportId && meta.reportId !== selectedReportId) {
        return { label: meta.reportDate || '', stale: true,
                 reason: 'these rows are from a DIFFERENT report than the one selected' };
    }
    if (hours > 12) {
        return { label: meta.reportDate || '', stale: true,
                 reason: `fetched ${age} - the report may have changed since` };
    }
    return { label: `${meta.reportDate || 'report'} - fetched ${age}`, stale: false, reason: '' };
}

function addFloatingButton(rows, meta, selectedReportId) {
    const info = describeRows(meta, selectedReportId);
    const existing = document.getElementById('pmweb-autofill-btn');
    if (existing) existing.remove();

    const btn = document.createElement('button');
    btn.id = 'pmweb-autofill-btn';
    btn.innerHTML = info.stale
        ? `⚠️ Fill ${rows.length} Rows<br><span style="font-size:10px;font-weight:400;">${info.reason}</span>`
        : `🚀 Fill ${rows.length} Rows<br><span style="font-size:10px;font-weight:400;opacity:.85;">${info.label}</span>`;
    btn.style.cssText = `
    position: fixed; bottom: 20px; right: 20px; z-index: 999999;
    padding: 12px 24px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white; border: none; border-radius: 12px; cursor: pointer;
    box-shadow: 0 4px 15px rgba(0,0,0,0.2); font-family: sans-serif; font-weight: bold;
    `;
    btn.addEventListener('click', () => {
        // Stale or mismatched rows get one confirmation naming the problem,
        // rather than silently filling a timesheet from the wrong data.
        if (info.stale && !confirm(
            `These rows may be wrong:

${info.reason}

` +
            `Open the extension popup and press "Fetch Data from App" to refresh.

` +
            `Fill ${rows.length} rows anyway?`)) {
            return;
        }
        window.dispatchEvent(new CustomEvent('PMWEB_FILL_TRIGGER', { detail: rows }));
    });
    document.body.appendChild(btn);
}
