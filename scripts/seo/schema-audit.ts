/**
 * Agent 5: structured data audit.
 *
 * The FAQ agent writes FAQPage JSON-LD on every page it touches. Malformed
 * structured data does not just fail to produce a rich result, it can get the
 * whole page's markup ignored, so an unsupervised writer emitting schema needs
 * something checking its output.
 *
 * Also flags page types that should carry schema and do not - both a fixed
 * path-based list (blog posts, the homepage) and, separately, any page at all
 * whose headings read like an FAQ section but whose JSON-LD carries no
 * FAQPage type. That second check exists because of a real miss: a shared
 * FAQ component rendered real question/answer content across the site's four
 * country hub pages and every individual university detail page (100+ pages)
 * with zero structured data, for months, because nothing here was looking at
 * headings, only at a hardcoded per-path expectation list. Heading text is
 * the only FAQ signal available from a crawl (no raw HTML is kept, see
 * CrawledPage in ./crawl), but every FAQ section on this site titles itself
 * with "FAQ" or "Frequently Asked Questions" in an h2, so it is a reliable one.
 */

import { crawlSite, toPath, writeReport } from "./crawl";

type Problem = { url: string; issue: string };

/** Required properties for the types this site emits. */
const REQUIRED: Record<string, string[]> = {
  FAQPage: ["mainEntity"],
  Question: ["name", "acceptedAnswer"],
  Article: ["headline"],
  BlogPosting: ["headline"],
  Organization: ["name"],
  BreadcrumbList: ["itemListElement"],
};

function typesIn(node: any, found: Set<string>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) typesIn(item, found);
    return;
  }
  const t = node["@type"];
  if (typeof t === "string") found.add(t);
  else if (Array.isArray(t)) for (const one of t) if (typeof one === "string") found.add(one);
  for (const value of Object.values(node)) typesIn(value, found);
}

function checkRequired(node: any, url: string, problems: Problem[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) checkRequired(item, url, problems);
    return;
  }

  const t = node["@type"];
  const type = typeof t === "string" ? t : Array.isArray(t) ? t[0] : null;
  if (type && REQUIRED[type]) {
    for (const prop of REQUIRED[type]) {
      const value = node[prop];
      const missing = value === undefined || value === null || (Array.isArray(value) && value.length === 0);
      if (missing) problems.push({ url, issue: `${type} is missing "${prop}"` });
    }
  }

  for (const value of Object.values(node)) checkRequired(value, url, problems);
}

function expectedType(url: string): string | null {
  const path = toPath(url);
  if (path.startsWith("/blog/") && path !== "/blog/") return "Article";
  if (path === "/") return "Organization";
  return null;
}

/** True when a page's own headings read like it carries a real FAQ section. */
const FAQ_HEADING = /\bfaqs?\b|frequently asked questions/i;
function looksLikeFaqPage(page: { h1: string[]; headings: string[] }): boolean {
  return [...page.h1, ...page.headings].some((h) => FAQ_HEADING.test(h));
}

async function main() {
  const pages = (await crawlSite()).filter((p) => p.status === 200);

  const invalid: Problem[] = [];
  const incomplete: Problem[] = [];
  const missing: { url: string; expected: string }[] = [];
  let withSchema = 0;
  const typeCounts = new Map<string, number>();

  for (const page of pages) {
    const types = new Set<string>();

    for (const raw of page.jsonLd) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err: any) {
        invalid.push({ url: page.url, issue: `JSON-LD does not parse: ${err.message?.slice(0, 80)}` });
        continue;
      }
      typesIn(parsed, types);
      checkRequired(parsed, page.url, incomplete);
    }

    if (page.jsonLd.length > 0) withSchema++;
    for (const t of types) typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);

    const expected = expectedType(page.url);
    if (expected && !types.has(expected)) {
      missing.push({ url: page.url, expected });
    }

    if (!types.has("FAQPage") && looksLikeFaqPage(page)) {
      missing.push({ url: page.url, expected: "FAQPage (heading reads like an FAQ section)" });
    }
  }

  const date = new Date().toISOString().split("T")[0];
  let report = `# Structured Data Audit: ${date}\n\n`;
  report += `**Pages checked:** ${pages.length}\n`;
  report += `**Pages with structured data:** ${withSchema}\n\n`;

  report += `## Summary\n\n| Check | Count |\n|-------|-------|\n`;
  report += `| Broken JSON-LD | ${invalid.length} |\n`;
  report += `| Missing required property | ${incomplete.length} |\n`;
  report += `| Page type with no schema | ${missing.length} |\n\n`;

  if (typeCounts.size > 0) {
    report += `### Types in use\n\n| Type | Pages |\n|------|-------|\n`;
    for (const [type, count] of [...typeCounts].sort((a, b) => b[1] - a[1])) {
      report += `| ${type} | ${count} |\n`;
    }
    report += `\n`;
  }

  report += `---\n\n`;

  if (invalid.length > 0) {
    report += `## Broken JSON-LD (${invalid.length})\n\n`;
    report += `Google ignores the whole block when it does not parse.\n\n`;
    for (const p of invalid.slice(0, 30)) report += `- **${toPath(p.url)}** ${p.issue}\n`;
    report += `\n`;
  }

  if (incomplete.length > 0) {
    report += `## Missing Required Properties (${incomplete.length})\n\n`;
    for (const p of incomplete.slice(0, 30)) report += `- **${toPath(p.url)}** ${p.issue}\n`;
    report += `\n`;
  }

  if (missing.length > 0) {
    report += `## No Schema Where There Should Be (${missing.length})\n\n`;
    report += `| Page | Expected |\n|------|----------|\n`;
    for (const m of missing.slice(0, 40)) report += `| ${toPath(m.url)} | ${m.expected} |\n`;
    report += `\n`;
  }

  if (invalid.length === 0 && incomplete.length === 0 && missing.length === 0) {
    report += `All structured data parses and carries its required properties.\n\n`;
  }

  report += `---\n\n`;
  writeReport("schema-audit", report);

  console.log(`Broken: ${invalid.length} | Incomplete: ${incomplete.length} | Missing: ${missing.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
