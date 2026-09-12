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
    window.addEventListener('PMWEB_FILL_TRIGGER', async (event) => {
        shouldStop = false; // Reset stop flag
        const rows = event.detail;
        console.log('📥 Worker received', rows.length, 'rows');
        await fillAllRows(rows);
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
        const userInput = prompt(`Resume from a specific row?\n\nTotal rows: ${appRows.length}\n\nEnter row number to start from (1-${appRows.length}), or press Cancel/enter 0 to start from beginning:`, '1');

        if (userInput !== null && userInput.trim() !== '') {
            const rowNum = parseInt(userInput, 10);
            if (rowNum >= 1 && rowNum <= appRows.length) {
                startIndex = rowNum - 1; // Convert to 0-based index
                console.log(`▶️ Resuming from row ${rowNum} (${appRows.length - startIndex} rows remaining)`);
            } else if (rowNum === 0) {
                console.log(`▶️ Starting from the beginning (${appRows.length} rows)`);
            } else {
                alert(`Invalid row number. Starting from beginning.`);
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
        alert('✅ Data Entry Complete!');
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

        // Calculate hours based on start/stop time difference WITH lunch deduction
        if (startMinutes !== null && finishMinutes !== null) {
            let rawMinutes = finishMinutes - startMinutes;
            if (rawMinutes < 0) rawMinutes += 1440; // Crosses midnight (night shift)
            const rawHours = rawMinutes / 60;
            // Subtract lunch (0.5 hrs) if the duration is 6 hours or more
            const calcHours = rawHours >= 6 ? rawHours - 0.5 : rawHours;
            
            const qty = parseFloat(data.quantity) || 0;
            const totalHours = qty * calcHours;

            // 1st hours column (UDF6) = Total Hours (qty * per-person hours)
            setText("EditUserDefinedFields6_txtData", totalHours.toFixed(2));
            console.log(`  ⏰ 1st Hours Col (UDF6) -> Total: ${totalHours.toFixed(2)} (Qty ${qty} * ${calcHours.toFixed(2)})`);

            // 2nd hours column (txtHours) = Per-Person Hours
            setText("txtHours", calcHours.toFixed(2));
            console.log(`  ⏰ 2nd Hours Col (txtHours) -> Per-Person: ${calcHours.toFixed(2)} (${rawHours} raw)`);
        } else {
            // Fallback if times are missing
            const qty = parseFloat(data.quantity) || 0;
            const totalHours = parseFloat(data.hours) || 0;
            const perPerson = qty > 0 ? totalHours / qty : 0;
            setText("EditUserDefinedFields6_txtData", totalHours.toFixed(2));
            setText("txtHours", perPerson.toFixed(2));
            console.log(`  ⏰ Hours (Fallback): 1st Col = ${totalHours.toFixed(2)}, 2nd Col = ${perPerson.toFixed(2)}`);
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
        const userInput = prompt(
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
                alert('Invalid number. Starting from beginning.');
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
        alert('✅ Activities Data Entry Complete!');
    }

    async function fillSingleActivity(BASE, data, company, rowNum) {
        console.log('=== ACTIVITY ' + rowNum + ': ' + data.title + ' ===');
        console.log('  📋 Data:', JSON.stringify(data, null, 2));
        const wait = bgWait;

        // --- Location (text input) ---
        const locInput = document.getElementById(BASE + 'txtLocation');
        if (locInput) {
            locInput.focus();
            locInput.value = data.location || '';
            locInput.dispatchEvent(new Event('change', { bubbles: true }));
            locInput.dispatchEvent(new Event('blur', { bubbles: true }));
            console.log('  ✅ Location: ' + data.location);
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
    // Orchestrates all 5 phases in sequence
    // ============================================

    window.addEventListener('PMWEB_FILL_EVERYTHING', async (event) => {
        await runFullAutoFill(event.detail, 1);
    });

    // Picks the run back up when a Save turned out to be a full page postback:
    // the page reloads, content.js injects this script again, and the run
    // continues from the phase recorded before the click.
    async function maybeResumeAfterReload() {
        const pending = loadResumeState();
        if (!pending) return;

        await bgWait(2500); // let PMWeb finish wiring up its controls
        console.log(`↻ Found an interrupted run — offering to resume at phase ${pending.phase}`);

        const go = window.confirm(
            'PMWeb Auto-Fill\n\n' +
            'The Main tab saved and the page reloaded.\n\n' +
            `Resume the run at Phase ${pending.phase} of 5?`
        );
        if (!go) { console.log('↻ Resume declined'); return; }

        await runFullAutoFill(pending.data, pending.phase);
    }

    if (document.readyState === 'complete') {
        maybeResumeAfterReload();
    } else {
        window.addEventListener('load', maybeResumeAfterReload);
    }

    async function runFullAutoFill(data, startPhase = 1) {
        shouldStop = false;
        console.log(`🚀 FULL AUTO-FILL: Starting 5-phase automation (from phase ${startPhase})`);
        console.log('📋 Payload:', JSON.stringify(data, null, 2).substring(0, 500));
        showStopButton();
        const wait = bgWait;

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

                // 7. Start Time (military, no colon: "630")
                setTextInput(
                    'ctl00_CPH1_DocumentSpecificationsHeader1_rptHeaderSpecification_ctl00_txtMeasure',
                    data.startTimeMilitary
                );

                // 8. End Time (military: "1530")
                setTextInput(
                    'ctl00_CPH1_DocumentSpecificationsHeader1_rptHeaderSpecification_ctl01_txtMeasure',
                    data.endTimeMilitary
                );

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
                    hideStopButton();
                    return;
                }

                if (saveStatus !== 'saved') {
                    hideStopButton();
                    alert(
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

            if (data.resources && data.resources.length > 0) {
                await clickTab('Labor and Equipment');
                await wait(1500);

                // Reuse existing fillAllRows
                await fillAllRows(data.resources);

                // Click Update Records after all timesheet rows
                const tsUpdateBtn = document.getElementById(
                    'ctl00_CPH1_DailyReportTimeSheet1_rdgDailyReportTimesheet_ctl00_ctl02_ctl00_lblUpdateRecords'
                );
                if (tsUpdateBtn) {
                    tsUpdateBtn.click();
                    if (tsUpdateBtn.parentElement && tsUpdateBtn.parentElement.tagName === 'A') {
                        tsUpdateBtn.parentElement.click();
                    }
                    console.log('💾 Timesheet Update Records clicked');
                    await wait(2000);
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

            await clickTab('Notes');
            await wait(1500);

            // ALWAYS copy to clipboard first as a bulletproof fallback
            try {
                const blob = new Blob([data.notesHtml], { type: 'text/html' });
                const clipboardItem = new ClipboardItem({ 'text/html': blob });
                await navigator.clipboard.write([clipboardItem]);
                console.log('📋 Notes HTML copied to clipboard!');
            } catch (clipErr) {
                console.warn('⚠️ Could not copy to clipboard automatically:', clipErr);
            }

            // Click Add Note button
            const addNoteBtn = document.querySelector('div.btnAddNote');
            if (addNoteBtn) {
                addNoteBtn.click();
                console.log('  ✅ Clicked Add Note');
            } else {
                console.error('  ❌ Add Note button (div.btnAddNote) not found');
                hideStopButton();
                alert('⚠️ Completed Phases 1-4, but Notes Add button not found.');
                return;
            }

            // Wait for popup to open (poll for the iframe)
            await wait(2000); 

            alert('📋 The Note has been copied to your clipboard!\n\n1. Click inside the white note editor.\n2. Press Ctrl+V (or Cmd+V) to paste.\n3. Click "Yes" to clean the Word formatting.\n4. Click Save & Exit.');

            console.log('✅ PHASE 5 COMPLETE');

        } catch (err) {
            console.error('🚨 FULL AUTO-FILL ERROR:', err);
            alert(`Auto-fill error: ${err.message}`);
        }

        clearResumeState();
        hideStopButton();
        console.log('🎉🎉🎉 ALL 5 PHASES COMPLETE! 🎉🎉🎉');
    }

})();
