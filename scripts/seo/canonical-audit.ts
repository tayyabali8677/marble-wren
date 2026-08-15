/**
 * Agent 15: canonical and indexability.
 *
 * A page can be perfect and still rank nowhere if it tells Google not to index
 * it, or points its canonical at a different page, or sits in the sitemap while
 * quietly canonicalising elsewhere. These are the mistakes that survive review
 * because the page looks fine to a human: the signal that suppresses it is in
 * the head, invisible on the rendered page.
 *
 * Everything here is checked against the crawl, which is the sitemap already, so
 * every page examined is one the site is actively asking Google to index. That
 * is exactly the set where a noindex or a foreign canonical is a real mistake
 * rather than a deliberate exclusion.
 */

import { crawlSite, writeReport, toPath, type CrawledPage } from "./crawl";

const SITE_ORIGIN = "https://titansabroad.org";
const MAX_REPORTED = 40;

function normalise(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/$/, "") : u.pathname;
    return `${u.origin}${path}`;
  } catch {
    return url;
  }
}

async function main() {
  const pages = await crawlSite();
  const ok = pages.filter((p) => p.status === 200);
  const inSitemap = new Set(ok.map((p) => normalise(p.url)));

  // Pages the sitemap lists that do not return 200.
  const broken = pages.filter((p) => p.status !== 200 && !p.error);
  const errored = pages.filter((p) => p.error);

  // noindex on a sitemap page is a contradiction: the sitemap asks Google to
  // index it, the meta tag asks Google not to.
  const noindex = ok.filter((p) => /\bnoindex\b/.test(p.robots));
  const nofollow = ok.filter((p) => /\bnofollow\b/.test(p.robots));

  type CanonFinding = { path: string; canonical: string; reason: string };
  const canonicalIssues: CanonFinding[] = [];
  let selfCanonical = 0;
  let missingCanonical = 0;

  for (const p of ok) {
    const self = normalise(p.url);
    if (!p.canonical) {
      missingCanonical++;
      continue;
    }
    const canon = normalise(p.canonical);

    // Off-site canonical hands the ranking to another domain outright.
    if (!canon.startsWith(SITE_ORIGIN)) {
      canonicalIssues.push({ path: toPath(p.url), canonical: p.canonical, reason: "Points to another domain" });
      continue;
    }
    if (canon === self) {
      selfCanonical++;
      continue;
    }
    // Canonical to a different page on the site. Legitimate for a genuine
    // duplicate, a problem when the page is meant to rank on its own.
    const targetLive = inSitemap.has(canon);
    canonicalIssues.push({
      path: toPath(p.url),
      canonical: toPath(p.canonical),
      reason: targetLive
        ? "Canonicalises to another sitemap page, so this page is asking not to rank"
        : "Canonicalises to a page not in the sitemap",
    });
  }

  // Two sitemap pages naming the same canonical is a duplicate cluster: only
  // one of them can win, and the sitemap is advertising all of them.
  const canonicalTargets = new Map<string, string[]>();
  for (const p of ok) {
    if (!p.canonical) continue;
    const canon = normalise(p.canonical);
    if (canon === normalise(p.url)) continue;
    const list = canonicalTargets.get(canon) ?? [];
    list.push(toPath(p.url));
    canonicalTargets.set(canon, list);
  }
  const clusters = [...canonicalTargets].filter(([, l]) => l.length > 1);

  // Redirects inside the sitemap. The sitemap should list final URLs, not URLs
  // that bounce, or crawl budget is spent following hops.
  const redirected = ok.filter((p) => normalise(p.finalUrl) !== normalise(p.url));

  const date = new Date().toISOString().split("T")[0];
  const total =
    broken.length + errored.length + noindex.length + canonicalIssues.length +
    clusters.length + redirected.length + missingCanonical;

  let report = `# Canonical And Indexability: ${date}\n\n`;
  report += `**Sitemap URLs crawled:** ${pages.length}\n`;
  report += `**Returning 200:** ${ok.length}\n`;
  report += `**Self-canonical (correct):** ${selfCanonical}\n`;
  report += `**Missing a canonical tag:** ${missingCanonical}\n`;
  report += `**noindex on a sitemap page:** ${noindex.length}\n`;
  report += `**Canonical problems:** ${canonicalIssues.length}\n`;
  report += `**Sitemap entries not returning 200:** ${broken.length + errored.length}\n\n`;

  if (total === 0) {
    report += `Every sitemap URL returns 200, canonicalises to itself, and is indexable. `;
    report += `Nothing here is suppressing a page that is meant to rank.\n\n---\n\n`;
    writeReport("canonical-audit", report);
    console.log("No indexability issues.");
    return;
  }

  if (noindex.length > 0) {
    report += `## Noindex On A Page In The Sitemap (${noindex.length})\n\n`;
    report += `The sitemap asks Google to index these, the page tells Google not to. One of `;
    report += `the two is a mistake, and the tag wins, so these pages will not rank.\n\n`;
    for (const p of noindex.slice(0, MAX_REPORTED)) report += `- **${toPath(p.url)}** \`${p.robots}\`\n`;
    report += `\n`;
  }

  if (broken.length + errored.length > 0) {
    report += `## Sitemap Entries That Do Not Return 200 (${broken.length + errored.length})\n\n`;
    report += `A sitemap of dead URLs erodes the trust Google places in the whole file.\n\n`;
    for (const p of [...broken, ...errored].slice(0, MAX_REPORTED)) {
      report += `- **${toPath(p.url)}** ${p.error ? `fetch failed (${p.error})` : `HTTP ${p.status}`}\n`;
    }
    report += `\n`;
  }

  if (canonicalIssues.length > 0) {
    report += `## Canonical Problems (${canonicalIssues.length})\n\n`;
    report += `A canonical pointing away from the page hands its ranking to whatever it points at.\n\n`;
    report += `| Page | Canonical points to | Why it matters |\n|---|---|---|\n`;
    for (const c of canonicalIssues.slice(0, MAX_REPORTED)) {
      report += `| ${c.path} | ${c.canonical} | ${c.reason} |\n`;
    }
    if (canonicalIssues.length > MAX_REPORTED) report += `\n*${canonicalIssues.length - MAX_REPORTED} more.*\n`;
    report += `\n`;
  }

  if (clusters.length > 0) {
    report += `## Pages Sharing One Canonical Target (${clusters.length})\n\n`;
    report += `Several sitemap pages point their canonical at the same URL. Only that URL can `;
    report += `rank, so the rest are along for the ride and should probably not be in the sitemap.\n\n`;
    for (const [target, list] of clusters.sort((a, b) => b[1].length - a[1].length).slice(0, MAX_REPORTED)) {
      report += `- **${toPath(target)}** is the canonical for: ${list.slice(0, 6).join(", ")}`;
      report += list.length > 6 ? ` and ${list.length - 6} more\n` : `\n`;
    }
    report += `\n`;
  }

  if (redirected.length > 0) {
    report += `## Sitemap URLs That Redirect (${redirected.length})\n\n`;
    report += `The sitemap should list the final URL, not one that bounces to it.\n\n`;
    report += `| Listed | Lands on |\n|---|---|\n`;
    for (const p of redirected.slice(0, MAX_REPORTED)) {
      report += `| ${toPath(p.url)} | ${toPath(p.finalUrl)} |\n`;
    }
    report += `\n`;
  }

  if (missingCanonical > 0) {
    report += `## Missing A Canonical Tag (${missingCanonical})\n\n`;
    report += `Not fatal, since Google will assume the page is its own canonical, but declaring `;
    report += `it removes the ambiguity, especially where query strings or trailing slashes vary.\n\n`;
    for (const p of ok.filter((x) => !x.canonical).slice(0, MAX_REPORTED)) report += `- ${toPath(p.url)}\n`;
    report += `\n`;
  }

  report += `---\n\n`;
  writeReport("canonical-audit", report);
  console.log(
    `noindex: ${noindex.length} | canonical issues: ${canonicalIssues.length} | dead in sitemap: ${broken.length + errored.length} | redirects: ${redirected.length}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
