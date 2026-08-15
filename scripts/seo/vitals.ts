/**
 * Agent 6: Core Web Vitals.
 *
 * Checks the pages that actually get impressions, not a fixed list, so the
 * measurement follows the traffic. Prefers field data from real Chrome users
 * when Google has enough of it, and falls back to the lab run otherwise. The
 * distinction matters: field data is what ranking uses.
 *
 * PAGESPEED_API_KEY is optional. Without it the API still answers, just at a
 * stricter rate, which is why the calls are spaced out.
 */

import { google } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { parseServiceAccount } from "./service-account";
import { writeReport, toPath } from "./crawl";

const SITE_URL = "https://titansabroad.org/";
const TOP_PAGES = 10;
const DAYS = 28;
const DELAY_MS = 2000;

// Google's own thresholds for a "good" experience.
const THRESHOLDS = {
  LARGEST_CONTENTFUL_PAINT_MS: { good: 2500, poor: 4000, label: "LCP", unit: "ms" },
  INTERACTION_TO_NEXT_PAINT: { good: 200, poor: 500, label: "INP", unit: "ms" },
  CUMULATIVE_LAYOUT_SHIFT_SCORE: { good: 0.1, poor: 0.25, label: "CLS", unit: "" },
};

type Metric = { label: string; value: number; unit: string; rating: string };
type PageVitals = { url: string; source: "field" | "lab"; metrics: Metric[]; error?: string };

function rate(key: keyof typeof THRESHOLDS, value: number): string {
  const t = THRESHOLDS[key];
  if (value <= t.good) return "good";
  if (value <= t.poor) return "needs work";
  return "poor";
}

async function topPages(): Promise<string[]> {
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
      dimensions: ["page"],
      rowLimit: TOP_PAGES,
    },
  });

  const pages = (res.data.rows ?? []).map((r) => r.keys![0]);
  // A site with no impressions still deserves a homepage measurement.
  return pages.length > 0 ? pages : [SITE_URL];
}

async function measure(url: string): Promise<PageVitals> {
  const apiKey = process.env.PAGESPEED_API_KEY;
  const endpoint =
    `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` +
    `?url=${encodeURIComponent(url)}&strategy=mobile&category=PERFORMANCE` +
    (apiKey ? `&key=${apiKey}` : "");

  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(90000) });
    if (!res.ok) {
      return { url, source: "lab", metrics: [], error: `HTTP ${res.status}` };
    }

    const data = (await res.json()) as any;
    const field = data.loadingExperience?.metrics;
    const metrics: Metric[] = [];

    if (field && Object.keys(field).length > 0) {
      for (const key of Object.keys(THRESHOLDS) as (keyof typeof THRESHOLDS)[]) {
        const m = field[key];
        if (!m) continue;
        const raw = m.percentile;
        const value = key === "CUMULATIVE_LAYOUT_SHIFT_SCORE" ? raw / 100 : raw;
        metrics.push({
          label: THRESHOLDS[key].label,
          value,
          unit: THRESHOLDS[key].unit,
          rating: rate(key, value),
        });
      }
      if (metrics.length > 0) return { url, source: "field", metrics };
    }

    // No field data yet, so fall back to the lab run.
    const audits = data.lighthouseResult?.audits ?? {};
    const lab: [keyof typeof THRESHOLDS, string][] = [
      ["LARGEST_CONTENTFUL_PAINT_MS", "largest-contentful-paint"],
      ["CUMULATIVE_LAYOUT_SHIFT_SCORE", "cumulative-layout-shift"],
    ];
    for (const [key, auditId] of lab) {
      const value = audits[auditId]?.numericValue;
      if (typeof value !== "number") continue;
      metrics.push({
        label: THRESHOLDS[key].label,
        value,
        unit: THRESHOLDS[key].unit,
        rating: rate(key, value),
      });
    }

    return { url, source: "lab", metrics };
  } catch (err: any) {
    return { url, source: "lab", metrics: [], error: err.message?.slice(0, 120) ?? "unknown" };
  }
}

async function main() {
  const pages = await topPages();
  console.log(`Measuring ${pages.length} pages...`);

  const results: PageVitals[] = [];
  for (const url of pages) {
    results.push(await measure(url));
    console.log(`  ${toPath(url)}`);
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  const failing = results.filter((r) => r.metrics.some((m) => m.rating === "poor"));
  const date = new Date().toISOString().split("T")[0];

  let report = `# Core Web Vitals: ${date}\n\n`;
  report += `**Pages measured:** ${results.length} (top pages by impressions)\n`;
  report += `**Pages with a poor metric:** ${failing.length}\n\n`;
  report += `Field data comes from real Chrome users and is what ranking uses. `;
  report += `Lab data is a single simulated run, shown only when Google has too few real samples.\n\n`;

  report += `| Page | Source | ${Object.values(THRESHOLDS).map((t) => t.label).join(" | ")} |\n`;
  report += `|------|--------|${Object.values(THRESHOLDS).map(() => "---").join("|")}|\n`;

  for (const r of results) {
    if (r.error) {
      report += `| ${toPath(r.url)} | - | ${Object.values(THRESHOLDS).map(() => "error").join(" | ")} |\n`;
      continue;
    }
    const cells = Object.values(THRESHOLDS).map((t) => {
      const m = r.metrics.find((x) => x.label === t.label);
      if (!m) return "-";
      const value = t.unit === "ms" ? Math.round(m.value) : m.value.toFixed(2);
      return `${value}${t.unit} (${m.rating})`;
    });
    report += `| ${toPath(r.url)} | ${r.source} | ${cells.join(" | ")} |\n`;
  }
  report += `\n`;

  const errored = results.filter((r) => r.error);
  if (errored.length > 0) {
    report += `## Could Not Measure (${errored.length})\n\n`;
    for (const r of errored) report += `- ${toPath(r.url)}: ${r.error}\n`;
    report += `\nUsually rate limiting. Set PAGESPEED_API_KEY as a secret to raise the quota.\n\n`;
  }

  if (failing.length > 0) {
    report += `## Poor Metrics (${failing.length})\n\n`;
    for (const r of failing) {
      const bad = r.metrics.filter((m) => m.rating === "poor").map((m) => m.label).join(", ");
      report += `- **${toPath(r.url)}** ${bad}\n`;
    }
    report += `\n`;
  }

  report += `---\n\n`;
  writeReport("vitals", report);
  console.log(`Measured ${results.length}, poor on ${failing.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
