import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { containsExpected, pollUntilVerified, verifyAndMaybeRollback } from "./verify-and-rollback";
import { revertCommit } from "./publish-data-file";

vi.mock("./publish-data-file", () => ({
  revertCommit: vi.fn(),
}));

describe("containsExpected", () => {
  it("returns true when the expected text is present in the HTML", () => {
    expect(containsExpected("<title>Alpha Scholarship 2026</title>", "Alpha Scholarship 2026")).toBe(true);
  });

  it("returns false when the expected text is missing", () => {
    expect(containsExpected("<title>Old Title</title>", "Alpha Scholarship 2026")).toBe(false);
  });
});

describe("pollUntilVerified", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("succeeds when fetch eventually returns ok + expected content", async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount++;
      if (callCount < 3) {
        return { ok: false, text: async () => "" } as Response;
      }
      return { ok: true, text: async () => "<title>Alpha Scholarship 2026</title>" } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = pollUntilVerified("/scholarships/alpha", "Alpha Scholarship 2026", 1000, 10);

    // Advance fake timers to let the retry loop's sleep() calls resolve.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(10);
    }

    const result = await promise;
    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns false when the timeout is exceeded and content never matches", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => "<title>Wrong</title>" }) as Response);
    vi.stubGlobal("fetch", fetchMock);

    const promise = pollUntilVerified("/scholarships/alpha", "Alpha Scholarship 2026", 50, 10);

    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(10);
    }

    const result = await promise;
    expect(result).toBe(false);
  });
});

describe("verifyAndMaybeRollback", () => {
  const repoDir = "/repo";
  const commitSha = "abc123";

  beforeEach(() => {
    vi.mocked(revertCommit).mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not call revertCommit when all checks verify", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => "<title>Alpha Scholarship 2026</title>" }) as Response)
    );

    const outcomes = await verifyAndMaybeRollback(
      [{ path: "/scholarships/alpha", expected: "Alpha Scholarship 2026" }],
      repoDir,
      commitSha
    );

    expect(revertCommit).not.toHaveBeenCalled();
    expect(outcomes).toEqual([{ path: "/scholarships/alpha", verified: true, reverted: false }]);
  });

  it("calls revertCommit with the right repoDir/commitSha and marks outcomes reverted when a check fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => "<title>Wrong</title>" }) as Response));
    vi.mocked(revertCommit).mockResolvedValue(undefined);

    const promise = verifyAndMaybeRollback(
      [{ path: "/scholarships/alpha", expected: "Alpha Scholarship 2026" }],
      repoDir,
      commitSha
    );
    for (let i = 0; i < 13; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }
    const outcomes = await promise;

    expect(revertCommit).toHaveBeenCalledTimes(1);
    expect(revertCommit).toHaveBeenCalledWith(repoDir, commitSha);
    expect(outcomes).toEqual([{ path: "/scholarships/alpha", verified: false, reverted: true }]);
  });

  it("does not throw and surfaces revertError when revertCommit itself throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => "<title>Wrong</title>" }) as Response));
    vi.mocked(revertCommit).mockRejectedValue(new Error("git push race: non-fast-forward"));

    const promise = verifyAndMaybeRollback(
      [{ path: "/scholarships/alpha", expected: "Alpha Scholarship 2026" }],
      repoDir,
      commitSha
    );
    for (let i = 0; i < 13; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }
    const outcomes = await promise;

    expect(revertCommit).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([
      {
        path: "/scholarships/alpha",
        verified: false,
        reverted: false,
        revertError: "git push race: non-fast-forward",
      },
    ]);
  });

  // Checks run concurrently via Promise.all, so when several of them fail at
  // once the revert must still fire exactly once for the whole commit — not
  // once per failed check. A per-check revert would try to revert the same
  // commit multiple times over.
  it("calls revertCommit exactly once when 2+ concurrent checks fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (typeof url === "string" && url.includes("/scholarships/beta")) {
          return { ok: true, text: async () => "<title>Beta Scholarship 2026</title>" } as Response;
        }
        // alpha and gamma both fail to verify
        return { ok: true, text: async () => "<title>Wrong</title>" } as Response;
      })
    );
    vi.mocked(revertCommit).mockResolvedValue(undefined);

    const promise = verifyAndMaybeRollback(
      [
        { path: "/scholarships/alpha", expected: "Alpha Scholarship 2026" },
        { path: "/scholarships/beta", expected: "Beta Scholarship 2026" },
        { path: "/scholarships/gamma", expected: "Gamma Scholarship 2026" },
      ],
      repoDir,
      commitSha
    );
    for (let i = 0; i < 13; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }
    const outcomes = await promise;

    expect(revertCommit).toHaveBeenCalledTimes(1);
    expect(revertCommit).toHaveBeenCalledWith(repoDir, commitSha);
    expect(outcomes).toEqual([
      { path: "/scholarships/alpha", verified: false, reverted: true },
      { path: "/scholarships/beta", verified: true, reverted: true },
      { path: "/scholarships/gamma", verified: false, reverted: true },
    ]);
  });
});
