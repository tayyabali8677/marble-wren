/**
 * Agent 20: competitor SERP tracker.
 *
 * Every other agent looks inward at our own pages. This one looks at the result
 * page itself: for the queries we already rank on, who sits above us, and which
 * rivals keep showing up across the whole set. Search Console tells us our own
 * average position but nothing about who is beating us there, and that is the
 * thing a content plan is actually competing against.
 *
 * This needs a live SERP, which no free Google API gives. Serper.dev does, with
 * a real free tier, so the agent is gated on SERPER_API_KEY: with a key it runs,
 * without one it writes a short dormant note and exits clean rather than failing
 * the night. The keyword list is not hand-maintained. It is drawn from the
 * queries Search Console says we already get impressions for, so the tracker
 * always watches the battles we are actually in.
 */

import { google } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { parseServiceAccount } from "./service-account";
import { writeReport } from "./crawl";

const SITE_URL = "https://titansabroad.org/";
const OWN_HOST = "titansabroad.org";
const DAYS = 28;
// The audience is Pakistani, so the SERP has to be read from Pakistan. A result
// page fetched from a US datacentre is a different page and would track the
// wrong competitors.
const GEO = "pk";
const LANG = "en";
// Free tier is 2,500 queries. One run a night at this cap is about 1,200 a
// month, comfortably inside it with room for the other GSC agents' own calls.
const MAX_KEYWORDS = 40;
// A query worth watching has enough volume that the ranking matters and sits
// close enough to page one that the competition is real.
const MIN_IMPRESSIONS = 20;
const MAX_POSITION = 30;
const SERP_DEPTH = 10;
const REQUEST_GAP_MS = 400;

type Organic = { position: number; title: string; link: string };

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function serper(query: string, apiKey: string): Promise<Organic[]> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, gl: GEO, hl: LANG, num: SERP_DEPTH }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    throw new Error(`Serper ${res.status} for "${query}": ${(await res.text()).slice(0, 120)}`);
  }
  const data = (await res.json()) as { organic?: Array<{ position?: number; title?: string; link?: string }> };
  return (data.organic ?? [])
    .filter((o) => o.link)
    .map((o) => ({ position: o.position ?? 0, title: o.title ?? "", link: o.link! }));
}

/** The queries Search Console says we already appear for, most impressions first. */
async function trackedKeywords(): Promise<Array<{ query: string; impressions: number; gscPosition: number }>> {
  const auth = new GoogleAuth({
    credentials: parseServiceAccount(process.env.GOOGLE_SERVICE_ACCOUNT!),
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
  });
  const searchconsole = google.searchconsole({ version: "v1", auth: auth as any });

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - DAYS);
  const fmt = (d: Date) => d.toISOString().split("T")[0];

  const res = await searchconsole.searchanalytics.query({
    siteUrl: SITE_URL,
    requestBody: {
      startDate: fmt(start),
      endDate: fmt(end),
      dimensions: ["query"],
      rowLimit: 5000,
    },
  });

  return (res.data.rows ?? [])
    .map((r) => ({
      query: r.keys![0],
      impressions: r.impressions ?? 0,
      gscPosition: r.position ?? 99,
    }))
    .filter((r) => r.impressions >= MIN_IMPRESSIONS && r.gscPosition <= MAX_POSITION)
    // A brand query returns us first by definition and tracks nothing useful,
    // so queries containing our own name are dropped.
    .filter((r) => !/titans?\s*abroad/i.test(r.query))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, MAX_KEYWORDS);
}

function dormantReport(reason: string) {
  const date = new Date().toISOString().split("T")[0];
  let report = `# Competitor SERP Tracker: ${date}\n\n`;
  report += `**Status:** dormant\n\n`;
  report += `${reason}\n\n`;
  report += `To turn this on, set a \`SERPER_API_KEY\` secret on the repository. Serper.dev has a `;
  report += `free tier of 2,500 searches, and this agent is capped at ${MAX_KEYWORDS} keywords a `;
  report += `night, so it stays inside the free allowance on its own. Once the key is present the `;
  report += `tracker picks the ${MAX_KEYWORDS} highest-impression queries from Search Console and `;
  report += `records who outranks us on each.\n\n---\n\n`;
  writeReport("serp-tracker", report);
  console.log(`SERP tracker dormant: ${reason}`);
}

async function main() {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    dormantReport("No SERP API key is configured, so no live result pages were fetched.");
    return;
  }

  const keywords = await trackedKeywords();
  if (keywords.length === 0) {
    dormantReport("Search Console returned no queries above the tracking threshold this period.");
    return;
  }
  console.log(`Tracking ${keywords.length} keywords via Serper...`);

  type Row = {
    query: string;
    impressions: number;
    gscPosition: number;
    serpPosition: number | null;
    above: string[]; // competitor hosts ranking above us
    top3: string[];
  };

  const rows: Row[] = [];
  const rivalCount = new Map<string, number>();
  const rivalAboveUs = new Map<string, number>();
  let failed = 0;

  for (const kw of keywords) {
    let organic: Organic[];
    try {
      organic = await serper(kw.query, apiKey);
    } catch (err: any) {
      console.error(err.message);
      failed++;
      await sleep(REQUEST_GAP_MS);
      continue;
    }

    const ourIndex = organic.findIndex((o) => hostOf(o.link).endsWith(OWN_HOST));
    const serpPosition = ourIndex === -1 ? null : ourIndex + 1;

    const hostsInOrder = organic.map((o) => hostOf(o.link)).filter((h) => !h.endsWith(OWN_HOST));
    const above = (ourIndex === -1 ? hostsInOrder : hostsInOrder.slice(0, ourIndex));
    const top3 = organic.slice(0, 3).map((o) => hostOf(o.link));

    for (const h of new Set(hostsInOrder)) rivalCount.set(h, (rivalCount.get(h) ?? 0) + 1);
    for (const h of new Set(above)) rivalAboveUs.set(h, (rivalAboveUs.get(h) ?? 0) + 1);

    rows.push({
      query: kw.query,
      impressions: kw.impressions,
      gscPosition: kw.gscPosition,
      serpPosition,
      above: [...new Set(above)],
      top3,
    });
    await sleep(REQUEST_GAP_MS);
  }

  const outranked = rows
    .filter((r) => r.serpPosition === null || r.serpPosition > 3)
    .sort((a, b) => b.impressions - a.impressions);
  const owned = rows.filter((r) => r.serpPosition !== null && r.serpPosition <= 3);

  const topRivals = [...rivalAboveUs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  const date = new Date().toISOString().split("T")[0];
  let report = `# Competitor SERP Tracker: ${date}\n\n`;
  report += `**Keywords tracked:** ${rows.length} (drawn from Search Console, ${DAYS}-day window)\n`;
  report += `**In the top 3 on Google:** ${owned.length}\n`;
  report += `**Outranked or absent:** ${outranked.length}\n`;
  if (failed > 0) report += `**Lookups that failed:** ${failed}\n`;
  report += `\n`;
  report += `The position here is Google's live result page read from Pakistan, which is why it `;
  report += `can differ from the smoothed average in Search Console. It is who actually sits above `;
  report += `us right now.\n\n`;

  if (topRivals.length > 0) {
    report += `## Rivals Who Keep Beating Us (${topRivals.length})\n\n`;
    report += `Domains that ranked above titansabroad on the most tracked keywords. A name near the `;
    report += `top of this list is the competitor a content plan is really up against, not whoever `;
    report += `happens to rank on one query.\n\n`;
    report += `| Competitor | Keywords where they outrank us |\n|---|---|\n`;
    for (const [host, count] of topRivals) {
      report += `| ${host} | ${count} |\n`;
    }
    report += `\n`;
  }

  if (outranked.length > 0) {
    report += `## Keywords Where We Are Being Outranked (${outranked.length})\n\n`;
    report += `Highest-impression first, so the ones costing the most traffic are at the top. "Absent" `;
    report += `means we did not appear in the first ${SERP_DEPTH} results at all despite Search Console `;
    report += `crediting us with impressions, usually a sign of a volatile position on the edge of page one.\n\n`;
    report += `| Query | Impressions | Our position | Who holds the top 3 |\n|---|---|---|---|\n`;
    for (const r of outranked.slice(0, 25)) {
      const pos = r.serpPosition === null ? "absent" : String(r.serpPosition);
      report += `| ${r.query} | ${r.impressions} | ${pos} | ${r.top3.join(", ")} |\n`;
    }
    if (outranked.length > 25) report += `\n*${outranked.length - 25} more.*\n`;
    report += `\n`;
  }

  if (owned.length > 0) {
    report += `## Keywords We Already Own (${owned.length})\n\n`;
    report += `Top three on the live result page. Worth knowing so a rewrite aimed at the list above `;
    report += `does not quietly cost us one of these.\n\n`;
    report += `| Query | Impressions | Our position |\n|---|---|---|\n`;
    for (const r of owned.sort((a, b) => (a.serpPosition ?? 9) - (b.serpPosition ?? 9)).slice(0, 25)) {
      report += `| ${r.query} | ${r.impressions} | ${r.serpPosition} |\n`;
    }
    report += `\n`;
  }

  report += `---\n\n`;
  writeReport("serp-tracker", report);
  console.log(
    `Tracked ${rows.length} keywords: ${owned.length} owned, ${outranked.length} outranked, ${failed} failed.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
