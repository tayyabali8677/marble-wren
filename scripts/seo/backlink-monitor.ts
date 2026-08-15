/**
 * Agent 21: backlink monitor.
 *
 * A backlink earned is worth knowing about; a backlink lost is worth knowing
 * about sooner, because a link that vanishes usually took some ranking with it.
 * Neither shows up anywhere else in this system, which only ever looks at our
 * own pages.
 *
 * No free API gives a competitor's backlinks, but Bing Webmaster Tools gives our
 * own for nothing, so that is what this uses. It is gated on
 * BING_WEBMASTER_API_KEY: dormant and exiting clean when the key is unset, so it
 * is wired in now and starts working the night a key is added. Create the key in
 * the Bing Webmaster Tools account under Settings, API access.
 *
 * Bing returns only a current snapshot, never history, so detecting what is new
 * or lost means remembering the last snapshot. The reports directory is
 * committed every night, so the previous snapshot is read from there and the
 * fresh one written back, which is the same state-in-git the rest of the nightly
 * job already leans on. The first run has nothing to compare against and simply
 * records a baseline.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { writeReport } from "./crawl";

const SITE_URL = "https://titansabroad.org/";
const OWN_HOST = "titansabroad.org";
const API_BASE = "https://ssl.bing.com/webmaster/api.svc/json";
// The snapshot lives in the committed reports directory so it survives between
// CI runs. The underscore keeps it out of the way of the dated .md reports the
// digest reads.
const SNAPSHOT = join(process.cwd(), "reports", "_backlinks-snapshot.json");
// How many of our most-linked pages to pull actual referring URLs for. Each is
// one more API call, and the domains behind the long tail of once-linked pages
// change rarely, so the top pages are where new and lost links actually show.
const TOP_PAGES_FOR_DOMAINS = 30;
const MAX_LINKCOUNT_PAGES = 20;
const REQUEST_GAP_MS = 300;

type Snapshot = {
  date: string;
  totalLinks: number;
  linkedPages: number;
  domains: string[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The JSON API wraps every payload in a "d" property; unwrap defensively. */
function unwrap(body: any): any {
  return body && typeof body === "object" && "d" in body ? body.d : body;
}

async function api(method: string, params: Record<string, string>, apiKey: string): Promise<any> {
  const qs = new URLSearchParams({ ...params, apikey: apiKey }).toString();
  const res = await fetch(`${API_BASE}/${method}?${qs}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    throw new Error(`Bing ${method} ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
  return unwrap(await res.json());
}

/** Per-page inbound link counts for the site, walked page by page until dry. */
async function linkCounts(apiKey: string): Promise<Array<{ url: string; count: number }>> {
  const out: Array<{ url: string; count: number }> = [];
  for (let page = 0; page < MAX_LINKCOUNT_PAGES; page++) {
    const data = await api("GetLinkCounts", { siteUrl: SITE_URL, page: String(page) }, apiKey);
    const links: any[] = data?.Links ?? [];
    if (links.length === 0) break;
    for (const l of links) {
      const url = l?.Url ?? l?.url;
      if (url) out.push({ url, count: Number(l?.Count ?? l?.count ?? 0) });
    }
    await sleep(REQUEST_GAP_MS);
  }
  return out;
}

/** Referring source URLs pointing at one of our pages. */
async function urlLinks(ourPage: string, apiKey: string): Promise<string[]> {
  const data = await api("GetUrlLinks", { siteUrl: SITE_URL, link: ourPage, page: "0" }, apiKey);
  const links: any[] = data?.Links ?? data?.UrlLinks ?? [];
  return links.map((l) => l?.Url ?? l?.url ?? "").filter(Boolean);
}

function loadPrevious(): Snapshot | null {
  if (!existsSync(SNAPSHOT)) return null;
  try {
    return JSON.parse(readFileSync(SNAPSHOT, "utf-8"));
  } catch {
    return null;
  }
}

function saveSnapshot(snap: Snapshot): void {
  mkdirSync(join(process.cwd(), "reports"), { recursive: true });
  writeFileSync(SNAPSHOT, JSON.stringify(snap, null, 2), "utf-8");
}

function dormantReport(reason: string) {
  const date = new Date().toISOString().split("T")[0];
  let report = `# Backlink Monitor: ${date}\n\n`;
  report += `**Status:** dormant\n\n`;
  report += `${reason}\n\n`;
  report += `To turn this on, create a free Bing Webmaster Tools account, verify titansabroad.org, `;
  report += `and generate an API key under Settings, API access. Set it as a \`BING_WEBMASTER_API_KEY\` `;
  report += `secret on the repository. The monitor then reports new and lost backlinks to the site `;
  report += `each night. It covers our own inbound links only; competitor backlinks need a paid `;
  report += `provider and are out of scope here.\n\n---\n\n`;
  writeReport("backlink-monitor", report);
  console.log(`Backlink monitor dormant: ${reason}`);
}

async function main() {
  const apiKey = process.env.BING_WEBMASTER_API_KEY;
  if (!apiKey) {
    dormantReport("No Bing Webmaster API key is configured, so no backlink data was fetched.");
    return;
  }

  let counts: Array<{ url: string; count: number }>;
  try {
    counts = await linkCounts(apiKey);
  } catch (err: any) {
    // A bad key or an unverified site should read clearly, not as a red run.
    dormantReport(`The Bing Webmaster API rejected the request: ${err.message}. Check that the key is valid and the site is verified.`);
    return;
  }

  const totalLinks = counts.reduce((s, c) => s + c.count, 0);
  counts.sort((a, b) => b.count - a.count);

  // Pull actual referring domains for the most-linked pages.
  const domainSet = new Set<string>();
  let domainCallsFailed = 0;
  for (const { url } of counts.slice(0, TOP_PAGES_FOR_DOMAINS)) {
    try {
      for (const src of await urlLinks(url, apiKey)) {
        const host = hostOf(src);
        if (host && !host.endsWith(OWN_HOST)) domainSet.add(host);
      }
    } catch {
      domainCallsFailed++;
    }
    await sleep(REQUEST_GAP_MS);
  }
  const domains = [...domainSet].sort();

  const date = new Date().toISOString().split("T")[0];
  const previous = loadPrevious();
  const current: Snapshot = { date, totalLinks, linkedPages: counts.length, domains };

  let report = `# Backlink Monitor: ${date}\n\n`;
  report += `**Total inbound links (Bing):** ${totalLinks}\n`;
  report += `**Pages with inbound links:** ${counts.length}\n`;
  report += `**Distinct referring domains (top ${TOP_PAGES_FOR_DOMAINS} pages):** ${domains.length}\n`;
  if (domainCallsFailed > 0) report += `**Referring-domain lookups that failed:** ${domainCallsFailed}\n`;
  report += `\n`;

  if (!previous) {
    report += `This is the first run, so there is nothing to compare against yet. Tonight's numbers `;
    report += `are the baseline; from tomorrow this reports what changed against them.\n\n`;
    report += `## Most-Linked Pages\n\n`;
    report += `| Page | Inbound links |\n|---|---|\n`;
    for (const c of counts.slice(0, 20)) {
      report += `| ${c.url.replace(/^https?:\/\/[^/]+/, "") || "/"} | ${c.count} |\n`;
    }
    report += `\n---\n\n`;
    writeReport("backlink-monitor", report);
    saveSnapshot(current);
    console.log(`Baseline recorded: ${totalLinks} links, ${domains.length} domains.`);
    return;
  }

  const prevDomains = new Set(previous.domains);
  const gained = domains.filter((d) => !prevDomains.has(d));
  const lost = previous.domains.filter((d) => !domainSet.has(d));
  const delta = totalLinks - previous.totalLinks;

  report += `Compared against the snapshot from ${previous.date}.\n\n`;
  report += `**Change in total inbound links:** ${delta >= 0 ? "+" : ""}${delta}\n`;
  report += `**New referring domains:** ${gained.length}\n`;
  report += `**Lost referring domains:** ${lost.length}\n\n`;

  if (lost.length > 0) {
    report += `## Lost Referring Domains (${lost.length})\n\n`;
    report += `These linked to us at the last check and no longer appear. A lost link often takes `;
    report += `ranking with it, so these are worth a look first: a removed mention, a rewritten page, `;
    report += `or a site that went down.\n\n`;
    for (const d of lost) report += `- ${d}\n`;
    report += `\n`;
  }

  if (gained.length > 0) {
    report += `## New Referring Domains (${gained.length})\n\n`;
    report += `New since the last check. Worth a glance to confirm they are genuine mentions rather `;
    report += `than scraper or spam domains, which are better disavowed than counted.\n\n`;
    for (const d of gained) report += `- ${d}\n`;
    report += `\n`;
  }

  if (gained.length === 0 && lost.length === 0) {
    report += `No referring domains gained or lost since ${previous.date}. Backlink profile is steady.\n\n`;
  }

  report += `---\n\n`;
  writeReport("backlink-monitor", report);
  saveSnapshot(current);
  console.log(
    `Links: ${totalLinks} (${delta >= 0 ? "+" : ""}${delta}) | Domains +${gained.length}/-${lost.length}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
