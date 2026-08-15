/**
 * Agent 4: thin and placeholder content.
 *
 * This exists because three blog posts sat live for over six months rendering
 * the literal words "Full article content coming soon", and nothing noticed.
 * Google crawls those, decides the page is worthless, and that judgement rubs
 * off on the rest of the site.
 *
 * Placeholder text is a bug and is reported separately from merely short
 * pages, which are often fine.
 */

import { crawlSite, toPath, writeReport, type CrawledPage } from "./crawl";

// Below this a page is unlikely to rank for anything, chrome included.
const THIN_WORDS = 250;

// A short page saying "coming soon" is an empty page. A 5000-word guide with a
// "coming soon" badge on one card in a sidebar is a finished page that happens
// to contain the phrase. Same string, completely different problem, so the
// word count decides which bucket it lands in.
const SUBSTANTIAL_WORDS = 800;

const PLACEHOLDER_PATTERNS = [
  /content coming soon/i,
  /coming soon\b/i,
  /placeholder for the/i,
  /lorem ipsum/i,
  /\btbd\b/i,
  /to be (?:added|written|updated)/i,
  /under construction/i,
];

function placeholderHit(text: string): string | null {
  for (const re of PLACEHOLDER_PATTERNS) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

function ageInDays(lastmod?: string): number | null {
  if (!lastmod) return null;
  const then = new Date(lastmod).getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86400000);
}

async function main() {
  const pages = (await crawlSite()).filter((p) => p.status === 200);

  const placeholders: { page: CrawledPage; hit: string }[] = [];
  const mentions: { page: CrawledPage; hit: string }[] = [];
  const thin: CrawledPage[] = [];
  const noDescription: CrawledPage[] = [];

  for (const page of pages) {
    const hit = placeholderHit(page.text);
    if (hit) {
      (page.words < SUBSTANTIAL_WORDS ? placeholders : mentions).push({ page, hit });
    } else if (page.words < THIN_WORDS) {
      thin.push(page);
    }

    if (!page.metaDescription) noDescription.push(page);
  }

  placeholders.sort((a, b) => (b.page.lastmod ?? "").localeCompare(a.page.lastmod ?? ""));

  thin.sort((a, b) => a.words - b.words);

  const date = new Date().toISOString().split("T")[0];
  let report = `# Thin and Placeholder Content: ${date}\n\n`;
  report += `**Pages checked:** ${pages.length}\n\n`;

  report += `## Summary\n\n| Check | Count |\n|-------|-------|\n`;
  report += `| Empty page saying content is coming | ${placeholders.length} |\n`;
  report += `| Full page containing the phrase | ${mentions.length} |\n`;
  report += `| Under ${THIN_WORDS} words | ${thin.length} |\n`;
  report += `| Missing meta description | ${noDescription.length} |\n\n---\n\n`;

  if (placeholders.length > 0) {
    report += `## Placeholder Text Live (${placeholders.length})\n\n`;
    report += `Fix or unpublish these. A page telling visitors the content is coming is worse than no page.\n\n`;
    report += `| Page | Found | Words | Age |\n|------|-------|-------|-----|\n`;
    for (const { page, hit } of placeholders) {
      const age = ageInDays(page.lastmod);
      report += `| ${toPath(page.url)} | "${hit}" | ${page.words} | ${age === null ? "?" : `${age}d`} |\n`;
    }
    report += `\n`;
  }

  if (mentions.length > 0) {
    report += `## Phrase On An Otherwise Full Page (${mentions.length})\n\n`;
    report += `These have real content, so the phrase is probably a badge on a card or a `;
    report += `single unfinished section. Worth a look, not urgent.\n\n`;
    report += `| Page | Found | Words |\n|------|-------|-------|\n`;
    for (const { page, hit } of mentions.slice(0, 40)) {
      report += `| ${toPath(page.url)} | "${hit}" | ${page.words} |\n`;
    }
    report += `\n`;
  }

  if (thin.length > 0) {
    report += `## Thin Pages (${thin.length})\n\n`;
    report += `Under ${THIN_WORDS} words including navigation and footer, so the real content is thinner still.\n\n`;
    report += `| Page | Words | Age |\n|------|-------|-----|\n`;
    for (const page of thin.slice(0, 40)) {
      const age = ageInDays(page.lastmod);
      report += `| ${toPath(page.url)} | ${page.words} | ${age === null ? "?" : `${age}d`} |\n`;
    }
    report += `\n`;
  }

  if (noDescription.length > 0) {
    report += `## Missing Meta Description (${noDescription.length})\n\n`;
    report += `Google writes its own snippet when this is absent, and it is usually worse than one you choose.\n\n`;
    for (const page of noDescription.slice(0, 40)) {
      report += `- ${toPath(page.url)}\n`;
    }
    report += `\n`;
  }

  if (placeholders.length === 0 && mentions.length === 0 && thin.length === 0 && noDescription.length === 0) {
    report += `No placeholder text, no thin pages, no missing descriptions.\n\n`;
  }

  report += `---\n\n`;
  writeReport("thin-content", report);

  console.log(
    `Empty: ${placeholders.length} | Mentions: ${mentions.length} | Thin: ${thin.length} | No description: ${noDescription.length}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
