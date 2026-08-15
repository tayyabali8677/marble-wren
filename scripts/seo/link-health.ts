/**
 * Agent 3: link health.
 *
 * Finds pages that do not return 200, internal links pointing at dead URLs,
 * and sitemap entries that redirect. The redirect check is here because a
 * sitemap full of redirects is exactly what kept this site at a 3.7% index
 * rate, and nothing was watching for it.
 */

import { crawlSite, toPath, writeReport, type CrawledPage } from "./crawl";

const TIMEOUT_MS = 15000;

async function headStatus(url: string): Promise<number> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; titansabroad-seo-agent)" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "manual",
    });
    return res.status;
  } catch {
    return 0;
  }
}

function normalize(url: string): string {
  return url.replace(/\/+$/, "").toLowerCase();
}

async function main() {
  const pages = await crawlSite();

  const dead = pages.filter((p) => p.status >= 400 || p.status === 0);
  const redirected = pages.filter(
    (p) => p.status >= 200 && p.status < 400 && normalize(p.finalUrl) !== normalize(p.url)
  );

  // Only check link targets we have not already crawled, so the sitemap
  // pages are not fetched twice.
  const known = new Map(pages.map((p) => [normalize(p.url), p.status]));
  const outside = new Set<string>();
  for (const page of pages) {
    for (const link of page.links) {
      if (!known.has(normalize(link))) outside.add(link);
    }
  }

  console.log(`Checking ${outside.size} link targets not in the sitemap...`);
  const checked = new Map<string, number>();
  const queue = [...outside];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let url = queue.shift(); url; url = queue.shift()) {
        checked.set(normalize(url), await headStatus(url));
      }
    })
  );

  // A link is broken when its target answers 4xx/5xx or not at all.
  const broken: { from: string; to: string; status: number }[] = [];
  for (const page of pages) {
    for (const link of page.links) {
      const status = known.get(normalize(link)) ?? checked.get(normalize(link));
      if (status !== undefined && (status >= 400 || status === 0)) {
        broken.push({ from: page.url, to: link, status });
      }
    }
  }

  const date = new Date().toISOString().split("T")[0];
  let report = `# Link Health: ${date}\n\n`;
  report += `**Pages crawled:** ${pages.length}\n`;
  report += `**External link targets checked:** ${outside.size}\n\n`;

  report += `## Summary\n\n| Check | Count |\n|-------|-------|\n`;
  report += `| Pages not returning 200 | ${dead.length} |\n`;
  report += `| Sitemap URLs that redirect | ${redirected.length} |\n`;
  report += `| Broken internal links | ${broken.length} |\n\n---\n\n`;

  if (dead.length > 0) {
    report += `## Pages Not Returning 200 (${dead.length})\n\n`;
    report += `These are in the sitemap but do not load. Google will drop them.\n\n`;
    report += `| URL | Status | Error |\n|-----|--------|-------|\n`;
    for (const p of dead.slice(0, 50)) {
      report += `| ${toPath(p.url)} | ${p.status || "no response"} | ${p.error ?? "-"} |\n`;
    }
    report += `\n`;
  }

  if (redirected.length > 0) {
    report += `## Sitemap URLs That Redirect (${redirected.length})\n\n`;
    report += `A sitemap should list final URLs. Redirects here waste crawl budget and `;
    report += `are what kept this site out of the index before.\n\n`;
    report += `| Listed | Actually serves |\n|--------|-----------------|\n`;
    for (const p of redirected.slice(0, 50)) {
      report += `| ${p.url} | ${p.finalUrl} |\n`;
    }
    report += `\n`;
  }

  if (broken.length > 0) {
    report += `## Broken Internal Links (${broken.length})\n\n`;
    report += `| On page | Links to | Status |\n|---------|----------|--------|\n`;
    for (const b of broken.slice(0, 50)) {
      report += `| ${toPath(b.from)} | ${toPath(b.to)} | ${b.status || "no response"} |\n`;
    }
    report += `\n`;
  }

  if (dead.length === 0 && redirected.length === 0 && broken.length === 0) {
    report += `Every sitemap URL returns 200 directly and no internal link is broken.\n\n`;
  }

  report += `---\n\n`;
  writeReport("link-health", report);

  console.log(`Dead: ${dead.length} | Redirects: ${redirected.length} | Broken links: ${broken.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
