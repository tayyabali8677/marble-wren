/**
 * Agent 14: titles and meta descriptions.
 *
 * The title is the only part of a page most people ever read. Google truncates
 * it on width rather than character count, so a title of 60 narrow characters
 * survives where 55 wide ones do not, and the part that gets cut is the end,
 * which is where templated titles keep the brand and the differentiator.
 *
 * Duplicates matter more than length. Ninety-five pages built from one template
 * can easily ship ninety-five titles that differ only in a university name
 * buried past the truncation point, at which point the search result gives a
 * reader no way to tell them apart and no reason to click one over another.
 */

import { crawlSite, writeReport, toPath, decodeEntities, type CrawledPage } from "./crawl";

// Google renders titles in roughly 580px and descriptions in roughly 920px on
// desktop. Both are approximations of a thing Google does not document.
const TITLE_PIXELS = 580;
const DESC_PIXELS = 920;
// Under this a title is not using the space it has been given.
const TITLE_SHORT_PIXELS = 250;
const DESC_SHORT_PIXELS = 400;
const MAX_REPORTED = 25;

/**
 * Character widths at the size Google renders titles, bucketed. Measuring the
 * real font would be more accurate and would need the font. This is within a
 * few percent, which is enough to tell a safe title from a truncated one.
 */
const NARROW = new Set("iljtfrI.,;:!|'`()[]{}-".split(""));
const WIDE = new Set("mwMW@%".split(""));

function pixelWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (ch === " ") width += 4.5;
    else if (NARROW.has(ch)) width += 4;
    else if (WIDE.has(ch)) width += 13;
    else if (ch >= "A" && ch <= "Z") width += 10;
    else width += 8;
  }
  return Math.round(width);
}

type Entry = {
  path: string;
  title: string;
  description: string;
  titleWidth: number;
  descWidth: number;
  page: CrawledPage;
};

/** Titles that differ only past the truncation point read as identical. */
function visiblePart(title: string): string {
  let width = 0;
  let out = "";
  for (const ch of title) {
    width += pixelWidth(ch);
    if (width > TITLE_PIXELS) break;
    out += ch;
  }
  return out.trim().toLowerCase();
}

function groupBy(entries: Entry[], key: (e: Entry) => string): Map<string, Entry[]> {
  const map = new Map<string, Entry[]>();
  for (const e of entries) {
    const k = key(e);
    if (!k) continue;
    const list = map.get(k) ?? [];
    list.push(e);
    map.set(k, list);
  }
  return map;
}

async function main() {
  const pages = (await crawlSite()).filter((p) => p.status === 200);

  const entries: Entry[] = pages.map((page) => {
    const title = decodeEntities(page.title).replace(/\s+/g, " ").trim();
    const description = decodeEntities(page.metaDescription).replace(/\s+/g, " ").trim();
    return {
      path: toPath(page.url),
      title,
      description,
      titleWidth: pixelWidth(title),
      descWidth: pixelWidth(description),
      page,
    };
  });

  const missingTitle = entries.filter((e) => !e.title);
  const missingDesc = entries.filter((e) => !e.description);
  const longTitle = entries.filter((e) => e.titleWidth > TITLE_PIXELS);
  const shortTitle = entries.filter((e) => e.title && e.titleWidth < TITLE_SHORT_PIXELS);
  const longDesc = entries.filter((e) => e.descWidth > DESC_PIXELS);
  const shortDesc = entries.filter((e) => e.description && e.descWidth < DESC_SHORT_PIXELS);

  const dupTitles = [...groupBy(entries, (e) => e.title.toLowerCase())].filter(([, l]) => l.length > 1);
  const dupDescs = [...groupBy(entries, (e) => e.description.toLowerCase())].filter(([, l]) => l.length > 1);
  // Distinct in full, identical in the part anyone sees.
  const dupVisible = [...groupBy(entries, (e) => visiblePart(e.title))]
    .filter(([, l]) => l.length > 1)
    .filter(([key]) => !dupTitles.some(([full]) => full === key));

  // A title that repeats no word from its own H1 is usually a template that
  // never got the page's actual subject into it.
  const stopWords = new Set(["mbbs","bds","in","the","a","for","and","of","to","study","university","medical","college","abroad","titans","pakistani","students","2025","2026"]);
  const titleOffTopic = entries.filter((e) => {
    if (!e.title || e.page.h1.length === 0) return false;
    const h1Words = new Set(
      decodeEntities(e.page.h1[0]).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !stopWords.has(w))
    );
    if (h1Words.size === 0) return false;
    const titleWords = new Set(e.title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    for (const w of h1Words) if (titleWords.has(w)) return false;
    return true;
  });

  const missingH1 = entries.filter((e) => e.page.h1.length === 0);
  const multipleH1 = entries.filter((e) => e.page.h1.length > 1);

  const date = new Date().toISOString().split("T")[0];
  let report = `# Titles And Meta Descriptions: ${date}\n\n`;
  report += `**Pages checked:** ${entries.length}\n`;
  report += `**Missing a title:** ${missingTitle.length}\n`;
  report += `**Missing a description:** ${missingDesc.length}\n`;
  report += `**Titles that will be truncated:** ${longTitle.length}\n`;
  report += `**Duplicate titles:** ${dupTitles.length} ${dupTitles.length === 1 ? "group" : "groups"}\n`;
  report += `**Titles identical once truncated:** ${dupVisible.length} ${dupVisible.length === 1 ? "group" : "groups"}\n`;
  report += `**Duplicate descriptions:** ${dupDescs.length} ${dupDescs.length === 1 ? "group" : "groups"}\n\n`;

  report += `Widths are estimated, not measured. Google truncates on rendered width in a `;
  report += `font we do not have, so treat anything within about 5% of the limit as `;
  report += `borderline rather than certain.\n\n`;

  const sections: Array<[string, Entry[], string]> = [
    ["Missing Titles", missingTitle, "No title tag at all. Google writes its own, usually badly."],
    ["Missing Descriptions", missingDesc, "Google will pull a sentence off the page instead. Sometimes that is fine, mostly it is not."],
    ["Titles That Will Be Truncated", longTitle, `Wider than about ${TITLE_PIXELS}px, so the end gets cut in results. Put the differentiator first.`],
    ["Titles Not Using The Space", shortTitle, "Short enough that a qualifier could be added for free."],
    ["Descriptions That Will Be Truncated", longDesc, `Wider than about ${DESC_PIXELS}px. The cut usually lands mid sentence.`],
    ["Descriptions Too Short To Sell", shortDesc, "Enough room left for another clause that gives someone a reason to click."],
    ["Titles That Do Not Mention Their Own Subject", titleOffTopic, "The title shares no substantial word with the page's H1, which usually means a template default survived."],
    ["Pages With No H1", missingH1, "Nothing tells a reader or a crawler what the page is about above the fold."],
    ["Pages With More Than One H1", multipleH1, "Not a ranking penalty, but it makes the page's subject ambiguous."],
  ];

  let findings = 0;
  for (const [heading, list, note] of sections) {
    if (list.length === 0) continue;
    findings += list.length;
    report += `## ${heading} (${list.length})\n\n${note}\n\n`;
    report += `| Page | Width | Text |\n|---|---|---|\n`;
    for (const e of list.slice(0, MAX_REPORTED)) {
      const isDesc = heading.includes("Description");
      const text = isDesc ? e.description : e.title || e.page.h1[0] || "";
      const width = isDesc ? e.descWidth : e.titleWidth;
      report += `| ${e.path} | ${width}px | ${text.slice(0, 100).replace(/\|/g, "/") || "(empty)"} |\n`;
    }
    if (list.length > MAX_REPORTED) report += `\n*${list.length - MAX_REPORTED} more.*\n`;
    report += `\n`;
  }

  for (const [heading, groups, note] of [
    ["Duplicate Titles", dupTitles, "The same title on more than one page. In a result list these are indistinguishable."],
    ["Titles Identical Once Truncated", dupVisible, "These differ, but only past the point Google cuts them. To a searcher they are the same title."],
    ["Duplicate Descriptions", dupDescs, "Usually a template that never took a per-page value."],
  ] as const) {
    if (groups.length === 0) continue;
    findings += groups.length;
    report += `## ${heading} (${groups.length})\n\n${note}\n\n`;
    for (const [text, list] of groups.sort((a, b) => b[1].length - a[1].length).slice(0, MAX_REPORTED)) {
      report += `- **"${text.slice(0, 90)}"** on ${list.length} pages: ${list.slice(0, 5).map((e) => e.path).join(", ")}`;
      report += list.length > 5 ? ` and ${list.length - 5} more\n` : `\n`;
    }
    report += `\n`;
  }

  if (findings === 0) {
    report += `Every page has a title and description of a sensible width, and none of them repeat.\n\n`;
  }

  report += `---\n\n`;
  writeReport("title-meta-audit", report);
  console.log(
    `Missing: ${missingTitle.length}t/${missingDesc.length}d | Truncated: ${longTitle.length} | Dupe titles: ${dupTitles.length} | Dupe once cut: ${dupVisible.length}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
