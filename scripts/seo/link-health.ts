/**
 * Agent 3: link health.
 *
 * Finds pages that do not return 200, internal links pointing at dead URLs,
 * sitemap entries that redirect, and broken external links. The redirect
 * check is here because a sitemap full of redirects is exactly what kept
 * this site at a 3.7% index rate, and nothing was watching for it.
 *
 * External links get the same check as internal ones. A dead link to an
 * application portal or a university's own site is worse than a dead
 * internal link, since it sits on the page where a student is trying to take
 * the one action that matters, and nothing else in this system checks
 * outbound links at all.
 */

import { crawlSite, toPath, writeReport, type CrawledPage } from "./crawl";

const TIMEOUT_MS = 15000;

// These platforms reject or silently drop scripted HEAD/GET requests
// regardless of whether the linked page is real, so a "no response" from one
// of them is not a signal, it is just how they treat bots. Checking them
// anyway produces the same false "broken" flag on every page that carries a
// social-share link in a shared footer. Add a host here the moment it shows
// the same pattern; this is the only place that needs editing.
const UNCHECKABLE_HOSTS = [
  "instagram.com",
  "facebook.com",
  "youtube.com",
  "youtu.be",
  "whatsapp.com",
  "wa.me",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "linkedin.com",
];

function isUncheckable(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return UNCHECKABLE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

async function requestOnce(url: string): Promise<number> {
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

async function headStatus(url: string): Promise<number> {
  return requestOnce(url);
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
  // pages are not fetched twice. External links are never in the crawl, so
  // every distinct one gets checked.
  const known = new Map(pages.map((p) => [normalize(p.url), p.status]));
  const outside = new Set<string>();
  const externalTargets = new Set<string>();
  for (const page of pages) {
    for (const link of page.links) {
      if (!known.has(normalize(link))) outside.add(link);
    }
    for (const link of page.externalLinks) {
      if (!isUncheckable(link)) externalTargets.add(link);
    }
  }

  console.log(`Checking ${outside.size} link targets not in the sitemap...`);
  console.log(`Checking ${externalTargets.size} external link targets...`);
  const checked = new Map<string, number>();
  const targets = new Map<string, string>();
  for (const url of [...outside, ...externalTargets]) targets.set(normalize(url), url);
  const queue = [...targets.values()];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let url = queue.shift(); url; url = queue.shift()) {
        checked.set(normalize(url), await headStatus(url));
      }
    })
  );

  // Six requests running at once, several to the same slow embassy or
  // ministry host, produces the occasional dropped connection that has
  // nothing to do with whether the page is actually up: the same URL,
  // fetched alone, comes back 200. Anything the batch pass called broken
  // gets one more try in isolation, one at a time with no other traffic
  // competing for the connection, before it is allowed into the report.
  const suspects = [...checked.entries()].filter(([, status]) => status === 0 || status >= 500);
  if (suspects.length > 0) {
    console.log(`Re-checking ${suspects.length} failures in isolation...`);
    for (const [key] of suspects) {
      const url = targets.get(key)!;
      let status = await headStatus(url);
      if (status === 0 || status >= 500) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        status = await headStatus(url);
      }
      checked.set(key, status);
    }
  }

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

  const brokenExternal: { from: string; to: string; status: number }[] = [];
  for (const page of pages) {
    for (const link of page.externalLinks) {
      if (isUncheckable(link)) continue;
      const status = checked.get(normalize(link));
      if (status !== undefined && (status >= 400 || status === 0)) {
        brokenExternal.push({ from: page.url, to: link, status });
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
  report += `| Broken internal links | ${broken.length} |\n`;
  report += `| Broken external links | ${brokenExternal.length} |\n\n---\n\n`;

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

  if (brokenExternal.length > 0) {
    report += `## Broken External Links (${brokenExternal.length})\n\n`;
    report += `These point off-site, to things like university pages, application portals, or `;
    report += `scholarship sites. A dead one here sits on the page where a student is trying to `;
    report += `take the one action that matters.\n\n`;
    report += `| On page | Links to | Status |\n|---------|----------|--------|\n`;
    for (const b of brokenExternal.slice(0, 50)) {
      report += `| ${toPath(b.from)} | ${b.to} | ${b.status || "no response"} |\n`;
    }
    report += `\n`;
  }

  if (dead.length === 0 && redirected.length === 0 && broken.length === 0 && brokenExternal.length === 0) {
    report += `Every sitemap URL returns 200 directly and no internal or external link is broken.\n\n`;
  }

  report += `---\n\n`;
  writeReport("link-health", report);

  console.log(
    `Dead: ${dead.length} | Redirects: ${redirected.length} | Broken internal: ${broken.length} | Broken external: ${brokenExternal.length}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
