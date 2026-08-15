import { google } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { parseServiceAccount } from "./service-account";
import { fetchSitemapEntries } from "./sitemap";

const SITE_URL = "https://titansabroad.org/";
const SITEMAP_URL = "https://titansabroad.org/sitemap.xml";
const DAYS = 28;

// A page only counts as a problem once it has had a fair chance to rank.
const MIN_AGE_DAYS = 60;
// Impressions over the window below which we call the page invisible rather
// than underperforming. These are different diagnoses with different fixes.
const VISIBILITY_FLOOR = 20;

type PageStats = {
  url: string;
  clicks: number;
  impressions: number;
  position: number;
  lastmod?: string;
  ageDays?: number;
};

function ageInDays(lastmod?: string): number | undefined {
  if (!lastmod) return undefined;
  const t = Date.parse(lastmod);
  if (Number.isNaN(t)) return undefined;
  return Math.floor((Date.now() - t) / 86_400_000);
}

async function main() {
  const auth = new GoogleAuth({
    credentials: parseServiceAccount(process.env.GOOGLE_SERVICE_ACCOUNT!),
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
  });

  const searchconsole = google.searchconsole({ version: "v1", auth: auth as any });

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - DAYS);
  const fmt = (d: Date) => d.toISOString().split("T")[0];

  console.log(`Fetching page performance (${fmt(startDate)} to ${fmt(endDate)})...`);

  const response = await searchconsole.searchanalytics.query({
    siteUrl: SITE_URL,
    requestBody: {
      startDate: fmt(startDate),
      endDate: fmt(endDate),
      dimensions: ["page"],
      rowLimit: 5000,
    },
  });

  const gscByUrl = new Map<string, PageStats>();
  for (const row of response.data.rows ?? []) {
    const url = row.keys![0];
    gscByUrl.set(normalize(url), {
      url,
      clicks: row.clicks ?? 0,
      impressions: row.impressions ?? 0,
      position: row.position ?? 0,
    });
  }

  console.log(`Search Console returned ${gscByUrl.size} pages with data.`);

  console.log("Fetching sitemap...");
  const sitemap = await fetchSitemapEntries(SITEMAP_URL);
  console.log(`Sitemap has ${sitemap.length} URLs.`);

  const underperforming: PageStats[] = [];
  const invisible: PageStats[] = [];
  const noData: PageStats[] = [];

  for (const entry of sitemap) {
    const age = ageInDays(entry.lastmod);
    if (age !== undefined && age < MIN_AGE_DAYS) continue;

    const stats = gscByUrl.get(normalize(entry.url));

    if (!stats) {
      noData.push({ url: entry.url, clicks: 0, impressions: 0, position: 0, lastmod: entry.lastmod, ageDays: age });
      continue;
    }

    if (stats.clicks > 0) continue;

    const enriched = { ...stats, lastmod: entry.lastmod, ageDays: age };
    if (stats.impressions >= VISIBILITY_FLOOR) {
      underperforming.push(enriched);
    } else {
      invisible.push(enriched);
    }
  }

  underperforming.sort((a, b) => b.impressions - a.impressions);
  invisible.sort((a, b) => b.impressions - a.impressions);
  noData.sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));

  const date = fmt(new Date());
  let report = `# Zero-Click Pages: ${date}\n\n`;
  report += `**Property:** ${SITE_URL}\n`;
  report += `**Period:** Last ${DAYS} days\n`;
  report += `**Minimum age to qualify:** ${MIN_AGE_DAYS} days\n\n`;
  report += `Pages live for ${MIN_AGE_DAYS}+ days that brought zero clicks in the window. `;
  report += `Each group needs a different decision, so they are split rather than dumped into one list.\n\n`;

  report += `## Summary\n\n| Group | Count | What it means |\n|-------|-------|---------------|\n`;
  report += `| Underperforming | ${underperforming.length} | Google shows them, nobody clicks. Title and meta problem. |\n`;
  report += `| Invisible | ${invisible.length} | Barely any impressions. Ranking or intent problem. |\n`;
  report += `| No data at all | ${noData.length} | Never surfaced in search. Check indexing first. |\n\n---\n\n`;

  if (underperforming.length > 0) {
    report += `## Underperforming (${underperforming.length})\n\n`;
    report += `Getting impressions but zero clicks. Google is showing these and searchers are scrolling past. `;
    report += `Rewrite the title and meta description before touching the body content.\n\n`;
    report += `| URL | Impressions | Avg position | Age (days) |\n|-----|-------------|--------------|------------|\n`;
    for (const p of underperforming.slice(0, 50)) {
      report += `| ${p.url} | ${p.impressions} | ${p.position.toFixed(1)} | ${p.ageDays ?? "?"} |\n`;
    }
    report += "\n";
  }

  if (invisible.length > 0) {
    report += `## Invisible (${invisible.length})\n\n`;
    report += `Under ${VISIBILITY_FLOOR} impressions over ${DAYS} days. Either nobody searches for this, or the page is not `;
    report += `competitive enough to be shown. Decide: improve, merge into a stronger page, or remove.\n\n`;
    report += `| URL | Impressions | Avg position | Age (days) |\n|-----|-------------|--------------|------------|\n`;
    for (const p of invisible.slice(0, 60)) {
      report += `| ${p.url} | ${p.impressions} | ${p.position > 0 ? p.position.toFixed(1) : "-"} | ${p.ageDays ?? "?"} |\n`;
    }
    report += "\n";
  }

  if (noData.length > 0) {
    report += `## No Search Console Data (${noData.length})\n\n`;
    report += `These never appeared in search results at all over the window. Cross-check them against the latest `;
    report += `indexing report before deciding anything: an unindexed page cannot get impressions.\n\n`;
    for (const p of noData.slice(0, 60)) {
      report += `- ${p.url} *(age: ${p.ageDays ?? "unknown"} days)*\n`;
    }
    report += "\n";
  }

  if (underperforming.length === 0 && invisible.length === 0 && noData.length === 0) {
    report += `Nothing to decide. Every page older than ${MIN_AGE_DAYS} days brought at least one click.\n`;
  }

  const reportsDir = join(process.cwd(), "reports");
  if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });

  const outPath = join(reportsDir, `zero-click-${date}.md`);
  writeFileSync(outPath, report, "utf-8");
  console.log(`\nReport saved: ${outPath}`);
  console.log(`Underperforming: ${underperforming.length} | Invisible: ${invisible.length} | No data: ${noData.length}`);
}

function normalize(url: string): string {
  return url.replace(/\/+$/, "").toLowerCase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
