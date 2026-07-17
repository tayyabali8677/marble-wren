import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env" });
loadEnv({ path: ".env.local", override: true });

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { ProxyAgent, setGlobalDispatcher } from "undici";

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

type Source = { slug: string; country: string; name: string; url: string; note?: string };

const SOURCES: Source[] = JSON.parse(
  readFileSync(path.join(__dirname, "sources.json"), "utf-8")
);
const SCRAPED_DIR = path.join(__dirname, "scraped");
const OUT_PATH = path.join(__dirname, "generated-batch.json");
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";

const API_KEYS: string[] = (
  process.env.GEMINI_API_KEYS
    ? process.env.GEMINI_API_KEYS.split(",").map((k) => k.trim()).filter(Boolean)
    : process.env.GEMINI_API_KEY
    ? [process.env.GEMINI_API_KEY]
    : []
);
let currentKeyIndex = 0;

function getNextKey(): string | null {
  if (!API_KEYS.length) return null;
  const key = API_KEYS[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
  return key;
}

const STYLE_REFERENCE = `{
  "slug": "chinese-government-scholarship-csc",
  "name": "Chinese Government Scholarship (CSC)",
  "description": "Fully funded scholarship by the China Scholarship Council - covering tuition, accommodation, stipend, and medical insurance for international students at Bachelor's, Master's, and PhD levels. Two application routes available: bilateral government track and direct university route.",
  "overview": [
    "The Chinese Government Scholarship (CSC), administered by the China Scholarship Council under China's Ministry of Education, is one of the largest and most generous government scholarship programs in the world. Established to promote educational exchange and international cooperation, it funds tens of thousands of international students every year from over 180 countries to pursue undergraduate, Master's, and PhD degrees at more than 300 designated Chinese universities.",
    "The scholarship covers every major cost of studying in China: full tuition fees, free on-campus accommodation or a monthly housing allowance, comprehensive medical insurance for the entire program duration, and a monthly living stipend ranging from 2,500 (approximately USD 350) for Bachelor's students to 3,500 (approximately USD 490) for doctoral students.",
    "There are two distinct application routes. Type A is the bilateral government track - coordinated through the applicant's home country government or embassy and China's Ministry of Education. Type B is the direct university route, in which students apply independently to CSC-authorized Chinese universities, choosing up to three institutions without requiring government nomination."
  ],
  "benefits": [
    "Full tuition fee waiver - covered entirely by CSC",
    "Monthly stipend: 2,500 (Bachelor's) / 3,000 (Master's) / 3,500 (PhD) - approximately USD 350-490/month",
    "Free on-campus accommodation or monthly housing allowance",
    "Comprehensive medical insurance throughout the program",
    "Round-trip airfare - included for Type A (HEC/Embassy) applicants only"
  ],
  "requirements": [
    "Bachelor's applicants: must have completed 12 years of education and be under 25 years old",
    "Master's applicants: must hold a Bachelor's degree and be under 35 years old",
    "PhD applicants: must hold a Master's degree and be under 40 years old",
    "Must not be receiving any other scholarship simultaneously"
  ]
}
Notice the level of specificity when the source material supports it: exact currency amounts, exact age cutoffs, named application tracks with their own rules - not vague summaries.`;

const SCHEMA_INSTRUCTIONS = `
Return a single JSON object matching exactly this shape (all fields required unless marked optional):

{
  "slug": string (kebab-case, e.g. "daad-scholarship-germany"),
  "name": string,
  "description": string (1-2 sentences, dense summary),
  "overview": string[] (4-6 paragraphs),
  "type": "international" | "national",  // "national" ONLY for Pakistani government scholarships for Pakistani students to study INSIDE Pakistan (e.g. HEC Need-Based, PEEF, Honhar, Ehsaas). Everything else — including foreign government scholarships, university scholarships, and Pakistani scholarships to study ABROAD — must be "international".
  "country": string,
  "flag": string (a single emoji flag),
  "fundingType": "fully-funded" | "partial" | "varies",
  "provider": string,
  "eligibleLevels": string[] (e.g. ["Master's","PhD"]),
  "eligibleFields": string[] (specific fields/subjects if the source names them),
  "deadline": string (exact dates/months if the source states them),
  "openingMonth": string,
  "benefits": string[] (5-8 items, exact amounts and currencies where available),
  "requirements": string[] (5-8 items),
  "documentsRequired": string[] (as many as the source lists),
  "applicationProcess": string[] (ordered, step-by-step),
  "whyChoose": string[] (4-6 items),
  "tips": string[] (5-7 items, specific to this program),
  "timeline": { "phase": string, "date": string, "note"?: string }[],
  "countryNote": string (optional),
  "officialWebsite": string,
  "status": "open" | "closed" | "upcoming" | "to-be-confirmed",
  "featured": false,
  "tags": string[],
  "seoTitle": string,
  "seoDescription": string,
  "faqs": { "q": string, "a": string }[] (3-5 items),
  "importantLinks": { "label": string, "url": string }[] (3-6 items — application portal, official scholarship page, required document checklist, partner university list, contact/embassy page; only include links explicitly mentioned in the source text),
  "sourceNotes": string
}

STYLE REFERENCE (depth/tone target, NOT factual content to reuse):
${STYLE_REFERENCE}

━━━ FACTUAL ACCURACY RULES ━━━
- Extract every concrete fact the SOURCE TEXT contains: exact amounts, exact deadlines, named tracks/programmes, specific eligibility cutoffs, specific document names.
- Base every fact ONLY on the SOURCE TEXT provided. Do not use outside knowledge.
- Only write "Varies - confirm on official site" when the source text genuinely does not address that field.
- If the source describes multiple sub-programmes or tracks, reflect that structure.
- Use "status": "to-be-confirmed" unless the source text explicitly states the programme is open or closed.

━━━ WRITING STYLE RULES ━━━

NO EM DASHES OR EN DASHES. Hard rule, zero exceptions. Replace with commas, colons, parentheses, or split sentences.

NO AI VOCABULARY. Never use: pivotal, crucial, delve, tapestry, landscape (abstract), testament, underscore, highlight (verb), foster, enhance, vibrant, groundbreaking, nestled, renowned, breathtaking, interplay, intricate, showcase (verb), encompass, cultivate, garner, enduring, align with.

NO PROMOTIONAL TONE. Write plainly. Not "a prestigious opportunity" but "a fully funded scholarship."

NO SIGNIFICANCE INFLATION. Never write "marks a pivotal moment" or "testament to" or "underscores the importance." Just state the fact.

NO -ING PADDING. Do not tack present-participle phrases onto sentences for fake depth.

NO RULE OF THREE. If there are two things say two, if six say six.

NO VAGUE ATTRIBUTION. No "experts say" or "observers note."

NO GENERIC ENDINGS. Tips must be specific to this programme only.

USE SIMPLE VERBS. "is" not "serves as." "has" not "boasts." "covers" not "encompasses."

VARY SENTENCE LENGTH. Mix short and long sentences.

SPECIFIC BEATS VAGUE. Exact figures, exact dates, exact names from the source.

━━━ OUTPUT ━━━
Output ONLY the JSON object. No markdown fences, no commentary.
`;

async function generateOne(source: Source): Promise<Record<string, unknown> | null> {
  const scrapedPath = path.join(SCRAPED_DIR, `${source.slug}.txt`);
  if (!existsSync(scrapedPath)) {
    console.error(`  SKIP ${source.slug}: no scraped file. Run scrape-source.ts first.`);
    return null;
  }
  const sourceText = readFileSync(scrapedPath, "utf-8").slice(0, 90000);

  if (!API_KEYS.length) {
    console.error("Missing API key. Set GEMINI_API_KEYS (comma-separated) or GEMINI_API_KEY in .env.");
    process.exit(1);
  }

  const prompt = `You are structuring scholarship information for a study-abroad website.\n\nTarget scholarship: ${source.name} (${source.country})\nSuggested slug: ${source.slug}\nOfficial source URL: ${source.url}\n\n${SCHEMA_INSTRUCTIONS}\n\nSOURCE TEXT:\n"""\n${sourceText}\n"""`;

  for (let keyAttempt = 0; keyAttempt < API_KEYS.length; keyAttempt++) {
    const apiKey = getNextKey()!;
    const keyLabel = API_KEYS.length > 1 ? ` [key ${currentKeyIndex === 0 ? API_KEYS.length : currentKeyIndex}/${API_KEYS.length}]` : "";
    console.log(`Generating ${source.slug} via ${MODEL}${keyLabel} ...`);

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
        }),
      }
    );

    if (res.status === 429) {
      const remaining = API_KEYS.length - keyAttempt - 1;
      if (remaining > 0) {
        console.warn(`  Key quota exceeded (429). Trying next key (${remaining} remaining)...`);
        continue;
      }
      console.error("  All API keys hit quota (429). Try again later or add more keys via GEMINI_API_KEYS.");
      return null;
    }

    if (!res.ok) {
      console.error(`  FAILED: ${res.status} ${res.statusText} — ${await res.text()}`);
      return null;
    }

    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error("  FAILED: no text in Gemini response", JSON.stringify(json).slice(0, 500));
      return null;
    }

    try {
      return JSON.parse(text);
    } catch {
      console.warn("  JSON parse failed (truncated response), will retry...");
      return null;
    }
  }

  return null;
}

async function generateOneWithRetry(source: Source, retries = 2): Promise<Record<string, unknown> | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const result = await generateOne(source);
    if (result) return result;
    if (attempt < retries) {
      console.log(`  Retry ${attempt}/${retries - 1} for ${source.slug}...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.error(`  FAILED after ${retries} attempts: ${source.slug}`);
  return null;
}

async function getPublishedSlugsFromDB(): Promise<Set<string>> {
  // Strip BOM that PowerShell can prepend when piping secrets to gh secret set
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/^﻿/, "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").replace(/^﻿/, "").trim();
  if (!url || !key) return new Set();
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(url, key);
    const { data, error } = await supabase.from("scholarships").select("slug").eq("status", "published");
    if (error) { console.warn(`  DB check failed: ${error.message} — will regenerate all`); return new Set(); }
    return new Set((data ?? []).map((r: { slug: string }) => r.slug));
  } catch (e) {
    console.warn(`  DB check threw: ${(e as Error).message} — will regenerate all`);
    return new Set();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const skipExisting = args.includes("--skip-existing");
  const requestedSlugs = all
    ? SOURCES.map((s) => s.slug)
    : args.filter((a) => !a.startsWith("--"));

  if (!requestedSlugs.length) {
    console.error("Usage: npx tsx scripts/generate-batch.ts <slug> [<slug2> ...] | --all [--skip-existing]");
    process.exit(1);
  }

  const dbSlugs = skipExisting ? await getPublishedSlugsFromDB() : new Set<string>();
  if (skipExisting) console.log(`Skipping ${dbSlugs.size} slug(s) already published in Supabase.`);

  const results: Record<string, unknown>[] = [];

  for (const slug of requestedSlugs) {
    const source = SOURCES.find((s) => s.slug === slug);
    if (!source) {
      console.error(`  SKIP ${slug}: not in sources.json`);
      continue;
    }
    if (skipExisting && dbSlugs.has(slug)) {
      console.log(`  SKIP ${slug}: already published`);
      continue;
    }
    // Check for scraped file before attempting generation — retrying won't help if scraping failed
    const scrapedPath = path.join(SCRAPED_DIR, `${source.slug}.txt`);
    if (!existsSync(scrapedPath)) {
      console.error(`  SKIP ${slug}: no scraped file (URL may have been blocked during scrape)`);
      continue;
    }
    const entry = await generateOneWithRetry(source);
    if (entry) results.push(entry);
    if (requestedSlugs.indexOf(slug) < requestedSlugs.length - 1) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  if (!results.length) {
    console.log("\nNothing new to generate — all sources already published or scraped files unavailable. Exiting cleanly.");
    process.exit(0);
  }

  writeFileSync(OUT_PATH, JSON.stringify(results, null, 2), "utf-8");
  console.log(`\nWrote ${results.length} entr${results.length === 1 ? "y" : "ies"} to ${path.relative(process.cwd(), OUT_PATH)}`);
}

main();
