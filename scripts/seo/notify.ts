/**
 * Nightly digest delivery.
 *
 * Opens a GitHub issue with the night's findings and assigns it to the repo
 * owner, which means GitHub emails it out. That is deliberate: it needs no new
 * credential, no SMTP server, and no bot token, so there is nothing extra to
 * keep alive. If TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set it also sends
 * a short Telegram message.
 *
 * The digest carries only what needs a decision. Full detail stays in the
 * committed report.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const REPO = process.env.GITHUB_REPOSITORY || "tayyabali123/marble-wren";
const OWNER = REPO.split("/")[0];

type Section = { title: string; body: string; needsDecision: boolean };

function readReport(name: string): string | null {
  const path = join(process.cwd(), "reports", name);
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

/** Pulls a "## Heading" block out of a report. */
function section(report: string | null, heading: string): string | null {
  if (!report) return null;
  const start = report.indexOf(`## ${heading}`);
  if (start === -1) return null;
  const rest = report.slice(start);
  const next = rest.indexOf("\n## ", 3);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/**
 * Keeps a section readable in an email. A 289-row table is a report, not a
 * digest, so long sections are cut off with a pointer to the full file.
 */
function clamp(text: string, maxLines = 18): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const dropped = lines.length - maxLines;
  return `${lines.slice(0, maxLines).join("\n")}\n\n*${dropped} more rows in the full report.*`;
}

function countAfter(text: string | null, pattern: RegExp): number {
  const m = text?.match(pattern);
  return m ? parseInt(m[1], 10) : 0;
}

async function createIssue(title: string, body: string): Promise<string | null> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("GITHUB_TOKEN not set, skipping issue creation.");
    return null;
  }

  const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, body, assignees: [OWNER], labels: ["seo-digest"] }),
  });

  if (!res.ok) {
    console.error(`Issue creation failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return null;
  }

  const issue = (await res.json()) as any;
  console.log(`Opened issue #${issue.number}: ${issue.html_url}`);
  return issue.html_url;
}

async function sendTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true }),
  });

  if (!res.ok) console.error(`Telegram send failed: ${res.status}`);
  else console.log("Telegram digest sent.");
}

async function main() {
  const date = new Date().toISOString().split("T")[0];

  const gap = readReport(`seo-gap-${date}.md`);
  const zeroClick = readReport(`zero-click-${date}.md`);
  const indexing = readReport(`indexing-${date}.md`);
  const linkHealth = readReport(`link-health-${date}.md`);
  const thinContent = readReport(`thin-content-${date}.md`);
  const schema = readReport(`schema-audit-${date}.md`);
  const vitals = readReport(`vitals-${date}.md`);
  const ctr = readReport(`ctr-outliers-${date}.md`);
  const internalLinks = readReport(`internal-links-${date}.md`);
  const striking = readReport(`striking-distance-${date}.md`);
  const duplicates = readReport(`duplicate-content-${date}.md`);
  const factDrift = readReport(`fact-drift-${date}.md`);
  const decay = readReport(`content-decay-${date}.md`);
  const titleMeta = readReport(`title-meta-audit-${date}.md`);
  const a11y = readReport(`accessibility-audit-${date}.md`);
  const mismatch = readReport(`query-page-mismatch-${date}.md`);
  const eeat = readReport(`eeat-audit-${date}.md`);
  const canonical = readReport(`canonical-audit-${date}.md`);
  const imageSeo = readReport(`image-seo-${date}.md`);
  const serp = readReport(`serp-tracker-${date}.md`);
  const backlinks = readReport(`backlink-monitor-${date}.md`);
  const sitemapRobots = readReport(`sitemap-robots-audit-${date}.md`);

  const all = [gap, zeroClick, indexing, linkHealth, thinContent, schema, vitals, ctr,
    internalLinks, striking, duplicates, factDrift, decay, titleMeta, a11y, mismatch, eeat, canonical,
    imageSeo, serp, backlinks, sitemapRobots];
  if (all.every((r) => !r)) {
    console.log("No reports for today, nothing to send.");
    return;
  }

  const sections: Section[] = [];

  const published = section(gap, "Auto-Published");
  if (published) {
    sections.push({
      title: "Published overnight",
      body: published,
      needsDecision: published.includes("held back"),
    });
  }

  const conflicts = section(gap, "Keyword Cannibalization");
  if (conflicts && !conflicts.includes("No conflicts found")) {
    sections.push({ title: "Cannibalization", body: conflicts, needsDecision: true });
  }

  const notIndexed = section(indexing, "Not Indexed");
  if (notIndexed) {
    sections.push({ title: "Not indexed", body: notIndexed, needsDecision: true });
  }

  const underperforming = section(zeroClick, "Underperforming");
  if (underperforming) {
    sections.push({ title: "Zero clicks despite impressions", body: underperforming, needsDecision: true });
  }

  const noData = section(zeroClick, "No Search Console Data");
  if (noData) {
    sections.push({ title: "Never appeared in search", body: noData, needsDecision: true });
  }

  // Anything below is only present when the agent actually found something, so
  // a quiet night produces a short digest rather than a wall of "0 found".
  const dead = section(linkHealth, "Pages Not Returning 200");
  if (dead) sections.push({ title: "Dead pages", body: dead, needsDecision: true });

  const redirects = section(linkHealth, "Sitemap URLs That Redirect");
  if (redirects) sections.push({ title: "Sitemap redirects", body: redirects, needsDecision: true });

  const brokenLinks = section(linkHealth, "Broken Internal Links");
  if (brokenLinks) sections.push({ title: "Broken links", body: brokenLinks, needsDecision: true });

  // A dead application-portal or university link sits on the page where a
  // student is trying to take the one action that matters, so this leads
  // ahead of the general broken-internal-links finding in spirit.
  const brokenExternalLinks = section(linkHealth, "Broken External Links");
  if (brokenExternalLinks) {
    sections.push({ title: "Broken external links", body: brokenExternalLinks, needsDecision: true });
  }

  const placeholder = section(thinContent, "Placeholder Text Live");
  if (placeholder) sections.push({ title: "Placeholder text live", body: placeholder, needsDecision: true });

  const thin = section(thinContent, "Thin Pages");
  if (thin) sections.push({ title: "Thin pages", body: thin, needsDecision: false });

  const brokenSchema = section(schema, "Broken JSON-LD");
  if (brokenSchema) sections.push({ title: "Broken structured data", body: brokenSchema, needsDecision: true });

  const incompleteSchema = section(schema, "Missing Required Properties");
  if (incompleteSchema) {
    sections.push({ title: "Incomplete structured data", body: incompleteSchema, needsDecision: true });
  }

  const poorVitals = section(vitals, "Poor Metrics");
  if (poorVitals) sections.push({ title: "Core Web Vitals", body: poorVitals, needsDecision: true });

  // The CTR report has one heading per page, so there is no single section to
  // lift. The count from the header is enough for a digest.
  const outliers = countAfter(ctr, /\*\*Underperforming:\*\* (\d+)/);
  if (outliers > 0) {
    sections.push({
      title: "CTR outliers",
      body: `## CTR outliers\n\n${outliers} first-page queries earn far fewer clicks than their position normally does. Title and description rewrites are listed per page in the full report.`,
      needsDecision: true,
    });
  }

  // Fact drift goes near the top of the digest in spirit: a wrong number on a
  // page about someone's medical degree matters more than a ranking.
  const leftovers = section(factDrift, "Template Leftovers Live");
  if (leftovers) sections.push({ title: "Template text live", body: leftovers, needsDecision: true });

  const contradictions = section(factDrift, "Contradicting Counts");
  if (contradictions) sections.push({ title: "Contradicting numbers", body: contradictions, needsDecision: true });

  const badRanges = section(factDrift, "Fee Ranges Narrower Than Reality");
  if (badRanges) sections.push({ title: "Fee ranges understated", body: badRanges, needsDecision: true });

  const twins = section(duplicates, "Effectively The Same Page");
  if (twins) sections.push({ title: "Duplicate pages", body: twins, needsDecision: true });

  const orphans = section(internalLinks, "Orphan Pages");
  if (orphans) sections.push({ title: "Orphan pages", body: orphans, needsDecision: false });

  // Striking distance is opportunity rather than breakage, so it reports a
  // number and a pointer instead of asking for a decision.
  const inRange = countAfter(striking, /position \d+ to \d+:\*\* (\d+)/);
  if (inRange > 0) {
    const upside = countAfter(striking, /reached position 5:\*\* (\d+)/);
    sections.push({
      title: "Striking distance",
      body: `## Striking distance\n\n${inRange} queries rank at position 8 to 20, worth roughly ${upside} clicks a month if they reached position 5. Per-page rewrites are in the full report.`,
      needsDecision: false,
    });
  }

  // A page that had real search presence and dropped to zero is closer to a
  // deindexing than an outranking, so it leads the decay findings.
  const vanished = section(decay, "Stopped Appearing Entirely");
  if (vanished) sections.push({ title: "Stopped appearing in search", body: vanished, needsDecision: true });

  const losingGround = countAfter(decay, /sustained decline:\*\* (\d+)/);
  if (losingGround > 0) {
    sections.push({
      title: "Content decay",
      body: `## Content decay\n\n${losingGround} pages lost meaningful ground versus the previous 28 days. The ones whose average position slipped are being outranked rather than falling with the season. Full breakdown in the report.`,
      needsDecision: false,
    });
  }

  // Two pages with the same title are indistinguishable in a result list, so a
  // reader has no reason to pick one. That is worth a decision.
  const dupeTitles = section(titleMeta, "Duplicate Titles");
  if (dupeTitles) sections.push({ title: "Duplicate titles", body: dupeTitles, needsDecision: true });

  const missingDesc = countAfter(titleMeta, /Missing a description:\*\* (\d+)/);
  const truncatedTitles = countAfter(titleMeta, /Titles that will be truncated:\*\* (\d+)/);
  if (missingDesc > 0 || truncatedTitles > 0) {
    sections.push({
      title: "Titles and descriptions",
      body: `## Titles and descriptions\n\n${truncatedTitles} titles are wide enough to be truncated in results, and ${missingDesc} pages have no meta description. Per-page widths and text are in the full report.`,
      needsDecision: false,
    });
  }

  // A missing lang attribute or bare alt-less image is a real WCAG failure,
  // not a ranking nicety, so both lead the accessibility findings.
  const missingLangCount = countAfter(a11y, /Missing an html lang attribute:\*\* (\d+)/);
  if (missingLangCount > 0) {
    sections.push({
      title: "Missing lang attribute",
      body: `## Missing lang attribute\n\n${missingLangCount} pages declare no html lang attribute, so a screen reader has to guess the page's language. Affected pages are listed in the full report.`,
      needsDecision: true,
    });
  }

  const noAltImages = section(a11y, "Images With No Alt Attribute");
  if (noAltImages) sections.push({ title: "Images with no alt attribute", body: noAltImages, needsDecision: true });

  const vagueLinkCount = countAfter(a11y, /Links with vague text:\*\* (\d+)/);
  if (vagueLinkCount > 0) {
    sections.push({
      title: "Vague link text",
      body: `## Vague link text\n\n${vagueLinkCount} links use text like "click here" or "read more" that tells a screen reader user nothing when tabbing through the page's links out of context. Per-page detail is in the full report.`,
      needsDecision: false,
    });
  }

  // The wrong page winning a query is a redirect-the-signal decision, distinct
  // from the consolidation decision cannibalization asks for.
  const wrongPage = countAfter(mismatch, /a better page exists:\*\* (\d+)/);
  if (wrongPage > 0) {
    const groups = countAfter(mismatch, /wrong-page groups:\*\* (\d+)/);
    sections.push({
      title: "Wrong page ranking",
      body: `## Wrong page ranking\n\n${wrongPage} queries rank a page when another page on the site answers them better, across ${groups} page pairs. Each is a title, heading and internal-link fix rather than a merge. Pairs are listed in the full report.`,
      needsDecision: true,
    });
  }

  // A page in the sitemap that tells Google not to index it is a live
  // contradiction suppressing a page meant to rank.
  const noindexed = section(canonical, "Noindex On A Page In The Sitemap");
  if (noindexed) sections.push({ title: "Noindex in sitemap", body: noindexed, needsDecision: true });

  const canonProblems = section(canonical, "Canonical Problems");
  if (canonProblems) sections.push({ title: "Canonical problems", body: canonProblems, needsDecision: true });

  const deadInSitemap = section(canonical, "Sitemap Entries That Do Not Return 200");
  if (deadInSitemap) sections.push({ title: "Dead sitemap entries", body: deadInSitemap, needsDecision: true });

  // Site-wide trust gaps and a missing-canonical sweep are standing states
  // rather than fresh breakage, so they inform without inflating the decision
  // count every single night.
  const missingCanonical = countAfter(canonical, /Missing a canonical tag:\*\* (\d+)/);
  if (missingCanonical > 20) {
    sections.push({
      title: "Canonical tags",
      body: `## Canonical tags\n\n${missingCanonical} pages declare no canonical tag. Google will assume each is its own canonical, but declaring it removes ambiguity across trailing-slash and query-string variants. A one-line addition to the shared layout covers the whole site.`,
      needsDecision: false,
    });
  }

  const noDate = countAfter(eeat, /No visible date:\*\* (\d+)/);
  const noAuthor = countAfter(eeat, /No named author:\*\* (\d+)/);
  if (noDate > 0 || noAuthor > 0) {
    sections.push({
      title: "Trust signals",
      body: `## Trust signals\n\nThis is YMYL content, where Google weighs who wrote a page and when it was checked. ${noAuthor} substantial pages carry no named author and ${noDate} show no visible update date. Adding a reviewer byline and a "last updated" stamp to the article template closes most of this at once.`,
      needsDecision: false,
    });
  }

  // A multi-megabyte image, especially one hotlinked live from another server,
  // is felt directly on a phone connection and is worth a decision. Coverage
  // gaps (alt, dimensions, dated formats) are a standing state that informs.
  const heavyImages = section(imageSeo, "Heavy Images");
  if (heavyImages) sections.push({ title: "Heavy images", body: heavyImages, needsDecision: true });

  const missingDims = countAfter(imageSeo, /layout shift risk\):\*\* (\d+)/);
  const datedFormats = countAfter(imageSeo, /where WebP\/AVIF would be smaller:\*\* (\d+)/);
  if (missingDims > 0 || datedFormats > 0) {
    sections.push({
      title: "Image coverage",
      body: `## Image coverage\n\n${missingDims} images ship without width and height, which allows layout shift, and ${datedFormats} sizeable images are in a dated format where WebP or AVIF would be smaller. Both are template-level fixes. Per-image detail is in the full report.`,
      needsDecision: false,
    });
  }

  // The SERP tracker is competitive intelligence rather than breakage, so it
  // informs the content plan without asking for a nightly decision. When the
  // key is unset the report has no sections and nothing lifts here.
  const rivals = section(serp, "Rivals Who Keep Beating Us");
  if (rivals) {
    const outranked = countAfter(serp, /Outranked or absent:\*\* (\d+)/);
    sections.push({
      title: "Competitors",
      body: `${rivals}\n\nWe are outranked or absent on ${outranked} of the tracked keywords. The per-keyword breakdown is in the full report.`,
      needsDecision: false,
    });
  }

  // A lost backlink often takes ranking with it, so it leads the backlink
  // findings and asks for a look. New domains inform, since some are spam worth
  // disavowing rather than genuine links.
  const lostLinks = section(backlinks, "Lost Referring Domains");
  if (lostLinks) sections.push({ title: "Lost backlinks", body: lostLinks, needsDecision: true });

  const newLinks = section(backlinks, "New Referring Domains");
  if (newLinks) sections.push({ title: "New backlinks", body: newLinks, needsDecision: false });

  // A sitemap URL blocked by robots.txt is a live contradiction in what we
  // tell Google, the same shape of finding as the noindex-in-sitemap check.
  const blockedInSitemap = section(sitemapRobots, "Sitemap URLs Blocked By Robots.txt");
  if (blockedInSitemap) {
    sections.push({ title: "Sitemap blocked by robots.txt", body: blockedInSitemap, needsDecision: true });
  }

  const decisions = sections.filter((s) => s.needsDecision).length;

  let body = `Nightly SEO run for ${date}.\n\n`;
  body += decisions === 0
    ? `Nothing needs your decision today.\n\n`
    : `**${decisions} ${decisions === 1 ? "item needs" : "items need"} your decision.**\n\n`;

  for (const s of sections) {
    body += `${clamp(s.body)}\n\n`;
  }

  body += `---\n\nFull reports: [\`reports/\`](https://github.com/${REPO}/tree/master/reports)\n`;

  const title = decisions === 0
    ? `SEO digest ${date}: all clear`
    : `SEO digest ${date}: ${decisions} ${decisions === 1 ? "decision" : "decisions"} needed`;

  const url = await createIssue(title, body);

  const summary = [
    `*SEO digest ${date}*`,
    decisions === 0 ? "Nothing needs your decision." : `${decisions} items need your decision.`,
    countAfter(published, /Pushed \*\*(\d+)\*\*/) > 0 ? `Published ${countAfter(published, /Pushed \*\*(\d+)\*\*/)} FAQ answers.` : "",
    url ? url : "",
  ].filter(Boolean).join("\n");

  await sendTelegram(summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
