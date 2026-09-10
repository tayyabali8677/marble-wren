/**
 * Conservative free-text deadline parsing shared by deadline-status-agent.ts.
 * Kept in sync by hand with titansabroad.org's own lib/deadlineStatus.ts -
 * this repo can't import across repos, so the same logic is duplicated
 * rather than trusting a third implementation to agree with either.
 */

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const DATE_RE = new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{1,2}\\s*,?\\s*)?(\\d{4})\\b`, "gi");

// A date immediately preceded by an "opened"/"opens"-type word describes when
// applications START, not when they're due - e.g. "applications opened
// November 1, 2025" says nothing about whether they're still open today.
// Counting that date as a deadline caused a real false positive during
// testing (nl-scholarship-netherlands), so any date within a short window of
// one of these words is excluded rather than misread as a closing date.
const OPENING_WORD_RE = /\b(open(?:ed|s|ing)?|start(?:ed|s|ing)?|begin(?:s|ning)?|from)\s*:?\s*$/i;
const LOOKBEHIND_CHARS = 20;

/** Every "Month [Day,] Year" occurrence found in free text, as Date objects,
 *  excluding ones that read as an opening date rather than a deadline. */
export function extractDates(text: string): Date[] {
  const dates: Date[] = [];
  for (const m of text.matchAll(DATE_RE)) {
    const before = text.slice(Math.max(0, m.index! - LOOKBEHIND_CHARS), m.index!);
    if (OPENING_WORD_RE.test(before)) continue;

    const month = MONTHS.indexOf(m[1].toLowerCase());
    // No day given ("September 2026") - assume end of month so a still-
    // current month-only round isn't misread as already closed.
    const day = m[2] ? parseInt(m[2], 10) : 28;
    const year = parseInt(m[3], 10);
    dates.push(new Date(year, month, day));
  }
  return dates;
}

/**
 * True only when the deadline text has at least one parseable date AND every
 * date found in it is in the past. Unparseable or dateless text (rolling
 * deadlines, "varies by institution", etc.) always returns false.
 */
export function isDeadlineStale(deadline: string, now: Date = new Date()): boolean {
  const dates = extractDates(deadline);
  if (dates.length === 0) return false;
  return dates.every((d) => d.getTime() < now.getTime());
}
