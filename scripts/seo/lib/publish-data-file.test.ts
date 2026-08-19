import { describe, it, expect } from "vitest";
import { isAllowed, applyExactReplace } from "./publish-data-file";

describe("isAllowed", () => {
  it("allows a file present in the allowlist", () => {
    expect(isAllowed("data/scholarships.ts", ["data/scholarships.ts"])).toBe(true);
  });

  it("rejects a file not present in the allowlist", () => {
    expect(isAllowed("app/layout.tsx", ["data/scholarships.ts"])).toBe(false);
  });

  it("rejects a path-traversal attempt disguised as an allowed name", () => {
    expect(isAllowed("../data/scholarships.ts", ["data/scholarships.ts"])).toBe(false);
  });
});

describe("applyExactReplace", () => {
  it("replaces the find string when it occurs exactly once", () => {
    const src = 'seoTitle: "Old Title",';
    const result = applyExactReplace(src, 'seoTitle: "Old Title"', 'seoTitle: "New Title"');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe('seoTitle: "New Title",');
  });

  it("refuses when the find string is missing", () => {
    const src = 'seoTitle: "Something Else",';
    const result = applyExactReplace(src, 'seoTitle: "Old Title"', 'seoTitle: "New Title"');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not found");
  });

  it("refuses when the find string occurs more than once", () => {
    const src = 'a: "$5,500–$14,000", b: "$5,500–$14,000"';
    const result = applyExactReplace(src, '"$5,500–$14,000"', '"$6,000–$15,000"');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not unique");
  });

  it("treats the replacement string literally, not as a $-pattern template", () => {
    const src = 'fee: "$5,500",';
    const result = applyExactReplace(src, '"$5,500"', '"$$6,000"');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe('fee: "$$6,000",');
  });
});
