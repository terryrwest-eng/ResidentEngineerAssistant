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

// UI Helper: Floating Button
chrome.storage.local.get(['pmwebRows'], (result) => {
    if (result.pmwebRows && result.pmwebRows.length > 0) {
        addFloatingButton(result.pmwebRows);
    }
});

function addFloatingButton(rows) {
    const existing = document.getElementById('pmweb-autofill-btn');
    if (existing) existing.remove();

    const btn = document.createElement('button');
    btn.id = 'pmweb-autofill-btn';
    btn.innerHTML = `🚀 Fill ${rows.length} Rows`;
    btn.style.cssText = `
    position: fixed; bottom: 20px; right: 20px; z-index: 999999;
    padding: 12px 24px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white; border: none; border-radius: 12px; cursor: pointer;
    box-shadow: 0 4px 15px rgba(0,0,0,0.2); font-family: sans-serif; font-weight: bold;
    `;
    btn.onclick = () => {
        window.dispatchEvent(new CustomEvent('PMWEB_FILL_TRIGGER', { detail: rows }));
    };
    document.body.appendChild(btn);
}
