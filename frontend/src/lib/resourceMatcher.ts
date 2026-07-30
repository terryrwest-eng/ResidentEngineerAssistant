/**
 * Daily Reporter V3 — Resource Matcher (TypeScript port)
 *
 * Fuzzy-matches raw AI descriptions to LE/LL PMWeb resource tags.
 *
 * Strategy:
 * 1. Exact substring match → 100% confidence → auto-apply
 * 2. Prefer GENERIC titles (e.g., "LE-109- Excavator") over specific
 * manufacturer+model titles (e.g., "LE-05- CAT 330 Excavator")
 * 3. If ambiguous → return top candidates for user selection
 *
 * Ported from V1 resourceMatcher.js — logic is identical.
 */

import { DEFAULT_MANPOWER, DEFAULT_EQUIPMENT } from './constants';

// ============================================
// Types
// ============================================

export interface MatchResult {
  matched: string | null;
  confidence: number;
  alternatives: string[];
}

interface ScoredResource {
  resource: string;
  score: number;
  specificity: number;
}

// ============================================
// Helpers
// ============================================

/** Known manufacturer names — their presence increases specificity. */
const MANUFACTURERS: string[] = [
  'cat', 'caterpillar', 'john deere', 'deere', 'kobelco', 'hitachi',
  'bobcat', 'kubota', 'volvo', 'komatsu', 'case', 'jlg', 'genie',
  'bomag', 'hamm', 'wacker', 'sakai', 'liebherr', 'link belt',
  'mcelroy', 'lincoln', 'toyota', 'yale', 'hoist', 'lorain',
  'freightliner', 'kenworth', 'xtreme', 'miller', 'generac',
  'maxim', 'badger', 'sunstate', 'greenle', 'ridgid', 'hilti',
  'seal boss', 'lily corp', 'ahearn', 'magnum',
];

/**
 * Scores how "generic" a resource title is. Lower score = more generic = preferred.
 * Generic titles lack manufacturer names and model numbers.
 */
function getSpecificityScore(resource: string): number {
  const desc = extractDescription(resource).toLowerCase();
  let score = 0;

  for (const mfr of MANUFACTURERS) {
    if (desc.includes(mfr)) {
      score += 10;
      break;
    }
  }

  // Model numbers (alphanumeric sequences like "330", "D5", "950") add specificity
  const modelPattern = /\b[A-Z]?\d{2,4}[A-Z]?\b/i;
  if (modelPattern.test(desc)) {
    score += 5;
  }

  return score;
}

/**
 * Extracts the description portion from a resource string.
 * "LE-109- Excavator" → "Excavator"
 * "LL-03- Laborers" → "Laborers"
 */
function extractDescription(resource: string): string {
  const match = resource.match(/^[A-Z]+-\d+-\s*(.+)$/);
  return match ? match[1].trim() : resource.trim();
}

/**
 * Normalizes a string for comparison.
 * Lowercases, removes extra spaces, strips special chars.
 */
function normalize(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Computes a match score between a query and a resource description.
 * Returns 0.0 to 1.0.
 */
function computeScore(query: string, resourceDesc: string): number {
  const normQuery = normalize(query);
  const normDesc = normalize(resourceDesc);

  if (!normQuery || !normDesc) return 0;

  // Exact match
  if (normQuery === normDesc) return 1.0;

  // Singular/plural match (e.g., "Laborer" matches "Laborers")
  if (normQuery + 's' === normDesc || normDesc + 's' === normQuery) return 0.98;

  // Query is a substring of description or vice versa
  if (normDesc.includes(normQuery)) return 0.95;
  if (normQuery.includes(normDesc)) return 0.90;

  // Word-level matching
  const queryWords = normQuery.split(' ');
  const descWords = normDesc.split(' ');

  // Check if all query words appear in description
  const allQueryWordsMatch = queryWords.every((qw) =>
    descWords.some((dw) => dw.includes(qw) || qw.includes(dw))
  );
  if (allQueryWordsMatch && queryWords.length > 0) {
    return 0.85;
  }

  // Partial word overlap
  const matchingWords = queryWords.filter((qw) =>
    descWords.some((dw) => dw.includes(qw) || qw.includes(dw))
  );
  const overlapRatio = matchingWords.length / Math.max(queryWords.length, 1);
  return overlapRatio * 0.7;
}

// ============================================
// ResourceMatcher Class
// ============================================

export class ResourceMatcher {
  private resources: string[];
  private equipmentResources: string[];
  private manpowerResources: string[];
  private equipmentAliases: Map<string, string> = new Map();
  private manpowerAliases: Map<string, string> = new Map();

  constructor(resources: string[]) {
    this.resources = resources || [];
    this.equipmentResources = this.resources.filter((r) => r.startsWith('LE-'));
    this.manpowerResources = this.resources.filter((r) => r.startsWith('LL-'));
  }

  /**
   * Load user-defined aliases. These are checked FIRST before fuzzy matching.
   * Format: { equipment: { "normalized_desc": "LE-109- Excavator", ... }, manpower: { ... } }
   */
  setAliases(aliases: { equipment?: Record<string, string>; manpower?: Record<string, string> }): void {
    this.equipmentAliases.clear();
    this.manpowerAliases.clear();
    if (aliases.equipment) {
      for (const [key, val] of Object.entries(aliases.equipment)) {
        this.equipmentAliases.set(normalize(key), val);
      }
    }
    if (aliases.manpower) {
      for (const [key, val] of Object.entries(aliases.manpower)) {
        this.manpowerAliases.set(normalize(key), val);
      }
    }
    console.debug('[ResourceMatcher] Loaded aliases:', this.equipmentAliases.size, 'equipment,', this.manpowerAliases.size, 'manpower');
  }

  /**
   * Add a single alias mapping. Immediately available for future matches.
   */
  addAlias(query: string, code: string, type: 'equipment' | 'manpower'): void {
    const key = normalize(query);
    if (type === 'equipment') {
      this.equipmentAliases.set(key, code);
    } else {
      this.manpowerAliases.set(key, code);
    }
    console.debug(`[ResourceMatcher] Added alias: "${query}" → ${code} (${type})`);
  }

  /**
   * Match a raw AI description to the best LE/LL resource.
   */
  match(query: string, type: 'equipment' | 'manpower' = 'equipment'): MatchResult {
    if (!query || !query.trim()) {
      return { matched: null, confidence: 0, alternatives: [] };
    }

    const pool = type === 'equipment' ? this.equipmentResources : this.manpowerResources;
    const aliasMap = type === 'equipment' ? this.equipmentAliases : this.manpowerAliases;

    // Check user-defined aliases FIRST — instant 1.0 confidence
    const normalizedQuery = normalize(query);
    const aliasMatch = aliasMap.get(normalizedQuery);
    if (aliasMatch) {
      // Verify the alias target still exists in the pool
      const exists = pool.find((r) => r === aliasMatch);
      if (exists) {
        console.debug(`[ResourceMatcher] Alias hit: "${query}" → ${aliasMatch}`);
        return { matched: aliasMatch, confidence: 1.0, alternatives: [] };
      }
    }

    // If the query is already a valid LE/LL tag, return it directly
    const codeMatch = query.match(/^[A-Z]+-\d+/);
    if (codeMatch) {
      const existing = pool.find((r) => r.startsWith(codeMatch[0]));
      if (existing) {
        return { matched: existing, confidence: 1.0, alternatives: [] };
      }
    }

    // Score all resources against the query
    const scored: ScoredResource[] = pool.map((resource) => ({
      resource,
      score: computeScore(query, extractDescription(resource)),
      specificity: getSpecificityScore(resource),
    }));

    // Sort by: score DESC, then specificity ASC (prefer generic)
    scored.sort((a, b) => {
      if (Math.abs(a.score - b.score) > 0.05) return b.score - a.score;
      return a.specificity - b.specificity;
    });

    const topCandidates = scored.filter((s) => s.score >= 0.95);
    const best = topCandidates[0];

    if (!best || best.score < 0.95) {
      return {
        matched: null,
        confidence: best ? best.score : 0,
        alternatives: scored.slice(0, 5).map((s) => s.resource),
      };
    }

    // Check if the best match is clearly dominant
    const secondBest = topCandidates[1];
    const isUnambiguous =
      best.score >= 0.95 &&
      (!secondBest || best.score - secondBest.score > 0.1 || best.specificity < secondBest.specificity);

    if (isUnambiguous) {
      return { matched: best.resource, confidence: 1.0, alternatives: [] };
    }

    // Ambiguous — return best guess + alternatives
    return {
      matched: best.resource,
      confidence: best.score,
      alternatives: topCandidates.slice(0, 5).map((s) => s.resource),
    };
  }

  /**
   * Checks if a string looks like an equipment/unit number (not an LE tag).
   */
  private _isEquipmentNumber(str: string): boolean {
    if (!str || !str.trim()) return false;
    const trimmed = str.trim();
    if (/^[A-Z]+-\d+-/.test(trimmed)) return false;
    if (/\d/.test(trimmed) && trimmed.length <= 20) return true;
    if (trimmed.length <= 15 && !trimmed.includes(' ')) return true;
    return false;
  }

  /**
   * Process a full array of manpower entries from AI, matching trades to LL tags.
   */
  processManpower(manpowerRows: Record<string, unknown>[]): { rows: Record<string, unknown>[]; needsReview: boolean } {
    if (!manpowerRows || !Array.isArray(manpowerRows)) {
      return { rows: [], needsReview: false };
    }

    let needsReview = false;

    const rows = manpowerRows.map((m) => {
      const rawTrade = String(m.trade || '');
      const result = this.match(rawTrade, 'manpower');

      if (result.matched && result.confidence >= 1.0) {
        return { ...m, trade: result.matched, name: m.name || '' };
      }

      if (result.matched && result.confidence >= 0.95) {
        needsReview = true;
        return { ...m, trade: result.matched, name: m.name || rawTrade };
      }

      needsReview = true;
      return { ...m, trade: rawTrade, name: m.name || '' };
    });

    return { rows, needsReview };
  }

  /**
   * Process a full array of equipment entries from AI, matching descriptions to LE tags.
   *
   * AI returns: { name: TAG/ID (e.g. "F450"), description: TYPE (e.g. "Crew Truck") }
   * We need: Col 1 (name) = LE tag, Col 2 (description) = equipment number
   */
  processEquipment(equipmentRows: Record<string, unknown>[]): { rows: Record<string, unknown>[]; needsReview: boolean } {
    if (!equipmentRows || !Array.isArray(equipmentRows)) {
      return { rows: [], needsReview: false };
    }

    let needsReview = false;

    const rows = equipmentRows.map((e) => {
      const rawName = String(e.name || '').trim();
      const rawDesc = String(e.description || '').trim();
      const typeForMatching = rawDesc || rawName;
      const hasEquipNumber = rawName && this._isEquipmentNumber(rawName);

      const result = this.match(typeForMatching, 'equipment');

      // Detect rental equipment from company name
      const companyLower = String(e.company || '').toLowerCase();
      const isRental =
        e.is_rental ||
        companyLower.includes('rental') ||
        companyLower.includes('rent') ||
        companyLower.includes('united rentals') ||
        companyLower.includes('sunbelt') ||
        companyLower.includes('sunstate');

      if (result.matched && result.confidence >= 1.0) {
        return {
          ...e,
          name: result.matched,
          description: hasEquipNumber ? rawName : (rawDesc || ''),
          is_rental: isRental,
        };
      }

      if (result.matched && result.confidence >= 0.95) {
        needsReview = true;
        return {
          ...e,
          name: result.matched,
          description: hasEquipNumber ? rawName : (rawDesc || ''),
          is_rental: isRental,
        };
      }

      needsReview = true;
      return {
        ...e,
        name: typeForMatching,
        description: hasEquipNumber ? rawName : '',
        is_rental: isRental,
      };
    });

    return { rows, needsReview };
  }
}

// ============================================
// Singleton Factory
// ============================================

let _cachedMatcher: ResourceMatcher | null = null;
let _aliasesLoaded = false;

/**
 * Returns a ResourceMatcher instance using the hardcoded PMWeb constants.
 * Cached after first call. Call `loadResourceAliases()` to inject user aliases
 * and custom resource codes.
 */
export function getResourceMatcher(extraCodes: string[] = []): ResourceMatcher {
  if (!_cachedMatcher) {
    const allCodes = Array.from(new Set([...DEFAULT_MANPOWER, ...DEFAULT_EQUIPMENT, ...extraCodes]));
    _cachedMatcher = new ResourceMatcher(allCodes);
    console.debug('[ResourceMatcher] Initialized with', DEFAULT_MANPOWER.length, 'manpower +', DEFAULT_EQUIPMENT.length, 'equipment +', extraCodes.length, 'custom codes');
  }
  return _cachedMatcher;
}

/**
 * Load user-defined resource aliases and custom codes from settings into the matcher.
 * Call this once after settings are fetched. Safe to call multiple times.
 */
export async function loadResourceAliases(): Promise<void> {
  if (_aliasesLoaded) return;
  try {
    // Dynamic import to avoid circular dependency
    const { settingsApi } = await import('./settingsApi');
    const settings = await settingsApi.get();

    // Load custom resource codes — rebuild matcher with extended pool
    const customLabor = settings.custom_resource_codes?.labor || [];
    const customEquipment = settings.custom_resource_codes?.equipment || [];
    if (customLabor.length > 0 || customEquipment.length > 0) {
      _cachedMatcher = null; // Invalidate cache to rebuild with custom codes
      getResourceMatcher([...customLabor, ...customEquipment]);
    }

    const aliases = (settings as unknown as Record<string, unknown>).resource_aliases as
      { equipment?: Record<string, string>; manpower?: Record<string, string> } | undefined;
    if (aliases) {
      getResourceMatcher().setAliases(aliases);
    }
    _aliasesLoaded = true;
    console.debug('[ResourceMatcher] Aliases + custom codes loaded from settings');
  } catch (err) {
    console.warn('[ResourceMatcher] Failed to load aliases from settings:', err);
  }
}

/**
 * Save a batch of new aliases to the server and update in-memory matcher.
 */
export async function saveResourceAliases(
  newAliases: { equipment?: Record<string, string>; manpower?: Record<string, string> }
): Promise<void> {
  try {
    const matcher = getResourceMatcher();
    // Update in-memory immediately
    if (newAliases.equipment) {
      for (const [key, val] of Object.entries(newAliases.equipment)) {
        matcher.addAlias(key, val, 'equipment');
      }
    }
    if (newAliases.manpower) {
      for (const [key, val] of Object.entries(newAliases.manpower)) {
        matcher.addAlias(key, val, 'manpower');
      }
    }
    // Persist to server
    const { settingsApi } = await import('./settingsApi');
    await settingsApi.saveResourceAliases(newAliases);
    console.debug('[ResourceMatcher] Aliases saved to server:', newAliases);
  } catch (err) {
    console.error('[ResourceMatcher] Failed to save aliases:', err);
  }
}
