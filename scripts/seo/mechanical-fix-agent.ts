/**
 * Agent: mechanical SEO fixes.
 *
 * Reads today's title/meta and accessibility reports, and for the narrow
 * set of findings that map to a single, dedicated field in a git-tracked
 * data file (scholarship seoTitle/seoDescription, university photo alt
 * text), drafts a replacement with Gemini and commits it directly.
 *
 * Everything else in those reports (static hub pages with hardcoded
 * metadata, blog dual-use fields, DB-stored scholarships) has no safe
 * single-field target and is left for the existing manual digest.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { writeReport } from "./crawl";
import { callGemini } from "./lib/gemini";
import { withinCap } from "./lib/guardrails";
import { findObjectLiteral } from "./lib/find-object-literal";
import { publishDataFileEdits, type DataFileEdit } from "./lib/publish-data-file";
import { verifyAndMaybeRollback } from "./lib/verify-and-rollback";

const TODAY = new Date().toISOString().slice(0, 10);
const MAX_MECHANICAL_FIXES_PER_RUN = Number(process.env.MAX_MECHANICAL_FIXES_PER_RUN || 10);
const ENABLED = (process.env.SEO_AUTOPUSH_MECHANICAL || "").toLowerCase() === "on";

const SCHOLARSHIPS_FILE = "data/scholarships.ts";
const UNIVERSITY_FILES: Record<string, string> = {
  "mbbs-in-china": "data/universities/china.ts",
  "mbbs-in-russia": "data/universities/russia.ts",
  "mbbs-in-georgia": "data/universities/georgia.ts",
  "mbbs-in-azerbaijan": "data/universities/azerbaijan.ts",
};
const COUNTRY_NAMES: Record<string, string> = {
  "mbbs-in-china": "China",
  "mbbs-in-russia": "Russia",
  "mbbs-in-georgia": "Georgia",
  "mbbs-in-azerbaijan": "Azerbaijan",
};

function isSafeForTsString(s: string): boolean {
  return !/["`\r\n]/.test(s);
}

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

type ScholarshipCandidate = { slug: string; missingTitle: boolean; missingDescription: boolean };
type AltCandidate = { countryFile: string; imageSrc: string };

function parseScholarshipCandidates(titleMetaReport: string): ScholarshipCandidate[] {
  const byySlug = new Map<string, ScholarshipCandidate>();
  const missingTitles = section(titleMetaReport, "Missing Titles");
  const missingDescriptions = section(titleMetaReport, "Missing Descriptions");

  const rowRe = /\|\s*(\/scholarships\/([a-z0-9-]+))\s*\|/g;

  for (const [block, field] of [
    [missingTitles, "missingTitle"],
    [missingDescriptions, "missingDescription"],
  ] as const) {
    let m: RegExpExecArray | null;
    rowRe.lastIndex = 0;
    while ((m = rowRe.exec(block))) {
      const slug = m[2];
      const existing = byySlug.get(slug) || { slug, missingTitle: false, missingDescription: false };
      existing[field] = true;
      byySlug.set(slug, existing);
    }
  }
  return [...byySlug.values()];
}

function parseAltCandidates(accessibilityReport: string): AltCandidate[] {
  const block = section(accessibilityReport, "Images With No Alt Attribute");
  const rowRe = /\|\s*(\/[^\s|]+)\s*\|\s*\[[^\]]*\]\(([^)]+)\)\s*\|/g;
  const out: AltCandidate[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(block))) {
    const path = m[1];
    // accessibility-audit.ts percent-encodes ( and ) in the href to keep its
    // markdown-link syntax unambiguous; decode back before matching against
    // the un-encoded url string literals in data/universities/*.ts
    const imageSrc = m[2].replace(/%28/g, "(").replace(/%29/g, ")");
    const countryPrefix = Object.keys(UNIVERSITY_FILES).find((p) => path.startsWith(`/${p}/`));
    if (countryPrefix) out.push({ countryFile: UNIVERSITY_FILES[countryPrefix], imageSrc });
  }
  return out;
}

async function fetchRawFile(path: string, token: string): Promise<string | null> {
  const res = await fetch(`https://raw.githubusercontent.com/tayyabali123/titans-abroad/main/${path}`, {
    headers: { Authorization: `token ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  return res.text();
}

async function draftScholarshipFix(
  slug: string,
  wantTitle: boolean,
  wantDescription: boolean,
  currentTitle: string,
  currentDescription: string
): Promise<{ title?: string; description?: string } | null> {
  const prompt = `You write SEO titles and meta descriptions for an MBBS-abroad consultancy site (Titans Abroad), for a scholarship detail page.
Scholarship slug: ${slug}
Current SEO title: ${currentTitle || "(missing)"}
Current SEO description: ${currentDescription || "(missing)"}

${wantTitle ? "Write a new SEO title, under 60 characters, mentioning the scholarship by name." : ""}
${wantDescription ? "Write a new SEO meta description, under 155 characters, factual and specific to this scholarship, no invented figures." : ""}

Respond with strict JSON only, matching this shape:
{ ${wantTitle ? `"title": "...", ` : ""}${wantDescription ? `"description": "..."` : ""} }`;

  const raw = await callGemini(prompt, true);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function draftAltText(imageSrc: string): Promise<string | null> {
  const filename = imageSrc.split("/").pop() || imageSrc;
  const prompt = `Write a short, factual alt text (under 120 characters) for a photo on a university profile page on an MBBS-abroad consultancy site. The image filename is "${filename}" — infer only what the filename plausibly tells you (do not invent specific claims about people, dates, or events). If the filename gives no useful signal, describe it generically as a photo of the university campus or facilities.

Respond with the alt text only, no quotes, no extra text.`;
  const raw = await callGemini(prompt, false);
  return raw ? raw.trim().replace(/^"|"$/g, "") : null;
}

async function main() {
  const token = process.env.SITE_REPO_TOKEN;
  if (!ENABLED) {
    writeReport("mechanical-fixes", `# Mechanical Fix Agent\n\nSEO_AUTOPUSH_MECHANICAL is not "on" — dormant this run.\n`);
    return;
  }
  if (!token) {
    writeReport("mechanical-fixes", `# Mechanical Fix Agent\n\nSITE_REPO_TOKEN not set — dormant this run.\n`);
    return;
  }

  const titleMetaReport = readReport("title-meta-audit");
  const accessibilityReport = readReport("accessibility-audit");
  const scholarshipCandidates = parseScholarshipCandidates(titleMetaReport);
  const altCandidates = parseAltCandidates(accessibilityReport);

  const edits: DataFileEdit[] = [];
  const checks: Array<{ path: string; expected: string }> = [];
  const heldBack: string[] = [];
  let budget = MAX_MECHANICAL_FIXES_PER_RUN;

  for (const cand of scholarshipCandidates) {
    if (!withinCap(edits.length + 1, budget)) break;
    const src = await fetchRawFile(SCHOLARSHIPS_FILE, token);
    if (!src) {
      heldBack.push(`${cand.slug}: could not read ${SCHOLARSHIPS_FILE}`);
      continue;
    }
    const obj = findObjectLiteral(src, `slug: "${cand.slug}"`);
    if (!obj) {
      heldBack.push(`${cand.slug}: not found in ${SCHOLARSHIPS_FILE} (likely stored in Supabase, not a git-committed file)`);
      continue;
    }
    const titleMatch = obj.text.match(/seoTitle:\s*"([^"]*)"/);
    const descMatch = obj.text.match(/seoDescription:\s*"([^"]*)"/);
    const currentTitle = titleMatch?.[1] || "";
    const currentDescription = descMatch?.[1] || "";

    const draft = await draftScholarshipFix(cand.slug, cand.missingTitle, cand.missingDescription, currentTitle, currentDescription);
    if (!draft) {
      heldBack.push(`${cand.slug}: Gemini draft failed`);
      continue;
    }
    if (cand.missingTitle && draft.title && titleMatch) {
      if (isSafeForTsString(draft.title)) {
        edits.push({
          file: SCHOLARSHIPS_FILE,
          find: `seoTitle: "${currentTitle}"`,
          replace: `seoTitle: "${draft.title}"`,
          description: `scholarship ${cand.slug}: seoTitle`,
        });
        checks.push({ path: `/scholarships/${cand.slug}`, expected: draft.title });
      } else {
        heldBack.push(`${cand.slug}: Gemini draft for seoTitle contained an unsafe character, held back`);
      }
    }
    if (cand.missingDescription && draft.description && descMatch) {
      if (isSafeForTsString(draft.description)) {
        edits.push({
          file: SCHOLARSHIPS_FILE,
          find: `seoDescription: "${currentDescription}"`,
          replace: `seoDescription: "${draft.description}"`,
          description: `scholarship ${cand.slug}: seoDescription`,
        });
        checks.push({ path: `/scholarships/${cand.slug}`, expected: draft.description });
      } else {
        heldBack.push(`${cand.slug}: Gemini draft for seoDescription contained an unsafe character, held back`);
      }
    }
  }

  for (const cand of altCandidates) {
    if (!withinCap(edits.length + 1, budget)) break;
    const src = await fetchRawFile(cand.countryFile, token);
    if (!src) {
      heldBack.push(`${cand.imageSrc}: could not read ${cand.countryFile}`);
      continue;
    }
    const obj = findObjectLiteral(src, `url: "${cand.imageSrc}"`);
    if (!obj) {
      heldBack.push(`${cand.imageSrc}: not found in ${cand.countryFile} (image is likely component-level, not in the data layer)`);
      continue;
    }
    const altMatch = obj.text.match(/alt:\s*"([^"]*)"/);
    if (!altMatch) {
      heldBack.push(`${cand.imageSrc}: found the photo entry but it has no alt field to replace`);
      continue;
    }
    const draftAlt = await draftAltText(cand.imageSrc);
    if (!draftAlt) {
      heldBack.push(`${cand.imageSrc}: Gemini draft failed`);
      continue;
    }
    if (!isSafeForTsString(draftAlt)) {
      heldBack.push(`${cand.imageSrc}: Gemini draft for alt text contained an unsafe character, held back`);
      continue;
    }
    edits.push({
      file: cand.countryFile,
      find: `alt: "${altMatch[1]}"`,
      replace: `alt: "${draftAlt}"`,
      description: `university photo ${cand.imageSrc}: alt text`,
    });
    const countryKey = Object.keys(UNIVERSITY_FILES).find((k) => UNIVERSITY_FILES[k] === cand.countryFile);
    if (countryKey) {
      checks.push({ path: `/${countryKey}`, expected: COUNTRY_NAMES[countryKey] });
    }
  }

  const result = await publishDataFileEdits(edits, [SCHOLARSHIPS_FILE, ...Object.values(UNIVERSITY_FILES)], `seo: mechanical fixes (${TODAY})`);

  let verifyLines: string[] = [];
  if (result.commitSha && result.repoDir && checks.length > 0) {
    const outcomes = await verifyAndMaybeRollback(checks, result.repoDir, result.commitSha);
    verifyLines = outcomes.map((o) => `- ${o.path}: ${o.verified ? "verified live" : o.reverted ? "reverted (verification failed)" : "not verified"}`);
  }

  const publishedLines = result.applied.map((e) => `- ${e.description}`);
  const heldLines = [...heldBack, ...result.skipped.map((s) => `${s.edit.description}: ${s.reason}`)];

  const body = `# Mechanical Fix Agent

## Auto-Published
${publishedLines.length ? publishedLines.join("\n") : "None this run."}

${verifyLines.length ? `## Verification\n${verifyLines.join("\n")}\n` : ""}
## Held Back
${heldLines.length ? heldLines.join("\n") : "None this run."}
`;
  writeReport("mechanical-fixes", body);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
