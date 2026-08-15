/**
 * Shared crawl of the whole site, cached to disk for the run.
 *
 * Three of the agents need the same page HTML. Crawling 474 URLs three times
 * would be slow and rude to our own server, so the first agent to ask does the
 * crawl and writes the cache, and the rest read it.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { fetchSitemapEntries } from "./sitemap";

const SITEMAP_URL = "https://titansabroad.org/sitemap.xml";
const CACHE_DIR = ".crawl-cache";
const CONCURRENCY = 6;
const TIMEOUT_MS = 20000;

export type CrawledPage = {
  url: string;
  status: number;
  /** Final URL after redirects, so redirect chains are visible. */
  finalUrl: string;
  lastmod?: string;
  /** Visible text with markup stripped. Empty when the fetch failed. */
  text: string;
  /** Word count of the visible text. */
  words: number;
  /** Internal hrefs found on the page, as absolute URLs. */
  links: string[];
  /** Raw contents of every ld+json block. */
  jsonLd: string[];
  title: string;
  metaDescription: string;
  error?: string;
};

function stripToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extract(html: string, re: RegExp): string {
  return html.match(re)?.[1]?.trim() ?? "";
}

async function fetchPage(url: string, lastmod?: string): Promise<CrawledPage> {
  const base: CrawledPage = {
    url,
    status: 0,
    finalUrl: url,
    lastmod,
    text: "",
    words: 0,
    links: [],
    jsonLd: [],
    title: "",
    metaDescription: "",
  };

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; titansabroad-seo-agent)" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });

    base.status = res.status;
    base.finalUrl = res.url || url;

    if (!res.ok) return base;

    const html = await res.text();
    const origin = new URL(url).origin;

    const links = [...html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)]
      .map((m) => m[1])
      .filter((h) => !h.startsWith("mailto:") && !h.startsWith("tel:"))
      .map((h) => {
        try {
          return new URL(h, url).toString();
        } catch {
          return "";
        }
      })
      .filter((h) => h.startsWith(origin));

    base.text = stripToText(html);
    base.words = base.text ? base.text.split(/\s+/).length : 0;
    base.links = [...new Set(links)];
    base.jsonLd = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(
      (m) => m[1].trim()
    );
    base.title = extract(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
    base.metaDescription = extract(html, /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i);
  } catch (err: any) {
    base.error = err.message?.slice(0, 120) ?? "unknown";
  }

  return base;
}

export async function crawlSite(): Promise<CrawledPage[]> {
  const date = new Date().toISOString().split("T")[0];
  const cachePath = join(process.cwd(), CACHE_DIR, `${date}.json`);

  if (existsSync(cachePath)) {
    console.log("Using cached crawl.");
    return JSON.parse(readFileSync(cachePath, "utf-8"));
  }

  const entries = await fetchSitemapEntries(SITEMAP_URL);
  console.log(`Crawling ${entries.length} URLs...`);

  const results: CrawledPage[] = [];
  const queue = [...entries];

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) {
        results.push(await fetchPage(entry.url, entry.lastmod));
        if (results.length % 50 === 0) console.log(`  ${results.length}/${entries.length}`);
      }
    })
  );

  mkdirSync(join(process.cwd(), CACHE_DIR), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(results), "utf-8");
  console.log(`Crawled ${results.length} pages.`);

  return results;
}

export function toPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function writeReport(name: string, body: string): void {
  const date = new Date().toISOString().split("T")[0];
  const dir = join(process.cwd(), "reports");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${name}-${date}.md`);
  writeFileSync(out, body, "utf-8");
  console.log(`Report saved: ${out}`);
}
