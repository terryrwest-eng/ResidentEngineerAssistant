// PMWeb Auto-Fill Extension - Injected Main World Script
// This script has access to Sys, Telerik, and the Page Context

(function () {
    // Guard: prevent double-initialization if injected multiple times
    if (window.__pmwebWorkerLoaded) {
        console.log("💉 PMWeb Extension: Worker already loaded, skipping re-init");
        return;
    }
    window.__pmwebWorkerLoaded = true;
    console.log("💉 PMWeb Extension: Pro Mode Worker Loaded");

    // --- BACKGROUND-SAFE WAIT ---
    // Chrome throttles setTimeout to 1s+ in background tabs, killing automation.
    // postMessage is NOT throttled, so we use it for precise timing.
    const _waitCallbacks = new Map();
    let _waitId = 0;
    window.addEventListener('message', (e) => {
        if (e.data && e.data.__pmwebWaitId !== undefined) {
            const cb = _waitCallbacks.get(e.data.__pmwebWaitId);
            if (cb) { _waitCallbacks.delete(e.data.__pmwebWaitId); cb(); }
        }
    });
    function bgWait(ms) {
        return new Promise(resolve => {
            const id = ++_waitId;
            _waitCallbacks.set(id, resolve);
            setTimeout(() => window.postMessage({ __pmwebWaitId: id }, '*'), ms);
        });
    }

    // ============================================
    // RESUME STATE
    // A full page postback destroys this script mid-run. Recording where the
    // run had got to, before the click that might reload, lets the freshly
    // injected copy pick the run back up.
    // ============================================

    const RESUME_KEY = '__pmwebAutoFillResume';

    function saveResumeState(phase, data) {
        try {
            sessionStorage.setItem(RESUME_KEY, JSON.stringify({ phase, data, ts: Date.now() }));
        } catch (e) {
            console.warn('⚠️ Could not record resume state:', e);
        }
    }

    function clearResumeState() {
        try { sessionStorage.removeItem(RESUME_KEY); } catch (e) { /* nothing to clear */ }
    }

    // One shot: reading it clears it, so a stale entry can never loop.
    function loadResumeState() {
        let state = null;
        try {
            const raw = sessionStorage.getItem(RESUME_KEY);
            if (!raw) return null;
            state = JSON.parse(raw);
        } catch (e) {
            clearResumeState();
            return null;
        }
        clearResumeState();
        if (!state || !state.data || !state.phase) return null;
        if (Date.now() - state.ts > 10 * 60 * 1000) return null; // gone stale
        return state;
    }

    // ============================================
    // ACTIVITY INSTRUMENTATION
    // PMWeb does not save through an ASP.NET partial postback, so
    // PageRequestManager cannot answer "did that click do anything?" — it stays
    // silent whether the click worked or not. Counting the requests the page
    // starts, and watching it re-render, answers it whatever the mechanism.
    // Third-party chatter (pendo and friends) is excluded by origin.
    // ============================================

    let _netInFlight = 0;
    let _netStarted = 0;
    let _mutations = 0;

    function isSameOriginRequest(url) {
        try {
            return new URL(url, location.href).origin === location.origin;
        } catch (e) {
            return false;
        }
    }

    (function instrumentPageActivity() {
        try {
            const XHR = window.XMLHttpRequest;
            if (XHR && XHR.prototype && !XHR.prototype.__pmwebInstrumented) {
                const open = XHR.prototype.open;
                const send = XHR.prototype.send;

                XHR.prototype.open = function (method, url) {
                    this.__pmwebUrl = url;
                    return open.apply(this, arguments);
                };

                XHR.prototype.send = function () {
                    if (isSameOriginRequest(this.__pmwebUrl)) {
                        _netStarted++;
                        _netInFlight++;
                        this.addEventListener('loadend', () => {
                            _netInFlight = Math.max(0, _netInFlight - 1);
                        }, { once: true });
                    }
                    return send.apply(this, arguments);
                };

                XHR.prototype.__pmwebInstrumented = true;
            }
        } catch (e) {
            console.warn('⚠️ Could not instrument XMLHttpRequest:', e);
        }

        try {
            if (typeof window.fetch === 'function' && !window.fetch.__pmwebInstrumented) {
                const original = window.fetch;
                const wrapped = function (input) {
                    const url = (input && input.url) || input;
                    if (!isSameOriginRequest(url)) return original.apply(this, arguments);
                    _netStarted++;
                    _netInFlight++;
                    return original.apply(this, arguments).finally(() => {
                        _netInFlight = Math.max(0, _netInFlight - 1);
                    });
                };
                wrapped.__pmwebInstrumented = true;
                window.fetch = wrapped;
            }
        } catch (e) {
            console.warn('⚠️ Could not instrument fetch:', e);
        }

        try {
            // The ASP.NET form only — pendo and other third-party widgets append
            // to <body>, and their churn must not read as the page responding.
            const scope = document.forms[0] || document.documentElement;
            new MutationObserver((records) => { _mutations += records.length; }).observe(
                scope,
                { childList: true, subtree: true, attributes: true, characterData: true }
            );
        } catch (e) {
            console.warn('⚠️ Could not observe DOM mutations:', e);
        }
    })();

    // ============================================
    // PAGE-LEVEL TOOLBAR (RadToolBar) + POSTBACK HELPERS
    // The Main tab is committed by the document toolbar's "Save (Alt+s)" icon.
    // That is a different control from the per-grid lblSave used by the
    // Labor/Equipment and Activities grids, and it does not respond reliably
    // to a bare .click() — RadToolBar drives its buttons from the full mouse
    // event sequence, or from its own client-side API.
    // ============================================

    function getPageRequestManager() {
        try {
            if (typeof Sys !== 'undefined' && Sys.WebForms && Sys.WebForms.PageRequestManager) {
                return Sys.WebForms.PageRequestManager.getInstance();
            }
        } catch (e) { /* not an ASP.NET AJAX page */ }
        return null;
    }

    // Runs `trigger`, then waits for whatever the page decides to do about it:
    // a partial postback, a request of its own, a full navigation, or just a
    // re-render. Returns 'ok' | 'full-postback' | 'timeout' | 'no-activity'.
    async function runAndAwaitActivity(trigger, timeoutMs = 30000, startWindowMs = 6000) {
        // Only `unload` is blocked by PMWeb's permissions policy; these two fire.
        let unloading = false;
        const onUnload = () => { unloading = true; };
        window.addEventListener('beforeunload', onUnload, true);
        window.addEventListener('pagehide', onUnload, true);

        const prm = getPageRequestManager();
        let ended = false;
        const onEnd = () => { ended = true; };
        if (prm) prm.add_endRequest(onEnd);

        const inAsync = () => !!prm
            && typeof prm.get_isInAsyncPostBack === 'function'
            && prm.get_isInAsyncPostBack();

        const netBaseline = _netStarted;
        const mutationBaseline = _mutations;
        const MUTATION_BURST = 3; // one stray attribute change is not a response

        try {
            trigger();

            // Did anything at all happen?
            let signal = '';
            const startDeadline = Date.now() + startWindowMs;
            while (Date.now() < startDeadline) {
                if (unloading) return 'full-postback';
                if (ended || inAsync()) { signal = 'partial postback'; break; }
                if (_netStarted > netBaseline) { signal = 'request'; break; }
                if (_mutations > mutationBaseline + MUTATION_BURST) { signal = 'form re-render'; break; }
                await bgWait(100);
            }
            if (!signal) return 'no-activity';
            console.log('     · page responded (' + signal + ')');

            // Now wait for it to finish.
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                if (unloading) return 'full-postback';
                if (_netInFlight === 0 && !inAsync()) {
                    await bgWait(1000); // let the re-rendered DOM settle
                    if (_netInFlight === 0 && !inAsync()) return 'ok';
                }
                await bgWait(200);
            }
            return 'timeout';
        } finally {
            if (prm) prm.remove_endRequest(onEnd);
            window.removeEventListener('beforeunload', onUnload, true);
            window.removeEventListener('pagehide', onUnload, true);
        }
    }

    function isVisible(el) {
        return !!el && el.getClientRects().length > 0;
    }

    // Every RadToolBar client component on the page.
    function getRadToolBars() {
        if (typeof Sys === 'undefined' || !Sys.Application) return [];
        return Sys.Application.getComponents().filter(c => {
            if (!c || typeof c.get_items !== 'function' || typeof c.get_element !== 'function') return false;
            let el = null;
            try { el = c.get_element(); } catch (e) { return false; }
            return !!el && /RadToolBar/.test(el.className || '');
        });
    }

    // Depth-first search of toolbar items (buttons can sit inside drop-downs).
    function findToolBarItem(match) {
        const visit = (items) => {
            if (!items || typeof items.get_count !== 'function') return null;
            for (let i = 0; i < items.get_count(); i++) {
                const it = items.getItem(i);
                const label = [
                    it.get_toolTip && it.get_toolTip(),
                    it.get_text && it.get_text(),
                    it.get_value && it.get_value()
                ].filter(Boolean).join(' | ');
                if (match(label, it)) return it;
                if (typeof it.get_items === 'function') {
                    const nested = visit(it.get_items());
                    if (nested) return nested;
                }
            }
            return null;
        };
        for (const tb of getRadToolBars()) {
            let found = null;
            try { found = visit(tb.get_items()); } catch (e) { /* skip odd component */ }
            if (found) return found;
        }
        return null;
    }

    // A synthetic .click() on its own is often ignored by RadToolBar, so send
    // the whole sequence. .click() goes last so a javascript:__doPostBack href
    // still fires and the click event is raised exactly once.
    function fireMouseClick(el) {
        const opts = { bubbles: true, cancelable: true, view: window, button: 0, detail: 1 };
        el.dispatchEvent(new MouseEvent('mouseover', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.click();
    }

    // The visible, enabled page-level Save anchor, most specific match first.
    function findToolbarSaveElement() {
        const selectors = [
            'span.rtbIcon[title="Save (Alt+s)"]',
            '[title="Save (Alt+s)"]',
            'span.rtbIcon[title^="Save ("]',
            '[title^="Save ("]'
        ];
        for (const sel of selectors) {
            for (const el of document.querySelectorAll(sel)) {
                const anchor = el.tagName === 'A' ? el : (el.closest('a') || el.parentElement);
                if (!anchor) continue;
                const li = anchor.closest('li');
                if (li && /rtbDisabled|rtbItemDisabled/.test(li.className || '')) continue;
                if (!isVisible(anchor)) continue;
                return anchor;
            }
        }
        return null;
    }

    // Dumps what the Save control actually looks like, so a failure says what is
    // there rather than leaving it to guesswork.
    function dumpSaveDiagnostics() {
        console.group('🔎 Save button diagnostics');
        const anchor = findToolbarSaveElement();
        if (!anchor) {
            console.log('No Save anchor matched. Anything with a Save-ish title:');
            document.querySelectorAll('[title*="Save" i]').forEach(el => {
                console.log(el.tagName, '|', el.className, '|', JSON.stringify(el.getAttribute('title')), el);
            });
        } else {
            console.log('anchor       :', anchor);
            console.log('outerHTML    :', anchor.outerHTML.slice(0, 600));
            console.log('href         :', anchor.getAttribute('href'));
            console.log('onclick attr :', anchor.getAttribute('onclick'));
            const li = anchor.closest('li');
            if (li) console.log('parent li    :', li.outerHTML.slice(0, 600));
            const toolbar = anchor.closest('.RadToolBar');
            if (toolbar) console.log('toolbar      :', toolbar.id, '|', toolbar.className);
        }
        console.log('PageRequestManager :', !!getPageRequestManager());
        console.log('RadToolBars        :', getRadToolBars().map(t => {
            const el = t.get_element();
            return el ? (el.id || el.className) : '(no element)';
        }));
        console.log('requests seen so far:', _netStarted, '| in flight:', _netInFlight);
        console.groupEnd();
    }

    // Clicks the page-level Save and waits for the page to act on it.
    // Each approach is tried ONCE, and the next one is only reached if the page
    // did not react at all — clicking Save repeatedly at a page that is already
    // saving is how the earlier version lost the run.
    // Returns { clicked, how, outcome }.
    async function clickToolbarSave() {
        // Commit whatever field still holds focus before saving.
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        await bgWait(300);

        const attempts = [];

        // 1. Telerik client API.
        const exact = (label) => /save\s*\(alt\+s\)/i.test(label);
        const loose = (label) => /(^|\|)\s*save\s*(\||$)/i.test(label);
        const item = findToolBarItem(exact) || findToolBarItem(loose);
        if (item && typeof item.click === 'function' && (!item.get_enabled || item.get_enabled())) {
            attempts.push({ how: 'telerik-api', run: () => item.click() });
        }

        // 2. Full mouse sequence on the toolbar anchor.
        const anchor = findToolbarSaveElement();
        if (anchor) {
            attempts.push({
                how: 'dom-click (' + (anchor.id || anchor.className) + ')',
                run: () => fireMouseClick(anchor)
            });
        }

        // 3. Alt+S hotkey.
        attempts.push({
            how: 'alt-s-hotkey',
            run: () => {
                for (const type of ['keydown', 'keypress', 'keyup']) {
                    document.dispatchEvent(new KeyboardEvent(type, {
                        bubbles: true, cancelable: true, key: 's', code: 'KeyS',
                        keyCode: 83, which: 83, altKey: true
                    }));
                }
            }
        });

        for (const attempt of attempts) {
            console.log('  ↪ Save via ' + attempt.how);
            const outcome = await runAndAwaitActivity(attempt.run);
            if (outcome !== 'no-activity') {
                return { clicked: true, how: attempt.how, outcome };
            }
            console.warn('  ⚠️ ' + attempt.how + ': the page did not react — trying the next approach');
        }

        dumpSaveDiagnostics();
        return { clicked: false, how: 'none', outcome: 'no-activity' };
    }

    // Saves the Main tab. Returns:
    //   'saved'     — committed, safe to move to the next tab
    //   'reloading' — the save was a full postback; the page is going away and
    //                 the reload handler resumes the run at Phase 2
    //   'failed'    — nothing was committed; do not navigate away
    async function saveMainTab(data) {
        console.log('💾 Saving Main tab (page-level Save) before leaving the page...');

        // Recorded before the click, because if this Save turns out to be a
        // full postback the page reloads and this script never runs again.
        saveResumeState(2, data);

        const result = await clickToolbarSave();

        if (!result.clicked) {
            clearResumeState();
            console.error('❌ Save (Alt+s) could not be triggered — the page did not react to any approach');
            return 'failed';
        }
        console.log(`  ✅ Save triggered via ${result.how} (page reacted: ${result.outcome})`);

        if (result.outcome === 'full-postback') {
            console.log('  ↻ Save ran as a full page postback — the run resumes after the reload');
            return 'reloading';
        }

        if (result.outcome === 'timeout') {
            clearResumeState();
            console.error('❌ The page never went quiet after Save (30s)');
            return 'failed';
        }

        // The page stayed put, so there is nothing to resume.
        clearResumeState();

        // Check the round-trip kept our values. Only an emptied field means the
        // save was rejected — PMWeb normalises some values on save, and that is
        // not a failure worth throwing the rest of the run away over.
        await bgWait(500);
        const checks = [
            ['Record #', 'ctl00_CPH1_txtCode', data.recordCode],
            ['Location', 'ctl00_CPH1_txtDescription', data.location]
        ];
        for (const [label, id, expected] of checks) {
            if (!expected) continue;
            const el = document.getElementById(id);
            if (!el) { console.warn(`  ⚠️ ${label} field is gone after save (${id})`); continue; }
            const actual = String(el.value).trim();
            if (!actual) {
                console.error(`  ❌ ${label} came back empty — the save was rejected`);
                return 'failed';
            }
            if (actual !== String(expected).trim()) {
                console.warn(`  ⚠️ ${label} came back as "${actual}" (sent "${expected}") — continuing anyway`);
                continue;
            }
            console.log(`  ✅ ${label} persisted: "${actual}"`);
        }

        console.log('✅ Main tab saved');
        return 'saved';
    }

    // STOP MECHANISM: Press Escape to cancel, or click stop button
    let shouldStop = false;
    let stopButton = null;

    function showStopButton() {
        if (stopButton) return;
        stopButton = document.createElement('button');
        stopButton.id = 'pmweb-stop-btn';
        stopButton.innerHTML = '⏹️ STOP';
        stopButton.style.cssText = `
            position: fixed; top: 20px; right: 20px; z-index: 999999;
            padding: 10px 20px; background: #dc2626; color: white;
            border: none; border-radius: 8px; cursor: pointer;
            font-weight: bold; box-shadow: 0 4px 15px rgba(0,0,0,0.3);
        `;
        stopButton.addEventListener('click', () => { shouldStop = true; console.log('🛑 STOP requested!'); });
        document.body.appendChild(stopButton);
    }

    function hideStopButton() {
        if (stopButton) { stopButton.remove(); stopButton = null; }
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { shouldStop = true; console.log('🛑 STOP via Escape key!'); }
    });

    // Listen for data from the content script
    // "Fill PMWeb Rows" - the Labor and Equipment tab on its own, for when the
    // rest of the record is already done and only the resources are missing.
    // Terry, 2026-09-27: "SO I NEED A WAY TO USE THE FAST VERSION IF IM JUST
    // DOING LABOR AND EQUIPMENT ALONE."
    //
    // Same engine as Phase 3: the picker creates every row, one editAllItems
    // opens them, one updateEditedItems commits them. The row-at-a-time filler
    // is kept as a fallback, but only for failures that happen before any row
    // has been created - falling back after that would add a second set on top.
    // Dialogs stop an unattended run dead - Terry, 2026-09-27: "ITS STILL ASKING
    // ME QUESTIONS". pmPrompt() and confirm() block until answered, and a run of
    // 60 reports cannot wait on a person. They were debugging aids; the answer
    // they wanted is now taken as the default and written to the console.
    //
    // Set window.__pmUnattended = false in the console to get them back.
    if (typeof window.__pmUnattended === 'undefined') { window.__pmUnattended = true; }
    var PM_NL = String.fromCharCode(10);
    function pmFirstLine(msg) { return String(msg).split(PM_NL)[0]; }
    function pmPrompt(msg, dflt) {
        if (window.__pmUnattended) {
            console.log('(auto) ' + pmFirstLine(msg) + ' -> ' + dflt);
            return dflt;
        }
        return prompt(msg, dflt);
    }
    function pmConfirm(msg) {
        if (window.__pmUnattended) {
            console.log('(auto) ' + pmFirstLine(msg) + ' -> yes');
            return true;
        }
        return window.confirm(msg);
    }
    function pmAlert(msg) {
        if (window.__pmUnattended) {
            console.log('(alert) ' + pmFirstLine(msg));
            return;
        }
        alert(msg);
    }

    // What the side panel shows. Until now a run said how it was going only in
    // the console, which the side panel - and Claude in Chrome, which drives it -
    // cannot see. These announce it on the page; content scripts hear them.
    function pmProgress(phase, label) {
        try {
            window.dispatchEvent(new CustomEvent('PMWEB_RUN_PROGRESS', {
                detail: { phase: phase, total: 5, label: label }
            }));
        } catch (e) { /* the run carries on regardless */ }
    }
    function pmStepResult(step, ok, message) {
        try {
            window.dispatchEvent(new CustomEvent('PMWEB_STEP_RESULT', {
                detail: { step: step, ok: !!ok, message: String(message || '') }
            }));
        } catch (e) { /* the step finished regardless */ }
    }

    // The side panel's Stop button. Same effect as Escape or the red STOP button.
    window.addEventListener('PMWEB_STOP', () => {
        shouldStop = true;
        console.log('🛑 STOP requested from the side panel');
    });

    // The side panel checks this script is on the page before it sends a run,
    // so a run sent to nothing says so instead of waiting forever.
    window.addEventListener('PMWEB_PING', () => {
        window.dispatchEvent(new CustomEvent('PMWEB_PONG'));
    });

    window.addEventListener('PMWEB_FILL_TRIGGER', async (event) => {
        shouldStop = false; // Reset stop flag
        const detail = event.detail || {};
        const rows = Array.isArray(detail) ? detail : (detail.rows || []);
        const mode = (Array.isArray(detail) ? null : detail.mode) || 'add';
        console.log('📥 Worker received', rows.length, 'rows — mode: ' + mode);

        let fast = null;
        try {
            fast = await fillResourcesFast(rows, mode);
        } catch (e) {
            console.error('⚠️ Fast fill threw: ' + e.message);
            fast = { ok: false, stage: 'pre', reason: e.message };
        }

        if (fast && fast.ok) {
            console.log('✅ Done: ' + fast.filled + ' row(s) filled, ' + fast.total + ' in the grid');
            pmStepResult('resources', true,
                fast.filled + ' row(s) filled, ' + fast.total + ' in the grid');
        } else if (fast && fast.stage === 'pre') {
            console.warn('⚠️ Falling back to the row-at-a-time filler — ' + fast.reason);
            await fillAllRows(rows);
            pmStepResult('resources', !shouldStop, shouldStop
                ? 'stopped part-way, check the grid'
                : 'filled one row at a time (' + fast.reason + '); check the grid');
        } else if (fast && fast.stage === 'picker') {
            console.error('❌ Stopped inside the resource picker: ' + fast.reason);
            console.error('   NOTHING was committed - the picker was never saved, so the grid');
            console.error('   is untouched. Close the picker with Cancel.');
            pmStepResult('resources', false, 'stopped inside the resource picker: ' + fast.reason
                + '. Nothing was committed. Close the picker with Cancel.');
        } else {
            console.error('❌ Did not finish cleanly: '
                + (fast ? fast.reason || ('blank ' + fast.blank + ', changed ' + fast.changed) : 'unknown'));
            console.error('   Rows have already been created — check the grid before re-running.');
            pmStepResult('resources', false, 'did not finish cleanly: '
                + (fast ? fast.reason || ('blank ' + fast.blank + ', changed ' + fast.changed) : 'unknown')
                + '. Rows were already created, so check the grid before running it again.');
        }
    });

    // Listen for sync trigger to extract all PMWeb resources
    window.addEventListener('PMWEB_SYNC_TRIGGER', async () => {
        try {
            console.log('🔍 Starting PMWeb Resource Sync extraction...');
            let input = document.querySelector('input[id*="ddlResources_Input"]:not([id*="Filter"])');
            if (!input) {
                console.log('Dropdown not found, attempting to click Add Line...');
                const addBtn = document.querySelector('[id*="lblAddLine"]');
                if (addBtn) {
                    addBtn.click();
                    // Wait for the row to be added and the dropdown to appear
                    let waitAttempts = 0;
                    while(!input && waitAttempts < 20) {
                        await new Promise(r => setTimeout(r, 500));
                        input = document.querySelector('input[id*="ddlResources_Input"]:not([id*="Filter"])');
                        waitAttempts++;
                    }
                }
            }

            if (!input) {
                console.error('❌ Could not find PMWeb resource dropdown. Are you on the Timesheet page?');
                window.dispatchEvent(new CustomEvent('PMWEB_SYNC_RESULT', { detail: { error: "Resource dropdown not found. Please ensure you are on a PMWeb Timesheet." } }));
                return;
            }

            const baseId = input.id.replace('_Input', '');
            const idDollar = baseId.replace(/_/g, '$');
            
            let combo = null;
            if (typeof $find === 'function') {
                combo = $find(baseId) || $find(idDollar);
            }
            if (!combo && typeof Sys !== 'undefined' && Sys.Application) {
                combo = Sys.Application.findComponent(baseId) || Sys.Application.findComponent(idDollar);
            }

            if (!combo) {
                window.dispatchEvent(new CustomEvent('PMWEB_SYNC_RESULT', { detail: { error: "Telerik component not found." } }));
                return;
            }

            // Force load initial page from server (empty text, false for append)
            console.log('⏳ Requesting first page of items from server...');
            combo.requestItems('', false);
            
            // Wait for initial load
            let attempts = 0;
            while (combo.get_items().get_count() === 0 && attempts < 20) {
                await new Promise(r => setTimeout(r, 250));
                attempts++;
            }
            
            let count = combo.get_items().get_count();
            console.log(`✅ Loaded initial page: ${count} items`);
            
            // Paginate through all remaining items
            let page = 1;
            let prevCount = count;
            
            while (page < 50) { // Safety limit
                console.log(`⏳ Requesting page ${page + 1}...`);
                combo.requestItems('', true); // true = append next page
                
                let pageAttempts = 0;
                while (combo.get_items().get_count() === prevCount && pageAttempts < 15) {
                    await new Promise(r => setTimeout(r, 250));
                    pageAttempts++;
                }
                
                count = combo.get_items().get_count();
                if (count === prevCount) {
                    // Try one more time with a longer delay to be absolutely sure
                    combo.requestItems('', true);
                    await new Promise(r => setTimeout(r, 1500));
                    count = combo.get_items().get_count();
                    if (count === prevCount) {
                        console.log('✅ Reached end of list. Total items:', count);
                        break;
                    }
                }
                
                console.log(`✅ Loaded page ${page + 1}. Total items now: ${count}`);
                prevCount = count;
                page++;
            }
            
            const items = combo.get_items();
            const resources = [];
            for (let i = 0; i < items.get_count(); i++) {
                resources.push(items.getItem(i).get_text());
            }
            
            // Send back to content.js
            window.dispatchEvent(new CustomEvent('PMWEB_SYNC_RESULT', { detail: { resources } }));
            
        } catch (err) {
            console.error('❌ Error during sync extraction:', err);
            window.dispatchEvent(new CustomEvent('PMWEB_SYNC_RESULT', { detail: { error: err.message } }));
        }
    });

    async function fillAllRows(appRows) {
        console.log('🎯 Starting active ADD-FILL-SAVE automation for', appRows.length, 'items... (Press ESC to stop)');
        showStopButton();
        const wait = bgWait; // Uses postMessage — not throttled in background tabs

        // Get Buttons




        // Helper to map data
        const mapRow = (row) => {
            const isSub = row.subcontractor === true || row.Subcontractor === 'Yes' || row.is_3rd_party === true;
            // Extract company from multiple possible locations
            let rawCompany = row.company || row.Company || row.subcontractor_company || row.sub_company || '';

            // Map company names to match PMWeb's dropdown values
            const companyMap = {
                'OHLA': 'OHL NA',
                'ohla': 'OHL NA',
                'Ohla': 'OHL NA',
                'hms': 'HMS',
                'Hms': 'HMS',
            };
            if (companyMap[rawCompany]) {
                console.log('🏢 Company mapped:', rawCompany, '→', companyMap[rawCompany]);
                rawCompany = companyMap[rawCompany];
            }

            // Log company data for debugging
            if (isSub) {
                console.log('🏢 SUB Company Debug:', {
                    'row.company': row.company,
                    'row.Company': row.Company,
                    'row.subcontractor_company': row.subcontractor_company,
                    'isSub': isSub,
                    'finalCompany': rawCompany
                });
            }

            return {
                resource: row.resource || row.Resource,
                payType: row.pay_type || row[' Pay Type'] || 'CS - Cost',
                classification: row.classification || row.Classification || 'LR - Labor Regular Time',
                specialist: row.specialist === true || row.Specialist === 'Yes',
                subcontractor: isSub,
                quantity: String(row.qty || row.Qty || 0),
                company: rawCompany,
                hours: String(row.total_hours || row.Hours || 0),
                startTime: row.start_time || row['Start Time'] || '7:00 AM',
                finishTime: row.finish_time || row['Finish Time'] || '3:30 PM',
                remarks: row.remarks || row.Remarks || ''
            };
        };

        // Ask user where to start
        let startIndex = 0;
        const userInput = pmPrompt(`Resume from a specific row?\n\nTotal rows: ${appRows.length}\n\nEnter row number to start from (1-${appRows.length}), or press Cancel/enter 0 to start from beginning:`, '1');

        if (userInput !== null && userInput.trim() !== '') {
            const rowNum = parseInt(userInput, 10);
            if (rowNum >= 1 && rowNum <= appRows.length) {
                startIndex = rowNum - 1; // Convert to 0-based index
                console.log(`▶️ Resuming from row ${rowNum} (${appRows.length - startIndex} rows remaining)`);
            } else if (rowNum === 0) {
                console.log(`▶️ Starting from the beginning (${appRows.length} rows)`);
            } else {
                pmAlert(`Invalid row number. Starting from beginning.`);
                console.log(`▶️ Invalid input, starting from the beginning (${appRows.length} rows)`);
            }
        } else {
            console.log(`▶️ Starting from the beginning (${appRows.length} rows)`);
        }

        // Loop items
        for (let i = startIndex; i < appRows.length; i++) {
            if (shouldStop) { console.log('🛑 Stopped by user at item ' + (i + 1)); break; }

            const rowData = mapRow(appRows[i]);
            console.log(`🎬 Processing Item ${i + 1}/${appRows.length}: ${rowData.resource}`);

            // 1. Click Add — POLL for the button (grid may still be reloading after postback)
            const ADD_BTN_ID = 'ctl00_CPH1_DailyReportTimeSheet1_rdgDailyReportTimesheet_ctl00_ctl02_ctl00_lblAddLine';
            try {
                let currentAddBtn = null;
                for (let pollAttempt = 0; pollAttempt < 20; pollAttempt++) {
                    currentAddBtn = document.getElementById(ADD_BTN_ID);
                    if (currentAddBtn && currentAddBtn.offsetParent !== null) break;
                    if (pollAttempt === 0) console.log('  ⏳ Waiting for Add button (grid reloading)...');
                    await wait(500);
                }

                if (currentAddBtn) {
                    currentAddBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    await wait(300);
                    currentAddBtn.click();
                    if (currentAddBtn.parentElement && currentAddBtn.parentElement.tagName === 'A') {
                        currentAddBtn.parentElement.click();
                    }
                    console.log('  Testing Add Click...');
                } else {
                    console.error("  ❌ Add button not found after 10s polling. Skipping item " + (i + 1));
                    continue; // Skip this item, try next instead of stopping
                }
            } catch (e) {
                console.error('  Add Click Failed', e);
                continue; // Skip and try next item
            }

            // 2. Wait for NEW row — poll for it instead of hardcoded wait
            await wait(1500);

            // 3. Find the new input — retry up to 15 attempts (7.5s total)
            const MAX_ROW_ATTEMPTS = 15;
            let attempts = 0;
            let targetInput = null;

            while (attempts < MAX_ROW_ATTEMPTS) {
                const inputs = document.querySelectorAll('input[id*="ddlResources_Input"]:not([id*="Filter"])');
                if (inputs.length > 0) {
                    targetInput = inputs[inputs.length - 1];
                    if (targetInput && targetInput.offsetParent !== null) {
                        break;
                    }
                }
                await wait(500);
                attempts++;
                if (attempts % 5 === 0) {
                    console.log('  ⏳ Still waiting for new row... (' + attempts + '/' + MAX_ROW_ATTEMPTS + ')');
                }
            }

            if (!targetInput) {
                console.warn('⚠️ Could not find new row input for item ' + (i + 1) + ' — skipping to next');
                continue; // SKIP instead of BREAK — try the next item
            }

            // Scroll to it
            targetInput.scrollIntoView({ behavior: 'auto', block: 'center' });
            await wait(200);

            // 4. Fill Row
            const freshRowPrefix = targetInput.id.replace('ddlResources_Input', '');
            await fillSingleRow(freshRowPrefix, rowData, i + 1);

            // 5. Click Save
            if (shouldStop) break;

            // RE-FIND SAVE BUTTON — poll for it
            const SAVE_BTN_ID = 'ctl00_CPH1_DailyReportTimeSheet1_rdgDailyReportTimesheet_ctl00_ctl02_ctl00_lblSave';
            let currentSaveBtn = null;
            for (let sp = 0; sp < 10; sp++) {
                currentSaveBtn = document.getElementById(SAVE_BTN_ID);
                if (currentSaveBtn) break;
                await wait(500);
            }

            if (currentSaveBtn) {
                console.log("  💾 Saving...");
                currentSaveBtn.click();
                if (currentSaveBtn.parentElement && currentSaveBtn.parentElement.tagName === 'A') {
                    currentSaveBtn.parentElement.click();
                }

                // Wait for postback: poll for Add button to reappear (grid reload complete)
                console.log('  ⏳ Waiting for grid to reload after save...');
                let reloadDone = false;
                for (let rp = 0; rp < 20; rp++) {
                    await wait(500);
                    const addCheck = document.getElementById(ADD_BTN_ID);
                    if (addCheck && addCheck.offsetParent !== null) {
                        reloadDone = true;
                        break;
                    }
                }
                if (!reloadDone) {
                    console.warn('  ⚠️ Grid did not reload within 10s, continuing anyway...');
                    await wait(2000); // Extra fallback wait
                }
            } else {
                console.warn("  ⚠️ Save button not found — row may not have been added properly, skipping.");
                continue; // Skip to next item instead of continuing with bad state
            }
        }

        hideStopButton();
        console.log('🎉 Batch Complete!');
        pmAlert('✅ Data Entry Complete!');
    }

    async function fillSingleRow(BASE, data, rowNum) {
        console.log('=== ROW ' + rowNum + ': ' + data.resource + ' ===');
        console.log('  📋 Full Row Data:', JSON.stringify({
            resource: data.resource,
            company: data.company,
            subcontractor: data.subcontractor,
            payType: data.payType,
            classification: data.classification,
            hours: data.hours
        }, null, 2));
        const wait = bgWait; // Uses postMessage — not throttled in background tabs

        // Telerik Finder
        function findComponentByInputId(inputId) {
            if (typeof Sys === 'undefined' || !Sys.Application) return null;
            const components = Sys.Application.getComponents();
            for (let i = 0; i < components.length; i++) {
                const c = components[i];
                if (c.get_inputDomElement && c.get_inputDomElement().id === inputId) return c;
            }
            return null;
        }

        // Set Dropdown (Robust: trigger filtering, request items, retry with multiple strategies)
        async function setDropdown(suffix, value, retryCount = 0) {
            const inputId = BASE + suffix + "_Input";
            const input = document.getElementById(inputId);
            const MAX_RETRIES = 2;

            // CRITICAL FIX: Try both formats (DOM ID vs Component ID)
            // Telerik sometimes uses ClientID (underscores) or UniqueID (dollars) for $find
            const idUnderscore = BASE + suffix;
            const idDollar = (BASE + suffix).replace(/_/g, '$');

            // Try $find with both
            let combo = null;
            if (typeof $find === 'function') {
                combo = $find(idUnderscore) || $find(idDollar);
            }

            // Fallback to Sys.Application
            if (!combo && typeof Sys !== 'undefined' && Sys.Application) {
                combo = Sys.Application.findComponent(idUnderscore) || Sys.Application.findComponent(idDollar);
            }

            if (!combo) {
                console.error('  ❌ Combo NOT FOUND. Tried: ' + idUnderscore + ' AND ' + idDollar);
                return false;
            }

            try {
                // Focus input first
                if (input) {
                    input.focus();
                    await wait(50); // Reduced from 100ms
                }

                // Strategy 1: Try requestItems if available (loads ALL items from server)
                if (combo.requestItems && retryCount === 0) {
                    try {
                        console.log('  📡 Requesting all items for: ' + suffix);
                        combo.requestItems('', false); // Empty filter = all items
                        await wait(800); // Reduced from 1200ms
                    } catch (e) {
                        console.log('  ℹ️ requestItems not available');
                    }
                }

                // Different search text strategies based on retry count
                let typeText = '';
                if (value.includes('-')) {
                    // Format like "LE-42- Utility Truck" or "CS - Cost"
                    const parts = value.split('-');
                    if (retryCount === 0) {
                        // First try: type the code prefix (e.g., "LE-42")
                        typeText = parts.slice(0, 2).join('-').trim();
                    } else if (retryCount === 1) {
                        // Second try: type just the letters (e.g., "LE")
                        typeText = parts[0].trim();
                    } else {
                        // Third try: type the description part
                        typeText = parts.slice(-1)[0].trim().substring(0, 6);
                    }
                } else {
                    typeText = value.substring(0, Math.min(6, value.length));
                }

                // Set text directly instead of char-by-char (MAJOR SPEED IMPROVEMENT)
                if (input && typeText) {
                    input.value = '';
                    await wait(30);
                    input.value = typeText; // Direct paste instead of loop
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: typeText.slice(-1) }));
                    console.log('  ⌨️ Typed: "' + typeText + '"');
                    await wait(600); // Reduced from 1000ms
                }

                // Show dropdown to ensure items are visible
                if (combo.showDropDown) combo.showDropDown();
                await wait(300); // Reduced from 500ms

                // Try to find the item
                let item = null;

                // Strategy A: Exact text match
                item = combo.findItemByText(value);

                // Strategy B: Fuzzy match on loaded items
                if (!item) {
                    const items = combo.get_items();
                    if (items && items.get_count() > 0) {
                        console.log('  📋 ' + items.get_count() + ' items loaded');

                        // Build search keys from value
                        const valueLower = value.toLowerCase();
                        const searchKeys = [];

                        // Add full value
                        searchKeys.push(valueLower);

                        // Add parts split by dash
                        if (value.includes('-')) {
                            const parts = value.split('-').map(p => p.trim().toLowerCase());
                            searchKeys.push(...parts.filter(p => p.length > 1));
                            // Add code like "LE-42" or "LL-02"
                            if (parts.length >= 2) {
                                searchKeys.push(parts[0] + '-' + parts[1]);
                            }
                        }

                        // Search through all items
                        for (let i = 0; i < items.get_count(); i++) {
                            const itemText = items.getItem(i).get_text();
                            const itemLower = itemText.toLowerCase();

                            // Check if item text matches any search key
                            for (const key of searchKeys) {
                                if (itemLower.includes(key) || key.includes(itemLower)) {
                                    item = items.getItem(i);
                                    console.log('  🔍 Matched: "' + itemText + '" via key "' + key + '"');
                                    break;
                                }
                            }
                            if (item) break;
                        }
                    } else {
                        console.warn('  ⚠️ No items loaded for: ' + suffix);

                        // If no items and we haven't retried, try again
                        if (retryCount < MAX_RETRIES) {
                            if (combo.hideDropDown) combo.hideDropDown();
                            await wait(300);
                            console.log('  🔄 Retrying... (attempt ' + (retryCount + 2) + ')');
                            return await setDropdown(suffix, value, retryCount + 1);
                        }
                    }
                }

                if (item) {
                    // Select the item using Telerik API
                    item.select();

                    // Also highlight and commit
                    if (combo.set_selectedIndex) {
                        combo.set_selectedIndex(item.get_index());
                    }

                    await wait(100);
                    if (combo.hideDropDown) combo.hideDropDown();
                    if (combo.commitChanges) combo.commitChanges();

                    // Trigger change events
                    if (input) {
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        input.dispatchEvent(new Event('blur', { bubbles: true }));
                    }

                    console.log('  ✅ ' + value);
                    return true;
                } else {
                    // Final fallback: If we've typed text, try pressing Enter to accept first match
                    if (input && retryCount >= MAX_RETRIES) {
                        console.log('  🎯 Fallback: Pressing Down+Enter to select first filtered item');
                        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown', keyCode: 40 }));
                        await wait(200);
                        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', keyCode: 13 }));
                        await wait(200);
                        if (combo.hideDropDown) combo.hideDropDown();
                        return true; // Assume success
                    }

                    console.warn('  ⚠️ NOT FOUND: ' + value);
                    if (combo.hideDropDown) combo.hideDropDown();

                    // Retry if we have attempts left
                    if (retryCount < MAX_RETRIES) {
                        await wait(300);
                        console.log('  🔄 Retrying with different search... (attempt ' + (retryCount + 2) + ')');
                        return await setDropdown(suffix, value, retryCount + 1);
                    }

                    return false;
                }

            } catch (e) {
                console.error('  ❌ Dropdown error: ' + suffix, e);
                if (combo && combo.hideDropDown) combo.hideDropDown();
                return false;
            }
        }

        // Set Time/Date properly
        async function setTime(suffix, timeStr) {
            const inputId = BASE + suffix + "_dateInput"; // TimePickers usually have _dateInput
            // Attempt to find the DatePicker/TimePicker component
            // It often has ID = BASE + suffix
            let picker = null;

            if (typeof Sys !== 'undefined') {
                // Try finding by component ID directly (often without _Input)
                const componentId = BASE + suffix;
                picker = Sys.Application.findComponent(componentId);

                // If not found, try by input ID
                if (!picker) picker = findComponentByInputId(inputId);
            }

            // Parse time
            let dateObj = null;
            try {
                const d = new Date(); // Today
                const [time, period] = timeStr.split(' ');
                let [hours, minutes] = time.split(':');
                hours = parseInt(hours);
                minutes = parseInt(minutes);
                if (period === 'PM' && hours < 12) hours += 12;
                if (period === 'AM' && hours === 12) hours = 0;
                d.setHours(hours);
                d.setMinutes(minutes);
                d.setSeconds(0);
                dateObj = d;
            } catch (e) { }

            if (picker && dateObj && picker.set_selectedDate) {
                try {
                    picker.set_selectedDate(dateObj);
                    console.log('  ✅ Time ' + timeStr + ' set via Telerik Picker');
                    return;
                } catch (e) { console.log("TimePicker Set Error", e); }
            }

            // Fallback to text input if picker fails (Time inputs are usually forgiving)
            const inp = document.getElementById(inputId);
            if (inp) {
                inp.focus();
                inp.value = timeStr;
                inp.dispatchEvent(new Event('change', { bubbles: true }));
                inp.dispatchEvent(new Event('blur', { bubbles: true }));
                console.log('  ✅ Time ' + timeStr + ' set via Input (Fallback)');
            }
        }

        // Text Input (Robust)
        function setText(suffix, value) {
            // Check for Telerik TextBox first
            const compId = BASE + suffix;
            let comp = Sys.Application.findComponent(compId);
            if (comp && comp.set_value) {
                comp.set_value(value);
                console.log('  ✅ Text set via Telerik: ' + suffix);
                return;
            }

            // Standard DOM
            const inp = document.getElementById(BASE + suffix);
            if (inp) {
                inp.value = value;
                inp.dispatchEvent(new Event('change', { bubbles: true }));
                inp.dispatchEvent(new Event('blur', { bubbles: true }));
            }
        }

        // Execute Field Fills ============================================

        // 1. Resource (CRITICAL: Pay Type and Classification depend on this selection)
        const resourceSuccess = await setDropdown("ddlResources", data.resource);
        // Wait for server to populate dependent dropdowns
        await wait(800); // Reduced from 1200ms

        // 2. Pay Type (Only try if Resource was set - depends on Resource selection)
        if (resourceSuccess) {
            const payTypeSuccess = await setDropdown("ddlResourcePayTypes", data.payType);
            await wait(300); // Reduced from 600ms

            // 3. Classification (depends on Resource + Pay Type)
            // Only try if Pay Type succeeded (chain dependency)
            if (payTypeSuccess) {
                await setDropdown("ddlResourceClasses", data.classification);
                await wait(100); // Reduced from 200ms
            } else {
                console.warn('  ⚠️ Skipping Classification (Pay Type failed)');
                // Try setting class anyway, sometimes it populates even if Pay Type confirmation fails
                await setDropdown("ddlResourceClasses", data.classification);
            }
        } else {
            console.warn('  ⚠️ Skipping Pay Type & Classification (Resource failed)');
        }

        // 4. Checkboxes
        const chkSpecial = document.getElementById(BASE + "EditUserDefinedFields4_chkData");
        if (chkSpecial && chkSpecial.checked !== data.specialist) chkSpecial.click();

        const chkSub = document.getElementById(BASE + "EditUserDefinedFields3_chkData");
        if (chkSub && chkSub.checked !== data.subcontractor) chkSub.click();

        // 5. Quantity
        setText("EditUserDefinedFields1_txtData", data.quantity);

        // 6. Company & Remarks — All contractors use Company dropdown
        let finalRemarks = data.remarks || '';

        console.log("  🔍 DEBUG Company Data: '" + data.company + "'");
        console.log("  🔍 DEBUG Resource Data: '" + data.resource + "'");

        // Set Company dropdown for ALL rows (GC and subs alike)
        const compVal = data.company || 'OHL NA';
        const companySuccess = await setDropdown("EditUserDefinedFields5_ddlData", compVal);

        // FALLBACK: If company not found in PMWeb dropdown (new contractor),
        // append company name to Remarks so the data isn't lost
        if (!companySuccess && compVal && compVal !== 'OHL NA') {
            const companyNote = '[Company: ' + compVal + ']';
            finalRemarks = finalRemarks ? finalRemarks + ' | ' + companyNote : companyNote;
            console.log('  ⚠️ Company "' + compVal + '" not in PMWeb dropdown — moved to Remarks');
        }

        // 7. Time & Hours
        // Parse start and finish times
        const parseTime = (timeStr) => {
            // Try with minutes: "7:30 PM", "8:30 AM"
            const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
            if (match) {
                let [_, hours, minutes, period] = match;
                hours = parseInt(hours);
                minutes = parseInt(minutes);
                if (period.toUpperCase() === 'PM' && hours < 12) hours += 12;
                if (period.toUpperCase() === 'AM' && hours === 12) hours = 0;
                return hours * 60 + minutes;
            }
            // Try bare hour: "8 PM", "8PM", "10AM"
            const matchBare = timeStr.match(/(\d+)\s*(AM|PM)/i);
            if (matchBare) {
                let hours = parseInt(matchBare[1]);
                const period = matchBare[2].toUpperCase();
                if (period === 'PM' && hours < 12) hours += 12;
                if (period === 'AM' && hours === 12) hours = 0;
                return hours * 60;
            }
            return null;
        };

        const startMinutes = parseTime(data.startTime);
        const finishMinutes = parseTime(data.finishTime);

        // Enter actual start/finish times first
        await setTime("tpStartTime", data.startTime);
        await setTime("tpFinishTime", data.finishTime);

        await wait(200); // Brief wait for PMWeb to finish auto-calculating

        // The hours on the time sheet are what the crew was paid for, so they are
        // what goes in. This used to recompute them from the start and finish times
        // minus a lunch break, which is how a 5-hour row came to read 1.73 - a 1
        // hour 44 minute span - and it also rewrote good figures: a row recording
        // 4.00 hours between 7:00 AM and 11:30 AM became 4.50, because that is what
        // the clock says. On most rows those times are the report's own defaults
        // rather than a measurement, so they are used only when a row has no hours.
        //
        // data.hours is the TOTAL - it is mapped straight from total_hours. PMWeb's
        // cell 11 takes that total; cell 18, this column, takes it divided by the
        // quantity. Terry, 2026-09-27: "it should be 5 but it says 1.73".
        const qty = parseFloat(data.quantity) || 0;
        const sheetTotal = parseFloat(data.hours) || 0;

        if (sheetTotal > 0) {
            const perUnit = qty > 0 ? sheetTotal / qty : sheetTotal;
            setText("EditUserDefinedFields6_txtData", sheetTotal.toFixed(2));
            setText("txtHours", perUnit.toFixed(2));
            console.log('  Hours from the time sheet: total ' + sheetTotal.toFixed(2)
                + ', per unit ' + perUnit.toFixed(2) + ' (qty ' + qty + ')');
        } else if (startMinutes !== null && finishMinutes !== null) {
            // No hours on the row at all. The clock is all there is.
            let rawMinutes = finishMinutes - startMinutes;
            if (rawMinutes < 0) rawMinutes += 1440;                       // crosses midnight
            const rawHours = rawMinutes / 60;
            const calcHours = rawHours >= 6 ? rawHours - 0.5 : rawHours;  // lunch
            const totalHours = qty * calcHours;
            setText("EditUserDefinedFields6_txtData", totalHours.toFixed(2));
            setText("txtHours", calcHours.toFixed(2));
            console.warn('  no hours on this row - taken from the clock instead: '
                + calcHours.toFixed(2) + ' per unit, total ' + totalHours.toFixed(2));
        } else {
            setText("EditUserDefinedFields6_txtData", '0.00');
            setText("txtHours", '0.00');
            console.warn('  this row carries neither hours nor times - both Hours columns left at 0.00');
        }

        // Memo
        setText("EditUserDefinedFields2_txtMemo", finalRemarks);
    }

    // ============================================
    // ACTIVITIES (OnSite) — FILL AUTOMATION
    // Grid: ctl00_CPH1_DailyReportDetails_rdgOnSite
    // ============================================

    window.addEventListener('PMWEB_FILL_ACTIVITIES_TRIGGER', async (event) => {
        shouldStop = false;
        const rows = event.detail;
        console.log('📥 Activities Worker received', rows.length, 'activity rows');
        await fillAllActivities(rows);
        pmStepResult('activities', !shouldStop, shouldStop
            ? 'stopped part-way, check the On Site grid'
            : 'finished ' + rows.length + ' activity row(s); the console has each row');
    });

    // The Notes tab on its own, for a report whose other tabs are already done.
    window.addEventListener('PMWEB_FILL_NOTE_TRIGGER', async (event) => {
        shouldStop = false;
        const html = event.detail;
        console.log('📝 Notes worker received ' + String(html || '').length + ' character(s)');

        // Make sure we are on the Notes tab first. The full run has its own tab
        // helper, but that one lives inside runFullAutoFill.
        const link = Array.from(document.querySelectorAll(
            '#ctl00_CPH1_tbsDocument .rtsUL .rtsLI a.rtsLink'))
            .find(a => (a.textContent || '').replace(/\s+/g, ' ').trim() === 'Notes');
        const li = link ? link.closest('li') : null;
        if (link && !/rtsSelected/.test((li && li.className) || '')) {
            fireMouseClick(link);
            await bgWait(2500);
        }

        const r = await fillNote(html);
        if (r.ok) {
            console.log('✅ Note written');
            pmStepResult('notes', true, 'note written and saved');
        } else {
            console.error('❌ Notes: ' + r.reason);
            console.error('   The note HTML is on the clipboard, so it can still go in by hand.');
            pmStepResult('notes', false, r.reason
                + '. The note is on the clipboard, so it can still go in by hand.');
        }
    });

    async function fillAllActivities(actRows) {
        console.log('🎯 Starting ACTIVITIES ADD-FILL-SAVE automation for', actRows.length, 'items... (Press ESC to stop)');
        showStopButton();
        const wait = bgWait;

        // OnSite grid IDs
        const ADD_BTN_ID = 'ctl00_CPH1_DailyReportDetails_rdgOnSite_ctl00_ctl02_ctl00_lblAddLine';
        const SAVE_BTN_ID = 'ctl00_CPH1_DailyReportDetails_rdgOnSite_ctl00_ctl02_ctl00_lblSave';

        // Company name aliases
        const companyMap = {
            'OHLA': 'OHL NA',
            'ohla': 'OHL NA',
            'Ohla': 'OHL NA',
            'hms': 'HMS',
            'Hms': 'HMS',
        };

        // Ask user where to start
        let startIndex = 0;
        const userInput = pmPrompt(
            `Resume from a specific activity?\n\nTotal activities: ${actRows.length}\n\nEnter number to start from (1-${actRows.length}), or press Cancel/enter 0 to start from beginning:`,
            '1'
        );

        if (userInput !== null && userInput.trim() !== '') {
            const rowNum = parseInt(userInput, 10);
            if (rowNum >= 1 && rowNum <= actRows.length) {
                startIndex = rowNum - 1;
                console.log(`▶️ Activities: Resuming from row ${rowNum} (${actRows.length - startIndex} remaining)`);
            } else if (rowNum === 0) {
                console.log(`▶️ Activities: Starting from the beginning (${actRows.length} rows)`);
            } else {
                pmAlert('Invalid number. Starting from beginning.');
            }
        }

        for (let i = startIndex; i < actRows.length; i++) {
            if (shouldStop) { console.log('🛑 Activities: Stopped by user at item ' + (i + 1)); break; }

            const row = actRows[i];
            let company = row.company || '';
            if (companyMap[company]) company = companyMap[company];

            console.log(`🎬 Activity ${i + 1}/${actRows.length}: "${row.title}" @ ${row.location} (${company})`);

            // 1. Click Add — poll for button
            try {
                let addBtn = null;
                for (let p = 0; p < 20; p++) {
                    addBtn = document.getElementById(ADD_BTN_ID);
                    if (addBtn && addBtn.offsetParent !== null) break;
                    if (p === 0) console.log('  ⏳ Waiting for Activities Add button...');
                    await wait(500);
                }

                if (addBtn) {
                    addBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    await wait(300);
                    addBtn.click();
                    if (addBtn.parentElement && addBtn.parentElement.tagName === 'A') {
                        addBtn.parentElement.click();
                    }
                    console.log('  ✅ Clicked Add');
                } else {
                    console.error('  ❌ Activities Add button not found after 10s. Skipping item ' + (i + 1));
                    continue;
                }
            } catch (e) {
                console.error('  ❌ Activities Add Click Failed', e);
                continue;
            }

            // 2. Wait for edit row to appear — poll for txtLocation input
            await wait(1500);

            const MAX_ATTEMPTS = 15;
            let attempts = 0;
            let locationInput = null;

            while (attempts < MAX_ATTEMPTS) {
                // Find txtLocation inputs in the OnSite grid (not filter row)
                const inputs = document.querySelectorAll('input[id*="DailyReportDetails_rdgOnSite"][id*="txtLocation"]:not([id*="Filter"])');
                if (inputs.length > 0) {
                    locationInput = inputs[inputs.length - 1];
                    if (locationInput && locationInput.offsetParent !== null) break;
                }
                await wait(500);
                attempts++;
                if (attempts % 5 === 0) {
                    console.log('  ⏳ Still waiting for new activity row... (' + attempts + '/' + MAX_ATTEMPTS + ')');
                }
            }

            if (!locationInput) {
                console.warn('  ⚠️ Could not find activity edit row for item ' + (i + 1) + ' — skipping');
                continue;
            }

            // Derive base prefix from the location input
            const BASE = locationInput.id.replace('txtLocation', '');
            console.log('  📍 Edit row base: ' + BASE);

            locationInput.scrollIntoView({ behavior: 'auto', block: 'center' });
            await wait(200);

            // 3. Fill the row
            await fillSingleActivity(BASE, row, company, i + 1);

            // 4. Click Save
            if (shouldStop) break;

            let saveBtn = null;
            for (let sp = 0; sp < 10; sp++) {
                saveBtn = document.getElementById(SAVE_BTN_ID);
                if (saveBtn) break;
                await wait(500);
            }

            if (saveBtn) {
                console.log('  💾 Saving activity...');
                saveBtn.click();
                if (saveBtn.parentElement && saveBtn.parentElement.tagName === 'A') {
                    saveBtn.parentElement.click();
                }

                // Wait for grid reload — poll for Add button to reappear
                console.log('  ⏳ Waiting for grid to reload after save...');
                let reloadDone = false;
                for (let rp = 0; rp < 20; rp++) {
                    await wait(500);
                    const addCheck = document.getElementById(ADD_BTN_ID);
                    if (addCheck && addCheck.offsetParent !== null) {
                        reloadDone = true;
                        break;
                    }
                }
                if (!reloadDone) {
                    console.warn('  ⚠️ Activities grid did not reload within 10s, continuing anyway...');
                    await wait(2000);
                }
            } else {
                console.warn('  ⚠️ Activities Save button not found — skipping');
                continue;
            }
        }

        hideStopButton();
        console.log('🎉 Activities Batch Complete!');
        pmAlert('✅ Activities Data Entry Complete!');
    }

    async function fillSingleActivity(BASE, data, company, rowNum) {
        console.log('=== ACTIVITY ' + rowNum + ': ' + data.title + ' ===');
        console.log('  📋 Data:', JSON.stringify(data, null, 2));
        const wait = bgWait;

        // --- Location (text input) ---
        const locInput = document.getElementById(BASE + 'txtLocation');
        if (locInput) {
            const place = pmPlace(data.location);
            locInput.focus();
            locInput.value = place;
            locInput.dispatchEvent(new Event('change', { bubbles: true }));
            locInput.dispatchEvent(new Event('blur', { bubbles: true }));
            console.log('  ✅ Location: ' + place
                + (place !== (data.location || '') ? '   (was "' + data.location + '")' : ''));
        } else {
            console.warn('  ⚠️ Location input not found');
        }

        // --- Company (Telerik RadComboBox) ---
        const companyInputId = BASE + 'ddlCompanies_Input';
        const companyInput = document.getElementById(companyInputId);

        // Try Telerik $find
        const compIdUnderscore = BASE + 'ddlCompanies';
        const compIdDollar = compIdUnderscore.replace(/_/g, '$');
        let combo = null;

        if (typeof $find === 'function') {
            combo = $find(compIdUnderscore) || $find(compIdDollar);
        }
        if (!combo && typeof Sys !== 'undefined' && Sys.Application) {
            combo = Sys.Application.findComponent(compIdUnderscore) || Sys.Application.findComponent(compIdDollar);
        }

        if (combo && company) {
            try {
                if (companyInput) {
                    companyInput.focus();
                    await wait(50);
                }

                // Request all items
                if (combo.requestItems) {
                    combo.requestItems('', false);
                    await wait(800);
                }

                // Type company prefix
                if (companyInput) {
                    companyInput.value = '';
                    await wait(30);
                    companyInput.value = company.substring(0, 6);
                    companyInput.dispatchEvent(new Event('input', { bubbles: true }));
                    companyInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: company.slice(-1) }));
                    await wait(600);
                }

                if (combo.showDropDown) combo.showDropDown();
                await wait(300);

                // Find item
                let item = combo.findItemByText(company);
                if (!item) {
                    const items = combo.get_items();
                    if (items && items.get_count() > 0) {
                        const compLower = company.toLowerCase();
                        for (let ci = 0; ci < items.get_count(); ci++) {
                            const itemText = items.getItem(ci).get_text().toLowerCase();
                            if (itemText.includes(compLower) || compLower.includes(itemText)) {
                                item = items.getItem(ci);
                                break;
                            }
                        }
                    }
                }

                if (item) {
                    item.select();
                    if (combo.set_selectedIndex) combo.set_selectedIndex(item.get_index());
                    await wait(100);
                    if (combo.hideDropDown) combo.hideDropDown();
                    if (combo.commitChanges) combo.commitChanges();
                    if (companyInput) {
                        companyInput.dispatchEvent(new Event('change', { bubbles: true }));
                        companyInput.dispatchEvent(new Event('blur', { bubbles: true }));
                    }
                    console.log('  ✅ Company: ' + company);
                } else {
                    console.warn('  ⚠️ Company "' + company + '" not found in dropdown');
                    if (combo.hideDropDown) combo.hideDropDown();
                    // Fallback: set text directly
                    if (companyInput) {
                        companyInput.value = company;
                        companyInput.dispatchEvent(new Event('change', { bubbles: true }));
                        companyInput.dispatchEvent(new Event('blur', { bubbles: true }));
                    }
                }
            } catch (e) {
                console.error('  ❌ Company dropdown error:', e);
                if (combo && combo.hideDropDown) combo.hideDropDown();
            }
        } else if (companyInput && company) {
            // Fallback to plain text input
            companyInput.value = company;
            companyInput.dispatchEvent(new Event('change', { bubbles: true }));
            companyInput.dispatchEvent(new Event('blur', { bubbles: true }));
            console.log('  ✅ Company (text fallback): ' + company);
        }

        // --- Activities/Notes (textarea) ---
        const notesTA = document.getElementById(BASE + 'txtNotes');
        if (notesTA) {
            notesTA.focus();
            notesTA.value = data.title || '';
            notesTA.dispatchEvent(new Event('change', { bubbles: true }));
            notesTA.dispatchEvent(new Event('blur', { bubbles: true }));
            console.log('  ✅ Activities: ' + data.title);
        } else {
            console.warn('  ⚠️ Activities textarea not found');
        }

        // --- Subcontractor checkbox (EditUserDefinedFields1_chkData) ---
        const chkSub = document.getElementById(BASE + 'EditUserDefinedFields1_chkData');
        if (chkSub && chkSub.checked !== data.subcontract) {
            chkSub.click();
            console.log('  ✅ Subcontractor: ' + data.subcontract);
        }

        // --- Extra Work checkbox (EditUserDefinedFields2_chkData) ---
        const chkEW = document.getElementById(BASE + 'EditUserDefinedFields2_chkData');
        if (chkEW && chkEW.checked !== data.extra_work) {
            chkEW.click();
            console.log('  ✅ Extra Work: ' + data.extra_work);
        }

        // --- Hours (EditUserDefinedFields4_txtData) ---
        const hoursInput = document.getElementById(BASE + 'EditUserDefinedFields4_txtData');
        if (hoursInput) {
            // Check for Telerik TextBox first
            let hoursComp = null;
            const hoursCompId = BASE + 'EditUserDefinedFields4_txtData';
            if (typeof Sys !== 'undefined' && Sys.Application) {
                hoursComp = Sys.Application.findComponent(hoursCompId);
            }

            if (hoursComp && hoursComp.set_value) {
                hoursComp.set_value(String(data.hours || 0));
            } else {
                hoursInput.value = String(data.hours || 0);
                hoursInput.dispatchEvent(new Event('change', { bubbles: true }));
                hoursInput.dispatchEvent(new Event('blur', { bubbles: true }));
            }
            console.log('  ✅ Hours: ' + data.hours);
        } else {
            console.warn('  ⚠️ Hours input not found');
        }

        // --- Specialist checkbox (EditUserDefinedFields5_chkData) — default unchecked ---
        // Not setting this — user said to ignore SPECIALIST column

        console.log('  ✅ Activity row ' + rowNum + ' filled');
    }

    // ============================================
    // FULL AUTOMATION — PMWEB_FILL_EVERYTHING
    // ═══════════════════════════════════════════════════════════════════════
    // FAST LABOR & EQUIPMENT
    //
    // The old fillAllRows adds one row at a time: Add Line, then a save, then
    // the next - about four postbacks a row, so a 57-row report costs upwards of
    // two hundred round trips. This does the same work in roughly a dozen.
    //
    //   1. the resource picker creates every row at once, with the Resource
    //      column already filled. A resource needed N times is ticked and moved
    //      N times inside the one picker session - Terry, 2026-09-26: "if you
    //      tick laborer, click move, then tick laborer and click move you end up
    //      with two laborers"
    //   2. editAllItems() opens every row in one postback
    //   3. every field is written client side
    //   4. updateEditedItems() commits the lot in one postback
    //
    // MODES
    //   'add'   leave the rows already in the grid alone and add these beside
    //           them. Terry, 2026-09-27: "NO IT ADDS MORE ON TOP TO ADD TO NOT
    //           WRITE OVER"
    //   'fill'  write into the rows already there, matching on resource code,
    //           and create only the shortfall
    //
    // THINGS THAT COST A DEAD END EACH, so they are not re-litigated here:
    //
    //   * No PMWeb client call may run inside an async function. ASP.NET walks
    //     the JS stack reading .caller / .arguments to see what triggered a
    //     postback, and both are poisoned on an async function - the call throws
    //     a strict-mode TypeError and the request is never sent. Everything that
    //     can post back goes through pmInject(), a plain function on a timer.
    //
    //   * set_value() does nothing on these load-on-demand combos. With no items
    //     loaded there is nothing to bind to, so it leaves "value":"" and the
    //     field commits blank. The selection has to be written into the hidden
    //     _ClientState as JSON.
    //
    //   * Ticking a tree node stages nothing. div.btnTreeDropItems moves the
    //     ticked nodes into the picker's selection pane, and it hides itself
    //     after each click until the ticks change again.
    //
    //   * Match on the resource CODE, never the display name. The picker's node
    //     text carries double spaces, trailing spaces, en dashes and a
    //     registered sign. The hyphen in the code is required, which excludes
    //     the malformed LE100- and LE101- nodes - normalising those would let a
    //     crew truck tick a drill rig.
    // ═══════════════════════════════════════════════════════════════════════

    const PM_GRID = 'ctl00_CPH1_DailyReportTimeSheet1_rdgDailyReportTimesheet';
    const PM_ADDRES = PM_GRID + '_ctl00_ctl02_ctl00_btnAddResource';

    // Read from PMWeb itself, off a real selection's _ClientState.
    const PM_PAYTYPE = { 'CS - Cost': 'LAB-4', 'EW - Extra Work': 'LAB-12' };
    const PM_CLASS = { 'LR - Labor Regular Time': 'LAB-19', 'LO - Labor Overtime': 'LAB-20' };
    // Terry writes the firm one way, PMWeb lists it another - "OHLA" is "OHL NA"
    // in the register, and SRK carries a trailing space. Each spelling maps to the
    // id PMWeb posts and the name it shows. A firm that is not here is not in the
    // register at all, and goes in under the City with its name in Remarks.
    // Read off the register itself - all 136 entries, paged out of the Company
    // combo on 2026-09-27 - rather than guessed at. Every spelling used across the
    // 60 reports is listed, because Terry writes a firm one way and PMWeb lists it
    // another: "OHLA" is "OHL NA", "Red Tail" is "Red Tail Environmental",
    // "NorCal" is "NorCal Pipeline Services", and Dean's Certified Welding appears
    // five different ways in the reports against one "Deans Welding" entry.
    //
    // The register has genuine duplicates - Brino Builders at 90 and 131, HMS at
    // 69 and 133 - and the entry whose name matches what Terry writes is the one
    // taken. "AR Concrete " carries a trailing space in PMWeb; the id is what gets
    // posted so that does not matter.
    const PM_COMPANY = {
        'OHL NA': ['38', 'OHL NA'],
        'OHLA': ['38', 'OHL NA'],
        'OHLA USA Inc.': ['38', 'OHL NA'],
        'City of San Diego': ['1', 'City of San Diego'],
        'City': ['1', 'City of San Diego'],
        'Kleinfelder Inc.': ['46', 'Kleinfelder Inc.'],
        'Kleinfelder': ['46', 'Kleinfelder Inc.'],
        'SRK Engineering': ['129', 'SRK Engineering'],
        'SRK Eng': ['129', 'SRK Engineering'],
        'SRK': ['129', 'SRK Engineering'],
        'Stantec Consulting Services Inc': ['20', 'Stantec Consulting Services Inc'],
        'Stantec': ['20', 'Stantec Consulting Services Inc'],
        'Red Tail': ['48', 'Red Tail Environmental'],
        'Red Tail Environmental': ['48', 'Red Tail Environmental'],
        'RedTail': ['48', 'Red Tail Environmental'],
        'McMahon': ['66', 'McMahon Construction, Inc.'],
        'McMahon Construction': ['66', 'McMahon Construction, Inc.'],
        'HMS': ['133', 'HMS'],
        'HMS Construction': ['69', 'HMS Construction, Inc.'],
        'Deans Welding': ['83', 'Deans Welding'],
        'Deans Weldng': ['83', 'Deans Welding'],
        'Deans Certified Welding': ['83', 'Deans Welding'],
        "Dean's Welding": ['83', 'Deans Welding'],
        "Dean's Certified Welding": ['83', 'Deans Welding'],
        'Sealright Paving': ['89', 'SealRight Paving'],
        'SealRight Paving': ['89', 'SealRight Paving'],
        'Brino Builders': ['90', 'Brino Builders'],
        'Brino': ['90', 'Brino Builders'],
        'NorCal': ['132', 'NorCal Pipeline Services'],
        'NorCal Pipline': ['132', 'NorCal Pipeline Services'],
        'NorCal Pipeline Services': ['132', 'NorCal Pipeline Services'],
        'Picket Fences': ['135', 'Picket Fences'],
        'Pickette Fences': ['135', 'Picket Fences'],
        'AR Concrete': ['130', 'AR Concrete '],
        'West Coast Civil': ['105', 'West Coast Civil'],
        'MTS': ['14', 'Metropolitan Transit System'],
        'Metropolitan Transit System': ['14', 'Metropolitan Transit System'],
        'SDGE': ['22', 'San Diego Gas and Electric'],
        'SDG&E': ['22', 'San Diego Gas and Electric'],
        'Penhall': ['51', 'Penhall'],
        'Select Electric': ['68', 'Select Electric']
    };

    // An activity's location, cut down to the place name.
    //
    // Terry, 2026-09-27: "when it fills tha activities the location are going to
    // need some adjusting. its using the text from the report but it should just
    // be the street names." So "Town Centre Dr at Excalibur Way and at Golden
    // Haven" becomes "Town Centre, Excalibur, Golden Haven".
    //
    // 130 of the 180 locations across the 60 reports carry a place name and
    // convert on their own. The other 49 name a vault, a station or a pipe and
    // carry no place at all - PM_LOCATION is Terry's own answer for each of
    // those, so they are decisions rather than guesses. NCWRP is the North
    // County Water Reclamation Plant: a facility rather than a street, but it is
    // what the place is called.
    //
    // Longest needle first, so "Town Centre Dr" is not caught by a bare "Town".
    var PM_PLACES = [
        ['rose canyon', 'Rose Canyon'], ['marian bear', 'Marian Bear'],
        ['water reclamation', 'NCWRP'], ['ncwrp', 'NCWRP'],
        ['town cent', 'Town Centre'], ['towne cent', 'Town Centre'],
        ['genesee', 'Genesee'], ['nobel', 'Nobel'], ['executive', 'Executive'],
        ['decoro', 'Decoro'], ['lombard', 'Lombard'], ['governor', 'Governor'],
        ['judicial', 'Judicial'], ['excalibur', 'Excalibur'],
        ['golden haven', 'Golden Haven'], ['april c', 'April Ct'],
        ['centurion', 'Centurion'], ['sr-52', 'SR-52'], ['hwy 52', 'SR-52'],
        ['i-805', 'I-805'], ['805', 'I-805'], ['utc', 'UTC']
    ];

    var PM_LOCATION = {
        'air release vault #11': 'Genesee',
        'air release vault #11 and the sdg&e trench': 'Genesee',
        'job site wide': 'Genesee to Executive',
        'job site': 'Genesee to Executive',
        'sdg&e trench': 'Genesee',
        '30-inch force main': 'Genesee',
        '30-inch and 48-inch manways': 'Genesee',
        '30-inch and 48-inch mainline': 'Genesee',
        '30-inch main': 'Genesee, Nobel',
        '30-inch brine centrate, sta 1133+90 to 1173+49': 'Genesee, Nobel',
        '48-inch and 30-inch force main': 'Genesee to Town Centre',
        '48-inch and 30-inch force mains': 'Nobel',
        '48-inch force main, sta 467+50 to 507+05': 'Genesee, Nobel',
        'blow-off #8': 'Genesee',
        'blow-off #9': 'NCWRP',
        'vault #6': 'Genesee',
        'vault #7': 'Town Centre',
        'av vault': 'Town Centre',
        'av vaults #12 and #13 and the isolation valve at sta 390+60': 'Nobel, Town Centre',
        'isolation valve at sta 1057+44': 'Genesee',
        'cathodic test stations #33 and #42': 'Genesee',
        'blind flange installation': 'Genesee',
        'damaged 2-inch conduit': 'Town Centre',
        'dry sump & blowoff number 5 vault': 'Genesee',
        'mainline at sta 488+07 to 489+30': 'Nobel',
        'mainline at sta 1154+60 and end of pipe at sta 489+30': 'Nobel',
        'mainline sta 488+84 to 488+40': 'Nobel',
        'mainline sta 489+10 to 488+20': 'Nobel',
        'mainline sta 489+10 to 488+40': 'Nobel',
        'section 4 of the 30-inch and 48-inch': 'Town Centre',
        'section 4 of the 30-inch and 48-inch pipeline': 'Town Centre',
        'section 4 of the 30-inch and 48-inch pipelines': 'Town Centre',
        'section 4 of the 48-inch pipeline': 'Town Centre',
        'fiber optic location 6': 'Genesee',
        'fiber optic location 7': 'Genesee',
        'fiber optic location 10': 'Genesee',
        'fiber optic location 11': 'Genesee',
        'fiber optic location 11 (485+72)': 'Genesee',
        'fiber optic locations 6 and 7': 'Genesee',
        'fiber optic locations 6 (437+98) and 7 (447+88)': 'Genesee',
        'fiber optic locations 9 (471+15) and 10 (478+79)': 'Genesee',
        'fiber optic trench at 486+55': 'Genesee',
        'fiber optic trench at 416+37 and the run 527+77 to 537+32': 'Genesee',
        'fiber optic vaults 411+24 to 447+88': 'Genesee',
        'fiber optic vaults 411+24 to 552+79': 'Genesee',
        'fiber optic vaults 447+88 to 501+72': 'Genesee',
        'fiber optic vaults 478+79 and 485+72': 'Genesee',
        'fiber optic vaults 548+02 to 552+79': 'Genesee',
        'fiber optic vaults 548+02, 485+72 and 486+55': 'Genesee'
    };

    function pmPlace(text) {
        var raw = String(text || '').trim();
        if (!raw) { return ''; }

        // Terry's own answer for a location that names no place
        var exact = PM_LOCATION[raw.toLowerCase()];
        if (exact) { return exact; }

        var hay = raw.toLowerCase();
        var out = [];
        PM_PLACES.forEach(function (p) {
            if (hay.indexOf(p[0]) >= 0 && out.indexOf(p[1]) < 0) { out.push(p[1]); }
        });
        if (out.length) { return out.join(', '); }

        // Nothing recognised. The report's own words are better than nothing,
        // and the warning shows which location still needs an answer.
        console.warn('   no place matched in location: ' + raw);
        return raw;
    }

    function pmInject(code) {
        const s = document.createElement('script');
        s.text = 'setTimeout(function(){try{' + code +
                 '}catch(e){console.log("PM inject failed: "+e.message);}},0);';
        document.body.appendChild(s);
    }
    function pmInjectInto(W, code) {
        const s = W.document.createElement('script');
        s.text = 'setTimeout(function(){try{' + code +
                 '}catch(e){console.log("PM popup failed: "+e.message);}},0);';
        W.document.body.appendChild(s);
    }
    function pmCode(s) {
        const m = /^\s*(LL|LE)-\s*0*(\d+)/.exec(s || '');
        if (!m) return null;
        const n = parseInt(m[2], 10);
        return m[1] + '-' + (n < 10 ? '0' + n : String(n));
    }
    function pmTime(s) {
        const m = /^\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/.exec(String(s || ''));
        if (!m) return null;
        let h = parseInt(m[1], 10);
        const mi = parseInt(m[2], 10), ap = (m[3] || '').toLowerCase();
        if (ap === 'pm' && h !== 12) h += 12;
        else if (ap === 'am' && h === 12) h = 0;
        return [h, mi];
    }
    function pmPopup() {
        try {
            const wm = $find('ctl00_PMWindowManager');
            for (const w of (wm ? wm.get_windows() : [])) {
                if (w.isVisible && w.isVisible()) {
                    const f = w.get_contentFrame();
                    if (f && f.contentDocument && f.contentDocument.getElementById('rtvLabors')) {
                        return f.contentWindow;
                    }
                }
            }
        } catch (e) { }
        return null;
    }
    const pmGridRows = () => document.querySelectorAll('#' + PM_GRID + ' tr.rgRow, #' + PM_GRID + ' tr.rgAltRow');
    const pmEditRows = () => document.querySelectorAll('#' + PM_GRID + ' tr.rgEditRow');
    const pmHeader = () => Array.from(document.querySelectorAll('#' + PM_GRID + '_ctl00_Header th'))
        .map(th => (th.textContent || '').replace(/\s+/g, ' ').trim());
    function pmCell(tr, name, hh) {
        const c = hh.indexOf(name);
        return c >= 0 && tr.cells[c] ? (tr.cells[c].textContent || '').replace(/\s+/g, ' ').trim() : '';
    }

    // The grid's page size, widened so the whole report is on one page.
    //
    // Both the row census in fillResourcesFast and editAllItems() only ever see
    // the rendered page. On a 40-row page a 54-row report is counted short and
    // half of it is filled - which is how the 2026-09-27 run ended with 54 rows
    // created and none of them filled. Terry, 2026-09-27: "it worked but only
    // becasuse i changed the page size to 250 before i started". This makes that
    // change itself, so a run no longer depends on the grid having been left the
    // right way.
    //
    // 250 is the largest size the pager offers (5, 10, 20, 40, 60, 250) and the
    // longest report is far short of it. Changing it is a postback, so it goes in
    // through pmInject as a plain function - an async caller cannot make an
    // ASP.NET client call at all.
    async function pmFitPageSize(needed) {
        const wait = bgWait;
        const TARGET = 250;
        const mtv = () => {
            try { return $find(PM_GRID).get_masterTableView(); } catch (e) { return null; }
        };
        const size = () => { const m = mtv(); try { return m ? m.get_pageSize() : 0; } catch (e) { return 0; } };
        const pages = () => { const m = mtv(); try { return m ? m.get_pageCount() : 1; } catch (e) { return 1; } };

        let ps = size();
        if (!ps) { console.log('   page size: the grid would not say - carrying on'); return 0; }
        if (ps >= needed && pages() <= 1) return ps;   // the whole report is already on screen
        if (ps >= TARGET) return ps;                   // as wide as it goes

        console.log('   page size is ' + ps + ' over ' + pages() + ' page(s) - widening to '
            + TARGET + ' so all ' + needed + ' row(s) are on one page');

        // Route 1 is the pager's own page-size combo, which is what a person
        // uses. Route 2 is the table view's setter, for a pager with no combo.
        pmInject([
            'var mt = $find("' + PM_GRID + '").get_masterTableView(), done = "";',
            'var inp = document.querySelector("#' + PM_GRID + ' input[id*=\\"PageSize\\"][id$=\\"_Input\\"]");',
            'if (inp) { var c = $find(inp.id.replace(/_Input$/, ""));',
            '  var it = c ? (c.findItemByText("' + TARGET + '") || c.findItemByValue("' + TARGET + '")) : null;',
            '  if (it) { it.select(); done = "the pager combo"; } }',
            'if (!done) { mt.set_pageSize(' + TARGET + '); done = "set_pageSize()"; }',
            'console.log("   page size changed through " + done);'
        ].join('\n'));
        for (let i = 0; i < 60; i++) { await wait(400); ps = size(); if (ps >= TARGET) break; }

        if (ps < TARGET) {
            // Selecting a combo item can leave the grid unmoved, so the setter is
            // tried on its own before giving up.
            pmInject('var mt = $find("' + PM_GRID + '").get_masterTableView();'
                + ' mt.set_pageSize(' + TARGET + '); if (mt.rebind) { mt.rebind(); }');
            for (let i = 0; i < 60; i++) { await wait(400); ps = size(); if (ps >= TARGET) break; }
        }
        console.log('   page size now ' + ps + ' over ' + pages() + ' page(s)');
        return ps;
    }

    // One row of the app's data, turned into what PMWeb needs. Rentals take a
    // blank company with "Rental" in Remarks; subs take the City with the sub's
    // name in Remarks and the Subcontractor box ticked - Terry, 2026-09-26.
    function pmMapRow(row) {
        const name = row.resource || row.Resource || '';
        const qty = Number(row.qty || row.Qty || row.quantity || 0) || 0;

        // PMWeb's two Hours columns hold different numbers: cell 11 is quantity
        // times hours, cell 18 is hours per unit. The app's export carries only the
        // total - `total_hours` and `qty`, with no per-unit field at all - so reading
        // row.hours_each put 0.00 into the per-unit column on every row. Terry,
        // 2026-09-27: "the hours in this column are not accurate. it should be 5 but
        // it says 1.73".
        //
        // Every caller in here names the TOTAL: the API calls it `total_hours`, the
        // row-at-a-time path's own shape calls it `hours`. Both are read as the
        // total, and the per-unit figure is derived from it - the relationship on
        // Terry's own completed report, qty 5 / 40.00 / 8.00.
        const total = Number(
            row.total_hours != null ? row.total_hours : (row.hours || row.Hours || 0)) || 0;
        const each = Number(row.hours_each || row.hoursEach || 0)
            || (qty > 0 ? total / qty : total);
        const rawCo = String(row.company || row.Company || '').trim();
        const rental = !!(row.is_rental || row.rental);
        const sub = !!(row.is_3rd_party || row.is_consultant || row.subcontractor || row.subcontract);

        // Each firm gets its own entry in the register, or no company at all.
        //
        // Terry, 2026-09-27: "its not getting the company name right on some. SRK
        // is showing city of san diego", and then "red tail is not city of san
        // diego either". Every sub was going in as the City - wrong for SRK,
        // Kleinfelder and Stantec, which each have their own entry, and wrong for
        // Red Tail too, because naming the City asserts something the record does
        // not say and reads as though the City supplied the crew.
        //
        // So: a firm PMWeb knows gets its name. One it does not know is left with
        // no company and named in Remarks, which states what is known and nothing
        // more. Anything appearing often in Remarks is a firm worth looking up and
        // adding to PM_COMPANY.
        const known = PM_COMPANY[rawCo];
        let companyId = '', company = '', remarks = String(row.remarks || row.Remarks || '');
        let subBox = false;
        if (rental) {
            remarks = remarks || 'Rental';
        } else if (sub) {
            subBox = true;
            if (known) {
                companyId = known[0];
                company = known[1];
            } else {
                remarks = remarks || rawCo;
            }
        } else if (rawCo) {
            if (known) {
                companyId = known[0];
                company = known[1];
            } else {
                remarks = remarks || rawCo;
            }
        }

        const pt = String(row.pay_type || row.payType || 'CS - Cost');
        const cl = String(row.classification || 'LR - Labor Regular Time');
        return {
            code: pmCode(name), name: name, qty: qty, each: each,
            total: total,
            companyId: companyId, company: company,
            remarks: remarks, sub: subBox,
            specialist: !!(row.specialist || row.Specialist === 'Yes'),
            payTypeId: PM_PAYTYPE[pt] || 'LAB-4', payType: pt,
            clsId: PM_CLASS[cl] || 'LAB-19', cls: cl,
            start: pmTime(row.start_time || row.startTime),
            stop: pmTime(row.finish_time || row.finishTime || row.stop_time)
        };
    }

    async function fillResourcesFast(appRows, mode) {
        // Every other long-running function in here aliases bgWait, which uses
        // postMessage so it is not throttled when the tab is in the background.
        // Leaving this out is what made the first real run throw "wait is not
        // defined" and fall back to the row-at-a-time filler.
        const wait = bgWait;
        mode = (mode === 'fill') ? 'fill' : 'add';
        const rows = (appRows || []).map(pmMapRow);
        const usable = rows.filter(r => r.code);
        const noCode = rows.filter(r => !r.code);
        console.log('⚡ Fast Labor & Equipment — mode: ' + mode + ', ' + usable.length + ' row(s)');
        if (noCode.length) {
            console.warn('⚠️ ' + noCode.length + ' row(s) have no PMWeb resource code and are skipped: '
                + noCode.map(r => r.name).join(', '));
        }
        if (!usable.length) return { ok: false, stage: 'pre', reason: 'no rows with a resource code' };

        // Widen the page before anything is counted. The census below reads
        // rendered rows, so a narrow page under-counts what is already there and
        // 'fill' mode would then create duplicates of rows sitting on page 2.
        await pmFitPageSize(usable.length);

        const hh0 = pmHeader();
        const before = {};
        Array.from(pmGridRows()).forEach(tr => {
            const line = pmCell(tr, 'Line #', hh0);
            if (line) {
                before[line] = ['Resource', 'Quantity', 'Hours', 'Pay Type', 'Classification', 'Company', 'Remarks']
                    .map(n => pmCell(tr, n, hh0)).join(' | ');
            }
        });
        const beforeLines = Object.keys(before);
        console.log('   rows already in the grid: ' + beforeLines.length
            + (mode === 'add' ? ' (left alone)' : ' (these get filled)'));

        // what to create
        const need = {};
        usable.forEach(r => { need[r.code] = (need[r.code] || 0) + 1; });
        const have = {};
        if (mode === 'fill') {
            Array.from(pmGridRows()).forEach(tr => {
                const c = pmCode(pmCell(tr, 'Resource', hh0));
                if (c) have[c] = (have[c] || 0) + 1;
            });
        }
        const create = {};
        let toCreate = 0;
        Object.keys(need).forEach(c => {
            const n = Math.max(0, need[c] - (have[c] || 0));
            if (n > 0) { create[c] = n; toCreate += n; }
        });
        const passes = toCreate ? Math.max.apply(null, Object.keys(create).map(c => create[c])) : 0;
        console.log('   creating ' + toCreate + ' new row(s) in ' + passes + ' picker pass(es)');

        if (toCreate) {
            let W = pmPopup();
            if (!W) {
                const b = document.getElementById(PM_ADDRES);
                if (!b) return { ok: false, stage: 'pre', reason: 'Add Resource(s) not on the page' };
                b.click();
                for (let i = 0; i < 48 && !W; i++) { await wait(250); W = pmPopup(); }
            }
            if (!W) return { ok: false, stage: 'pre', reason: 'the resource picker never opened' };

            const nodes = W.$find('rtvLabors').get_allNodes();
            const byCode = {};
            nodes.forEach(n => {
                const c = pmCode((n.get_text() || '').replace(/\s+/g, ' ').trim());
                if (c && !(c in byCode)) byCode[c] = n;
            });
            const missing = Object.keys(create).filter(c => !(c in byCode));
            if (missing.length) {
                return { ok: false, stage: 'pre', reason: 'not in the picker: ' + missing.join(', ') };
            }

            const selCount = () => {
                try { return W.document.querySelectorAll('#rdgResources tr.rgRow, #rdgResources tr.rgAltRow').length; }
                catch (e) { return -1; }
            };
            for (let p = 0; p < passes; p++) {
                if (shouldStop) return { ok: false, stage: 'post', reason: 'stopped' };
                const want = Object.keys(create).filter(c => create[c] > p);
                const was = selCount();

                // Tick by clicking the checkbox, not by set_checked().
                //
                // set_checked() changes the tick but raises none of the tree's own
                // events, and div.btnTreeDropItems hides itself after each use
                // until the selection changes - Terry, 2026-09-26: "the move button
                // dissapears after you click it until you tick more items". So the
                // first pass worked, the second ticked 11 nodes and then clicked a
                // button that was still hidden: "btnTreeDropItems present=true
                // visible=false". Clicking the checkbox span is what a person does,
                // and it drives the control's own logic, so the button comes back.
                //
                // The root, "All Labor Resources", is left alone - it carries a
                // tri-state box and clicking it would tick all 224.
                pmInjectInto(W, [
                    'var WANT = ' + JSON.stringify(want) + ';',
                    'function codeOf(t) {',
                    '  var m = /^(LL|LE)-\\s*0*(\\d+)/.exec((t || "").replace(/\\s+/g, " ").trim());',
                    '  if (!m) { return null; }',
                    '  var n = parseInt(m[2], 10);',
                    '  return m[1] + "-" + (n < 10 ? "0" + n : String(n));',
                    '}',
                    'var rows = document.querySelectorAll("#rtvLabors div.rtTop, #rtvLabors div.rtMid, #rtvLabors div.rtBot");',
                    'var off = 0, on = 0;',
                    'for (var i = 0; i < rows.length; i++) {',
                    '  var lbl = rows[i].querySelector("span.rtIn");',
                    '  var code = lbl ? codeOf(lbl.textContent) : null;',
                    '  if (!code) { continue; }',
                    '  var checked = rows[i].querySelector("span.rtChecked");',
                    '  var unchecked = rows[i].querySelector("span.rtUnchecked");',
                    '  var wanted = WANT.indexOf(code) >= 0;',
                    '  if (wanted && unchecked) { unchecked.click(); on++; }',
                    '  else if (!wanted && checked) { checked.click(); off++; }',
                    '}',
                    'console.log("   ticked " + on + ", unticked " + off);',
                    'var b = document.querySelector(".btnTreeDropItems");',
                    'console.log("   drop button visible: " + !!(b && b.offsetParent !== null));',
                    'if (b) {',
                    '  ["mousedown", "mouseup", "click"].forEach(function (t) {',
                    '    b.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));',
                    '  });',
                    '}'
                ].join('\n'));
                let now = was;
                for (let i = 0; i < 60; i++) {
                    await wait(400);
                    if (!pmPopup()) break;
                    now = selCount();
                    if (now >= was + want.length) break;
                }
                console.log('   pass ' + (p + 1) + '/' + passes + ': ' + want.length
                    + ' ticked, staged ' + was + ' → ' + now);
                if (now <= was) {
                    // The drop moved nothing. Before giving up, say what the picker
                    // actually looked like at that moment - whether the ticks took,
                    // whether the button was there, and what is already staged -
                    // because "staged nothing" on its own does not say why.
                    let checked = 0;
                    nodes.forEach(n => { try { if (n.get_checked()) checked++; } catch (e) { } });
                    let btn = null, vis = false;
                    try {
                        btn = W.document.querySelector('.btnTreeDropItems');
                        vis = !!(btn && btn.offsetParent !== null);
                    } catch (e) { }
                    let staged = [];
                    try {
                        staged = Array.from(W.document.querySelectorAll(
                            '#rdgResources tr.rgRow td span, #rdgResources tr.rgAltRow td span'))
                            .map(x => (x.textContent || '').replace(/\s+/g, ' ').trim());
                    } catch (e) { }
                    console.error('   nothing moved on pass ' + (p + 1) + '. Diagnosis:');
                    console.error('      nodes reporting checked: ' + checked + ' (wanted ' + want.length + ')');
                    console.error('      btnTreeDropItems present=' + !!btn + ' visible=' + vis);
                    console.error('      wanted this pass: ' + want.join(', '));
                    console.error('      already staged (' + staged.length + '): ' + staged.join(' | '));
                    console.error('      => if the ticks took and the button is there, the picker is');
                    console.error('         refusing a resource it already holds, and repeats need');
                    console.error('         another route.');
                    return { ok: false, stage: 'picker', reason: 'pass ' + (p + 1) + ' staged nothing' };
                }
            }

            pmInjectInto(W, 'var tb=$find("TreeToolbar");if(tb){tb.get_items().forEach(function(it){'
                + 'if(it.get_commandName&&it.get_commandName()==="SaveExit"){it.click();}});}');
            for (let i = 0; i < 30; i++) { await wait(400); if (!pmPopup()) break; }
            const still = pmPopup();
            if (still) {
                pmInjectInto(still, 'var tb=$find("mainToolBar");if(tb){tb.get_items().forEach(function(it){'
                    + 'if(it.get_commandName&&it.get_commandName()==="SaveAndExit"){it.click();}});}');
            }
            const wantTotal = beforeLines.length + toCreate;

            // Adding rows re-renders the grid, so the fit is checked again here.
            // Only a widening that genuinely fails stops the run: filling the rows
            // on screen and leaving the rest blank would be worse than saying so,
            // because afterwards nothing would show which rows were missed.
            const psNow = await pmFitPageSize(wantTotal);
            if (psNow && wantTotal > psNow) {
                console.error('   page size is ' + psNow + ' but this report needs ' + wantTotal
                    + ' rows, and it could not be widened.');
                console.error('   Set the grid page size to 250 by hand and run again - only the');
                console.error('   rows on screen can be filled.');
                return { ok: false, stage: 'post',
                         reason: 'page size ' + psNow + ' is smaller than ' + wantTotal + ' rows' };
            }

            let got = 0;
            for (let i = 0; i < 90; i++) { await wait(500); got = pmGridRows().length; if (got >= wantTotal) break; }
            console.log('   rows in the grid: ' + got + ' (wanted ' + wantTotal + ')');
            if (got < wantTotal) return { ok: false, stage: 'post', reason: 'only ' + got + ' of ' + wantTotal + ' rows arrived' };
        }

        // open every row in one postback
        pmInject('$find("' + PM_GRID + '").get_masterTableView().editAllItems();');
        let er = [];
        for (let i = 0; i < 120; i++) { await wait(250); er = pmEditRows(); if (er.length >= pmGridRows().length) break; }
        console.log('   rows open for editing: ' + er.length);
        if (!er.length) return { ok: false, stage: 'post', reason: 'editAllItems opened nothing' };

        // match rows to data by code, in order
        const queue = {};
        usable.forEach(r => { (queue[r.code] = queue[r.code] || []).push(r); });
        const hh = pmHeader();
        const lineCol = hh.indexOf('Line #');
        const plan = [];
        let skipped = 0;
        const unmatched = [];
        Array.from(er).forEach(tr => {
            const line = lineCol >= 0 && tr.cells[lineCol]
                ? (tr.cells[lineCol].textContent || '').replace(/\s+/g, ' ').trim() : '';
            if (mode === 'add' && line && before[line] !== undefined) { skipped++; return; }
            const inp = tr.querySelector('input[id$="_ddlResources_Input"]');
            const prefix = inp ? inp.id.replace(/ddlResources_Input$/, '') : null;
            const c = pmCode(inp ? inp.value : '');
            const r = (c && queue[c] && queue[c].length) ? queue[c].shift() : null;
            if (!prefix || !r) {
                unmatched.push((line ? 'line ' + line + ': ' : '')
                    + ((inp && inp.value) || '(no resource)'));
                return;
            }
            plan.push({ p: prefix, r: r });
        });
        const leftOver = Object.keys(queue).filter(k => queue[k].length);
        console.log('   matched ' + plan.length + ', left alone ' + skipped
            + ', no data ' + unmatched.length);
        if (leftOver.length) {
            console.warn('   ⚠️ data with no row: ' + leftOver.map(k => k + ' ×' + queue[k].length).join(', '));
        }
        if (unmatched.length) {
            // PMWeb seeds its own numbers into a row created from the picker - a
            // per-unit Hours of 1.73 turned up in a row from the 2026-09-27 run that
            // was created and never written to. So a row with no data is not visibly
            // empty; it carries a figure nobody entered. Naming them is the only way
            // they get found.
            console.warn('   ⚠️ ' + unmatched.length + ' row(s) in the grid had no data to put in them.');
            unmatched.forEach(u => console.warn('        ' + u));
            console.warn('        PMWeb fills a picked row in with its own numbers, so these are');
            console.warn('        NOT blank on screen. Delete them, or they read as real hours.');
        }

        window.__pmFillPlan = plan;
        pmInject([
            'var P = window.__pmFillPlan, bad = [];',
            'function T(id, v) { var e = document.getElementById(id); if (!e) { bad.push(id); return; }',
            '  e.value = v; e.dispatchEvent(new Event("input", { bubbles: true }));',
            '  e.dispatchEvent(new Event("change", { bubbles: true })); }',
            'function C(base, id, text) { var cs = document.getElementById(base + "_ClientState");',
            '  if (!cs) { bad.push(base); return; }',
            '  cs.value = JSON.stringify({ logEntries: [], value: id, text: text, enabled: true,',
            '    checkedIndices: [], checkedItemsTextOverflows: false });',
            '  var i = document.getElementById(base + "_Input"); if (i) { i.value = text; } }',
            'function K(id, on) { var e = document.getElementById(id); if (!e) { return; }',
            '  e.checked = !!on; e.dispatchEvent(new Event("change", { bubbles: true })); }',
            // Both pickers together, because the finish has to be dated against the
            // start. A night shift ending 5:00 AM finishes the NEXT day, and writing it
            // on the record's own date puts the finish before the start - which is what
            // made PMWeb's count nonsense on night rows.
            'var rolled = 0;',
            'function DD(bStart, bStop, s, e) {',
            '  if (!s && !e) { return; }',
            '  var ps = null, pe = null;',
            '  try { ps = $find(bStart); } catch (x) { }',
            '  try { pe = $find(bStop); } catch (x) { }',
            '  var d = null;',
            '  try { d = (ps && ps.get_selectedDate()) || (pe && pe.get_selectedDate()); } catch (x) { }',
            '  if (!d) { d = new Date(); }',
            '  var Y = d.getFullYear(), M = d.getMonth(), D0 = d.getDate();',
            '  if (!ps && s) { bad.push(bStart); }',
            '  if (!pe && e) { bad.push(bStop); }',
            '  if (ps && s) { ps.set_selectedDate(new Date(Y, M, D0, s[0], s[1], 0)); }',
            '  if (pe && e) {',
            '    var over = (s && (e[0] * 60 + e[1]) <= (s[0] * 60 + s[1])) ? 1 : 0;',
            '    if (over) { rolled++; }',
            '    pe.set_selectedDate(new Date(Y, M, D0 + over, e[0], e[1], 0));',
            '  }',
            '}',
            // The times go FIRST. PMWeb recalculates both Hours columns whenever a
            // time changes - Terry, 2026-09-27: "i just put one row into edit mode and
            // changed it to a time that isnt the next day and it changed the hours
            // automactically" - so setting the times after the hours, which is what
            // this used to do, threw away every figure it had just written.
            'for (var i = 0; i < P.length; i++) { var b = P[i].p, r = P[i].r;',
            '  DD(b + "tpStartTime", b + "tpFinishTime", r.start, r.stop);',
            '  T(b + "EditUserDefinedFields1_txtData", String(r.qty));',
            '  T(b + "txtHours", Number(r.each).toFixed(2));',
            '  T(b + "EditUserDefinedFields6_txtData", Number(r.total).toFixed(2));',
            '  T(b + "EditUserDefinedFields2_txtMemo", r.remarks || "");',
            '  K(b + "EditUserDefinedFields3_chkData", r.sub);',
            '  K(b + "EditUserDefinedFields4_chkData", r.specialist);',
            '  C(b + "ddlResourcePayTypes", r.payTypeId, r.payType);',
            '  C(b + "ddlResourceClasses", r.clsId, r.cls);',
            '  if (r.companyId) { C(b + "EditUserDefinedFields5_ddlData", r.companyId, r.company); }',
            '}',
            // Did PMWeb recompute over the top of us? Read both Hours fields back and
            // put the sheet's figures in again where it did. .value only, with no
            // change event: the postback reads .value, and firing change is what sets
            // the recalculation off.
            'var fought = 0;',
            'for (var i = 0; i < P.length; i++) { var b = P[i].p, r = P[i].r;',
            '  var wantPer = Number(r.each).toFixed(2), wantTot = Number(r.total).toFixed(2);',
            '  var per = document.getElementById(b + "txtHours");',
            '  var tot = document.getElementById(b + "EditUserDefinedFields6_txtData");',
            '  if (per && per.value !== wantPer) {',
            '    console.log("   PMWeb made the per-unit hours " + per.value + "; the sheet says "',
            '      + wantPer + " - putting it back"); per.value = wantPer; fought++; }',
            '  if (tot && tot.value !== wantTot) {',
            '    console.log("   PMWeb made the total hours " + tot.value + "; the sheet says "',
            '      + wantTot + " - putting it back"); tot.value = wantTot; fought++; }',
            '}',
            'if (fought) { console.log("   " + fought + " hours field(s) had to be written twice"',
            '  + " - PMWeb calculates them from the start and finish times"); }',
            'if (rolled) { console.log("   rolled the finish to the next day on " + rolled',
            '  + " row(s) that work past midnight"); }',
            'console.log("   filled " + P.length + " row(s)" + (bad.length ? ", missing: " + bad.length : ""));',
            '$find("' + PM_GRID + '").get_masterTableView().updateEditedItems();'
        ].join('\n'));

        for (let i = 0; i < 120; i++) {
            await wait(500);
            if (!pmEditRows().length && pmGridRows().length) break;
        }

        // Read it back. A commit that reports success and one that landed are not
        // the same thing, and an untouched row that changed is a silent loss.
        const hh3 = pmHeader();
        let blank = 0;
        Array.from(pmGridRows()).forEach(tr => {
            const q = pmCell(tr, 'Quantity', hh3);
            const pt = pmCell(tr, 'Pay Type', hh3);
            if (!q || q === '0' || !pt) blank++;
        });
        const changed = beforeLines.filter(l => {
            const tr = Array.from(pmGridRows()).find(t => pmCell(t, 'Line #', hh3) === l);
            const now = tr ? ['Resource', 'Quantity', 'Hours', 'Pay Type', 'Classification', 'Company', 'Remarks']
                .map(n => pmCell(tr, n, hh3)).join(' | ') : '(GONE)';
            return now !== before[l];
        });
        console.log('   grid now holds ' + pmGridRows().length + ' row(s); '
            + blank + ' missing a quantity or pay type');
        if (mode === 'add' && changed.length) {
            console.error('   ❌ ' + changed.length + ' row(s) that were already there have CHANGED');
            changed.slice(0, 8).forEach(l => console.error('      line ' + l + ' was: ' + before[l]));
        }
        return {
            stage: 'done',
            ok: blank === 0 && (mode !== 'add' || changed.length === 0),
            filled: plan.length, blank: blank, changed: changed.length,
            total: pmGridRows().length
        };
    }

    // Orchestrates all 5 phases in sequence
    // ============================================

    window.addEventListener('PMWEB_FILL_EVERYTHING', async (event) => {
        await runAndReport(event.detail, 1);
    });

    // A run that ends early - stopped, or the Main tab would not save - used to
    // return without a word, so its queue entry sat at "running" for good. Its
    // result is announced here instead, in the same shape as a finished run's.
    // A run that pauses for a page reload is not over, so it says nothing.
    let pmRunReported = false;
    let pmRunEndNote = '';
    async function runAndReport(data, startPhase) {
        pmRunReported = false;
        pmRunEndNote = '';
        await runFullAutoFill(data, startPhase);
        if (pmRunReported || pmRunEndNote === 'reloading') return;
        const why = pmRunEndNote
            || (shouldStop ? 'was stopped before the end' : 'ended early - the console says where');
        try {
            window.dispatchEvent(new CustomEvent('PMWEB_RUN_RESULT', {
                detail: {
                    reportId: data.reportId || null,
                    reportDate: data.reportDate || '',
                    recordCode: data.recordCode || '',
                    problems: ['the run ' + why],
                    finishedAt: Date.now()
                }
            }));
        } catch (e) { /* the run is over regardless */ }
    }

    // Picks the run back up when a Save turned out to be a full page postback:
    // the page reloads, content.js injects this script again, and the run
    // continues from the phase recorded before the click.
    async function maybeResumeAfterReload() {
        const pending = loadResumeState();
        if (!pending) return;

        // Only ever resume on a daily report. A save PMWeb rejects server-side
        // sends the browser to /PMWeb/ErrorPage.aspx, and the run used to pick
        // itself up there and hunt for a tab strip that does not exist - and with
        // the dialogs silenced it answered its own resume prompt "yes" and carried
        // on regardless. The saved state is kept rather than cleared, so opening
        // the record again resumes properly.
        if (location.pathname.indexOf('DailyReports.aspx') < 0) {
            console.warn('An interrupted run is waiting at phase ' + pending.phase
                + ', but this is ' + location.pathname + ' - not resuming here.');
            if (location.pathname.indexOf('ErrorPage') >= 0) {
                console.warn('   PMWeb rejected the save. Open the report again from the '
                    + 'Daily Reports list and the run will pick up where it left off.');
            }
            return;
        }

        await bgWait(2500); // let PMWeb finish wiring up its controls
        console.log(`↻ Found an interrupted run — offering to resume at phase ${pending.phase}`);

        const go = pmConfirm(
            'PMWeb Auto-Fill\n\n' +
            'The Main tab saved and the page reloaded.\n\n' +
            `Resume the run at Phase ${pending.phase} of 5?`
        );
        if (!go) { console.log('↻ Resume declined'); return; }

        await runAndReport(pending.data, pending.phase);
    }

    if (document.readyState === 'complete') {
        maybeResumeAfterReload();
    } else {
        window.addEventListener('load', maybeResumeAfterReload);
    }

    // Every visible RadWindow's inner window, so a popup can be found by what is
    // inside it rather than by an id nobody has read off a live page.
    function pmPopupWindows() {
        const out = [];
        try {
            const wm = $find('ctl00_PMWindowManager');
            for (const w of (wm ? wm.get_windows() : [])) {
                if (!(w.isVisible && w.isVisible())) continue;
                const f = w.get_contentFrame();
                if (f && f.contentWindow && f.contentDocument) out.push(f.contentWindow);
            }
        } catch (e) { }
        return out;
    }

    // Wherever the note editor is: the popup that holds a RadEditor, or the page
    // itself if PMWeb puts the editor inline.
    function pmNoteTarget() {
        const has = (d) => {
            try { return !!d.querySelector('.RadEditor, iframe.reContentIframe, .reContentArea'); }
            catch (e) { return false; }
        };
        for (const W of pmPopupWindows()) { if (has(W.document)) return W; }
        return has(document) ? window : null;
    }

    // What the note editor is actually made of. Printed only when the note could
    // not be written, so the next run can address the editor directly instead of
    // guessing at it again.
    function pmDumpNoteEditor(W) {
        const say = (t) => console.log('      ' + t);
        console.log('   -- note editor structure --');
        try { say('url: ' + W.location.href); } catch (e) { say('url: unreadable'); }
        try {
            const comps = (W.Sys && W.Sys.Application) ? W.Sys.Application.getComponents() : [];
            const idOf = (c) => { try { return c.get_id ? c.get_id() : '?'; } catch (e) { return '?'; } };
            say('components: ' + comps.length);
            say('with set_html: ' + (comps.filter(c => c && typeof c.set_html === 'function')
                .map(idOf).join(', ') || 'none'));
            comps.filter(c => c && typeof c.get_items === 'function').forEach(tb => {
                const names = [];
                try {
                    const items = tb.get_items();
                    for (let i = 0; i < items.get_count(); i++) {
                        const it = items.getItem(i);
                        names.push((it.get_commandName && it.get_commandName())
                            || (it.get_text && it.get_text()) || '?');
                    }
                } catch (e) { }
                if (names.length) say('toolbar ' + idOf(tb) + ': ' + names.join(', '));
            });
        } catch (e) { say('components: ' + e.message); }
        ['iframe', 'textarea', 'input[type=text]', '[contenteditable=true]', '.RadEditor'].forEach(sel => {
            let list = [];
            try { list = Array.from(W.document.querySelectorAll(sel)); } catch (e) { }
            say(sel + ' (' + list.length + '): '
                + list.map(e => e.id || e.className || e.tagName).join(' ~ '));
        });
        console.log('   -- end --');
    }

    // The Notes tab, written straight into the editor.
    //
    // Until now the note went in by hand: the HTML was put on the clipboard and
    // an alert asked for Ctrl+V, Yes to the Word-cleanup prompt, then Save &
    // Exit. In an unattended run that alert is silenced, so the note was simply
    // never written - Terry, 2026-09-27: "it just to the next tab then didnt
    // touch the notes tab". RadEditor holds its content in its own client
    // component, so set_html() puts the note in with no paste and no prompt.
    //
    // Nothing here is addressed by a fixed id, because none of it has been read
    // off a live page: the popup, the editor and Save & Exit are each found by
    // what they are. If any cannot be found, the structure is dumped and the
    // clipboard copy is left in place - the run falls back to the manual paste
    // rather than losing the note.
    async function fillNote(html) {
        const wait = bgWait;
        if (!html) return { ok: false, reason: 'the payload carries no note HTML' };

        try {
            const blob = new Blob([html], { type: 'text/html' });
            await navigator.clipboard.write([new ClipboardItem({ 'text/html': blob })]);
            console.log('   note HTML is also on the clipboard, as the fallback');
        } catch (e) {
            console.warn('   clipboard copy failed (not fatal): ' + e.message);
        }

        let W = pmNoteTarget();
        if (!W) {
            const add = document.querySelector('div.btnAddNote');
            if (!add) return { ok: false, reason: 'the Add Note button (div.btnAddNote) is not on the page' };
            fireMouseClick(add);
            console.log('   clicked Add Note');
            for (let i = 0; i < 48 && !W; i++) { await wait(250); W = pmNoteTarget(); }
        }
        if (!W) return { ok: false, reason: 'the note editor never appeared' };
        const inPopup = (W !== window);
        console.log('   editor found ' + (inPopup ? 'in a popup' : 'on the page itself'));

        // Wait for the editor to finish wiring up, or set_html lands nowhere.
        let ready = false;
        for (let i = 0; i < 40 && !ready; i++) {
            try {
                ready = !!(W.Sys && W.Sys.Application && W.Sys.Application.getComponents()
                    .some(c => c && typeof c.set_html === 'function'));
            } catch (e) { }
            if (!ready) await wait(250);
        }
        console.log('   editor component ' + (ready ? 'ready' : 'not found - trying the content iframe'));

        W.__pmNoteHtml = html;
        pmInjectInto(W, [
            'var H = window.__pmNoteHtml, done = "";',
            'try { Sys.Application.getComponents().forEach(function (c) {',
            '  if (done || !c || typeof c.set_html !== "function") { return; }',
            '  c.set_html(H);',
            '  if (typeof c.saveHtml === "function") { c.saveHtml(); }',
            '  if (typeof c.saveContent === "function") { c.saveContent(); }',
            '  done = "component " + (c.get_id ? c.get_id() : "?");',
            '}); } catch (e) { console.log("   component route failed: " + e.message); }',
            'if (!done) {',
            '  var f = document.querySelector("iframe.reContentIframe, .reContentArea iframe");',
            '  if (f && f.contentDocument && f.contentDocument.body) {',
            '    f.contentDocument.body.innerHTML = H; done = "the content iframe"; }',
            '  var ta = document.querySelector("textarea.reTextArea, textarea[id$=\\"_TextArea\\"]");',
            '  if (ta) { ta.value = H; }',
            '}',
            'console.log("   note written through " + (done || "NOTHING"));'
        ].join('\n'));
        await wait(1200);

        // Did it land? The editor is asked what it now holds.
        let got = '';
        try {
            const c = W.Sys.Application.getComponents().filter(x => x && typeof x.get_html === 'function')[0];
            if (c) got = String(c.get_html() || '');
        } catch (e) { }
        if (!got) {
            try {
                const f = W.document.querySelector('iframe.reContentIframe, .reContentArea iframe');
                if (f && f.contentDocument && f.contentDocument.body) got = f.contentDocument.body.innerHTML || '';
            } catch (e) { }
        }
        console.log('   the editor now holds ' + got.length + ' character(s) (the note is ' + html.length + ')');
        if (got.length < 20) {
            pmDumpNoteEditor(W);
            return { ok: false, reason: 'the note did not land in the editor' };
        }

        // Save & Exit - the same shape as the resource picker, so the command is
        // looked for rather than a button id.
        pmInjectInto(W, [
            'var hit = "";',
            'try { Sys.Application.getComponents().forEach(function (tb) {',
            '  if (hit || !tb || typeof tb.get_items !== "function") { return; }',
            '  var items = null; try { items = tb.get_items(); } catch (e) { return; }',
            '  if (!items || !items.get_count) { return; }',
            '  for (var i = 0; i < items.get_count(); i++) {',
            '    var it = items.getItem(i);',
            '    var n = (it.get_commandName && it.get_commandName()) || "";',
            '    var t = (it.get_toolTip && it.get_toolTip()) || (it.get_text && it.get_text()) || "";',
            '    if (/SaveAndExit|SaveExit/i.test(n) || /save\\s*&\\s*exit/i.test(t)) {',
            '      it.click(); hit = n || t; break; }',
            '  }',
            '}); } catch (e) { console.log("   save route failed: " + e.message); }',
            'if (!hit) {',
            '  var b = document.querySelector("[title=\\"Save & Exit\\"]")',
            '    || document.querySelector("span.rtbIcon[title*=\\"Save\\"]");',
            '  if (b) { ["mousedown", "mouseup", "click"].forEach(function (t) {',
            '    b.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); });',
            '    hit = "the Save & Exit icon"; }',
            '}',
            'console.log("   saved through " + (hit || "NOTHING"));'
        ].join('\n'));

        if (!inPopup) {
            await wait(2500);
            console.log('   note written and saved (inline editor - check the Notes grid by eye)');
            return { ok: true };
        }
        for (let i = 0; i < 40; i++) { await wait(400); if (!pmNoteTarget()) break; }
        if (pmNoteTarget()) {
            pmDumpNoteEditor(W);
            return { ok: false, reason: 'the note was written but the editor would not save and close' };
        }
        console.log('   note saved and the editor closed');
        return { ok: true };
    }
    async function runFullAutoFill(data, startPhase = 1) {
        shouldStop = false;
        console.log(`🚀 FULL AUTO-FILL: Starting 5-phase automation (from phase ${startPhase})`);
        console.log('📋 Payload:', JSON.stringify(data, null, 2).substring(0, 500));
        showStopButton();
        const wait = bgWait;

        // What did not go in. The run used to print ALL 5 PHASES COMPLETE whatever
        // happened, so a report with 54 empty resource rows and an empty Notes tab
        // looked finished - Terry, 2026-09-27: "the resources were all added but
        // none of the other data went in".
        const problems = [];

        // Tab navigation helper — polls for the tab strip (it is re-rendered by
        // every postback) and waits out the postback the switch kicks off.
        async function clickTab(tabName) {
            let target = null;
            for (let attempt = 0; attempt < 20; attempt++) {
                const tabs = document.querySelectorAll('#ctl00_CPH1_tbsDocument .rtsUL .rtsLI a.rtsLink');
                for (const tab of tabs) {
                    if (tab.textContent.trim() === tabName) { target = tab; break; }
                }
                if (target && isVisible(target)) break;
                if (attempt === 0) console.log(`  ⏳ Waiting for tab strip to render "${tabName}"...`);
                await wait(500);
            }

            if (!target) {
                console.error(`❌ Tab not found: "${tabName}"`);
                return false;
            }

            const result = await runAndAwaitActivity(() => fireMouseClick(target));
            console.log(`📑 Clicked tab: "${tabName}" (page reacted: ${result})`);
            return true;
        }

        // Helper: set a plain text input and fire change/blur
        function setTextInput(id, value) {
            const el = document.getElementById(id);
            if (!el) { console.warn(`⚠️ Input not found: ${id}`); return false; }
            el.focus();
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
            console.log(`  ✅ Set ${id} = "${value}"`);
            return true;
        }

        // Helper: set Telerik RadComboBox by typing + selecting
        async function setComboBox(inputId, value) {
            const input = document.getElementById(inputId);
            if (!input) { console.warn(`⚠️ ComboBox input not found: ${inputId}`); return false; }

            const baseId = inputId.replace('_Input', '');
            const idDollar = baseId.replace(/_/g, '$');
            let combo = null;
            if (typeof $find === 'function') combo = $find(baseId) || $find(idDollar);
            if (!combo && typeof Sys !== 'undefined' && Sys.Application) {
                combo = Sys.Application.findComponent(baseId) || Sys.Application.findComponent(idDollar);
            }

            if (!combo) {
                // Fallback: just set the text directly
                input.focus();
                input.value = value;
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('blur', { bubbles: true }));
                console.log(`  ✅ ComboBox fallback: ${inputId} = "${value}"`);
                return true;
            }

            try {
                input.focus();
                await wait(50);

                // Set value directly
                input.value = value;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                await wait(300);

                // Try to find matching item
                if (combo.showDropDown) combo.showDropDown();
                await wait(200);

                let item = combo.findItemByText(value);
                if (!item) {
                    // Fuzzy search
                    const items = combo.get_items();
                    const valLower = value.toLowerCase();
                    for (let i = 0; items && i < items.get_count(); i++) {
                        if (items.getItem(i).get_text().toLowerCase().includes(valLower)) {
                            item = items.getItem(i);
                            break;
                        }
                    }
                }

                if (item) {
                    item.select();
                    if (combo.set_selectedIndex) combo.set_selectedIndex(item.get_index());
                }

                await wait(100);
                if (combo.hideDropDown) combo.hideDropDown();
                if (combo.commitChanges) combo.commitChanges();
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('blur', { bubbles: true }));

                console.log(`  ✅ ComboBox: ${inputId} = "${value}"`);
                return true;
            } catch (e) {
                console.error(`  ❌ ComboBox error: ${inputId}`, e);
                if (combo && combo.hideDropDown) combo.hideDropDown();
                return false;
            }
        }

        // Helper: set Telerik DatePicker
        function setDatePicker(inputId, dateStr) {
            // dateStr format: "2026-07-20"
            const input = document.getElementById(inputId);
            if (!input) { console.warn(`⚠️ DatePicker not found: ${inputId}`); return false; }

            // Format to MM-DD-YYYY for the visible input
            try {
                const parts = dateStr.split('-');
                const formatted = `${parts[1]}-${parts[2]}-${parts[0]}`;
                input.focus();
                input.value = formatted;
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('blur', { bubbles: true }));
                console.log(`  ✅ DatePicker: ${inputId} = "${formatted}"`);

                // Also try setting via Telerik API
                const baseId = inputId.replace('_dateInput', '');
                if (typeof Sys !== 'undefined' && Sys.Application) {
                    const picker = Sys.Application.findComponent(baseId);
                    if (picker && picker.set_selectedDate) {
                        picker.set_selectedDate(new Date(dateStr + 'T12:00:00'));
                    }
                }
                return true;
            } catch (e) {
                console.error('DatePicker error:', e);
                return false;
            }
        }

        try {
            // Suppress PMWeb's "You have unsaved changes" confirm dialogs
            // Because we inject into the MAIN world, this directly overrides the page's confirm method
            const originalConfirm = window.confirm;
            window.confirm = () => true;
            window.onbeforeunload = null;

            // ═══════════════════════════════════════
            // PHASE 1: MAIN TAB FIELDS
            // ═══════════════════════════════════════
            if (startPhase > 1) {
                console.log('⏭️ Skipping Phase 1 — the Main tab was saved before the reload');
            } else {
                console.log('━━━ PHASE 1/5: Main Tab Fields ━━━');
                pmProgress(1, 'Main tab');

                // Ensure we're on the Main tab
                await clickTab('Main');
                await wait(500);

                // 1. Report Date
                setDatePicker('ctl00_CPH1_dtpReportDate_dateInput', data.reportDate);
                await wait(200);

                // 2. Record #
                setTextInput('ctl00_CPH1_txtCode', data.recordCode);

                // 3. Location
                setTextInput('ctl00_CPH1_txtDescription', data.location);

                // 4. Weather Conditions (comma-separated string like "Sunny,Partly Cloudy")
                await setComboBox('ctl00_CPH1_ddlConditions_Input', data.weatherConditions);

                // 5. Temperature (average)
                if (data.temperature) {
                    setTextInput('ctl00_CPH1_txtTemperature', data.temperature);
                }

                // 6. Precip Amount
                setTextInput('ctl00_CPH1_txtPrecip', data.precipAmount);

                // 7 and 8. Start and End Time. Both boxes are class="Integer" -
                // military digits, no colon: 630 and 1800. Terry, 2026-09-27:
                // "these two time slots are supposedto be in military time, only
                // these thought". A colon in there does not fail loudly, it just
                // does not save, so a value that is not digits is refused and
                // said out loud instead of typed.
                [
                    ['start', data.startTimeMilitary, 'ctl00'],
                    ['end', data.endTimeMilitary, 'ctl01']
                ].forEach(([which, raw, ctl]) => {
                    const v = String(raw || '').trim();
                    const id = 'ctl00_CPH1_DocumentSpecificationsHeader1_'
                        + 'rptHeaderSpecification_' + ctl + '_txtMeasure';
                    if (!v) {
                        console.warn('  ⚠️ ' + which + ' time: the report does not say - left alone');
                        return;
                    }
                    if (!/^[0-9]{1,4}$/.test(v)) {
                        console.error('  ❌ ' + which + ' time "' + v + '" is not military digits'
                            + ' - NOT typed, that box would not save');
                        problems.push('the ' + which + ' time arrived as "' + v
                            + '" instead of military digits, so it was left blank');
                        return;
                    }
                    setTextInput(id, v);
                });

                // 9. Shift
                await setComboBox(
                    'ctl00_CPH1_DocumentSpecificationsHeader1_rptHeaderSpecification_ctl02_ddlMeasure_Input',
                    data.shiftValue
                );

                // 10. SAVE Main Tab — this has to land before we leave the page,
                // or every field typed above is discarded when the tab switches.
                const saveStatus = await saveMainTab(data);

                if (saveStatus === 'reloading') {
                    // The page is on its way out. Stop quietly; the freshly injected
                    // copy resumes at Phase 2 once the reload finishes.
                    console.log('⏸️ Pausing — the page is reloading, the run continues after it');
                    pmRunEndNote = 'reloading';
                    pmProgress(1, 'Main tab saved, the page is reloading - the run carries on after it');
                    hideStopButton();
                    return;
                }

                if (saveStatus !== 'saved') {
                    pmRunEndNote = 'stopped after the Main tab: the page Save did not go through, '
                        + 'so nothing was committed. The fields are still filled in on screen - '
                        + 'press Save, then run Auto-Fill Everything again';
                    hideStopButton();
                    pmAlert(
                        '⚠️ Auto-fill stopped after the Main tab.\n\n' +
                        'The page-level Save (Alt+s) did not go through, so nothing was committed ' +
                        'and the remaining tabs were skipped rather than losing your data.\n\n' +
                        'The fields are still filled in on screen — press Save yourself, then re-run ' +
                        'Auto-Fill Everything to continue. See the console for which step failed.'
                    );
                    return;
                }
            
                if (shouldStop) { hideStopButton(); return; }
                console.log('✅ PHASE 1 COMPLETE');
            }

            // ═══════════════════════════════════════
            // PHASE 2: ACTIVITIES (On Site tab)
            // ═══════════════════════════════════════
            console.log('━━━ PHASE 2/5: Activities ━━━');
            pmProgress(2, 'Activities (On Site)');

            if (data.activities && data.activities.length > 0) {
                await clickTab('On Site');
                await wait(1500); // Wait for tab to load

                // Reuse existing fillAllActivities
                await fillAllActivities(data.activities);

                // Click Update Records after all activities
                const actUpdateBtn = document.getElementById(
                    'ctl00_CPH1_DailyReportDetails_rdgOnSite_ctl00_ctl02_ctl00_lblUpdateRecords'
                );
                if (actUpdateBtn) {
                    actUpdateBtn.click();
                    if (actUpdateBtn.parentElement && actUpdateBtn.parentElement.tagName === 'A') {
                        actUpdateBtn.parentElement.click();
                    }
                    console.log('💾 Activities Update Records clicked');
                    await wait(2000);
                }
            } else {
                console.log('ℹ️ No activities to fill, skipping Phase 2');
            }

            if (shouldStop) { hideStopButton(); return; }
            console.log('✅ PHASE 2 COMPLETE');

            // ═══════════════════════════════════════
            // PHASE 3: LABOR & EQUIPMENT
            // ═══════════════════════════════════════
            console.log('━━━ PHASE 3/5: Labor & Equipment ━━━');
            pmProgress(3, 'Labor and Equipment');

            if (data.resources && data.resources.length > 0) {
                await clickTab('Labor and Equipment');
                await wait(1500);

                // The picker route - roughly a dozen postbacks for a whole
                // report instead of about four per row. data.resourceMode is
                // 'add' (leave what is there and add beside it) or 'fill'
                // (write into the rows already there, create only the shortfall).
                const resMode = data.resourceMode || 'add';
                let fast = null;
                try {
                    fast = await fillResourcesFast(data.resources, resMode);
                } catch (e) {
                    console.error('⚠️ Fast Labor & Equipment threw: ' + e.message);
                    fast = { ok: false, stage: 'pre', reason: e.message };
                }

                if (fast && fast.ok) {
                    console.log('✅ Fast fill: ' + fast.filled + ' row(s) filled, '
                        + fast.total + ' in the grid');
                } else if (fast && fast.stage === 'pre') {
                    // Nothing was created, so the old filler can safely take over.
                    console.warn('⚠️ Falling back to the row-at-a-time filler - ' + fast.reason);
                    await fillAllRows(data.resources);
                    const tsUpdateBtn = document.getElementById(
                        'ctl00_CPH1_DailyReportTimeSheet1_rdgDailyReportTimesheet_ctl00_ctl02_ctl00_lblUpdateRecords'
                    );
                    if (tsUpdateBtn) {
                        // One click. The old code clicked the span and then its
                        // parent anchor, firing the same postback twice.
                        tsUpdateBtn.click();
                        console.log('💾 Timesheet Update Records clicked');
                        await wait(2000);
                    }
                } else if (fast && fast.stage === 'picker') {
                    console.error('❌ Stopped inside the resource picker: ' + fast.reason);
                    console.error('   NOTHING was committed - the picker was never saved, so the');
                    console.error('   grid is untouched. Close the picker with Cancel.');
                    problems.push('Labor & Equipment: ' + fast.reason
                        + ' (nothing committed, close the picker with Cancel)');
                } else {
                    // Rows were already created. Running the old filler now would
                    // add a second set on top, so it stops and says what to look at.
                    console.error('❌ Labor & Equipment did not finish cleanly: '
                        + (fast ? fast.reason || ('blank ' + fast.blank + ', changed ' + fast.changed) : 'unknown'));
                    console.error('   Rows have already been created - check the grid by eye '
                        + 'before running anything else on this report.');
                    problems.push('Labor & Equipment: '
                        + (fast ? fast.reason || 'did not finish' : 'unknown')
                        + ' (rows exist, so do not re-run Phase 3 on this report)');
                }
            } else {
                console.log('ℹ️ No resources to fill, skipping Phase 3');
            }

            if (shouldStop) { hideStopButton(); return; }
            console.log('✅ PHASE 3 COMPLETE');

            // ═══════════════════════════════════════
            // PHASE 4: ADDITIONAL INFORMATION
            // ═══════════════════════════════════════
            console.log('━━━ PHASE 4/5: Additional Information ━━━');
            pmProgress(4, 'Additional Information');

            await clickTab('Additional Information');
            await wait(1500);

            await setComboBox(
                'ctl00_CPH1_DocumentSpecifications1_rdgSpecifications_ctl00_ctl05_ddlMeasure_Input',
                data.dayTypeValue
            );
            await wait(500);

            // Click Update Records (using exact A tag ID from user)
            const addInfoUpdateBtn = document.getElementById(
                'ctl00_CPH1_DocumentSpecifications1_rdgSpecifications_ctl00_ctl02_ctl00_btnUpdateEdited'
            ) || document.getElementById(
                'ctl00_CPH1_DocumentSpecifications1_rdgSpecifications_ctl00_ctl02_ctl00_Label1'
            );
            
            if (addInfoUpdateBtn) {
                addInfoUpdateBtn.click();
                if (addInfoUpdateBtn.tagName !== 'A' && addInfoUpdateBtn.parentElement && addInfoUpdateBtn.parentElement.tagName === 'A') {
                    addInfoUpdateBtn.parentElement.click();
                }
                console.log('💾 Additional Info Update Records clicked');
                await wait(2000);
            }

            if (shouldStop) { hideStopButton(); return; }
            console.log('✅ PHASE 4 COMPLETE');

            // ═══════════════════════════════════════
            // PHASE 5: NOTES
            // ═══════════════════════════════════════
            console.log('━━━ PHASE 5/5: Notes ━━━');
            pmProgress(5, 'Notes');

            await clickTab('Notes');
            await wait(1500);

            const note = await fillNote(data.notesHtml);
            if (note.ok) {
                console.log('✅ PHASE 5 COMPLETE');
            } else {
                console.error('❌ Notes: ' + note.reason);
                console.error('   The note HTML is on the clipboard, so it can still go in by hand: '
                    + 'Add Note, click in the editor, Ctrl+V, Yes to the cleanup prompt, Save & Exit.');
                problems.push('the note was not written - ' + note.reason);
            }

        } catch (err) {
            console.error('🚨 FULL AUTO-FILL ERROR:', err);
            problems.push('the run threw: ' + err.message);
            pmAlert(`Auto-fill error: ${err.message}`);
        }

        clearResumeState();
        hideStopButton();

        // Tell the queue how it went. content.js picks this up and writes it to
        // storage; the popup reads it the next time it opens, and the side panel
        // hears it straight away.
        pmRunReported = true;
        try {
            window.dispatchEvent(new CustomEvent('PMWEB_RUN_RESULT', {
                detail: {
                    reportId: data.reportId || null,
                    reportDate: data.reportDate || '',
                    recordCode: data.recordCode || '',
                    problems: problems.slice(),
                    finishedAt: Date.now()
                }
            }));
        } catch (e) { /* the run still finished */ }

        if (problems.length) {
            console.warn('⚠️ FINISHED, BUT ' + problems.length + ' THING(S) DID NOT GO IN:');
            problems.forEach(p => console.warn('   - ' + p));
            pmAlert('⚠️ Auto-fill finished, but ' + problems.length + ' thing(s) did not go in:\n\n'
                + problems.map(p => '- ' + p).join('\n')
                + '\n\nThe console has the detail.');
        } else {
            console.log('🎉🎉🎉 ALL 5 PHASES COMPLETE! 🎉🎉🎉');
        }
    }

})();
