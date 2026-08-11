// Daily Reporter — token sync
//
// Runs on the app's own pages and copies the session token the app already
// holds into the extension's storage, so the popup never has to be given one by
// hand.
//
// WHY this and not a paste box: the token the user would paste IS this value,
// read off the same page. Pasting adds a manual step, goes stale silently 30
// days later, and puts a credential on the clipboard. Reading it here keeps one
// source of truth and repairs itself — sign in again and the extension follows.
//
// The paste box in the popup is deliberately left in place as the fallback for
// the case this cannot cover: using the phone app instead of the web app, where
// there is no desktop page for this script to read.

(function syncToken() {
    // Same key the app writes — see the auth module's `auth_token` constant.
    const TOKEN_KEY = 'auth_token';

    /** localStorage throws in some privacy modes; a failure here must not break the page. */
    function readToken() {
        try {
            return localStorage.getItem(TOKEN_KEY) || '';
        } catch (e) {
            return '';
        }
    }

    /**
     * Only write when the value actually changed. chrome.storage.local.set
     * fires change events, and this runs on every page load of the app.
     */
    function push(token) {
        if (!token) return;
        chrome.storage.local.get(['apiToken'], (stored) => {
            if (stored.apiToken === token) return;
            chrome.storage.local.set({ apiToken: token }, () => {
                console.log('[token-sync] Extension token updated from the app session');
            });
        });
    }

    /** Signing out clears the token — carry that across too, rather than leaving a dead one behind. */
    function clearIfSignedOut(token) {
        if (token) return;
        chrome.storage.local.get(['apiToken'], (stored) => {
            if (!stored.apiToken) return;
            chrome.storage.local.remove(['apiToken'], () => {
                console.log('[token-sync] App signed out — cleared the extension token');
            });
        });
    }

    function sync() {
        const token = readToken();
        if (token) push(token);
        else clearIfSignedOut(token);
    }

    sync();

    // The app is a single-page app: signing in swaps the token without a page
    // load, so a one-shot read at document_idle would miss it. `storage` only
    // fires for OTHER tabs, so poll this one — cheap, and it stops after the
    // token settles.
    let lastSeen = readToken();
    let ticks = 0;
    const MAX_TICKS = 60;          // ~2 minutes at 2s, then give up
    const timer = setInterval(() => {
        const token = readToken();
        if (token !== lastSeen) {
            lastSeen = token;
            sync();
        }
        if (++ticks >= MAX_TICKS) clearInterval(timer);
    }, 2000);

    // Another tab signing in or out should land here immediately.
    window.addEventListener('storage', (e) => {
        if (e.key === TOKEN_KEY) sync();
    });
})();
