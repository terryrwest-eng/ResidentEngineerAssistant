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

// How a finished run gets back to the queue. The popup is shut for most of a
// run - Terry clicks into the PMWeb page and it closes - so a runtime message
// would go nowhere. Storage is still there when the popup next opens.
window.addEventListener('PMWEB_RUN_RESULT', (event) => {
    try {
        chrome.storage.local.set({ pmwebLastRun: event.detail });
        console.log('📬 run result recorded for the queue', event.detail);
    } catch (e) {
        console.warn('Could not record the run result', e);
    }
});

// The floating "Fill N Rows" button that used to sit here is now the "Fill
// Labor and Equipment" step in the side panel (panel.js). The panel names the
// rows' report and age the same way (PMCore.describeRows), and asks about stale
// rows with a second button instead of a confirm() dialog, which froze the page
// for Claude in Chrome.
