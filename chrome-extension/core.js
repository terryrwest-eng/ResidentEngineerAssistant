// PMWeb Auto-Fill - shared logic
//
// Loaded by the popup (popup.html) and by the side panel on PMWeb pages
// (manifest.json, content_scripts). One copy of the logic, so a fix made for
// one is a fix for both - the same reason the queue drives the existing
// Auto-Fill path instead of building a second payload.
//
// Nothing in here draws anything, and nothing uses chrome.tabs or
// chrome.scripting: a content script has neither. Each caller decides how to
// show a message and how to reach the page.

var PMCore = (function () {

    // ── Signing requests ─────────────────────────────────────────────────────
    //
    // Reports are per-user, so every endpoint except /api/health needs the
    // access token. token-sync.js copies it from the app's own pages into
    // chrome.storage.local; the popup's paste box is the fallback.

    async function getAuthToken() {
        const stored = await chrome.storage.local.get(['apiToken']);
        return stored.apiToken || '';
    }

    /**
     * fetch() with the stored access token attached. onUnauthorized runs on a
     * 401 or 403, which needs a different fix from "the server is down".
     */
    async function apiFetch(url, options, onUnauthorized) {
        const token = await getAuthToken();
        const opts = options || {};
        const headers = Object.assign({}, opts.headers || {});
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const resp = await fetch(url, Object.assign({}, opts, { headers }));
        if ((resp.status === 401 || resp.status === 403) && typeof onUnauthorized === 'function') {
            onUnauthorized();
        }
        return resp;
    }

    /** One request with a time limit, for probing whether an address answers. */
    async function healthy(base) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);
            const resp = await fetch(`${base}/api/health`, { method: 'GET', signal: controller.signal });
            clearTimeout(timeoutId);
            return resp.ok;
        } catch (e) {
            return false;
        }
    }

    // The saved app address, or the first known address that answers.
    async function getApiBase() {
        const stored = await chrome.storage.local.get(['apiBase']);
        if (stored.apiBase) {
            if (await healthy(stored.apiBase)) return stored.apiBase;
            await chrome.storage.local.remove(['apiBase']);
            console.log('Cleared stale apiBase, re-discovering...');
        }

        // Railway first - V3 is the active deployment
        const railwayUrls = [
            'https://residentengineerassistant-production.up.railway.app',
            'https://daily-observation-application-production.up.railway.app',
            'https://daily-reporting-app-main-production.up.railway.app',
            'https://daily-reporting-app.up.railway.app'
        ];
        for (const url of railwayUrls) {
            if (await healthy(url)) {
                await chrome.storage.local.set({ apiBase: url });
                return url;
            }
        }

        // localhost as the fallback
        for (const port of [8000, 3001, 5000, 8080]) {
            const url = `http://localhost:${port}`;
            if (await healthy(url)) {
                await chrome.storage.local.set({ apiBase: url });
                return url;
            }
        }
        return null;
    }

    // ── The selected report ──────────────────────────────────────────────────

    /** The report the app's context points at, or null. */
    async function getContextReportId(apiBase, onUnauthorized) {
        try {
            const resp = await apiFetch(`${apiBase}/api/extension/context`, {}, onUnauthorized);
            if (!resp.ok) return null;
            const context = await resp.json();
            return context.report_id || null;
        } catch (e) {
            console.log('Context check failed.', e);
            return null;
        }
    }

    /**
     * Point the app's context at a report. Rows fetched for a different report
     * are dropped: they belong to the report they came from, and leaving them
     * in place is how the wrong report's crew ends up in PMWeb.
     */
    async function setContextReport(apiBase, reportId, onUnauthorized) {
        await apiFetch(`${apiBase}/api/extension/context`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ report_id: reportId }),
        }, onUnauthorized);
        const stored = await chrome.storage.local.get(['pmwebRowsMeta']);
        const meta = stored.pmwebRowsMeta;
        if (meta && meta.reportId && meta.reportId !== reportId) {
            await chrome.storage.local.remove(['pmwebRows', 'pmwebRowsMeta']);
            console.log('[picker] Cleared rows fetched for a different report');
        }
        await chrome.storage.local.set({ selectedReportId: reportId });
    }

    /**
     * Every report, walking the pages. The endpoint pages because it reads
     * each report for its activity names; the ceiling is a runaway guard, not
     * a limit on what can be shown.
     */
    async function loadReports(apiBase, onUnauthorized) {
        let reports = [];
        let total = 0;
        for (let offset = 0; offset < 20000; offset += 200) {
            const resp = await apiFetch(
                `${apiBase}/api/extension/reports?limit=200&offset=${offset}`, {}, onUnauthorized);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const page = data.reports || [];
            reports = reports.concat(page);
            total = data.total || reports.length;
            if (page.length === 0 || reports.length >= total) break;
        }
        return { reports, total };
    }

    async function fetchJson(apiBase, path, onUnauthorized) {
        const resp = await apiFetch(`${apiBase}${path}`, {}, onUnauthorized);
        if (!resp.ok) throw new Error(`API returned ${resp.status}`);
        return await resp.json();
    }

    /** The whole PMWeb bundle for one report: Main tab, activities, resources, notes. */
    function fetchFullData(apiBase, reportId, onUnauthorized) {
        return fetchJson(apiBase, `/api/export/${reportId}/pmweb-full`, onUnauthorized);
    }

    function fetchResourceRows(apiBase, reportId, onUnauthorized) {
        return fetchJson(apiBase, `/api/reports/${reportId}/consolidated`, onUnauthorized);
    }

    function fetchActivityRows(apiBase, reportId, onUnauthorized) {
        return fetchJson(apiBase, `/api/reports/${reportId}/activities-consolidated`, onUnauthorized);
    }

    /**
     * Keep fetched resource rows for the Fill step, stamped with WHICH report
     * and WHEN. A Fill reads them straight out of storage and never re-fetches,
     * so without the stamp nothing says whether they are this report's or one
     * from last week.
     */
    async function storeResourceRows(rows, reportId, reportDate) {
        await chrome.storage.local.set({
            pmwebRows: rows,
            pmwebRowsMeta: {
                reportId,
                reportDate: reportDate || '',
                fetchedAt: Date.now(),
            },
        });
    }

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

    /**
     * What a set of fetched resource rows is, so a Fill button is never an
     * anonymous "Fill 40 Rows". The rows are filled from storage without being
     * re-fetched, so they can be any age and can belong to a report other than
     * the one now selected.
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

    // ── Auto-Fill Everything: the payload ────────────────────────────────────

    // PMWeb's Location box rejects a long value - a 192-character location
    // makes the whole document save fail with "String or binary data would
    // be truncated", which is a SQL error, not a validation message, so the
    // record simply will not save. The control reports maxLength=1000, so
    // the real column is smaller than the page claims.
    //
    // The fix is not to truncate, though. Terry, 2026-09-27, on a location
    // listing every station, vault and manway: "THATS WAY TOO LONG EVEN IF
    // IT IDDNT CAUSE THE ERROR. THAT SHOULD SAY Genesee, Nobel." So PMWeb
    // gets the streets, and the report itself keeps the full detail.
    //
    // Longest first, so "Town Centre Dr" is not caught by a bare "Town".
    const PLACES = [
        ['rose canyon', 'Rose Canyon'], ['marian bear', 'Marian Bear'],
        ['town cent', 'Town Centre'], ['towne cent', 'Town Centre'],
        ['genesee', 'Genesee'], ['nobel', 'Nobel'], ['executive', 'Executive'],
        ['renaissance', 'Renaissance'], ['governor', 'Governor'],
        ['sr-52', 'SR-52'], ['sr 52', 'SR-52'],
        ['i-805', 'I-805'], ['805', 'I-805'],
        ['utc', 'UTC'], ['morena', 'Morena'], ['regents', 'Regents'],
        ['la jolla', 'La Jolla'], ['eastgate', 'Eastgate'],
        ['campus point', 'Campus Point'],
    ];

    function placesIn(text) {
        const hay = String(text || '').toLowerCase();
        const out = [];
        PLACES.forEach(([needle, name]) => {
            if (hay.indexOf(needle) >= 0 && out.indexOf(name) < 0) out.push(name);
        });
        return out;
    }

    function shortLocation(loc, activities) {
        let found = placesIn(loc);
        if (!found.length) {
            // Some reports carry no location at all - 2026-04-21 is empty -
            // but the activities still name where the work was.
            const fromActs = (activities || [])
                .map(a => (a.location || '') + ' ' + (a.title || '')).join(' ');
            found = placesIn(fromActs);
        }
        if (found.length) return found.join(', ');
        // Nothing recognised. 2025-11-11 is just "SDG&E trench" - short
        // already, and better than nothing.
        return String(loc || '').slice(0, 60);
    }

    // The two time boxes on the Main tab are military digits and nothing
    // else - PMWeb renders them class="Integer". Terry, 2026-09-27: "these
    // two time slots are supposedto be in military time, only these thought".
    //
    // Reading it the way Terry writes it: the start is the clock as written,
    // and an end at or before the start is PM when that lands within 16 hours
    // of the start, otherwise the next morning. 2025-11-11's night shift
    // 20:30 - 05:00 therefore gives 2030 and 500, while 2025-10-29's
    // 07:00 - 05:00 gives 700 and 1700.
    function timeMinutes(t) {
        const s = String(t || '').trim();
        let m = /^(\d{1,2}):(\d{2})\s*([APap])\.?[Mm]?\.?$/.exec(s);
        if (m) {
            let h = parseInt(m[1], 10) % 12;
            if (m[3].toUpperCase() === 'P') h += 12;
            return h * 60 + parseInt(m[2], 10);
        }
        m = /^(\d{1,2}):(\d{2})$/.exec(s);
        if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
        m = /^(\d{1,2})(\d{2})$/.exec(s);   // already military
        if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
        return null;
    }

    function militaryDigits(mins) {
        if (mins === null) return '';
        const h = Math.floor(mins / 60) % 24;
        return String(h * 100 + (mins % 60));   // 6:30 -> 630, as PMWeb writes it
    }

    function militaryPair(startRaw, endRaw) {
        const a = timeMinutes(startRaw);
        let b = timeMinutes(endRaw);
        if (a !== null && b !== null && b <= a && b + 720 > a && b + 720 <= a + 16 * 60) {
            b += 720;   // an end written 05:00 for five in the afternoon
        }
        return { start: militaryDigits(a), end: militaryDigits(b) };
    }

    // The value PMWeb's Shift dropdown holds for each shift.
    const SHIFT_VALUES = {
        'Day': '☀️ Day',
        'Evening': '🌙 Evening',
        'Night': '🌑 Night'
    };

    /**
     * Everything injected.js needs for the five phases, from the /pmweb-full
     * bundle and the record number, shift and resource mode for this run.
     * reportId is not used to fill anything - it comes back with the run's
     * result so the queue knows which entry finished.
     */
    function buildFullPayload(fullData, opts) {
        const recordCode = `${opts.recordNum} ${opts.shift}`;   // "1470 Day"
        const shiftValue = SHIFT_VALUES[opts.shift] || `☀️ ${opts.shift}`;
        const dayTypeValue = fullData.general.is_working_day
            ? '1 -Working Day'
            : '2 -Non-Working Day';

        const times = militaryPair(
            fullData.general.start_time || fullData.general.start_time_military,
            fullData.general.end_time || fullData.general.end_time_military
        );
        if (!times.start || !times.end) {
            console.warn('The report does not give both shift times: '
                + JSON.stringify([fullData.general.start_time, fullData.general.end_time]));
        }

        return {
            // Phase 1: Main Tab
            reportDate: fullData.general.report_date,
            recordCode: recordCode,
            location: shortLocation(fullData.general.project_location, fullData.activities),
            weatherConditions: fullData.general.sky_conditions_pmweb,
            temperature: fullData.general.temperature_avg != null
                ? String(fullData.general.temperature_avg)
                : '',
            precipAmount: '0.00',
            startTimeMilitary: times.start,
            endTimeMilitary: times.end,
            shiftValue: shiftValue,
            // Phase 2: Activities
            activities: fullData.activities,
            // Phase 3: Resources
            resources: fullData.resources,
            resourceMode: opts.resourceMode || 'add',
            // Phase 4: Additional Info
            dayTypeValue: dayTypeValue,
            // Phase 5: Notes
            notesHtml: fullData.notes_html,
            reportId: opts.reportId || null
        };
    }

    // ── The queue ────────────────────────────────────────────────────────────
    //
    // One entry per report, each carrying the record number and shift PMWeb
    // needs. Held in chrome.storage so it survives the popup closing, and so the
    // popup and the side panel show the same queue.
    //
    // status: 'pending' -> 'sent' (the run was started) -> 'done' or 'problems',
    // the last two set from what the page reports back when it finishes.

    async function loadQueue() {
        const stored = await chrome.storage.local.get(['pmwebQueue']);
        return (stored.pmwebQueue && Array.isArray(stored.pmwebQueue.items))
            ? stored.pmwebQueue
            : { items: [] };
    }

    async function saveQueue(queue) {
        await chrome.storage.local.set({ pmwebQueue: queue });
    }

    function queueHas(queue, id) {
        return queue.items.some((i) => i.id === id);
    }

    /** Add the report to the queue, or take it out if it is already in. */
    function toggleQueueItem(queue, report, mode) {
        const at = queue.items.findIndex((i) => i.id === report.id);
        if (at >= 0) {
            queue.items.splice(at, 1);
        } else {
            queue.items.push({
                id: report.id,
                date: report.report_date || '',
                record: '',
                shift: 'Day',
                mode: mode || 'add',
                status: 'pending',
            });
        }
    }

    function nextInQueue(queue) {
        return queue.items.find((i) => i.status === 'pending') || null;
    }

    /** Mark the running entry done or "check it" from a run's result. Returns the entry, or null. */
    function applyRunResult(queue, run) {
        if (!run) return null;
        const item = queue.items.find((i) => i.id === run.reportId && i.status === 'sent')
            || queue.items.find((i) => i.date && i.date === run.reportDate && i.status === 'sent');
        if (!item) return null;
        item.status = (run.problems && run.problems.length) ? 'problems' : 'done';
        item.problems = run.problems || [];
        return item;
    }

    /**
     * The result content.js saved when a run finished while the popup was
     * shut. Applied once, then removed.
     */
    async function applyStoredLastRun(queue) {
        const stored = await chrome.storage.local.get(['pmwebLastRun']);
        const run = stored.pmwebLastRun;
        if (!run) return false;
        const item = applyRunResult(queue, run);
        if (item) await saveQueue(queue);
        await chrome.storage.local.remove(['pmwebLastRun']);
        return !!item;
    }

    // ── Other helpers ────────────────────────────────────────────────────────

    /** Readable text from the report HTML, for the plain-text clipboard flavour. */
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

    /**
     * Empties every visible timesheet field on the PMWeb page and returns how
     * many it cleared. Self-contained, because the popup hands it to
     * chrome.scripting.executeScript, which sends the function's source alone.
     */
    function clearTimesheetFields() {
        console.log('🗑️ PMWeb Clear: Starting...');
        let clearedCount = 0;

        const inputs = document.querySelectorAll('input[type="text"][id*="DailyReportTimesheet"]');
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

        const checkboxes = document.querySelectorAll('input[type="checkbox"][id*="DailyReportTimesheet"]');
        checkboxes.forEach(chk => {
            if (chk.offsetParent !== null && chk.checked) {
                chk.click();
                clearedCount++;
            }
        });

        // Remarks / Memo fields
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
        return clearedCount;
    }

    return {
        getAuthToken, apiFetch, getApiBase,
        getContextReportId, setContextReport, loadReports,
        fetchFullData, fetchResourceRows, fetchActivityRows, storeResourceRows,
        fmtPickerDate, fmtShift, describeRows,
        buildFullPayload, militaryPair, shortLocation,
        loadQueue, saveQueue, queueHas, toggleQueueItem, nextInQueue,
        applyRunResult, applyStoredLastRun,
        htmlToPlainText, clearTimesheetFields,
    };
})();
