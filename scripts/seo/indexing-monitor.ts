import { google } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const SITE_URL = "https://titansabroad.org/";
const SITEMAP_URL = "https://titansabroad.org/sitemap.xml";
const MAX_URLS_TO_CHECK = 300;
const DELAY_MS = 300;

async function fetchSitemapUrls(): Promise<string[]> {
  const res = await fetch(SITEMAP_URL);
  if (!res.ok) throw new Error(`Failed to fetch sitemap: ${res.status}`);
  const xml = await res.text();

  const urls: string[] = [];

  // Handle sitemap index (multiple sitemaps)
  const sitemapMatches = [...xml.matchAll(/<sitemap>[\s\S]*?<loc>(.*?)<\/loc>/g)];
  if (sitemapMatches.length > 0) {
    for (const match of sitemapMatches) {
      const subRes = await fetch(match[1].trim());
      const subXml = await subRes.text();
      const subMatches = [...subXml.matchAll(/<url>[\s\S]*?<loc>(.*?)<\/loc>/g)];
      urls.push(...subMatches.map((m) => m[1].trim()));
    }
  } else {
    const urlMatches = [...xml.matchAll(/<url>[\s\S]*?<loc>(.*?)<\/loc>/g)];
    urls.push(...urlMatches.map((m) => m[1].trim()));
  }

  return [...new Set(urls)];
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
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT!);

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

  for (let i = 0; i < urlsToCheck.length; i++) {
    const url = urlsToCheck[i];

    if (i % 20 === 0 && i > 0) {
      console.log(`Progress: ${i}/${urlsToCheck.length}`);
    }

    try {
      const res = await searchconsole.urlInspection.index.inspect({
        requestBody: {
          inspectionUrl: url,
          siteUrl: SITE_URL,
        },
      });

      const result = res.data.inspectionResult;
      const idx = result?.indexStatusResult;
      const verdict = idx?.verdict ?? "UNKNOWN";
      const indexingState = idx?.indexingState ?? "UNKNOWN";
      const coverageState = idx?.coverageState ?? "";
      const lastCrawl = idx?.lastCrawlTime ?? undefined;
      const robotsTxtState = idx?.robotsTxtState ?? undefined;

      const status: UrlStatus = { url, verdict, indexingState, coverageState, lastCrawl, robotsTxtState };

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

    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  // Resubmit sitemaps to signal Google
  try {
    await searchconsole.sitemaps.submit({ siteUrl: SITE_URL, feedpath: SITEMAP_URL });
    console.log("Sitemap resubmitted to Google.");
  } catch (err: any) {
    console.warn("Sitemap resubmit failed:", err.message);
  }

  const date = new Date().toISOString().split("T")[0];
  let report = `# Indexing Monitor Report — ${date}\n\n`;
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
