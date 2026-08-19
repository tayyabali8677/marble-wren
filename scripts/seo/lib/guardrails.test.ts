import { describe, it, expect } from "vitest";
import { withinCap, dollarRangesAgree, parseDollarRange } from "./guardrails";

describe("withinCap", () => {
  it("allows counts under the cap", () => {
    expect(withinCap(3, 10)).toBe(true);
  });

  it("allows counts exactly at the cap", () => {
    expect(withinCap(10, 10)).toBe(true);
  });

  it("rejects counts over the cap", () => {
    expect(withinCap(11, 10)).toBe(false);
  });
});

describe("parseDollarRange", () => {
  it("parses a standard en-dash range", () => {
    expect(parseDollarRange("$5,500–$14,000")).toEqual({ low: 5500, high: 14000 });
  });

  it("parses a hyphen range with no thousands separator", () => {
    expect(parseDollarRange("$2000-$8000")).toEqual({ low: 2000, high: 8000 });
  });

  it("returns null for text with no dollar range", () => {
    expect(parseDollarRange("Free tuition")).toBeNull();
  });

  it("returns null for a reversed/malformed range (low > high)", () => {
    expect(parseDollarRange("$14,000–$5,500")).toBeNull();
  });
});

describe("dollarRangesAgree", () => {
  it("agrees when two sources report the identical range", () => {
    const a = parseDollarRange("$5,500–$14,000")!;
    const b = parseDollarRange("$5,500–$14,000")!;
    expect(dollarRangesAgree([a, b])).toBe(true);
  });

  it("agrees when two sources are within 5% of each other on both ends", () => {
    const a = parseDollarRange("$5,500–$14,000")!;
    const b = parseDollarRange("$5,600–$13,600")!;
    expect(dollarRangesAgree([a, b])).toBe(true);
  });

  it("disagrees when sources differ by more than 5%", () => {
    const a = parseDollarRange("$5,500–$14,000")!;
    const b = parseDollarRange("$7,000–$14,000")!;
    expect(dollarRangesAgree([a, b])).toBe(false);
  });

  it("requires at least 2 sources", () => {
    const a = parseDollarRange("$5,500–$14,000")!;
    expect(dollarRangesAgree([a])).toBe(false);
  });

  it("disagrees with 3+ sources when two of them differ from each other by more than 5%, even though both individually agree with a shared middle anchor", () => {
    // C is the "anchor" (first element). A and C are within 5% of each
    // other (4.76%), and B and C are within 5% of each other (4.55%), so
    // anchor-vs-first comparison would wrongly report agreement. But A and
    // B themselves differ by 9.09%, which is a real disagreement between
    // two sources that a genuine pairwise check must catch.
    const c = parseDollarRange("$1,050–$14,000")!;
    const a = parseDollarRange("$1,000–$14,000")!;
    const b = parseDollarRange("$1,100–$14,000")!;
    expect(dollarRangesAgree([c, a, b])).toBe(false);
  });
});
