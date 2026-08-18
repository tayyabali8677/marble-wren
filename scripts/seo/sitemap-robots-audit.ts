/**
 * Agent 23: sitemap and robots.txt consistency.
 *
 * A URL that is both submitted for indexing in the sitemap and blocked from
 * crawling in robots.txt sends Google two contradictory instructions at once.
 * Nothing else in this system compares the two files against each other, and
 * sitemap.xml and robots.txt are edited independently, so nothing catches a
 * new Disallow rule silently orphaning sitemap entries.
 *
 * This only checks literal path-prefix Disallow rules, the common case for a
 * Next.js site's robots.txt. It does not evaluate `*` or `$` wildcards, so a
 * wildcard rule that would in fact block a sitemap URL can be missed. That is
 * a false negative, not a false positive: it stays quiet rather than crying
 * wolf on a pattern it cannot evaluate correctly.
 */

import { fetchSitemapEntries } from "./sitemap";
import { writeReport, toPath } from "./crawl";

const SITE_ORIGIN = "https://titansabroad.org";
const SITEMAP_URL = `${SITE_ORIGIN}/sitemap.xml`;
const ROBOTS_URL = `${SITE_ORIGIN}/robots.txt`;
const MAX_REPORTED = 50;

/** Disallow rules under `User-agent: *`, plus any rule under our own UA if named. */
function parseDisallowRules(robotsTxt: string): string[] {
  const rules: string[] = [];
  let inRelevantGroup = false;

  for (const rawLine of robotsTxt.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      inRelevantGroup = value === "*" || /titansabroad-seo-agent/i.test(value);
      continue;
    }
    if (key === "disallow" && inRelevantGroup && value) {
      rules.push(value);
    }
  }

  return rules;
}

function isBlocked(pathname: string, rules: string[]): string | null {
  for (const rule of rules) {
    if (rule.includes("*") || rule.includes("$")) continue;
    if (pathname.startsWith(rule)) return rule;
  }
  return null;
}

async function main() {
  const [entries, robotsRes] = await Promise.all([
    fetchSitemapEntries(SITEMAP_URL),
    fetch(ROBOTS_URL),
  ]);

  const date = new Date().toISOString().split("T")[0];

  if (!robotsRes.ok) {
    const report =
      `# Sitemap / Robots.txt Consistency: ${date}\n\n` +
      `Could not fetch ${ROBOTS_URL} (status ${robotsRes.status}). Nothing checked.\n\n---\n\n`;
    writeReport("sitemap-robots-audit", report);
    console.log(`robots.txt fetch failed: ${robotsRes.status}`);
    return;
  }

  const robotsTxt = await robotsRes.text();
  const rules = parseDisallowRules(robotsTxt);

  const blocked: Array<{ url: string; rule: string }> = [];
  for (const entry of entries) {
    let pathname: string;
    try {
      pathname = new URL(entry.url).pathname;
    } catch {
      continue;
    }
    const rule = isBlocked(pathname, rules);
    if (rule) blocked.push({ url: entry.url, rule });
  }

  let report = `# Sitemap / Robots.txt Consistency: ${date}\n\n`;
  report += `**Sitemap URLs:** ${entries.length}\n`;
  report += `**Disallow rules checked:** ${rules.length}\n`;
  report += `**Sitemap URLs blocked by robots.txt:** ${blocked.length}\n\n`;
  report += `Only literal path-prefix Disallow rules are evaluated; wildcard rules `;
  report += `(containing \`*\` or \`$\`) are skipped rather than guessed at.\n\n---\n\n`;

  if (blocked.length > 0) {
    report += `## Sitemap URLs Blocked By Robots.txt (${blocked.length})\n\n`;
    report += `Google is told to index these and to not crawl them, at the same time. `;
    report += `Either drop them from the sitemap or remove the Disallow rule.\n\n`;
    report += `| URL | Blocked by rule |\n|---|---|\n`;
    for (const b of blocked.slice(0, MAX_REPORTED)) {
      report += `| ${toPath(b.url)} | \`Disallow: ${b.rule}\` |\n`;
    }
    if (blocked.length > MAX_REPORTED) report += `\n*${blocked.length - MAX_REPORTED} more.*\n`;
    report += `\n`;
  } else {
    report += `No sitemap URL is blocked by a literal robots.txt rule.\n\n`;
  }

  report += `---\n\n`;
  writeReport("sitemap-robots-audit", report);
  console.log(`Sitemap URLs: ${entries.length} | Blocked by robots.txt: ${blocked.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
