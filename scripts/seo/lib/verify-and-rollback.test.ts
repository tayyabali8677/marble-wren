import { describe, it, expect } from "vitest";
import { containsExpected } from "./verify-and-rollback";

describe("containsExpected", () => {
  it("returns true when the expected text is present in the HTML", () => {
    expect(containsExpected("<title>Alpha Scholarship 2026</title>", "Alpha Scholarship 2026")).toBe(true);
  });

  it("returns false when the expected text is missing", () => {
    expect(containsExpected("<title>Old Title</title>", "Alpha Scholarship 2026")).toBe(false);
  });
});
