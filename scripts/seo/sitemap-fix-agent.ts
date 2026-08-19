/**
 * Agent: sitemap entry corrections.
 *
 * canonical-audit.ts finds sitemap URLs that redirect instead of landing
 * directly. This agent only touches app/sitemap.ts's hand-maintained
 * staticRoutes array — never next.config.js redirects, route files, or
 * page structure — so it changes what search engines are told, not how
 * the site actually routes.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { writeReport } from "./crawl";
import { withinCap } from "./lib/guardrails";
import { publishDataFileEdits, type DataFileEdit } from "./lib/publish-data-file";
import { verifyAndMaybeRollback, type VerifyOutcome } from "./lib/verify-and-rollback";

function formatVerifyLine(o: VerifyOutcome): string {
  if (o.verified) return `- ${o.path}: verified live`;
  if (o.revertError) {
    return `- ${o.path}: PUSHED BUT VERIFICATION FAILED AND AUTO-REVERT ALSO FAILED (${o.revertError}) — MANUAL REVIEW NEEDED`;
  }
  if (o.reverted) return `- ${o.path}: reverted (verification failed)`;
  return `- ${o.path}: not verified`;
}

const TODAY = new Date().toISOString().slice(0, 10);
const MAX_SITEMAP_FIXES_PER_RUN = Number(process.env.MAX_SITEMAP_FIXES_PER_RUN || 20);
const ENABLED = (process.env.SEO_AUTOPUSH_SITEMAP || "").toLowerCase() === "on";
const SITEMAP_FILE = "app/sitemap.ts";
const BASE = "https://titansabroad.org";

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

type RedirectCandidate = { listed: string; landsOn: string };

function parseRedirectCandidates(canonicalReport: string): RedirectCandidate[] {
  const block = section(canonicalReport, "Sitemap URLs That Redirect");
  const rowRe = /\|\s*(\/\S*)\s*\|\s*(\/\S*)\s*\|/g;
  const out: RedirectCandidate[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(block))) {
    out.push({ listed: m[1], landsOn: m[2] });
  }
  return out;
}

async function fetchStaticRoutesSection(token: string): Promise<string | null> {
  const res = await fetch(`https://raw.githubusercontent.com/tayyabali123/titans-abroad/main/${SITEMAP_FILE}`, {
    headers: { Authorization: `token ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  return res.text();
}

async function main() {
  const token = process.env.SITE_REPO_TOKEN;
  if (!ENABLED) {
    writeReport("sitemap-fixes", `# Sitemap Fix Agent\n\nSEO_AUTOPUSH_SITEMAP is not "on" — dormant this run.\n`);
    return;
  }
  if (!token) {
    writeReport("sitemap-fixes", `# Sitemap Fix Agent\n\nSITE_REPO_TOKEN not set — dormant this run.\n`);
    return;
  }

  const canonicalReport = readReport("canonical-audit");
  const candidates = parseRedirectCandidates(canonicalReport);
  const src = await fetchStaticRoutesSection(token);

  const edits: DataFileEdit[] = [];
  const checks: Array<{ path: string; expected: string }> = [];
  const heldBack: string[] = [];
  const budget = MAX_SITEMAP_FIXES_PER_RUN;

  if (!src) {
    writeReport("sitemap-fixes", `# Sitemap Fix Agent\n\nCould not read ${SITEMAP_FILE} from the repo — dormant this run.\n`);
    return;
  }

  // staticRoutes entries look like: `${BASE}/some-path`
  const staticRoutesStart = src.indexOf("staticRoutes");
  const staticRoutesBlock = staticRoutesStart === -1 ? "" : src.slice(staticRoutesStart);
  const staticRoutesEnd = staticRoutesBlock.indexOf("];");
  const staticRoutesText = staticRoutesEnd === -1 ? staticRoutesBlock : staticRoutesBlock.slice(0, staticRoutesEnd);

  for (const cand of candidates) {
    if (!withinCap(edits.length + 1, budget)) break;
    const oldEntry = `\`\${BASE}${cand.listed}\``;
    if (!staticRoutesText.includes(oldEntry)) {
      heldBack.push(`${cand.listed} -> ${cand.landsOn}: not a static route entry (likely programmatic, out of scope for this agent)`);
      continue;
    }
    const newEntry = `\`\${BASE}${cand.landsOn}\``;
    edits.push({
      file: SITEMAP_FILE,
      find: oldEntry,
      replace: newEntry,
      description: `sitemap: ${cand.listed} -> ${cand.landsOn}`,
    });
    // Every check here targets the same /sitemap.xml path (just a different
    // expected substring), so downstream correlation must go by array index,
    // not by path — a path-keyed map would collide across candidates.
    checks.push({ path: "/sitemap.xml", expected: `${BASE}${cand.landsOn}` });
  }

  const result = await publishDataFileEdits(edits, [SITEMAP_FILE], `seo: sitemap entry corrections (${TODAY})`);

  let verifyLines: string[] = [];
  const outcomeByEdit = new Map<DataFileEdit, VerifyOutcome>();
  if (result.commitSha && result.repoDir && checks.length > 0) {
    const outcomes = await verifyAndMaybeRollback(checks, result.repoDir, result.commitSha);
    verifyLines = outcomes.map(formatVerifyLine);
    // checks (and therefore outcomes) were built in the same order as edits.
    edits.forEach((e, i) => outcomeByEdit.set(e, outcomes[i]));
  }

  // An edit that was committed still shows up here even if it failed
  // verification and got reverted (or the revert itself failed) — annotate it
  // so "Auto-Published" alone never reads as a clean success for those.
  const publishedLines = result.applied.map((e) => {
    const outcome = outcomeByEdit.get(e);
    if (!outcome || outcome.verified) return `- ${e.description}`;
    const marker = outcome.revertError
      ? " [PUSHED BUT ROLLBACK FAILED — STILL LIVE, NEEDS MANUAL REVIEW]"
      : outcome.reverted
        ? " [REVERTED]"
        : " [NOT VERIFIED]";
    return `- ${e.description}${marker}`;
  });
  const heldLines = [...heldBack, ...result.skipped.map((s) => `${s.edit.description}: ${s.reason}`)];

  const body = `# Sitemap Fix Agent

## Auto-Published
${publishedLines.length ? publishedLines.join("\n") : "None this run."}

${verifyLines.length ? `## Verification\n${verifyLines.join("\n")}\n` : ""}
## Held Back
${heldLines.length ? heldLines.join("\n") : "None this run."}
`;
  writeReport("sitemap-fixes", body);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
