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
const MAX_FEE_FIXES_PER_RUN = Number(process.env.MAX_FEE_FIXES_PER_RUN || 10);
const ENABLED = (process.env.SEO_AUTOPUSH_FEECHECK || "").toLowerCase() === "on";

// The site being edited. A source hosted here can't count as independent
// verification of a number this agent is about to write back onto its own
// page, so any result on this host (or a subdomain of it) is excluded before
// the 2-source agreement check ever sees it. Matches the OWN_HOST convention
// used elsewhere in scripts/seo (e.g. serp-tracker.ts, image-seo.ts).
const OWN_HOST = "titansabroad.org";

// Two sources agreeing is only meaningful if at least one of them is likely
// to actually know the fact, not just repeat it. Generic blogs and SEO
// content mills routinely scrape each other's tuition figures, so require
// at least one agreeing source to be an academic (.edu / .edu.<cc> / .ac.<cc>)
// or government (.gov) domain — the kind of domain an official university or
// education-ministry page would use.
//
// This can't be a single loose regex: `.edu` and `.gov` are themselves real
// TLDs (a hostname either ends in exactly `.edu`/`.gov`, or it doesn't — there
// is no legitimate `.edu.com` or `.gov.com`), while `.ac` is only ever a
// second-level label in front of a genuine two-letter country-code TLD (e.g.
// `.ac.uk`, `.ac.in`). A naive `(\.[a-z]{2,3})?` suffix would happily match
// spoofs like `fake.ac.com` or `fake.gov.com`, so the country-code piece is
// checked against a real ISO 3166-1 alpha-2 list instead of "any 2-3 letters".
const EDU_EXACT_RE = /\.edu$/i;
const GOV_EXACT_RE = /\.gov$/i;
const EDU_CC_RE = /\.edu\.([a-z]{2})$/i;
const AC_CC_RE = /\.ac\.([a-z]{2})$/i;

// ISO 3166-1 alpha-2 country codes, lowercase. Used to validate the country
// component of .edu.<cc> and .ac.<cc> hosts so an arbitrary 2-letter string
// (or a fake TLD that happens to be 2-3 letters) can't pass as "authoritative".
//
// "uk" is included alongside the strict ISO list even though the United
// Kingdom's ISO 3166-1 alpha-2 code is technically "gb" — its country-code
// TLD is the long-standing exception ".uk" (not ".gb"), and ".ac.uk" is a
// real, common academic domain suffix (e.g. soton.ac.uk) that would otherwise
// be wrongly rejected.
const ISO_3166_ALPHA2 = new Set([
  "ad", "ae", "af", "ag", "ai", "al", "am", "ao", "aq", "ar", "as", "at", "au", "aw", "ax", "az",
  "ba", "bb", "bd", "be", "bf", "bg", "bh", "bi", "bj", "bl", "bm", "bn", "bo", "bq", "br", "bs",
  "bt", "bv", "bw", "by", "bz",
  "ca", "cc", "cd", "cf", "cg", "ch", "ci", "ck", "cl", "cm", "cn", "co", "cr", "cu", "cv", "cw",
  "cx", "cy", "cz",
  "de", "dj", "dk", "dm", "do", "dz",
  "ec", "ee", "eg", "eh", "er", "es", "et",
  "fi", "fj", "fk", "fm", "fo", "fr",
  "ga", "gb", "gd", "ge", "gf", "gg", "gh", "gi", "gl", "gm", "gn", "gp", "gq", "gr", "gs", "gt",
  "gu", "gw", "gy",
  "hk", "hm", "hn", "hr", "ht", "hu",
  "id", "ie", "il", "im", "in", "io", "iq", "ir", "is", "it",
  "je", "jm", "jo", "jp",
  "ke", "kg", "kh", "ki", "km", "kn", "kp", "kr", "kw", "ky", "kz",
  "la", "lb", "lc", "li", "lk", "lr", "ls", "lt", "lu", "lv", "ly",
  "ma", "mc", "md", "me", "mf", "mg", "mh", "mk", "ml", "mm", "mn", "mo", "mp", "mq", "mr", "ms",
  "mt", "mu", "mv", "mw", "mx", "my", "mz",
  "na", "nc", "ne", "nf", "ng", "ni", "nl", "no", "np", "nr", "nu", "nz",
  "om",
  "pa", "pe", "pf", "pg", "ph", "pk", "pl", "pm", "pn", "pr", "ps", "pt", "pw", "py",
  "qa",
  "re", "ro", "rs", "ru", "rw",
  "sa", "sb", "sc", "sd", "se", "sg", "sh", "si", "sj", "sk", "sl", "sm", "sn", "so", "sr", "ss",
  "st", "sv", "sx", "sy", "sz",
  "tc", "td", "tf", "tg", "th", "tj", "tk", "tl", "tm", "tn", "to", "tr", "tt", "tv", "tw", "tz",
  "ua", "ug", "uk", "um", "us", "uy", "uz",
  "va", "vc", "ve", "vg", "vi", "vn", "vu",
  "wf", "ws",
  "ye", "yt",
  "za", "zm", "zw",
]);

function isOwnHost(hostname: string): boolean {
  return hostname === OWN_HOST || hostname.endsWith(`.${OWN_HOST}`);
}

function isRealCountryCode(cc: string): boolean {
  return ISO_3166_ALPHA2.has(cc.toLowerCase());
}

function isAuthoritativeHost(hostname: string): boolean {
  const host = hostname.toLowerCase();

  if (EDU_EXACT_RE.test(host) || GOV_EXACT_RE.test(host)) return true;

  const eduCcMatch = host.match(EDU_CC_RE);
  if (eduCcMatch && isRealCountryCode(eduCcMatch[1])) return true;

  const acCcMatch = host.match(AC_CC_RE);
  if (acCcMatch && isRealCountryCode(acCcMatch[1])) return true;

  return false;
}

const COUNTRY_FILES: Record<string, string> = {
  China: "app/mbbs-in-china/page.tsx",
  Russia: "app/mbbs-in-russia/page.tsx",
  Georgia: "app/mbbs-in-georgia/page.tsx",
  Azerbaijan: "app/mbbs-in-azerbaijan/page.tsx",
};

// Must match fact-drift.ts's COUNTRIES prefixes exactly, so a candidate is
// only accepted when it was actually detected on the hub page this agent is
// about to edit — not some other page that merely mentioned the country.
const HUB_PATHS: Record<string, string> = {
  China: "/mbbs-in-china/",
  Russia: "/mbbs-in-russia/",
  Georgia: "/mbbs-in-georgia/",
  Azerbaijan: "/mbbs-in-azerbaijan/",
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

type FeeCandidate = { page: string; country: string; claimed: string; actually: string; raw: string };

function parseFeeCandidates(factDriftReport: string): FeeCandidate[] {
  const block = section(factDriftReport, "Fee Ranges Narrower Than Reality");
  const rowRe = /\|\s*(\S+)\s*\|\s*(China|Russia|Georgia|Azerbaijan)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*[^|]+?\s*\|\s*`([^`]+)`\s*\|/g;
  const out: FeeCandidate[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(block))) {
    out.push({ page: m[1], country: m[2], claimed: m[3].trim(), actually: m[4].trim(), raw: m[5].trim() });
  }
  return out;
}

async function serperSearch(query: string, apiKey: string): Promise<Array<{ snippet: string; link: string }>> {
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: 5 }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    const organic = (data?.organic || []) as Array<{ snippet?: string; link?: string }>;
    return organic
      .filter((o) => o.snippet && o.link)
      .map((o) => ({ snippet: o.snippet as string, link: o.link as string }));
  } catch {
    return [];
  }
}

async function findAgreedRange(country: string): Promise<DollarRange | null> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return null;
  const results = await serperSearch(`MBBS in ${country} tuition fee per year USD official`, apiKey);
  const withRanges = results
    .map((r) => {
      const range = parseDollarRange(r.snippet);
      if (!range) return null;
      let hostname: string;
      try {
        hostname = new URL(r.link).hostname;
      } catch {
        return null;
      }
      return { range, hostname };
    })
    .filter((r): r is { range: DollarRange; hostname: string } => r !== null)
    // The site being edited can't verify its own claim.
    .filter((r) => !isOwnHost(r.hostname));
  const ranges = withRanges.map((r) => r.range);
  const distinctHosts = new Set(withRanges.map((r) => r.hostname));
  const hasAuthoritativeSource = withRanges.some((r) => isAuthoritativeHost(r.hostname));
  if (
    ranges.length < 2 ||
    distinctHosts.size < 2 ||
    !hasAuthoritativeSource ||
    !dollarRangesAgree(ranges)
  ) {
    return null;
  }
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
  const agreedByCountry = new Map<string, DollarRange | null>();

  for (const cand of candidates) {
    if (!withinCap(edits.length + 1, budget)) break;
    const file = COUNTRY_FILES[cand.country];
    if (!file) {
      heldBack.push(`${cand.page}: no known hub-page file for ${cand.country}`);
      continue;
    }
    if (cand.page !== HUB_PATHS[cand.country]) {
      heldBack.push(`${cand.page}: drift was found on a non-hub page, not ${HUB_PATHS[cand.country]} — skipping to avoid editing the wrong file`);
      continue;
    }
    let agreed: DollarRange | null;
    if (agreedByCountry.has(cand.country)) {
      agreed = agreedByCountry.get(cand.country)!;
    } else {
      agreed = await findAgreedRange(cand.country);
      agreedByCountry.set(cand.country, agreed);
    }
    if (!agreed) {
      heldBack.push(`${cand.page}: could not find 2 independent sources agreeing on a ${cand.country} fee range`);
      continue;
    }
    const newValue = formatRange(agreed);
    const edit: DataFileEdit = {
      file,
      find: cand.raw,
      replace: newValue,
      description: `${cand.country} hub page fee range: ${cand.raw} -> ${newValue}`,
    };
    edits.push(edit);
    checks.push({ path: cand.page, expected: newValue });
  }

  const result = await publishDataFileEdits(edits, Object.values(COUNTRY_FILES), `seo: fee range corrections (${TODAY})`);

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
