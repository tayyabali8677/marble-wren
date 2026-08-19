/**
 * Pure guardrail checks shared by the auto-push agents. No IO here on
 * purpose — every function is a plain value-in, value-out check so it can
 * be unit tested without a network or a git clone.
 */

export function withinCap(count: number, max: number): boolean {
  return count <= max;
}

export type DollarRange = { low: number; high: number };

const RANGE_RE = /\$([\d,]+)\s*[–-]\s*\$?([\d,]+)/;

export function parseDollarRange(text: string): DollarRange | null {
  const m = text.match(RANGE_RE);
  if (!m) return null;
  const low = Number(m[1].replace(/,/g, ""));
  const high = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return { low, high };
}

// Sources are allowed to differ slightly (rounding, currency-of-the-day
// fee sheets) without being treated as a disagreement. Anything past this
// tolerance means the sources are describing different numbers, not the
// same fact stated two ways.
const AGREEMENT_TOLERANCE_PCT = 0.05;

function withinTolerance(a: number, b: number): boolean {
  const base = Math.max(a, b);
  if (base === 0) return a === b;
  return Math.abs(a - b) / base <= AGREEMENT_TOLERANCE_PCT;
}

export function dollarRangesAgree(ranges: DollarRange[]): boolean {
  if (ranges.length < 2) return false;
  const [first, ...rest] = ranges;
  return rest.every((r) => withinTolerance(r.low, first.low) && withinTolerance(r.high, first.high));
}
