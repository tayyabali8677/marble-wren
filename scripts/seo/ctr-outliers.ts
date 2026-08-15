/**
 * Agent 7: click-through outliers.
 *
 * Different problem from the zero-click agent. That one asks "is this page
 * getting seen at all". This one takes pages that already rank well and asks
 * why nobody clicks them, which is almost always the title or the description
 * rather than the content.
 *
 * The comparison is against typical CTR for the position the query sits at, so
 * a query at position 3 is judged by position 3 standards.
 */

import { google } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { parseServiceAccount } from "./service-account";
import { writeReport, toPath } from "./crawl";

const SITE_URL = "https://titansabroad.org/";
const DAYS = 28;
const MIN_IMPRESSIONS = 20;
const MAX_POSITION = 10;
// Flag a query only when it earns less than this share of the CTR normal for
// its position. Half is a wide enough margin to avoid noise.
const UNDERPERFORM_RATIO = 0.5;

// Typical organic CTR by position. Approximate by nature, which is why the
// threshold is generous rather than precise.
const EXPECTED_CTR: Record<number, number> = {
  1: 0.28, 2: 0.15, 3: 0.11, 4: 0.08, 5: 0.06,
  6: 0.05, 7: 0.04, 8: 0.03, 9: 0.028, 10: 0.025,
};

function expectedFor(position: number): number {
  return EXPECTED_CTR[Math.max(1, Math.min(10, Math.round(position)))] ?? 0.025;
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
      rowLimit: 2500,
    },
  });

  const rows = res.data.rows ?? [];

  const candidates = rows.filter(
    (r) => (r.impressions ?? 0) >= MIN_IMPRESSIONS && (r.position ?? 99) <= MAX_POSITION
  );

  const outliers = candidates
    .map((r) => {
      const position = r.position ?? 0;
      const expected = expectedFor(position);
      const actual = r.ctr ?? 0;
      return {
        query: r.keys![0],
        page: r.keys![1],
        position,
        impressions: r.impressions ?? 0,
        clicks: r.clicks ?? 0,
        actual,
        expected,
        ratio: expected > 0 ? actual / expected : 1,
      };
    })
    .filter((r) => r.ratio < UNDERPERFORM_RATIO)
    .sort((a, b) => b.impressions - a.impressions);

  // Group by page, since the fix is one title or description per page.
  const byPage = new Map<string, typeof outliers>();
  for (const o of outliers) {
    const list = byPage.get(o.page) ?? [];
    list.push(o);
    byPage.set(o.page, list);
  }

  const date = new Date().toISOString().split("T")[0];
  let report = `# CTR Outliers: ${date}\n\n`;
  report += `**Period:** last ${DAYS} days\n`;
  report += `**Queries examined:** ${candidates.length} (position ${MAX_POSITION} or better, ${MIN_IMPRESSIONS}+ impressions)\n`;
  report += `**Underperforming:** ${outliers.length} across ${byPage.size} pages\n\n`;

  if (outliers.length === 0) {
    report += `Nothing ranking well is being ignored. Every query at position ${MAX_POSITION} or better `;
    report += `earns at least ${Math.round(UNDERPERFORM_RATIO * 100)}% of the clicks normal for its position.\n\n---\n\n`;
    writeReport("ctr-outliers", report);
    console.log("No CTR outliers.");
    return;
  }

  report += `These rank on the first page but get far fewer clicks than that position normally earns. `;
  report += `The content is not the problem, the title or description is: it is not matching what the `;
  report += `searcher hoped to see.\n\n`;

  for (const [page, list] of [...byPage].sort((a, b) => {
    const impressions = (l: typeof outliers) => l.reduce((s, r) => s + r.impressions, 0);
    return impressions(b[1]) - impressions(a[1]);
  })) {
    report += `## ${toPath(page)}\n\n`;
    report += `| Query | Position | Impressions | Clicks | CTR | Normal | Gap |\n`;
    report += `|-------|----------|-------------|--------|-----|--------|-----|\n`;
    for (const o of list.slice(0, 10)) {
      const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
      report += `| ${o.query} | ${o.position.toFixed(1)} | ${o.impressions} | ${o.clicks} | `;
      report += `${pct(o.actual)} | ${pct(o.expected)} | ${Math.round((1 - o.ratio) * 100)}% below |\n`;
    }
    const missed = list.reduce((s, o) => s + (o.expected - o.actual) * o.impressions, 0);
    report += `\n**Roughly ${Math.round(missed)} clicks a month are going to someone else.** `;
    report += `Rewrite the page title and meta description around: ${list.slice(0, 3).map((o) => `"${o.query}"`).join(", ")}.\n\n`;
  }

  report += `---\n\n`;
  writeReport("ctr-outliers", report);
  console.log(`${outliers.length} outliers across ${byPage.size} pages`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
