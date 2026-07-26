/**
 * Daily Reporter V3 — Dispatch Helpers (Shared Module)
 *
 * Activity-building helpers extracted from DispatchImportDialog.tsx
 * so they can be reused by the auto-create feature and other consumers.
 *
 * These functions convert parsed dispatch job data into structured
 * Activity objects with proper PMWeb resource matching.
 */

import { getResourceMatcher } from '@/lib/resourceMatcher';
import type {
  DispatchJob,
  ScheduleShift,
  Activity,
  ManpowerRow,
  EquipmentRow,
} from '@/types';

// ============================================
// Helper: Generate unique IDs
// ============================================

export function generateId(): string {
  const id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  console.debug('[dispatchHelpers] generateId:', id);
  return id;
}

// ============================================
// Helper: Clean time strings — strip trailing text like "NIGHT WORK"
// ============================================

export function cleanTime(t: string): string {
  if (!t) return '';
  // Extract just the time portion: "7:30 PM NIGHT WORK" → "7:30 PM", "8 PM" → "8 PM"
  const match = t.match(/(\d{1,2}(?::\d{2})?\s*(?:AM|PM))/i);
  if (match) {
    console.debug('[dispatchHelpers] cleanTime:', t, '→', match[1].trim());
    return match[1].trim();
  }
  // Try 24h: "19:30 NIGHT WORK" → "19:30"
  const match24 = t.match(/(\d{1,2}:\d{2})/);
  if (match24) {
    console.debug('[dispatchHelpers] cleanTime (24h):', t, '→', match24[1]);
    return match24[1];
  }
  console.debug('[dispatchHelpers] cleanTime (passthrough):', t);
  return t.trim();
}

// ============================================
// Helper: Parse time strings to minutes since midnight
// ============================================

export function parseTimeToMinutes(t: string): number {
  const cleaned = cleanTime(t);
  // Try 12h with minutes: "8:30 PM", "7:30 AM"
  const match12 = cleaned.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (match12) {
    let hrs = parseInt(match12[1]);
    const mins = parseInt(match12[2]);
    const period = match12[3].toUpperCase();
    if (period === 'PM' && hrs !== 12) hrs += 12;
    if (period === 'AM' && hrs === 12) hrs = 0;
    const result = hrs * 60 + mins;
    console.debug('[dispatchHelpers] parseTimeToMinutes:', t, '→', result, 'min');
    return result;
  }
  // Try 12h bare hour: "8 PM", "8PM", "10AM"
  const matchBare = cleaned.match(/(\d{1,2})\s*(AM|PM)/i);
  if (matchBare) {
    let hrs = parseInt(matchBare[1]);
    const period = matchBare[2].toUpperCase();
    if (period === 'PM' && hrs !== 12) hrs += 12;
    if (period === 'AM' && hrs === 12) hrs = 0;
    const result = hrs * 60;
    console.debug('[dispatchHelpers] parseTimeToMinutes (bare):', t, '→', result, 'min');
    return result;
  }
  // Try 24h format: "05:00", "17:30"
  const match24 = cleaned.match(/(\d{1,2}):(\d{2})/);
  if (match24) {
    const result = parseInt(match24[1]) * 60 + parseInt(match24[2]);
    console.debug('[dispatchHelpers] parseTimeToMinutes (24h):', t, '→', result, 'min');
    return result;
  }
  console.warn('[dispatchHelpers] Could not parse time:', t);
  return 0;
}

// ============================================
// Helper: Calculate hours between two times (handles overnight)
// ============================================

export function calcHours(startTimeStr: string, endTimeStr: string): number {
  const startMins = parseTimeToMinutes(startTimeStr);
  const endMins = parseTimeToMinutes(endTimeStr);
  let diff = endMins - startMins;
  if (diff <= 0) diff += 24 * 60; // Overnight shift
  const result = Math.round((diff / 60) * 10) / 10; // Round to 1 decimal
  console.debug('[dispatchHelpers] calcHours:', startTimeStr, '→', endTimeStr, '=', result, 'hrs');
  return result;
}

// ============================================
// Helper: Convert 24h time input to display format
// ============================================

export function formatEndTime(t: string): string {
  const match = t.match(/(\d{1,2}):(\d{2})/);
  if (!match) {
    console.debug('[dispatchHelpers] formatEndTime (no match):', t);
    return t;
  }
  let hrs = parseInt(match[1]);
  const mins = match[2];
  const period = hrs >= 12 ? 'PM' : 'AM';
  if (hrs > 12) hrs -= 12;
  if (hrs === 0) hrs = 12;
  const result = `${hrs}:${mins} ${period}`;
  console.debug('[dispatchHelpers] formatEndTime:', t, '→', result);
  return result;
}

// ============================================
// Builder: Activity from selected dispatch jobs
// ============================================

export function buildActivity(
  selectedJobs: DispatchJob[],
  company: string,
  endTime: string,
  shiftData: ScheduleShift | null,
  shiftNumber: string,
  scheduleType: 'digout' | 'grind_overlay' = 'digout',
  stationRanges: { from: string; to: string }[] = [],
  extraSummary: { asphaltTons?: string; trafficControl?: string; additionalContext?: string } = {},
): Activity {
  console.debug('[dispatchHelpers] buildActivity called:', {
    jobCount: selectedJobs.length,
    company,
    endTime,
    hasShift: !!shiftData,
    shiftNumber,
    scheduleType,
    stationRanges,
    extraSummary,
  });

  const matcher = getResourceMatcher();

  // Separate CONTRACT vs CHANGE ORDER jobs
  const contractJobs = selectedJobs.filter(j => j.contract_type !== 'CHANGE ORDER');
  const changeOrderJobs = selectedJobs.filter(j => j.contract_type === 'CHANGE ORDER');

  // work_area: combine all job names + descriptions (deduplicated)
  const workAreaParts: string[] = [];
  const seenDescriptions = new Set<string>();
  for (const job of selectedJobs) {
    const desc = `${job.job_name} - ${job.job_description}`;
    if (!seenDescriptions.has(desc)) {
      seenDescriptions.add(desc);
      workAreaParts.push(desc);
    }
  }
  const work_area = workAreaParts.join(' / ');

  // stations: combine streets + location (deduplicated)
  const allStreets = new Set<string>();
  const allLocations = new Set<string>();
  for (const job of selectedJobs) {
    (job.streets || []).forEach(s => { if (s && s !== 'N/A') allStreets.add(s); });
    if (job.location && job.location !== 'N/A') allLocations.add(job.location);
  }
  const stations = [...allStreets].join(' / ') + (allLocations.size > 0 ? ' - ' + [...allLocations].join(' / ') : '');

  // summary: schedule data + material/plant
  let summary = '';
  if (shiftData && shiftNumber) {
    if (scheduleType === 'grind_overlay') {
      // Grind & Overlay summary format
      summary += `• Grind & Overlay — ${shiftNumber}:\n`;
      // Station ranges
      if (stationRanges.length > 0) {
        for (const range of stationRanges) {
          summary += `  ${range.from} to ${range.to}\n`;
        }
      }
      for (const row of shiftData.rows) {
        const doStr = row.do_number && String(row.do_number) !== '0' ? ` DO #${row.do_number}` : '';
        const depthStr = row.depth ? ` — ${row.depth}' depth` : '';
        summary += `  - ${row.direction}${doStr}${depthStr} — ${row.sf.toLocaleString()} SF (${row.tons} tons)\n`;
      }
      summary += `  Total: ${shiftData.total_sf.toLocaleString()} SF / ${shiftData.total_tons.toLocaleString()} Tons\n`;
    } else {
      // Digout summary format (existing)
      summary += `• Digout Schedule — ${shiftNumber}:\n`;
      for (const row of shiftData.rows) {
        summary += `  - DO #${row.do_number} ${row.direction} — ${row.depth}' depth × ${row.width}W × ${row.length}L = ${row.sf.toLocaleString()} SF (${row.tons} tons)\n`;
      }
      summary += `  Total: ${shiftData.total_sf.toLocaleString()} SF / ${shiftData.total_tons.toLocaleString()} Tons\n`;
    }
  }
  // Material/Plant from all selected jobs
  for (const job of selectedJobs) {
    if (job.material && job.material !== 'N/A') summary += `• Material: ${job.material}\n`;
    if (job.plant && job.plant !== 'N/A') summary += `• Plant: ${job.plant}\n`;
  }
  // Extra summary data (asphalt tonnage, traffic control, additional context)
  if (extraSummary.asphaltTons && extraSummary.asphaltTons.trim()) {
    summary += `• Asphalt Laid: ${extraSummary.asphaltTons.trim()} tons\n`;
  }
  if (extraSummary.trafficControl && extraSummary.trafficControl.trim()) {
    summary += `• Traffic Control: ${extraSummary.trafficControl.trim()}\n`;
  }
  if (extraSummary.additionalContext && extraSummary.additionalContext.trim()) {
    summary += `• ${extraSummary.additionalContext.trim()}\n`;
  }

  const endTimeFormatted = formatEndTime(endTime);

  // --- Build manpower rows from jobs ---
  function buildManpowerFromJobs(jobs: DispatchJob[]): ManpowerRow[] {
    const rows: ManpowerRow[] = [];
    for (const job of jobs) {
      // Foreman
      if (job.foreman?.name) {
        const hours = calcHours(job.foreman.time || job.start_time, endTime);
        rows.push({
          id: generateId(), trade: 'LL-02- Foreman', name: job.foreman.name,
          qty: 1, hours, start_time: cleanTime(job.foreman.time || job.start_time), stop_time: endTimeFormatted,
          company, classification: '', is_3rd_party: false, is_extra_work: false, is_consultant: false, locked: false,
        });
      }
      // Operators
      for (const op of (job.operators || [])) {
        const hours = calcHours(op.time || job.start_time, endTime);
        rows.push({
          id: generateId(), trade: 'LL-04- Operator', name: op.name,
          qty: 1, hours, start_time: cleanTime(op.time || job.start_time), stop_time: endTimeFormatted,
          company, classification: '', is_3rd_party: false, is_extra_work: false, is_consultant: false, locked: false,
        });
      }
      // Laborers
      for (const lab of (job.laborers || [])) {
        const hours = calcHours(lab.time || job.start_time, endTime);
        rows.push({
          id: generateId(), trade: 'LL-03- Laborers', name: lab.name,
          qty: 1, hours, start_time: cleanTime(lab.time || job.start_time), stop_time: endTimeFormatted,
          company, classification: '', is_3rd_party: false, is_extra_work: false, is_consultant: false, locked: false,
        });
      }
      // Rakers
      for (const r of (job.rakers || [])) {
        const hours = calcHours(r.time || job.start_time, endTime);
        rows.push({
          id: generateId(), trade: 'LL-03- Laborers', name: r.name,
          qty: 1, hours, start_time: cleanTime(r.time || job.start_time), stop_time: endTimeFormatted,
          company, classification: '', is_3rd_party: false, is_extra_work: false, is_consultant: false, locked: false,
        });
      }
      // Traffic Control
      for (const tc of (job.traffic_control || [])) {
        const hours = calcHours(tc.time || job.start_time, endTime);
        rows.push({
          id: generateId(), trade: 'LL-03- Laborers', name: tc.name,
          qty: 1, hours, start_time: cleanTime(tc.time || job.start_time), stop_time: endTimeFormatted,
          company, classification: '', is_3rd_party: false, is_extra_work: false, is_consultant: false, locked: false,
        });
      }
      // Trucking subs (3rd party manpower)
      if (job.trucking?.company && job.trucking.details !== 'N/A') {
        const truckCount = job.trucking.count || 1;
        const hours = calcHours(job.trucking.time || job.start_time, endTime);
        rows.push({
          id: generateId(), trade: 'LL-11- Teamster', name: `${job.trucking.company} Driver`,
          qty: truckCount, hours, start_time: cleanTime(job.trucking.time || job.start_time), stop_time: endTimeFormatted,
          company: job.trucking.company, classification: '', is_3rd_party: true, is_extra_work: false, is_consultant: false, locked: false,
        });
      }
      // Grinder subs (3rd party)
      if (job.grinders?.company && job.grinders.details !== 'N/A') {
        const count = job.grinders.count || 1;
        const hours = calcHours(job.grinders.time || job.start_time, endTime);
        rows.push({
          id: generateId(), trade: 'LL-04- Operator', name: `${job.grinders.company} Operator`,
          qty: count, hours, start_time: cleanTime(job.grinders.time || job.start_time), stop_time: endTimeFormatted,
          company: job.grinders.company, classification: '', is_3rd_party: true, is_extra_work: false, is_consultant: false, locked: false,
        });
      }
      // Sub Traffic Control (3rd party)
      if (job.sub_traffic_control?.company && job.sub_traffic_control.details !== 'N/A') {
        const count = job.sub_traffic_control.count || 1;
        const hours = calcHours(job.sub_traffic_control.time || job.start_time, endTime);
        rows.push({
          id: generateId(), trade: 'LL-03- Laborers', name: `${job.sub_traffic_control.company} Flagger`,
          qty: count, hours, start_time: cleanTime(job.sub_traffic_control.time || job.start_time), stop_time: endTimeFormatted,
          company: job.sub_traffic_control.company, classification: '', is_3rd_party: true, is_extra_work: false, is_consultant: false, locked: false,
        });
      }
      // Oil Truck Driver
      if (job.oil_truck?.driver) {
        const hours = calcHours(job.start_time, endTime);
        rows.push({
          id: generateId(), trade: 'LL-04- Operator', name: job.oil_truck.driver,
          qty: 1, hours, start_time: cleanTime(job.start_time), stop_time: endTimeFormatted,
          company, classification: '', is_3rd_party: false, is_extra_work: false, is_consultant: false, locked: false,
        });
      }
    }
      return rows;
  }

  // --- Build equipment rows from jobs ---
  function buildEquipmentFromJobs(jobs: DispatchJob[]): EquipmentRow[] {
    const rows: EquipmentRow[] = [];
    for (const job of jobs) {
      // Equipment items
      for (const eq of (job.equipment || [])) {
        const matchResult = matcher.match(eq.description || eq.id, 'equipment');
        const pmwebCode = matchResult.matched || eq.description || eq.id;
        const hours = calcHours(job.start_time, endTime);
        rows.push({
          id: generateId(), name: pmwebCode, description: eq.id,
          qty: 1, hours, start_time: cleanTime(job.start_time), stop_time: endTimeFormatted,
          company, is_3rd_party: false, is_extra_work: false, is_consultant: false, is_rental: false, locked: false,
        });
      }
      if (job.trucking?.company && job.trucking.details !== 'N/A') {
        const truckMatchResult = matcher.match('End Dump Truck', 'equipment');
        const truckCode = truckMatchResult.matched || 'End Dump Truck';
        const hours = calcHours(job.trucking.time || job.start_time, endTime);
        rows.push({
          id: generateId(), name: truckCode, description: `${job.trucking.company} Truck`,
          qty: job.trucking.count || 1, hours, start_time: cleanTime(job.trucking.time || job.start_time), stop_time: endTimeFormatted,
          company: job.trucking.company, is_3rd_party: true, is_extra_work: false, is_consultant: false, is_rental: false, locked: false,
        });
      }
      if (job.grinders?.company && job.grinders.details !== 'N/A') {
        const grinderMatchResult = matcher.match('Pavement Grinder', 'equipment');
        const grinderCode = grinderMatchResult.matched || 'Pavement Grinder';
        const hours = calcHours(job.grinders.time || job.start_time, endTime);
        rows.push({
          id: generateId(), name: grinderCode, description: `${job.grinders.company} Grinder`,
          qty: job.grinders.count || 1, hours, start_time: cleanTime(job.grinders.time || job.start_time), stop_time: endTimeFormatted,
          company: job.grinders.company, is_3rd_party: true, is_extra_work: false, is_consultant: false, is_rental: false, locked: false,
        });
      }
      if (job.sub_brooms?.company && job.sub_brooms.details !== 'N/A') {
        const broomMatchResult = matcher.match('Street Sweeper', 'equipment');
        const broomCode = broomMatchResult.matched || 'Street Sweeper';
        const hours = calcHours(job.start_time, endTime);
        rows.push({
          id: generateId(), name: broomCode, description: `${job.sub_brooms.company} Broom`,
          qty: 1, hours, start_time: cleanTime(job.start_time), stop_time: endTimeFormatted,
          company: job.sub_brooms.company, is_3rd_party: true, is_extra_work: false, is_consultant: false, is_rental: false, locked: false,
        });
      }
      // Oil Truck equipment
      if (job.oil_truck?.equipment_desc) {
        const matchResult = matcher.match(job.oil_truck.equipment_desc, 'equipment');
        const pmwebCode = matchResult.matched || job.oil_truck.equipment_desc;
        const hours = calcHours(job.start_time, endTime);
        rows.push({
          id: generateId(), name: pmwebCode, description: job.oil_truck.equipment_id || '',
          qty: 1, hours, start_time: cleanTime(job.start_time), stop_time: endTimeFormatted,
          company, is_3rd_party: false, is_extra_work: false, is_consultant: false, is_rental: false, locked: false,
        });
      }
      // Rentals
      for (const rental of (job.rentals || [])) {
        const matchResult = matcher.match(rental.description, 'equipment');
        const pmwebCode = matchResult.matched || rental.description;
        const hours = calcHours(job.start_time, endTime);
        rows.push({
          id: generateId(), name: pmwebCode, description: rental.description,
          qty: 1, hours, start_time: cleanTime(job.start_time), stop_time: endTimeFormatted,
          company: rental.company || company, is_3rd_party: false, is_extra_work: false, is_consultant: false, is_rental: true, locked: false,
        });
      }
    }
    return rows;
  }

  // Build from CONTRACT jobs → regular manpower/equipment
  const manpower = buildManpowerFromJobs(contractJobs);
  const equipment = buildEquipmentFromJobs(contractJobs);

  // Build from CHANGE ORDER jobs → extra_work arrays, with is_extra_work=true
  const ewManpower = buildManpowerFromJobs(changeOrderJobs).map(r => ({ ...r, is_extra_work: true }));
  const ewEquipment = buildEquipmentFromJobs(changeOrderJobs).map(r => ({ ...r, is_extra_work: true }));

  // For G&O, override stations with station ranges
  let finalStations = stations;
  if (scheduleType === 'grind_overlay' && stationRanges.length > 0) {
    finalStations = stationRanges.map(r => `${r.from} to ${r.to}`).join(' / ');
  }

  console.debug('[dispatchHelpers] Built activity:', {
    work_area,
    stations: finalStations.slice(0, 60),
    manpower: manpower.length,
    equipment: equipment.length,
    ewManpower: ewManpower.length,
    ewEquipment: ewEquipment.length,
  });

  return {
    id: generateId(),
    work_area,
    stations: finalStations,
    summary: summary.trim(),
    manpower,
    equipment,
    extra_work_manpower: ewManpower,
    extra_work_equipment: ewEquipment,
    consultant_manpower: [],
  };
}
