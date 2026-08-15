/**
 * Agent 9: internal link graph.
 *
 * On a site with 580 URLs the cheapest ranking lever left is usually how the
 * pages point at each other. A page nothing links to gets crawled late, ranks
 * badly, and passes nothing on.
 *
 * The trick that makes this useful rather than noise is discounting chrome.
 * Header, footer and sidebar links appear on nearly every page, so counting raw
 * inbound links tells you every page is well linked. Only links that appear on
 * a minority of pages are editorial, and those are the ones that count here.
 */

import { crawlSite, writeReport, toPath, type CrawledPage } from "./crawl";

// A link target that shows up on this share of all pages is navigation, not an
// editorial mention, so it is excluded from the inbound counts.
const CHROME_SHARE = 0.5;
const WEAK_MAX = 2;
// Suggesting 40 sources for one orphan is not a suggestion, it is a list.
const MAX_SUGGESTIONS = 5;
const MAX_REPORTED = 40;

type Node = {
  page: CrawledPage;
  path: string;
  /** Editorial inbound links only, chrome excluded. */
  inbound: string[];
  outbound: number;
};

/**
 * Titles come out of the raw HTML, so they still carry entities while the body
 * text has already been decoded. Without this, "IBCC &amp; MOFA" never matches
 * the "IBCC & MOFA" sitting in the prose and the page looks unmentionable.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * The phrase that identifies a page well enough to look for mentions of it
 * elsewhere. Titles run "Beihua University MBBS in China | Fees ...", so the
 * part before the first separator is the useful half.
 */
function subjectOf(page: CrawledPage): string {
  const head = decodeEntities(page.title).split(/[|·–-]/)[0].trim();
  return head.replace(/\s+(MBBS|BDS|in China|in Russia|in Georgia)\b.*$/i, "").trim();
}

function normalise(url: string): string {
  const path = toPath(url);
  return path.length > 1 ? path.replace(/\/$/, "") : path;
}

async function main() {
  const pages = (await crawlSite()).filter((p) => p.status === 200);
  const byPath = new Map<string, CrawledPage>();
  for (const p of pages) byPath.set(normalise(p.url), p);

  // How many distinct pages link to each target, before any filtering. This is
  // what tells chrome apart from editorial.
  const linkers = new Map<string, Set<string>>();
  for (const p of pages) {
    const from = normalise(p.url);
    for (const href of p.links) {
      const to = normalise(href);
      if (to === from || !byPath.has(to)) continue;
      const set = linkers.get(to) ?? new Set<string>();
      set.add(from);
      linkers.set(to, set);
    }
  }

  const chromeCutoff = pages.length * CHROME_SHARE;
  const chrome = new Set([...linkers].filter(([, s]) => s.size >= chromeCutoff).map(([to]) => to));

  const nodes: Node[] = [];
  for (const [path, page] of byPath) {
    const inbound = chrome.has(path) ? [] : [...(linkers.get(path) ?? [])];
    const outbound = new Set(
      page.links.map(normalise).filter((t) => t !== path && byPath.has(t) && !chrome.has(t))
    ).size;
    nodes.push({ page, path, inbound, outbound });
  }

  const orphans = nodes.filter((n) => !chrome.has(n.path) && n.inbound.length === 0);
  const weak = nodes.filter(
    (n) => !chrome.has(n.path) && n.inbound.length > 0 && n.inbound.length <= WEAK_MAX
  );

  /**
   * Pages that already talk about this subject in their body text but do not
   * link to it. Those are real editorial opportunities rather than arbitrary
   * link insertions, because the context is already on the page.
   */
  function suggestSources(node: Node): string[] {
    const subject = subjectOf(node.page);
    if (subject.length < 6) return [];
    const needle = subject.toLowerCase();
    const already = new Set(node.inbound);
    return nodes
      .filter((n) => n.path !== node.path && !already.has(n.path))
      .filter((n) => n.page.text.toLowerCase().includes(needle))
      .sort((a, b) => b.outbound - a.outbound)
      .slice(0, MAX_SUGGESTIONS)
      .map((n) => n.path);
  }

  const date = new Date().toISOString().split("T")[0];
  let report = `# Internal Link Graph: ${date}\n\n`;
  report += `**Pages:** ${nodes.length}\n`;
  report += `**Navigation targets excluded:** ${chrome.size} (linked from ${Math.round(CHROME_SHARE * 100)}%+ of pages, so header, footer or sidebar)\n`;
  report += `**Orphans:** ${orphans.length}\n`;
  report += `**Weakly linked (1 to ${WEAK_MAX} editorial links):** ${weak.length}\n\n`;
  report += `Inbound counts here ignore navigation. A page reachable only through the `;
  report += `menu has no editorial support, which is what this measures.\n\n`;

  if (orphans.length === 0 && weak.length === 0) {
    report += `Every page has at least ${WEAK_MAX + 1} editorial inbound links. Nothing to do.\n\n---\n\n`;
    writeReport("internal-links", report);
    console.log("No orphans or weakly linked pages.");
    return;
  }

  for (const [heading, list, note] of [
    ["Orphan Pages", orphans, "Nothing but navigation points here. These rank worst and are crawled last."],
    ["Weakly Linked Pages", weak, `One or two editorial links each. Worth strengthening where the page matters.`],
  ] as const) {
    if (list.length === 0) continue;
    report += `## ${heading} (${list.length})\n\n${note}\n\n`;
    for (const node of list.slice(0, MAX_REPORTED)) {
      const sources = suggestSources(node);
      report += `### ${node.path}\n\n`;
      report += `**Subject:** ${subjectOf(node.page) || "(title not usable)"}\n`;
      report += `**Editorial inbound:** ${node.inbound.length}\n`;
      if (sources.length > 0) {
        report += `**Already mentions it, does not link to it:**\n\n`;
        for (const s of sources) report += `- ${s}\n`;
      } else {
        report += `\nNo other page mentions this subject, so a link needs new copy rather than a hyperlink.\n`;
      }
      report += `\n`;
    }
    if (list.length > MAX_REPORTED) {
      report += `*${list.length - MAX_REPORTED} more in the same state.*\n\n`;
    }
  }

  report += `---\n\n`;
  writeReport("internal-links", report);
  console.log(`Orphans: ${orphans.length} | Weak: ${weak.length} | Chrome targets: ${chrome.size}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
