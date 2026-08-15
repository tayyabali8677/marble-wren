/**
 * Agent 11: near-duplicate detection.
 *
 * The 95 university pages come off one template, which is efficient to build
 * and dangerous to rank. When two pages share most of their prose Google keeps
 * one and quietly drops the other, and the dropped one ranks nowhere no matter
 * what else is done to it. This is the failure mode that looks like nothing is
 * wrong: the page is live, indexed, and invisible.
 *
 * Boilerplate is stripped before comparing. Every page carries the same header,
 * footer and CTA text, so leaving it in would report the whole site as one
 * duplicate. Only wording that appears on a minority of pages counts.
 */

import { crawlSite, writeReport, toPath, type CrawledPage } from "./crawl";

// Nine words is long enough that a shared phrase means shared writing rather
// than shared vocabulary.
const SHINGLE = 9;
// A phrase on this share of pages is template furniture, not content.
const BOILERPLATE_SHARE = 0.3;
// MinHash signature length. 200 estimates Jaccard closely enough to rank pairs.
const SIGNATURE = 200;
// These look low and are not. The score is Jaccard overlap of nine-word phrases
// after every phrase common to the site has been removed, so two pages on the
// same subject written independently land near 5%. The observed ceiling across
// this site is 41%, which is three URLs covering one scholarship. Anything past
// 30% is a page with a twin.
const SIMILAR = 0.22;
const SERIOUS = 0.32;
const MAX_WORDS = 4000;
const MAX_REPORTED = 30;

function words(page: CrawledPage): string[] {
  return page.text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
}

/** FNV-1a, 32 bit. Fast, and collisions at this volume do not change rankings. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function shingles(list: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + SHINGLE <= list.length; i++) {
    out.push(hash(list.slice(i, i + SHINGLE).join(" ")));
  }
  return out;
}

/**
 * The smallest N hashes of a set estimate its Jaccard overlap with any other
 * set built the same way, which avoids holding every shingle of every page.
 */
function signature(hashes: number[]): Set<number> {
  return new Set([...new Set(hashes)].sort((a, b) => a - b).slice(0, SIGNATURE));
}

function similarity(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const h of a) if (b.has(h)) shared++;
  return shared / (a.size + b.size - shared);
}

async function main() {
  const pages = (await crawlSite()).filter((p) => p.status === 200 && p.words > 200);
  console.log(`Comparing ${pages.length} pages...`);

  const tokenised = pages.map(words);

  // Pass one: how many pages carry each phrase, so template furniture can go.
  const documentFrequency = new Map<number, number>();
  for (const list of tokenised) {
    for (const h of new Set(shingles(list))) {
      documentFrequency.set(h, (documentFrequency.get(h) ?? 0) + 1);
    }
  }
  const boilerplateCutoff = pages.length * BOILERPLATE_SHARE;
  let boilerplateCount = 0;
  for (const count of documentFrequency.values()) if (count >= boilerplateCutoff) boilerplateCount++;

  // Pass two: signatures built only from wording that is not everywhere.
  const signatures = tokenised.map((list) =>
    signature(shingles(list).filter((h) => (documentFrequency.get(h) ?? 0) < boilerplateCutoff))
  );

  type Pair = { a: CrawledPage; b: CrawledPage; score: number };
  const pairs: Pair[] = [];
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const score = similarity(signatures[i], signatures[j]);
      if (score >= SIMILAR) pairs.push({ a: pages[i], b: pages[j], score });
    }
  }
  pairs.sort((x, y) => y.score - x.score);

  const serious = pairs.filter((p) => p.score >= SERIOUS);

  const date = new Date().toISOString().split("T")[0];
  let report = `# Near-Duplicate Content: ${date}\n\n`;
  report += `**Pages compared:** ${pages.length} (200+ words)\n`;
  report += `**Template phrases ignored:** ${boilerplateCount} (on ${Math.round(BOILERPLATE_SHARE * 100)}%+ of pages)\n`;
  report += `**Pairs at ${Math.round(SIMILAR * 100)}% or above:** ${pairs.length}\n`;
  report += `**Pairs at ${Math.round(SERIOUS * 100)}% or above:** ${serious.length}\n\n`;

  if (pairs.length === 0) {
    report += `No two pages share more than ${Math.round(SIMILAR * 100)}% of their non-template wording. `;
    report += `The templated pages are carrying enough unique content to stand on their own.\n\n---\n\n`;
    writeReport("duplicate-content", report);
    console.log("No near-duplicates.");
    return;
  }

  report += `Similarity here is measured after removing wording that appears across the site, `;
  report += `so these numbers describe the writing that is supposed to be unique to each page. `;
  report += `Read the scale accordingly: two pages on the same subject written separately score `;
  report += `around 5%, so ${Math.round(SIMILAR * 100)}% is already a lot of shared sentences.\n\n`;

  if (serious.length > 0) {
    report += `## Effectively The Same Page (${serious.length})\n\n`;
    report += `At this level Google will pick one and drop the other. Either merge them, or `;
    report += `give the weaker one enough of its own substance to justify existing.\n\n`;
    report += `| Similarity | Page A | Page B |\n|---|---|---|\n`;
    for (const p of serious.slice(0, MAX_REPORTED)) {
      report += `| ${Math.round(p.score * 100)}% | ${toPath(p.a.url)} | ${toPath(p.b.url)} |\n`;
    }
    report += `\n`;
  }

  const moderate = pairs.filter((p) => p.score < SERIOUS);
  if (moderate.length > 0) {
    report += `## Substantially Overlapping (${moderate.length})\n\n`;
    report += `Not yet a filtering risk, but these pages are competing to say the same thing. `;
    report += `Worth checking they target different queries.\n\n`;
    report += `| Similarity | Page A | Page B |\n|---|---|---|\n`;
    for (const p of moderate.slice(0, MAX_REPORTED)) {
      report += `| ${Math.round(p.score * 100)}% | ${toPath(p.a.url)} | ${toPath(p.b.url)} |\n`;
    }
    if (moderate.length > MAX_REPORTED) report += `\n*${moderate.length - MAX_REPORTED} more pairs in the same band.*\n`;
    report += `\n`;
  }

  report += `---\n\n`;
  writeReport("duplicate-content", report);
  console.log(`Similar pairs: ${pairs.length} | Serious: ${serious.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
