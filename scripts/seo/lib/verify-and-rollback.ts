import { revertCommit } from "./publish-data-file";

const SITE_ORIGIN = "https://titansabroad.org";

export function containsExpected(html: string, expected: string): boolean {
  return html.includes(expected);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls a page path until it 200s and contains the expected text, up to a
 * timeout. Deploys after a bot push are not instant, so a single fetch
 * right after pushing would false-negative on every run.
 */
export async function pollUntilVerified(
  path: string,
  expected: string,
  timeoutMs = 180_000,
  intervalMs = 15_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${SITE_ORIGIN}${path}`, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const html = await res.text();
        if (containsExpected(html, expected)) return true;
      }
    } catch {
      // network hiccup or deploy not live yet — fall through to retry
    }
    await sleep(intervalMs);
  }
  return false;
}

export type VerifyOutcome = {
  path: string;
  verified: boolean;
  reverted: boolean;
  revertError?: string;
};

/**
 * Verifies each pushed change is actually live, and reverts the whole
 * commit if any one of them isn't — an edit that only half-applied
 * (some pages fixed, one broken) shouldn't stay on main partially wrong.
 *
 * If the revert attempt itself throws (git conflict, push race, network
 * failure), the failure is surfaced on each outcome's `revertError` rather
 * than propagating — this is the safety net's own failure mode, so callers
 * need a structured signal instead of an unhandled exception.
 */
export async function verifyAndMaybeRollback(
  checks: Array<{ path: string; expected: string }>,
  repoDir: string,
  commitSha: string
): Promise<VerifyOutcome[]> {
  const outcomes: VerifyOutcome[] = [];
  for (const check of checks) {
    const verified = await pollUntilVerified(check.path, check.expected);
    outcomes.push({ path: check.path, verified, reverted: false });
  }

  const anyFailed = outcomes.some((o) => !o.verified);
  if (anyFailed) {
    try {
      await revertCommit(repoDir, commitSha);
      for (const o of outcomes) o.reverted = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const o of outcomes) {
        o.reverted = false;
        o.revertError = message;
      }
    }
  }

  return outcomes;
}
