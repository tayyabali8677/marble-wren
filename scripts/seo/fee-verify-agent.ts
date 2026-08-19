/**
 * Agent: fee-range corrections.
 *
 * fact-drift.ts finds hub-page fee claims narrower than what our own crawl
 * data shows. A wrong number here is a false claim on a live page, so this
 * agent never trusts the crawl alone: it searches for the claim's official
 * source pages and only pushes a correction when 2+ independent sources
 * agree on the same range. One source, or disagreement, is held back.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { writeReport } from "./crawl";
import { withinCap, parseDollarRange, dollarRangesAgree, type DollarRange } from "./lib/guardrails";
import { publishDataFileEdits, applyExactReplace, type DataFileEdit } from "./lib/publish-data-file";
import { verifyAndMaybeRollback } from "./lib/verify-and-rollback";

const TODAY = new Date().toISOString().slice(0, 10);
const MAX_FEE_FIXES_PER_RUN = Number(process.env.MAX_FEE_FIXES_PER_RUN || 10);
const ENABLED = (process.env.SEO_AUTOPUSH_FEECHECK || "").toLowerCase() === "on";

const COUNTRY_FILES: Record<string, string> = {
  China: "app/mbbs-in-china/page.tsx",
  Russia: "app/mbbs-in-russia/page.tsx",
  Georgia: "app/mbbs-in-georgia/page.tsx",
  Azerbaijan: "app/mbbs-in-azerbaijan/page.tsx",
};

function readReport(name: string): string {
  const path = join("reports", `${name}-${TODAY}.md`);
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

function section(report: string, heading: string): string {
  const start = report.indexOf(`## ${heading}`);
  if (start === -1) return "";
  const rest = report.slice(start + heading.length + 3);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

type FeeCandidate = { page: string; country: string; claimed: string; actually: string };

function parseFeeCandidates(factDriftReport: string): FeeCandidate[] {
  const block = section(factDriftReport, "Fee Ranges Narrower Than Reality");
  const rowRe = /\|\s*(\S+)\s*\|\s*(China|Russia|Georgia|Azerbaijan)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/g;
  const out: FeeCandidate[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(block))) {
    out.push({ page: m[1], country: m[2], claimed: m[3].trim(), actually: m[4].trim() });
  }
  return out;
}

async function serperSearch(query: string, apiKey: string): Promise<string[]> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: 5 }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as any;
  const organic = (data?.organic || []) as Array<{ snippet?: string }>;
  return organic.map((o) => o.snippet || "").filter(Boolean);
}

async function findAgreedRange(country: string): Promise<DollarRange | null> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return null;
  const snippets = await serperSearch(`MBBS in ${country} tuition fee per year USD official`, apiKey);
  const ranges = snippets.map(parseDollarRange).filter((r): r is DollarRange => r !== null);
  if (ranges.length < 2 || !dollarRangesAgree(ranges)) return null;
  return ranges[0];
}

function formatRange(r: DollarRange): string {
  return `$${r.low.toLocaleString()}–$${r.high.toLocaleString()}`;
}

async function main() {
  const token = process.env.SITE_REPO_TOKEN;
  if (!ENABLED) {
    writeReport("fee-fixes", `# Fee Verify Agent\n\nSEO_AUTOPUSH_FEECHECK is not "on" — dormant this run.\n`);
    return;
  }
  if (!token) {
    writeReport("fee-fixes", `# Fee Verify Agent\n\nSITE_REPO_TOKEN not set — dormant this run.\n`);
    return;
  }
  if (!process.env.SERPER_API_KEY) {
    writeReport("fee-fixes", `# Fee Verify Agent\n\nSERPER_API_KEY not set — dormant this run (no way to gather independent sources).\n`);
    return;
  }

  const factDriftReport = readReport("fact-drift");
  const candidates = parseFeeCandidates(factDriftReport);

  const edits: DataFileEdit[] = [];
  const checks: Array<{ path: string; expected: string }> = [];
  const heldBack: string[] = [];
  const budget = MAX_FEE_FIXES_PER_RUN;

  for (const cand of candidates) {
    if (!withinCap(edits.length + 1, budget)) break;
    const file = COUNTRY_FILES[cand.country];
    if (!file) {
      heldBack.push(`${cand.page}: no known hub-page file for ${cand.country}`);
      continue;
    }
    const agreed = await findAgreedRange(cand.country);
    if (!agreed) {
      heldBack.push(`${cand.page}: could not find 2 independent sources agreeing on a ${cand.country} fee range`);
      continue;
    }
    const newValue = formatRange(agreed);
    edits.push({
      file,
      find: `"${cand.claimed}"`,
      replace: `"${newValue}"`,
      description: `${cand.country} hub page fee range: ${cand.claimed} -> ${newValue}`,
    });
    checks.push({ path: cand.page, expected: newValue });
  }

  const result = await publishDataFileEdits(edits, Object.values(COUNTRY_FILES), `seo: fee range corrections (${TODAY})`);

  let verifyLines: string[] = [];
  if (result.commitSha && result.repoDir && checks.length > 0) {
    const outcomes = await verifyAndMaybeRollback(checks, result.repoDir, result.commitSha);
    verifyLines = outcomes.map((o) => `- ${o.path}: ${o.verified ? "verified live" : o.reverted ? "reverted (verification failed)" : "not verified"}`);
  }

  const publishedLines = result.applied.map((e) => `- ${e.description}`);
  const heldLines = [...heldBack, ...result.skipped.map((s) => `${s.edit.description}: ${s.reason}`)];

  const body = `# Fee Verify Agent

## Auto-Published
${publishedLines.length ? publishedLines.join("\n") : "None this run."}

${verifyLines.length ? `## Verification\n${verifyLines.join("\n")}\n` : ""}
## Held Back
${heldLines.length ? heldLines.join("\n") : "None this run."}
`;
  writeReport("fee-fixes", body);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
