import { google } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { parseServiceAccount } from "./service-account";
import { scanConflicts, renderConflicts } from "./cannibalization";
import { publishFaqs, toPathname, type FaqEntry } from "./publish-faqs";

const SITE_URL = "https://titansabroad.org/";
const DAYS = 28;
const MIN_IMPRESSIONS = 5;
const MIN_POSITION = 8;
const MAX_POSITION = 20;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";

// Same key rotation the scholarship generator uses: on a quota 429, fall through
// to the next key instead of losing the suggestion.
async function callGemini(prompt: string, jsonMode = false): Promise<string> {
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
          generationConfig: {
            temperature: 0.4,
            ...(jsonMode ? { responseMimeType: "application/json" } : {}),
          },
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

type GeneratedFaq = { keyword: string; question: string; answer: string };

// The prompt tells the model not to invent numbers. It sometimes does anyway,
// and a wrong eligibility percentage or fee on a consultancy site is the one
// mistake an unsupervised writer must not be able to make. Anything matching
// these still lands in the report for review, it just does not go live.
const RISKY_CLAIM = [
  /\b\d+(\.\d+)?\s*(?:%|percent|percentage)/i,
  /\b(?:rs\.?|pkr|usd|\$|€|£|¥|rmb|yuan|rubles?|lari|aed)\s*[\d,]/i,
  /[\d,]+\s*(?:rupees|dollars|yuan|rmb|rubles?|lari|lakh|crore)/i,
  /\b(?:deadline|last date|closing date)\b[^.]*\b\d/i,
  /\branked?\b[^.]*\b(?:#\s*\d|\d+(?:st|nd|rd|th)\b|top\s+\d)/i,
  /\b\d+(?:st|nd|rd|th)\s+(?:in|among|worldwide|globally)\b/i,
];

function hasRiskyClaim(answer: string): boolean {
  return RISKY_CLAIM.some((re) => re.test(answer));
}

// The model is asked for JSON, but a stray code fence or a bad entry should
// cost one page's suggestion, not the whole run.
function parseFaqJson(raw: string): GeneratedFaq[] {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  if (!cleaned) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.error("  Could not parse FAQ JSON from model output.");
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((f: any) => f && typeof f.question === "string" && typeof f.answer === "string")
    .map((f: any) => ({
      keyword: typeof f.keyword === "string" ? f.keyword.trim() : "",
      question: f.question.trim(),
      answer: f.answer.trim(),
    }))
    .filter((f) => f.keyword && f.question.length > 10 && f.answer.length > 40);
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

  // Path to FAQ entries the agent wants to push live this run.
  const candidates: Record<string, FaqEntry[]> = {};
  let heldForReview = 0;

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
      const prompt = `You are an SEO content writer for TitansAbroad.org, a Pakistani MBBS abroad consultancy helping students study medicine in China, Russia, Georgia, and other countries.

Page URL: ${page}
Keywords this page is almost ranking for (position 8-20): ${kwList}

Write 2 or 3 FAQ entries that directly answer what someone searching those keywords wants to know. Rules:
- Write in the simple English Pakistani students actually use when searching.
- Each answer is 40 to 70 words, factual and specific. No marketing filler.
- Never state a fee, tuition amount, percentage, eligibility mark, deadline, or ranking. Not even an approximate one. Describe the process or the requirement in words instead. An answer containing any such number will be discarded.
- The question should read like a real search, not a headline.

Return ONLY a JSON array in this exact shape:
[{"keyword": "<which of the listed keywords this answers>", "question": "...", "answer": "..."}]`;

      try {
        const suggestion = await callGemini(prompt, true);
        const parsed = parseFaqJson(suggestion);

        if (parsed.length > 0) {
          const path = toPathname(page);
          const positionByKeyword = new Map(
            top5.map((k) => [k.keys![0].toLowerCase(), k.position ?? 0])
          );

          const safe = parsed.filter((f) => !hasRiskyClaim(f.answer));
          const held = parsed.filter((f) => hasRiskyClaim(f.answer));
          heldForReview += held.length;

          if (safe.length > 0) {
            candidates[path] = safe.map((f) => ({
              keyword: f.keyword,
              question: f.question,
              answer: f.answer,
              addedAt: date,
              positionAtGeneration: positionByKeyword.get(f.keyword.toLowerCase()) ?? 0,
            }));
          }

          report += `\n### Generated FAQ\n\n`;
          for (const f of safe) {
            report += `**Q: ${f.question}**\n\nA: ${f.answer}\n\n`;
          }
          for (const f of held) {
            report += `**Q: ${f.question}** (held for review, states a number)\n\nA: ${f.answer}\n\n`;
          }
        } else {
          report += `\n*Content suggestion unavailable*\n\n`;
        }
        await new Promise((r) => setTimeout(r, 1000));
      } catch (err: any) {
        console.error(`  FAQ generation failed for ${page}: ${err.message}`);
        report += `\n*Content suggestion unavailable*\n\n`;
      }
    }

    report += `---\n\n`;
  }

  const result = await publishFaqs(candidates);
  console.log(`Publish: ${result.published} published, ${result.skipped} skipped${result.reason ? ` (${result.reason})` : ""}`);

  let publishSection = `## Auto-Published\n\n`;
  if (result.published > 0) {
    publishSection += `Pushed **${result.published}** new FAQ ${result.published === 1 ? "answer" : "answers"} to ${result.paths.length} `;
    publishSection += `${result.paths.length === 1 ? "page" : "pages"}. Vercel redeploys on the push, so these are live.\n\n`;
    for (const p of result.paths) publishSection += `- ${p}\n`;
    publishSection += `\n`;
  } else {
    publishSection += `Nothing published${result.reason ? `: ${result.reason}` : ""}.\n\n`;
  }
  if (heldForReview > 0) {
    publishSection += `${heldForReview} answer${heldForReview === 1 ? " was" : "s were"} held back for stating a fee, percentage, deadline, or ranking. `;
    publishSection += `They are in the section below marked "held for review". Check the number, then paste the answer in by hand if it is right.\n\n`;
  }
  if (result.skipped > 0) {
    publishSection += `${result.skipped} candidate${result.skipped === 1 ? "" : "s"} skipped (already published, or over the per-run cap).\n\n`;
  }
  publishSection += `---\n\n`;

  report = report.replace("## Keyword Cannibalization", publishSection + "## Keyword Cannibalization");

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
