import { describe, it, expect } from "vitest";
import { findObjectLiteral } from "./find-object-literal";

const SRC = `export const scholarships = [
  {
    slug: "alpha-scholarship",
    seoTitle: "Alpha Scholarship 2026",
    seoDescription: "Apply now for the Alpha Scholarship.",
  },
  {
    slug: "beta-scholarship",
    seoTitle: "Beta Scholarship 2026",
    seoDescription: "Apply now for the Beta Scholarship.",
  },
];
`;

describe("findObjectLiteral", () => {
  it("finds the object containing the anchor and returns its exact text", () => {
    const result = findObjectLiteral(SRC, 'slug: "beta-scholarship"');
    expect(result).not.toBeNull();
    expect(result!.text).toContain('slug: "beta-scholarship"');
    expect(result!.text).toContain("Beta Scholarship 2026");
    expect(result!.text).not.toContain("alpha-scholarship");
  });

  it("returns the exact start/end offsets of the object", () => {
    const result = findObjectLiteral(SRC, 'slug: "alpha-scholarship"')!;
    expect(SRC.slice(result.start, result.end)).toBe(result.text);
  });

  it("returns null when the anchor string isn't present", () => {
    expect(findObjectLiteral(SRC, 'slug: "gamma-scholarship"')).toBeNull();
  });

  it("does not get confused by braces inside string values", () => {
    const src = `[{ slug: "x", note: "uses a { brace } inline" }]`;
    const result = findObjectLiteral(src, 'slug: "x"')!;
    expect(result.text).toBe('{ slug: "x", note: "uses a { brace } inline" }');
  });

  it("does not get confused by a stray brace inside a line comment (forward scan)", () => {
    const src = `[{\n slug: "v",\n // legacy note: uses a stray }\n val: 1,\n },\n { slug: "next" },\n]`;
    const result = findObjectLiteral(src, 'slug: "v"')!;
    expect(result).not.toBeNull();
    expect(result.text).toBe('{\n slug: "v",\n // legacy note: uses a stray }\n val: 1,\n }');
  });

  it("does not get confused by a stray brace inside a string before the anchor (backward scan)", () => {
    const src = `[{ note: "closing brace } stray", slug: "target-one" }, { slug: "other" }]`;
    const result = findObjectLiteral(src, 'slug: "target-one"');
    expect(result).not.toBeNull();
    expect(result!.text).toBe('{ note: "closing brace } stray", slug: "target-one" }');
  });

  it("returns null when the anchor is ambiguous (occurs more than once)", () => {
    const src = `[{ slug: "dup", a: 1 }, { slug: "dup", a: 2 }]`;
    expect(findObjectLiteral(src, 'slug: "dup"')).toBeNull();
  });
});
