/**
 * Agent 13: content decay.
 *
 * Medical education content rots on a schedule. Fees change, intakes open and
 * close, a university drops off a recognition list, and a page that ranked all
 * of last year quietly slides because a fresher competitor answered this year's
 * version of the question. Decay is the earliest warning a page needs work, and
 * it shows up in Search Console long before it shows up in traffic totals.
 *
 * Rather than persist state between runs, which a CI cache cannot be trusted to
 * keep, this asks Search Console for two windows in one call: the most recent
 * 28 days and the 28 before that. Search Console holds 16 months, so both are
 * always available. A page losing ground across that boundary is decaying now.
 */

import { google } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { parseServiceAccount } from "./service-account";
import { writeReport, toPath } from "./crawl";

const SITE_URL = "https://titansabroad.org/";
const WINDOW = 28;
// A page needs enough impressions in the earlier window for a drop to mean
// something. Below this, a swing is noise.
const MIN_BASE_IMPRESSIONS = 40;
// Relative drop that counts as decay rather than weekly wobble.
const IMPRESSION_DROP = 0.25;
const CLICK_DROP = 0.3;
// A worsening average position is the cleanest decay signal: the page itself
// slipped, independent of how search volume moved.
const POSITION_SLIP = 1.5;
const MAX_REPORTED = 30;

type Row = { clicks: number; impressions: number; position: number };

function fmt(d: Date): string {
  return d.toISOString().split("T")[0];
}

async function query(
  searchconsole: any,
  startDate: string,
  endDate: string
): Promise<Map<string, Row>> {
  const res = await searchconsole.searchanalytics.query({
    siteUrl: SITE_URL,
    requestBody: { startDate, endDate, dimensions: ["page"], rowLimit: 5000 },
  });
  const map = new Map<string, Row>();
  for (const r of res.data.rows ?? []) {
    map.set(r.keys![0].replace(/\/+$/, ""), {
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      position: r.position ?? 0,
    });
  }
  return map;
}

async function main() {
  const auth = new GoogleAuth({
    credentials: parseServiceAccount(process.env.GOOGLE_SERVICE_ACCOUNT!),
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
  });
  const searchconsole = google.searchconsole({ version: "v1", auth: auth as any });

  // Search Console lags about three days, so the recent window ends there.
  const recentEnd = new Date();
  recentEnd.setDate(recentEnd.getDate() - 3);
  const recentStart = new Date(recentEnd);
  recentStart.setDate(recentStart.getDate() - WINDOW);
  const priorEnd = new Date(recentStart);
  priorEnd.setDate(priorEnd.getDate() - 1);
  const priorStart = new Date(priorEnd);
  priorStart.setDate(priorStart.getDate() - WINDOW);

  console.log(`Recent: ${fmt(recentStart)} to ${fmt(recentEnd)}`);
  console.log(`Prior:  ${fmt(priorStart)} to ${fmt(priorEnd)}`);

  const [recent, prior] = await Promise.all([
    query(searchconsole, fmt(recentStart), fmt(recentEnd)),
    query(searchconsole, fmt(priorStart), fmt(priorEnd)),
  ]);

  type Decay = {
    path: string;
    impressionsThen: number;
    impressionsNow: number;
    clicksThen: number;
    clicksNow: number;
    positionThen: number;
    positionNow: number;
    reasons: string[];
    severity: number;
  };

  const decaying: Decay[] = [];
  const vanished: Array<{ path: string; impressionsThen: number; clicksThen: number }> = [];

  for (const [url, then] of prior) {
    if (then.impressions < MIN_BASE_IMPRESSIONS) continue;
    const now = recent.get(url);

    if (!now || now.impressions === 0) {
      vanished.push({ path: toPath(url), impressionsThen: then.impressions, clicksThen: then.clicks });
      continue;
    }

    const reasons: string[] = [];
    let severity = 0;

    const impDrop = (then.impressions - now.impressions) / then.impressions;
    if (impDrop >= IMPRESSION_DROP) {
      reasons.push(`impressions down ${Math.round(impDrop * 100)}%`);
      severity += impDrop;
    }

    if (then.clicks >= 5) {
      const clickDrop = (then.clicks - now.clicks) / then.clicks;
      if (clickDrop >= CLICK_DROP) {
        reasons.push(`clicks down ${Math.round(clickDrop * 100)}%`);
        severity += clickDrop;
      }
    }

    // Position rises as it worsens, so a positive delta is a slip.
    const slip = now.position - then.position;
    if (then.position > 0 && slip >= POSITION_SLIP) {
      reasons.push(`slipped ${slip.toFixed(1)} positions (${then.position.toFixed(1)} to ${now.position.toFixed(1)})`);
      severity += slip / 10;
    }

    if (reasons.length > 0) {
      decaying.push({
        path: toPath(url),
        impressionsThen: then.impressions,
        impressionsNow: now.impressions,
        clicksThen: then.clicks,
        clicksNow: now.clicks,
        positionThen: then.position,
        positionNow: now.position,
        reasons,
        severity,
      });
    }
  }

  decaying.sort((a, b) => b.severity - a.severity);
  vanished.sort((a, b) => b.impressionsThen - a.impressionsThen);

  const date = fmt(new Date());
  let report = `# Content Decay: ${date}\n\n`;
  report += `**Recent window:** ${fmt(recentStart)} to ${fmt(recentEnd)}\n`;
  report += `**Compared against:** ${fmt(priorStart)} to ${fmt(priorEnd)}\n`;
  report += `**Pages in sustained decline:** ${decaying.length}\n`;
  report += `**Pages that stopped appearing entirely:** ${vanished.length}\n\n`;

  if (decaying.length === 0 && vanished.length === 0) {
    report += `No page with a real audience lost meaningful ground between the two windows. `;
    report += `Nothing is decaying fast enough to act on yet.\n\n---\n\n`;
    writeReport("content-decay", report);
    console.log("No decay detected.");
    return;
  }

  report += `A drop here is not always a problem to fix. Seasonality moves medical-admissions `;
  report += `queries hard, so a page down after an intake closed is behaving normally. What to `;
  report += `look for is a page slipping in average position, which is the page losing to a `;
  report += `competitor rather than to the calendar.\n\n`;

  if (vanished.length > 0) {
    report += `## Stopped Appearing Entirely (${vanished.length})\n\n`;
    report += `These had a real presence in the earlier window and are now at zero impressions. `;
    report += `Check indexing first: a page that vanishes completely is usually deindexed, not `;
    report += `merely outranked.\n\n`;
    report += `| Page | Impressions before | Clicks before |\n|---|---|---|\n`;
    for (const v of vanished.slice(0, MAX_REPORTED)) {
      report += `| ${v.path} | ${v.impressionsThen} | ${v.clicksThen} |\n`;
    }
    report += `\n`;
  }

  if (decaying.length > 0) {
    report += `## Losing Ground (${decaying.length})\n\n`;
    report += `Ranked by how sharply they are falling. The position column is the one to trust: `;
    report += `a page whose average position worsened is a page a fresher competitor overtook.\n\n`;
    report += `| Page | Impressions | Clicks | Position | What changed |\n|---|---|---|---|---|\n`;
    for (const d of decaying.slice(0, MAX_REPORTED)) {
      report += `| ${d.path} | ${d.impressionsThen} to ${d.impressionsNow} | ${d.clicksThen} to ${d.clicksNow} | ${d.positionThen.toFixed(1)} to ${d.positionNow.toFixed(1)} | ${d.reasons.join(", ")} |\n`;
    }
    if (decaying.length > MAX_REPORTED) report += `\n*${decaying.length - MAX_REPORTED} more in slower decline.*\n`;
    report += `\n`;
  }

  report += `---\n\n`;
  writeReport("content-decay", report);
  console.log(`Decaying: ${decaying.length} | Vanished: ${vanished.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
