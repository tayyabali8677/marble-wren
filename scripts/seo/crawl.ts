/**
 * Shared crawl of the whole site, cached to disk for the run.
 *
 * Most of the agents need the same page HTML. Crawling every URL once per agent
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
// Bump when CrawledPage gains a field, so a cache written by the old shape is
// not read back with the new fields silently undefined.
const SCHEMA = "v3";

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
  /** Hrefs pointing off-site, as absolute URLs. Kept for citation checks. */
  externalLinks: string[];
  /** Raw contents of every ld+json block. */
  jsonLd: string[];
  title: string;
  metaDescription: string;
  /** rel=canonical target, absolute. Empty when the page declares none. */
  canonical: string;
  /** Contents of the robots meta tag, lowercased. Empty when absent. */
  robots: string;
  /** Text of every h1, in document order. */
  h1: string[];
  /** Text of every h2 and h3, in document order. */
  headings: string[];
  /** Every <img> on the page. src is absolute; dims is true when both width
   *  and height attributes are present, which is what prevents layout shift. */
  images: Array<{ src: string; alt: string | null; dims: boolean }>;
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

/**
 * Entities survive extraction from raw HTML, so "IBCC &amp; MOFA" never matches
 * the "IBCC & MOFA" sitting in the decoded body text. Only the fields added
 * after the original three agents are decoded here; title and metaDescription
 * are left as they were so nothing already tuned against them shifts.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ");
}

/** Inner text of a matched element, markup removed. */
function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function headingsOf(html: string, tags: string): string[] {
  const re = new RegExp(`<(${tags})\\b[^>]*>([\\s\\S]*?)<\\/\\1>`, "gi");
  return [...html.matchAll(re)].map((m) => textOf(m[2])).filter(Boolean);
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"));
  return m ? m[1] : null;
}

/**
 * Every img on the page. A missing alt attribute and a present-but-empty one are
 * different things: empty alt is a deliberate "this is decorative" and is
 * correct, a missing attribute is an oversight, so null is kept distinct from "".
 * Next.js renders responsive images through srcset, so the largest candidate in
 * srcset is preferred over src when present, since that is what actually ships.
 */
function imagesOf(html: string, url: string): CrawledPage["images"] {
  const out: CrawledPage["images"] = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const rawAlt = attr(tag, "alt");
    const srcset = attr(tag, "srcset");
    let src = attr(tag, "src");
    if (srcset) {
      const last = srcset.split(",").pop()?.trim().split(/\s+/)[0];
      if (last) src = last;
    }
    if (!src || src.startsWith("data:")) continue;
    let abs = src;
    try {
      abs = new URL(decodeEntities(src), url).toString();
    } catch {
      // Keep the raw value if it will not resolve; the agent can still flag it.
    }
    out.push({
      src: abs,
      alt: rawAlt === null ? null : decodeEntities(rawAlt).trim(),
      dims: attr(tag, "width") !== null && attr(tag, "height") !== null,
    });
  }
  return out;
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
    externalLinks: [],
    jsonLd: [],
    title: "",
    metaDescription: "",
    canonical: "",
    robots: "",
    h1: [],
    headings: [],
    images: [],
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

    const hrefs = [...html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)]
      .map((m) => m[1])
      .filter((h) => !h.startsWith("mailto:") && !h.startsWith("tel:"))
      .map((h) => {
        try {
          return new URL(h, url).toString();
        } catch {
          return "";
        }
      })
      .filter(Boolean);

    base.text = stripToText(html);
    base.words = base.text ? base.text.split(/\s+/).length : 0;
    base.links = [...new Set(hrefs.filter((h) => h.startsWith(origin)))];
    base.externalLinks = [...new Set(hrefs.filter((h) => /^https?:/.test(h) && !h.startsWith(origin)))];
    base.h1 = headingsOf(html, "h1");
    base.headings = headingsOf(html, "h2|h3");
    base.images = imagesOf(html, url);
    base.jsonLd = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(
      (m) => m[1].trim()
    );
    base.title = extract(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
    base.metaDescription = extract(html, /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i);

    // Attribute order is not guaranteed by anything, so both orderings are
    // tried before concluding a tag is absent. Reporting a missing canonical
    // that is present is worse than not checking.
    const canonicalRaw =
      extract(html, /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) ||
      extract(html, /<link[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);
    if (canonicalRaw) {
      try {
        base.canonical = new URL(decodeEntities(canonicalRaw), url).toString();
      } catch {
        base.canonical = canonicalRaw;
      }
    }

    base.robots = (
      extract(html, /<meta[^>]*name=["']robots["'][^>]*content=["']([^"']*)["']/i) ||
      extract(html, /<meta[^>]*content=["']([^"']*)["'][^>]*name=["']robots["']/i)
    ).toLowerCase();
  } catch (err: any) {
    base.error = err.message?.slice(0, 120) ?? "unknown";
  }

  return base;
}

export async function crawlSite(): Promise<CrawledPage[]> {
  const date = new Date().toISOString().split("T")[0];
  const cachePath = join(process.cwd(), CACHE_DIR, `${date}-${SCHEMA}.json`);

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
