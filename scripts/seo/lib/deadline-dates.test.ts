import { describe, it, expect } from "vitest";
import { extractDates, isDeadlineStale } from "./deadline-dates";

const NOW = new Date(2026, 8, 10); // September 10, 2026 - matches the site's reference "today"

describe("extractDates", () => {
  it("parses a single full date", () => {
    const dates = extractDates("May 31, 2026");
    expect(dates).toHaveLength(1);
    expect(dates[0]).toEqual(new Date(2026, 4, 31));
  });

  it("parses a month-and-year with no day as the end of that month", () => {
    const dates = extractDates("Round 2: September 2026");
    expect(dates).toHaveLength(1);
    expect(dates[0]).toEqual(new Date(2026, 8, 28));
  });

  it("parses every date in a multi-round deadline", () => {
    const dates = extractDates("Round 1: May 21, 2026 (Bachelor's & Master's/PhD) | Round 2: September 2026");
    expect(dates).toHaveLength(2);
    expect(dates[0]).toEqual(new Date(2026, 4, 21));
    expect(dates[1]).toEqual(new Date(2026, 8, 28));
  });

  it("finds nothing in dateless free text", () => {
    expect(extractDates("Varies by institution")).toHaveLength(0);
    expect(extractDates("Ongoing - rolling admissions")).toHaveLength(0);
  });

  it("ignores a date that describes when applications opened, not a deadline", () => {
    // Real example that surfaced this as a live false-positive risk before ship.
    expect(extractDates("Varies by participating institution; applications for 2026-27 opened November 1, 2025")).toHaveLength(0);
  });

  it("still counts a genuine deadline date elsewhere in the same string as an opening date", () => {
    const dates = extractDates("Applications opened October 1, 2025; deadline is March 15, 2026");
    expect(dates).toHaveLength(1);
    expect(dates[0]).toEqual(new Date(2026, 2, 15));
  });
});

describe("isDeadlineStale", () => {
  it("is stale when the only date has clearly passed", () => {
    expect(isDeadlineStale("May 31, 2026", NOW)).toBe(true);
  });

  it("is stale when a date-with-day has passed even earlier the same month", () => {
    expect(isDeadlineStale("September 2, 2026", NOW)).toBe(true);
  });

  it("is not stale when the only date is still ahead", () => {
    expect(isDeadlineStale("December 15, 2026", NOW)).toBe(false);
  });

  it("is not stale when a month-only date's assumed end-of-month hasn't passed yet", () => {
    // "September 2026" defaults to Sept 28; NOW is Sept 10, so this reads as still open.
    expect(isDeadlineStale("September 2026", NOW)).toBe(false);
  });

  it("is not stale when a multi-round deadline still has a later round ahead", () => {
    expect(isDeadlineStale("Round 1: May 21, 2026 | Round 2: September 2026", NOW)).toBe(false);
  });

  it("is stale only when every round in a multi-round deadline has passed", () => {
    expect(isDeadlineStale("Round 1: January 10, 2026 | Round 2: March 15, 2026", NOW)).toBe(true);
  });

  it("is never stale for unparseable or dateless text", () => {
    expect(isDeadlineStale("Varies by institution", NOW)).toBe(false);
    expect(isDeadlineStale("Ongoing - rolling admissions", NOW)).toBe(false);
    expect(isDeadlineStale("Check official website", NOW)).toBe(false);
  });

  it("is not stale when the only date found is an opening date, not a deadline", () => {
    expect(isDeadlineStale("Varies by participating institution; applications for 2026-27 opened November 1, 2025", NOW)).toBe(false);
  });
});
