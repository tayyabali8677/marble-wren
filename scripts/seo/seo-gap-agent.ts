import { google } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { parseServiceAccount } from "./service-account";
import { scanConflicts, renderConflicts } from "./cannibalization";

const SITE_URL = "https://titansabroad.org/";
const DAYS = 28;
const MIN_IMPRESSIONS = 5;
const MIN_POSITION = 8;
const MAX_POSITION = 20;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";

// Same key rotation the scholarship generator uses: on a quota 429, fall through
// to the next key instead of losing the suggestion.
async function callGemini(prompt: string): Promise<string> {
  const keys = (process.env.GEMINI_API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) return "";

  for (let i = 0; i < keys.length; i++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${keys[i]}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4 },
        }),
      }
    );

    if (res.status === 429) {
      console.warn(`  Key ${i + 1}/${keys.length} hit quota, trying next...`);
      continue;
    }

    if (!res.ok) {
      console.error(`  Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return "";
    }

    const data = (await res.json()) as any;
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error(`  Gemini returned no text: ${JSON.stringify(data).slice(0, 300)}`);
      return "";
    }
    return text;
  }

  console.error("  All Gemini keys hit quota.");
  return "";
}

async function main() {
  const serviceAccount = parseServiceAccount(process.env.GOOGLE_SERVICE_ACCOUNT!);

  const auth = new GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
  });

  const searchconsole = google.searchconsole({ version: "v1", auth: auth as any });

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - DAYS);
  const fmt = (d: Date) => d.toISOString().split("T")[0];

  console.log(`Fetching Search Console data (${fmt(startDate)} to ${fmt(endDate)})...`);

  const response = await searchconsole.searchanalytics.query({
    siteUrl: SITE_URL,
    requestBody: {
      startDate: fmt(startDate),
      endDate: fmt(endDate),
      dimensions: ["query", "page"],
      rowLimit: 2500,
    },
  });

  const rows = response.data.rows || [];
  console.log(`Total rows: ${rows.length}`);

  const opportunities = rows.filter((row) => {
    const pos = row.position ?? 0;
    const imp = row.impressions ?? 0;
    return pos >= MIN_POSITION && pos <= MAX_POSITION && imp >= MIN_IMPRESSIONS;
  });

  opportunities.sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0));

  const byPage: Record<string, typeof opportunities> = {};
  for (const row of opportunities) {
    const page = row.keys![1];
    if (!byPage[page]) byPage[page] = [];
    byPage[page].push(row);
  }

  const topPages = Object.entries(byPage)
    .sort((a, b) => {
      const aImpressions = a[1].reduce((s, r) => s + (r.impressions ?? 0), 0);
      const bImpressions = b[1].reduce((s, r) => s + (r.impressions ?? 0), 0);
      return bImpressions - aImpressions;
    })
    .slice(0, 15);

  console.log(`Found ${opportunities.length} opportunities across ${Object.keys(byPage).length} pages. Generating content suggestions...`);

  const scan = scanConflicts(rows);
  console.log(`Cannibalization: ${scan.conflicts.length} conflicts from ${scan.multiPageQueries} multi-page queries`);

  const date = fmt(new Date());
  let report = `# SEO Gap Report: ${date}\n\n`;
  report += `**Property:** ${SITE_URL}\n`;
  report += `**Period:** Last ${DAYS} days\n`;
  report += `**Total opportunities:** ${opportunities.length} keywords across ${Object.keys(byPage).length} pages\n`;
  report += `**Cannibalization conflicts:** ${scan.conflicts.length}\n`;
  report += `**Showing top:** ${topPages.length} pages by total impressions\n\n---\n\n`;

  report += renderConflicts(scan);

  report += `## Near-Miss Keywords (position ${MIN_POSITION} to ${MAX_POSITION})\n\n`;

  for (const [page, keywords] of topPages) {
    const top5 = keywords.slice(0, 5);
    const totalImpressions = keywords.reduce((s, r) => s + (r.impressions ?? 0), 0);
    const avgPosition = (keywords.reduce((s, r) => s + (r.position ?? 0), 0) / keywords.length).toFixed(1);

    report += `## ${page}\n\n`;
    report += `**Total impressions:** ${totalImpressions} | **Avg position:** ${avgPosition} | **Keywords in range:** ${keywords.length}\n\n`;
    report += `| Keyword | Position | Impressions | Clicks | CTR |\n`;
    report += `|---------|----------|-------------|--------|-----|\n`;
    for (const kw of top5) {
      const ctr = (((kw.ctr ?? 0) * 100)).toFixed(1);
      report += `| ${kw.keys![0]} | ${(kw.position ?? 0).toFixed(1)} | ${kw.impressions} | ${kw.clicks} | ${ctr}% |\n`;
    }

    if (process.env.GEMINI_API_KEYS) {
      const kwList = top5.map((k) => k.keys![0]).join(", ");
      const prompt = `You are an SEO content writer for TitansAbroad.org, a Pakistani MBBS abroad consultancy helping students study medicine in China, Russia, and other countries.

Page URL: ${page}
Keywords this page is almost ranking for (position 8-20): ${kwList}

Write a short, helpful FAQ-style content section (2-3 questions and answers, 150-200 words total) that naturally covers these keywords. Write in simple English that Pakistani students would search for. Do not add headings like "FAQ Section" — just the Q&A pairs using "**Q: ...**" and "**A: ...**" format.`;

      try {
        const suggestion = await callGemini(prompt);
        if (suggestion.trim()) {
          report += `\n### Suggested Content to Add\n\n${suggestion.trim()}\n\n`;
        } else {
          report += `\n*Content suggestion unavailable*\n\n`;
        }
        await new Promise((r) => setTimeout(r, 1000));
      } catch {
        report += `\n*Content suggestion unavailable*\n\n`;
      }
    }

    report += `---\n\n`;
  }

  const reportsDir = join(process.cwd(), "reports");
  if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });

  const outPath = join(reportsDir, `seo-gap-${date}.md`);
  writeFileSync(outPath, report, "utf-8");
  console.log(`Report saved: ${outPath}`);
  console.log(`Top page: ${topPages[0]?.[0] ?? "none"} with ${topPages[0]?.[1].length ?? 0} keyword opportunities`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
