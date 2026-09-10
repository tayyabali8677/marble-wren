/**
 * Agent: scholarship deadline status correction.
 *
 * `Scholarship.status` on titansabroad.org is set once, by hand, when an
 * entry is written or last edited - nothing ever revisits it, so a single-
 * date scholarship quietly stays "open" for months after its deadline has
 * actually passed. This agent re-reads data/scholarships.ts nightly, checks
 * each "open" entry's free-text deadline against today's date using the same
 * conservative heuristic the site's own client-side fallback uses (see
 * lib/deadlineStatus.ts on titansabroad.org), and flips status to "closed"
 * only when every date it can find in the deadline text has clearly passed.
 * Anything ambiguous (unparseable text, a still-open later round, "varies
 * by institution") is left untouched rather than risk closing a scholarship
 * that's genuinely still accepting applications.
 */
import { writeReport } from "./crawl";
import { publishDataFileEdits, type DataFileEdit } from "./lib/publish-data-file";
import { verifyAndMaybeRollback, type VerifyOutcome } from "./lib/verify-and-rollback";
import { isDeadlineStale } from "./lib/deadline-dates";

const TODAY = new Date().toISOString().slice(0, 10);
const MAX_DEADLINE_FIXES_PER_RUN = Number(process.env.MAX_DEADLINE_FIXES_PER_RUN || 15);
const ENABLED = (process.env.SEO_AUTOPUSH_DEADLINES || "").toLowerCase() === "on";
const DATA_FILE = "data/scholarships.ts";

type Candidate = { slug: string; deadline: string; find: string; replace: string };

/**
 * Scans the raw scholarships.ts source for every `slug: "..."` entry whose
 * `status: "open"` and `deadline: "..."` fields (read from within that
 * entry's own object, i.e. before the next `slug:`) indicate a clearly-
 * passed deadline. The find/replace span runs from the slug line through the
 * status line - since slugs are unique across the file, that whole span is
 * guaranteed unique too, so applyExactReplace's uniqueness check can't
 * collide with another entry that also happens to say `status: "open",`.
 */
function findStaleCandidates(src: string): Candidate[] {
  const out: Candidate[] = [];
  const slugRe = /slug:\s*"([^"]+)"/g;
  const matches = [...src.matchAll(slugRe)];
  for (let i = 0; i < matches.length; i++) {
    const slug = matches[i][1];
    const start = matches[i].index!;
    const end = i + 1 < matches.length ? matches[i + 1].index! : src.length;
    const entry = src.slice(start, end);

    const statusMatch = entry.match(/status:\s*"open"/);
    if (!statusMatch) continue;
    const deadlineMatch = entry.match(/deadline:\s*"((?:[^"\\]|\\.)*)"/);
    if (!deadlineMatch) continue;
    const deadlineText = deadlineMatch[1];

    if (!isDeadlineStale(deadlineText)) continue;

    const statusEndInEntry = statusMatch.index! + statusMatch[0].length;
    const find = entry.slice(0, statusEndInEntry);
    const replace = find.replace(/status:\s*"open"/, `status: "closed"`);
    out.push({ slug, deadline: deadlineText, find, replace });
  }
  return out;
}

function formatVerifyLine(o: VerifyOutcome): string {
  if (o.verified) return `- ${o.path}: verified live`;
  if (o.revertError) {
    return `- ${o.path}: PUSHED BUT VERIFICATION FAILED AND AUTO-REVERT ALSO FAILED (${o.revertError}) — MANUAL REVIEW NEEDED`;
  }
  if (o.reverted) return `- ${o.path}: reverted (verification failed)`;
  return `- ${o.path}: not verified`;
}

async function fetchScholarshipsSource(token: string): Promise<string | null> {
  const res = await fetch(`https://raw.githubusercontent.com/tayyabali8677/titans-abroad/main/${DATA_FILE}`, {
    headers: { Authorization: `token ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  return res.text();
}

async function main() {
  const token = process.env.SITE_REPO_TOKEN;
  if (!ENABLED) {
    writeReport("deadline-status-fixes", `# Deadline Status Agent\n\nSEO_AUTOPUSH_DEADLINES is not "on" — dormant this run.\n`);
    return;
  }
  if (!token) {
    writeReport("deadline-status-fixes", `# Deadline Status Agent\n\nSITE_REPO_TOKEN not set — dormant this run.\n`);
    return;
  }

  const src = await fetchScholarshipsSource(token);
  if (!src) {
    writeReport("deadline-status-fixes", `# Deadline Status Agent\n\nCould not fetch ${DATA_FILE} from GitHub — dormant this run.\n`);
    return;
  }

  const allCandidates = findStaleCandidates(src);
  const budget = MAX_DEADLINE_FIXES_PER_RUN;
  const candidates = allCandidates.slice(0, budget);
  const overflow = allCandidates.length - candidates.length;

  const edits: DataFileEdit[] = candidates.map((c) => ({
    file: DATA_FILE,
    find: c.find,
    replace: c.replace,
    description: `${c.slug}: deadline "${c.deadline}" has passed — status open -> closed`,
  }));
  // "Currently Closed" is the status badge's unconditional label (see
  // statusLabel in app/scholarships/[slug]/page.tsx) - unlike the "Check the
  // Official Website" CTA, it renders regardless of whether the scholarship
  // has an officialWebsite set, so it's a reliable verification target for
  // every entry this agent might touch.
  const checks = candidates.map((c) => ({
    path: `/scholarships/${c.slug}`,
    expected: "Currently Closed",
  }));

  const result = await publishDataFileEdits(edits, [DATA_FILE], `seo: close scholarships past their deadline (${TODAY})`);

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
  // so "Auto-Closed" alone never reads as a clean success for those.
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
  const heldLines = result.skipped.map((s) => `${s.edit.description}: ${s.reason}`);

  const body = `# Deadline Status Agent

Scanned ${DATA_FILE} for "open" scholarships whose deadline text has clearly
passed. Found ${allCandidates.length} candidate${allCandidates.length === 1 ? "" : "s"} this run${overflow > 0 ? ` (capped at ${budget}/run, ${overflow} carried to a future run)` : ""}.

## Auto-Published
${publishedLines.length ? publishedLines.join("\n") : "None this run."}

${verifyLines.length ? `## Verification\n${verifyLines.join("\n")}\n` : ""}
## Held Back
${heldLines.length ? heldLines.join("\n") : "None this run."}
`;
  writeReport("deadline-status-fixes", body);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
