/**
 * Agent 10: striking distance.
 *
 * Queries sitting just off the first page. These already rank, Google already
 * considers the page relevant, and the gap to page one is usually a title that
 * does not contain the query or a section that does not answer it. Cheaper than
 * anything else on the site and the traffic step from position 11 to position 9
 * is far larger than the two places suggest.
 *
 * The CTR agent covers positions 1 to 10, so this deliberately starts at 8:
 * a query averaging 8.5 spends real time on page two.
 */

import { google } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { parseServiceAccount } from "./service-account";
import { writeReport, toPath } from "./crawl";

const SITE_URL = "https://titansabroad.org/";
const DAYS = 28;
const MIN_POSITION = 8;
const MAX_POSITION = 20;
// Below this the query is too rare to be worth a rewrite even if it moved.
const MIN_IMPRESSIONS = 15;
const MAX_PER_PAGE = 8;

/**
 * Roughly what each position earns, used to size the prize rather than to
 * predict it. Position 11 to 5 is a jump of about ten times the clicks.
 */
const CTR_BY_POSITION: Record<number, number> = {
  1: 0.28, 2: 0.15, 3: 0.11, 4: 0.08, 5: 0.06,
  6: 0.05, 7: 0.04, 8: 0.03, 9: 0.028, 10: 0.025,
};

function ctrAt(position: number): number {
  const p = Math.round(position);
  if (p <= 10) return CTR_BY_POSITION[Math.max(1, p)] ?? 0.025;
  // Page two and beyond is close enough to nothing that the exact shape of the
  // curve stops mattering.
  return 0.01 / Math.max(1, p - 9);
}

async function main() {
  const auth = new GoogleAuth({
    credentials: parseServiceAccount(process.env.GOOGLE_SERVICE_ACCOUNT!),
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
  });
  const searchconsole = google.searchconsole({ version: "v1", auth: auth as any });

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - DAYS);
  const fmt = (d: Date) => d.toISOString().split("T")[0];

  const res = await searchconsole.searchanalytics.query({
    siteUrl: SITE_URL,
    requestBody: {
      startDate: fmt(start),
      endDate: fmt(end),
      dimensions: ["query", "page"],
      rowLimit: 5000,
    },
  });

  const rows = res.data.rows ?? [];

  const candidates = rows
    .filter((r) => {
      const p = r.position ?? 99;
      return p >= MIN_POSITION && p <= MAX_POSITION && (r.impressions ?? 0) >= MIN_IMPRESSIONS;
    })
    .map((r) => {
      const position = r.position ?? 0;
      const impressions = r.impressions ?? 0;
      return {
        query: r.keys![0],
        page: r.keys![1],
        position,
        impressions,
        clicks: r.clicks ?? 0,
        // What the same impressions would earn at position 5.
        upside: Math.round(impressions * (ctrAt(5) - ctrAt(position))),
      };
    })
    .filter((r) => r.upside > 0)
    .sort((a, b) => b.upside - a.upside);

  const byPage = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const list = byPage.get(c.page) ?? [];
    list.push(c);
    byPage.set(c.page, list);
  }

  const totalUpside = candidates.reduce((s, c) => s + c.upside, 0);

  const date = new Date().toISOString().split("T")[0];
  let report = `# Striking Distance: ${date}\n\n`;
  report += `**Period:** last ${DAYS} days\n`;
  report += `**Queries at position ${MIN_POSITION} to ${MAX_POSITION}:** ${candidates.length} across ${byPage.size} pages\n`;
  report += `**Rough upside if all reached position 5:** ${totalUpside} clicks a month\n\n`;

  if (candidates.length === 0) {
    report += `Nothing is sitting in striking distance with ${MIN_IMPRESSIONS}+ impressions. `;
    report += `Either the queries that rank are already on page one, or there is not enough `;
    report += `search volume yet for the ones that are not.\n\n---\n\n`;
    writeReport("striking-distance", report);
    console.log("Nothing in striking distance.");
    return;
  }

  report += `These already rank. Google has decided the page is relevant and put it just `;
  report += `outside where anyone looks. Getting one of these onto page one is usually a title `;
  report += `and heading change, not new content.\n\n`;
  report += `## Biggest Single Wins\n\n`;
  report += `| Query | Page | Position | Impressions | Clicks | Upside at pos 5 |\n`;
  report += `|-------|------|----------|-------------|--------|-----------------|\n`;
  for (const c of candidates.slice(0, 15)) {
    report += `| ${c.query} | ${toPath(c.page)} | ${c.position.toFixed(1)} | ${c.impressions} | ${c.clicks} | +${c.upside} |\n`;
  }
  report += `\n`;

  report += `## By Page\n\n`;
  const pagesByUpside = [...byPage].sort((a, b) => {
    const total = (l: typeof candidates) => l.reduce((s, c) => s + c.upside, 0);
    return total(b[1]) - total(a[1]);
  });

  for (const [page, list] of pagesByUpside.slice(0, 20)) {
    const upside = list.reduce((s, c) => s + c.upside, 0);
    report += `### ${toPath(page)}\n\n`;
    report += `**${list.length} ${list.length === 1 ? "query" : "queries"} in striking distance, worth roughly ${upside} clicks a month.**\n\n`;
    report += `| Query | Position | Impressions |\n`;
    report += `|-------|----------|-------------|\n`;
    for (const c of list.slice(0, MAX_PER_PAGE)) {
      report += `| ${c.query} | ${c.position.toFixed(1)} | ${c.impressions} |\n`;
    }
    const best = list[0];
    report += `\nStart by getting "${best.query}" into the page title and an H2, then make sure `;
    report += `the section under that heading answers it directly in the first two sentences.\n\n`;
  }

  report += `---\n\n`;
  writeReport("striking-distance", report);
  console.log(`${candidates.length} queries in striking distance across ${byPage.size} pages (${totalUpside} clicks upside)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
