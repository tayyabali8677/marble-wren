import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { ProxyAgent, setGlobalDispatcher } from "undici";

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

type Source = { slug: string; country: string; name: string; url: string; note?: string };

const DIR = path.join(__dirname, "scraped");
const SOURCES: Source[] = JSON.parse(
  readFileSync(path.join(__dirname, "sources.json"), "utf-8")
);

const MAX_PAGES = 6;
const MAX_TOTAL_CHARS = 90000;
const RELEVANT_KEYWORDS = [
  "scholarship", "eligib", "apply", "application", "faq", "benefit", "fund",
  "deadline", "requirement", "document", "how-to", "criteria", "grant", "stipend",
];

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
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

function extractLinks(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const links = new Set<string>();
  const re = /<a\s+[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const [, href, anchorHtml] = match;
    let abs: URL;
    try {
      abs = new URL(href, base);
    } catch {
      continue;
    }
    if (abs.hostname !== base.hostname) continue;
    const anchorText = anchorHtml.replace(/<[^>]+>/g, " ").toLowerCase();
    const hrefLower = abs.pathname.toLowerCase();
    const relevant = RELEVANT_KEYWORDS.some((k) => anchorText.includes(k) || hrefLower.includes(k));
    if (relevant) links.add(abs.toString().split("#")[0]);
  }
  return Array.from(links);
}

async function fetchPage(url: string): Promise<{ html: string; text: string } | null> {
  const res = await fetch(url, UA);
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return null;
  const html = await res.text();
  return { html, text: htmlToText(html) };
}

async function scrapeOne(source: Source) {
  console.log(`Fetching ${source.name} (${source.url}) ...`);
  const seed = await fetchPage(source.url);
  if (!seed) {
    console.error(`  FAILED: could not fetch seed URL`);
    return;
  }

  const pages: { url: string; text: string }[] = [{ url: source.url, text: seed.text }];
  let totalChars = seed.text.length;

  const candidateLinks = extractLinks(seed.html, source.url).slice(0, 20);
  for (const link of candidateLinks) {
    if (pages.length >= MAX_PAGES || totalChars >= MAX_TOTAL_CHARS) break;
    try {
      const page = await fetchPage(link);
      if (!page || page.text.length < 200) continue;
      pages.push({ url: link, text: page.text });
      totalChars += page.text.length;
      console.log(`  + followed ${link} (${page.text.length} chars)`);
    } catch {
      // skip broken links silently
    }
  }

  const combined = pages
    .map((p) => `===== SOURCE PAGE: ${p.url} =====\n${p.text}`)
    .join("\n\n");

  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  const outPath = path.join(DIR, `${source.slug}.txt`);
  writeFileSync(outPath, combined, "utf-8");
  console.log(`  saved ${pages.length} page(s), ${combined.length} chars -> ${path.relative(process.cwd(), outPath)}`);
}

async function main() {
  const [, , onlySlug] = process.argv;
  const targets = onlySlug ? SOURCES.filter((s) => s.slug === onlySlug) : SOURCES;

  if (!targets.length) {
    console.error(`No source found${onlySlug ? ` for slug "${onlySlug}"` : ""}.`);
    process.exit(1);
  }

  for (const source of targets) {
    try {
      await scrapeOne(source);
    } catch (err) {
      console.error(`  ERROR scraping ${source.slug}:`, (err as Error).message);
    }
  }
}

main();
