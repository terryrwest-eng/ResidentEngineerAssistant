/**
 * Daily Reporter V3 — Summary & Text Formatters
 *
 * Provides utilities for sanitizing AI output and activity summary text
 * to ensure consistent, clean bullet points without HTML tags.
 */

/**
 * Clean summary text to ensure plain-text bullet points starting with '• '
 * and remove raw HTML tags like <ul>, <li>, <p>, etc.
 */
export function cleanSummaryBullets(text: string | null | undefined): string {
  if (!text) return '';
  let t = String(text).trim();
  if (!t) return '';

  // If text contains HTML tags like <li>, <br>, <p>, <ul>
  if (/<[a-z][\s\S]*>/i.test(t)) {
    // Convert <li> tags to newlines with bullet character
    t = t.replace(/<li[^>]*>/gi, '\n• ');
    // Convert block-closing tags and <br> to newlines
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<\/(?:p|div|li|tr|ul|ol)>/gi, '\n');
    // Remove all remaining HTML tags
    t = t.replace(/<[^>]+>/g, '');
    // Decode common HTML entities
    t = t
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"');
  }

  // Split lines, clean up whitespace, and ensure bullet points
  const rawLines = t.split('\n').map(l => l.trim()).filter(Boolean);
  const cleanedLines: string[] = [];

  for (const line of rawLines) {
    // Strip leading bullet chars/symbols/numbers if present
    const content = line.replace(/^[•\-\*\–\d+\.]\s*/, '').trim();
    if (content) {
      cleanedLines.push(`• ${content}`);
    }
  }

  return cleanedLines.join('\n');
}
