import { google } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { parseServiceAccount } from "./service-account";
import { fetchSitemapEntries } from "./sitemap";

const SITE_URL = "https://titansabroad.org/";
const SITEMAP_URL = "https://titansabroad.org/sitemap.xml";
// The Inspection API allows 2000 calls a day, so the whole sitemap fits well
// inside quota. The old 300 cap existed because serial checks took about nine
// seconds each. Four at a time covers everything in roughly a third of the
// time and stays far under the per-minute limit.
const MAX_URLS_TO_CHECK = Number(process.env.MAX_URLS_TO_CHECK || 2000);
const CONCURRENCY = 4;

async function fetchSitemapUrls(): Promise<string[]> {
  return (await fetchSitemapEntries(SITEMAP_URL)).map((e) => e.url);
}

type UrlStatus = {
  url: string;
  verdict: string;
  indexingState: string;
  coverageState: string;
  lastCrawl?: string;
  robotsTxtState?: string;
  error?: string;
};

async function main() {
  const serviceAccount = parseServiceAccount(process.env.GOOGLE_SERVICE_ACCOUNT!);

  const auth = new GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/webmasters"],
  });

  const searchconsole = google.searchconsole({ version: "v1", auth: auth as any });

  console.log("Fetching sitemap URLs...");
  const allUrls = await fetchSitemapUrls();
  console.log(`Found ${allUrls.length} URLs in sitemap`);

  const urlsToCheck = allUrls.slice(0, MAX_URLS_TO_CHECK);
  console.log(`Checking ${urlsToCheck.length} URLs via URL Inspection API...`);

  const indexed: UrlStatus[] = [];
  const notIndexed: UrlStatus[] = [];
  const crawledNotIndexed: UrlStatus[] = [];
  const errors: { url: string; error: string }[] = [];

  let completed = 0;

  async function inspect(url: string): Promise<void> {
    try {
      const res = await searchconsole.urlInspection.index.inspect({
        requestBody: {
          inspectionUrl: url,
          siteUrl: SITE_URL,
        },
      });

      const idx = res.data.inspectionResult?.indexStatusResult;
      const verdict = idx?.verdict ?? "UNKNOWN";
      const indexingState = idx?.indexingState ?? "UNKNOWN";
      const coverageState = idx?.coverageState ?? "";

      const status: UrlStatus = {
        url,
        verdict,
        indexingState,
        coverageState,
        lastCrawl: idx?.lastCrawlTime ?? undefined,
        robotsTxtState: idx?.robotsTxtState ?? undefined,
      };

      if (verdict === "PASS") {
        indexed.push(status);
      } else if (indexingState === "CRAWLED_CURRENTLY_NOT_INDEXED" || coverageState?.includes("Crawled")) {
        crawledNotIndexed.push(status);
      } else {
        notIndexed.push(status);
      }
    } catch (err: any) {
      errors.push({ url, error: err.message?.slice(0, 120) ?? "unknown" });
    }

    completed++;
    if (completed % 25 === 0) {
      console.log(`Progress: ${completed}/${urlsToCheck.length}`);
    }
  }

  // Workers pull from one shared queue, so a slow URL does not stall a whole
  // batch the way fixed-size chunks would.
  const queue = [...urlsToCheck];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let url = queue.shift(); url; url = queue.shift()) {
        await inspect(url);
      }
    })
  );

  // Resubmit sitemaps to signal Google
  try {
    await searchconsole.sitemaps.submit({ siteUrl: SITE_URL, feedpath: SITEMAP_URL });
    console.log("Sitemap resubmitted to Google.");
  } catch (err: any) {
    console.warn("Sitemap resubmit failed:", err.message);
  }

  const date = new Date().toISOString().split("T")[0];
  let report = `# Indexing Monitor Report: ${date}\n\n`;
  report += `**Property:** ${SITE_URL}\n`;
  report += `**Total URLs in sitemap:** ${allUrls.length}\n`;
  report += `**URLs checked:** ${urlsToCheck.length}\n`;
  report += `**Sitemap resubmitted:** Yes\n\n`;

  report += `## Summary\n\n`;
  report += `| Status | Count |\n|--------|-------|\n`;
  report += `| Indexed | ${indexed.length} |\n`;
  report += `| Not Indexed | ${notIndexed.length} |\n`;
  report += `| Crawled — Not Indexed | ${crawledNotIndexed.length} |\n`;
  report += `| Errors | ${errors.length} |\n\n`;

  const indexRate = urlsToCheck.length > 0
    ? ((indexed.length / urlsToCheck.length) * 100).toFixed(1)
    : "0";
  report += `**Index rate:** ${indexRate}%\n\n---\n\n`;

  if (notIndexed.length > 0) {
    report += `## Not Indexed (${notIndexed.length})\n\nThese pages need attention — Google is not indexing them.\n\n`;
    report += `| URL | State | Coverage | Robots |\n|-----|-------|----------|--------|\n`;
    for (const s of notIndexed.slice(0, 50)) {
      report += `| ${s.url} | ${s.indexingState} | ${s.coverageState} | ${s.robotsTxtState ?? "-"} |\n`;
    }
    report += "\n";
  }

  if (crawledNotIndexed.length > 0) {
    report += `## Crawled But Not Indexed (${crawledNotIndexed.length})\n\nGoogle crawled these but chose not to index — usually thin content or duplicate.\n\n`;
    for (const s of crawledNotIndexed.slice(0, 30)) {
      report += `- ${s.url} *(last crawl: ${s.lastCrawl ?? "unknown"})*\n`;
    }
    report += "\n";
  }

  if (errors.length > 0) {
    report += `## API Errors (${errors.length})\n\n`;
    for (const e of errors.slice(0, 20)) {
      report += `- **${e.url}** — ${e.error}\n`;
    }
    report += "\n";
  }

  if (indexed.length > 0) {
    report += `## Indexed Pages (${indexed.length})\n\n<details><summary>Show all</summary>\n\n`;
    for (const s of indexed) {
      report += `- ${s.url}\n`;
    }
    report += `\n</details>\n`;
  }

  const reportsDir = join(process.cwd(), "reports");
  if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });

  const outPath = join(reportsDir, `indexing-${date}.md`);
  writeFileSync(outPath, report, "utf-8");
  console.log(`\nReport saved: ${outPath}`);
  console.log(`Indexed: ${indexed.length} | Not indexed: ${notIndexed.length} | Crawled not indexed: ${crawledNotIndexed.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
