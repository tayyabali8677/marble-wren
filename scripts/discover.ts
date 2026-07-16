/**
 * Discovery step — scrapes scholarship aggregator/listing pages and extracts
 * individual scholarship sources to add to sources.json automatically.
 *
 * This sits BEFORE the normal scrape -> generate -> publish pipeline.
 * It does NOT generate content — it just keeps sources.json up to date
 * so the next pipeline run picks up new scholarships.
 *
 * Usage:
 *   npx tsx scripts/scholarship-pipeline/discover.ts            # all discovery sources
 *   npx tsx scripts/scholarship-pipeline/discover.ts <slug>     # one discovery source
 *   npx tsx scripts/scholarship-pipeline/discover.ts --dry-run  # print without saving
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env" });
loadEnv({ path: ".env.local", override: true });

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ProxyAgent, setGlobalDispatcher } from "undici";

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

type Source = { slug: string; country: string; name: string; url: string; note?: string };
type DiscoverySource = { slug: string; name: string; url: string; note?: string };

const SOURCES_PATH = path.join(__dirname, "sources.json");
const DISCOVERY_PATH = path.join(__dirname, "discovery-sources.json");

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

const UA = { headers: { "User-Agent": "Mozilla/5.0 (compatible; ResearchBot/1.0)" } };

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|p|div|li|h[1-6]|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
}

async function scrapeText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, UA);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html")) return null;
    return htmlToText(await res.text()).slice(0, 60000);
  } catch {
    return null;
  }
}

async function extractSources(
  discoverySource: DiscoverySource,
  pageText: string,
  existingSlugs: Set<string>
): Promise<Source[]> {
  const apiKey = getNextKey();
  if (!apiKey) {
    console.error("No Gemini API key available.");
    return [];
  }

  const prompt = `You are reading a scholarship listing/aggregator page and extracting individual scholarships to research further.

Page URL: ${discoverySource.url}
Page name: ${discoverySource.name}

From the text below, extract individual scholarships that:
- Are government-funded or from major international organisations
- Are relevant to international students (especially from Pakistan/South Asia)
- Have a specific official website or apply URL you can identify

For each scholarship found, return a JSON array of objects with this shape:
{
  "slug": string (kebab-case unique identifier, e.g. "gates-cambridge-scholarship"),
  "name": string (full official name),
  "country": string (the country offering the scholarship, e.g. "United Kingdom"),
  "url": string (the most specific official URL for this scholarship — prefer the apply/detail page over a generic homepage),
  "note": string (optional — any caveats about the URL or scholarship)
}

RULES:
- Only include scholarships with a clear, specific official URL. Do not invent URLs.
- Skip scholarships that are loan programs, paid programs, or require citizenship of the offering country.
- Skip anything that looks like a blog post, news article, or opinion piece — only real scholarship programmes.
- Each slug must be unique kebab-case. Use country suffix if needed to disambiguate (e.g. "merit-scholarship-japan").
- Output ONLY the JSON array. No markdown fences, no commentary.

PAGE TEXT:
"""
${pageText}
"""`;

  for (let attempt = 0; attempt < API_KEYS.length; attempt++) {
    const key = attempt === 0 ? apiKey : getNextKey()!;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
        }),
      }
    );

    if (res.status === 429) {
      console.warn(`  Key quota exceeded (429), trying next key...`);
      continue;
    }
    if (!res.ok) {
      console.error(`  Gemini error: ${res.status} ${res.statusText}`);
      return [];
    }

    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return [];

    let extracted: Source[];
    try {
      extracted = JSON.parse(text);
      if (!Array.isArray(extracted)) return [];
    } catch {
      console.warn(`  JSON parse failed for discovery response`);
      return [];
    }

    // Filter out slugs that already exist in sources.json
    const newOnes = extracted.filter((s) => {
      if (!s.slug || !s.name || !s.country || !s.url) return false;
      if (existingSlugs.has(s.slug)) return false;
      return true;
    });

    return newOnes;
  }

  return [];
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const targetSlug = args.find((a) => !a.startsWith("--"));

  if (!API_KEYS.length) {
    console.error("Missing GEMINI_API_KEYS or GEMINI_API_KEY in .env.local.");
    process.exit(1);
  }

  const discoverySources: DiscoverySource[] = JSON.parse(
    readFileSync(DISCOVERY_PATH, "utf-8")
  );
  const currentSources: Source[] = JSON.parse(readFileSync(SOURCES_PATH, "utf-8"));
  const existingSlugs = new Set(currentSources.map((s) => s.slug));

  const targets = targetSlug
    ? discoverySources.filter((s) => s.slug === targetSlug)
    : discoverySources;

  if (!targets.length) {
    console.error(`No discovery source found${targetSlug ? ` for slug "${targetSlug}"` : ""}.`);
    process.exit(1);
  }

  const allNew: Source[] = [];

  for (const ds of targets) {
    console.log(`\nDiscovering from: ${ds.name} (${ds.url})`);
    const text = await scrapeText(ds.url);
    if (!text) {
      console.error(`  FAILED to fetch page`);
      continue;
    }
    console.log(`  Scraped ${text.length} chars, asking Gemini to extract sources...`);

    const found = await extractSources(ds, text, existingSlugs);
    if (!found.length) {
      console.log(`  No new sources found`);
      continue;
    }

    console.log(`  Found ${found.length} new source(s):`);
    found.forEach((s) => {
      console.log(`    + [${s.country}] ${s.name}`);
      console.log(`      slug: ${s.slug}`);
      console.log(`      url:  ${s.url}`);
      existingSlugs.add(s.slug); // prevent cross-source duplicates
    });

    allNew.push(...found);

    // Pause between discovery sources to avoid rate limits
    if (targets.indexOf(ds) < targets.length - 1) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  if (!allNew.length) {
    console.log("\nNo new sources discovered.");
    return;
  }

  console.log(`\nTotal new sources: ${allNew.length}`);

  if (dryRun) {
    console.log("--dry-run set — sources.json not updated.");
    console.log(JSON.stringify(allNew, null, 2));
    return;
  }

  const updated = [...currentSources, ...allNew];
  writeFileSync(SOURCES_PATH, JSON.stringify(updated, null, 2), "utf-8");
  console.log(`Updated sources.json: ${currentSources.length} -> ${updated.length} sources.`);
  console.log("Run the normal pipeline next:");
  console.log("  npx tsx scripts/scholarship-pipeline/scrape-source.ts");
  console.log("  npx tsx scripts/scholarship-pipeline/generate-batch.ts --all --skip-existing");
  console.log("  npx tsx scripts/scholarship-pipeline/publish-scholarship.ts scripts/scholarship-pipeline/generated-batch.json");
}

main();
