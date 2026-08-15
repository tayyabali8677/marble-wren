/**
 * Agent 16: E-E-A-T signals.
 *
 * Medical education is squarely YMYL: someone reads a fee figure or an
 * eligibility rule here and makes a decision that costs them years and a
 * fortune. Google holds this category to a visibly higher bar for who wrote the
 * page, when it was last checked, and what it cites. A correct page with none
 * of those signals still loses to a worse page that has them.
 *
 * This cannot judge whether the site is authoritative. It can only check that
 * the signals a reader and a rater look for are present on the page: a named
 * author, a visible date, and a link to a primary source rather than an
 * assertion. Their absence is not proof of low quality, but on a money-and-life
 * topic it is the cheapest quality gap to close.
 */

import { crawlSite, writeReport, toPath, type CrawledPage } from "./crawl";

const MAX_REPORTED = 30;

// A page that carries real advice and therefore should show its work. Thin
// index and category pages are exempt: nobody expects a byline on a list.
const MIN_WORDS = 400;

// Primary sources for this subject. A link to one of these is a citation; a
// sentence asserting the same fact without one is not.
const AUTHORITATIVE = [
  "moe.gov.cn", "pmc.gov.pk", "pmdc.pk", "hec.gov.pk", "who.int", "wdomsdirectory",
  "faimer", "ecfmg.org", "russia.study", "edu.cn", ".gov.pk", ".gov.cn", ".gov.ge",
  "ibcc.edu.pk", "mofa.gov.pk", "nmc.org.in",
];

// Text that signals a human with standing wrote or checked this. A bare
// "by Two Capitalised Words" is deliberately excluded: it fires on "by Harbin
// Medical University" and "by Chinese Government" far more than on any byline,
// and a signal that mostly matches prose reports the wrong pages as safe.
const AUTHOR_MARKERS = [
  /\bwritten by\b/i,
  /\breviewed by\b/i,
  /\bauthor(?:ed by)?[:\s]/i,
  /\bmedically reviewed\b/i,
  /\bby\s+(?:dr|prof|professor)\.?\s+[A-Z][a-z]+/,
];
const CREDENTIAL_MARKERS = [
  /\bMBBS\b/, /\bMD\b/, /\bPhD\b/, /\bconsultant\b/i, /\bprofessor\b/i, /\beducation (?:consultant|advisor|adviser)\b/i,
];

// A visible freshness date. Content that turns over on an admissions cycle
// needs to show it was checked for this cycle.
const DATE_MARKERS = [
  /\b(?:updated|last updated|reviewed|published)(?:\s+on)?[:\s]+\w+\s+\d{1,2},?\s+\d{4}/i,
  /\b(?:updated|reviewed)(?:\s+on)?[:\s]+\d{1,2}\s+\w+\s+\d{4}/i,
  /\b(?:updated|reviewed|published)\s+\w+\s+\d{4}/i,
];
const CURRENT_YEAR = new Date().getFullYear();

function anyMatch(text: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(text));
}

function citationCount(page: CrawledPage): number {
  return page.externalLinks.filter((href) => {
    const lower = href.toLowerCase();
    return AUTHORITATIVE.some((d) => lower.includes(d));
  }).length;
}

/** A year mentioned in the body that is not the current or next cycle. */
function staleYear(page: CrawledPage): number | null {
  const years = [...page.text.matchAll(/\b(20\d{2})\b/g)]
    .map((m) => parseInt(m[1], 10))
    .filter((y) => y >= 2018 && y <= CURRENT_YEAR + 1);
  if (years.length === 0) return null;
  const newest = Math.max(...years);
  return newest < CURRENT_YEAR ? newest : null;
}

async function main() {
  const pages = (await crawlSite())
    .filter((p) => p.status === 200 && p.words >= MIN_WORDS);
  console.log(`Checking ${pages.length} substantial pages...`);

  type Finding = {
    path: string;
    words: number;
    author: boolean;
    credential: boolean;
    date: boolean;
    citations: number;
    stale: number | null;
  };

  const findings: Finding[] = pages.map((page) => ({
    path: toPath(page.url),
    words: page.words,
    author: anyMatch(page.text, AUTHOR_MARKERS),
    credential: anyMatch(page.text, CREDENTIAL_MARKERS),
    date: anyMatch(page.text, DATE_MARKERS),
    citations: citationCount(page),
    stale: staleYear(page),
  }));

  const noAuthor = findings.filter((f) => !f.author);
  const noDate = findings.filter((f) => !f.date);
  const noCitations = findings.filter((f) => f.citations === 0);
  const staleDated = findings.filter((f) => f.stale !== null && !f.date);

  // The pages that fail on every axis are where a rater's eye lands first.
  const scored = findings
    .map((f) => ({
      ...f,
      gaps: (!f.author ? 1 : 0) + (!f.date ? 1 : 0) + (f.citations === 0 ? 1 : 0),
    }))
    .filter((f) => f.gaps > 0)
    .sort((a, b) => b.gaps - a.gaps || b.words - a.words);

  const date = new Date().toISOString().split("T")[0];
  let report = `# E-E-A-T Signals: ${date}\n\n`;
  report += `**Substantial pages checked (${MIN_WORDS}+ words):** ${pages.length}\n`;
  report += `**No named author:** ${noAuthor.length}\n`;
  report += `**No visible date:** ${noDate.length}\n`;
  report += `**No citation to a primary source:** ${noCitations.length}\n`;
  report += `**Newest date on the page is a past year, with no update stamp:** ${staleDated.length}\n\n`;

  report += `These are signals, not verdicts. A page can be authoritative without a byline. `;
  report += `But on a topic where a wrong figure costs a reader years, the absence of an `;
  report += `author, a date, and a source is the gap Google's raters are trained to notice, `;
  report += `and it is cheap to close.\n\n`;

  if (scored.length > 0) {
    report += `## Weakest On Trust Signals (${scored.length})\n\n`;
    report += `Ranked by how many of the three signals are missing, then by length, so the `;
    report += `longest pages carrying real advice with the least backing come first.\n\n`;
    report += `| Page | Words | Author | Date | Citations |\n|---|---|---|---|---|\n`;
    for (const f of scored.slice(0, MAX_REPORTED)) {
      report += `| ${f.path} | ${f.words} | ${f.author ? "yes" : "**no**"} | ${f.date ? "yes" : "**no**"} | ${f.citations || "**0**"} |\n`;
    }
    if (scored.length > MAX_REPORTED) report += `\n*${scored.length - MAX_REPORTED} more with at least one gap.*\n`;
    report += `\n`;
  }

  if (staleDated.length > 0) {
    report += `## Reads As Out Of Date (${staleDated.length})\n\n`;
    report += `The most recent year written on these pages is in the past and there is no `;
    report += `"updated" stamp to say the advice still holds for the current cycle. To a reader `;
    report += `in ${CURRENT_YEAR} the page looks abandoned even if the facts are current.\n\n`;
    for (const f of staleDated.slice(0, MAX_REPORTED)) {
      report += `- **${f.path}** newest year on page: ${f.stale}\n`;
    }
    report += `\n`;
  }

  if (scored.length === 0 && staleDated.length === 0) {
    report += `Every substantial page carries an author, a date, and at least one primary-source citation.\n\n`;
  }

  report += `---\n\n`;
  writeReport("eeat-audit", report);
  console.log(
    `No author: ${noAuthor.length} | No date: ${noDate.length} | No citations: ${noCitations.length} | Stale: ${staleDated.length}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
