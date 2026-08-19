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
});
