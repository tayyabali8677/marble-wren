/**
 * Agent 19: image SEO.
 *
 * Two cheap wins hide in images. Alt text is the accessible name of the image
 * and the only thing a search engine reads from it, so a missing alt is a lost
 * ranking signal and a barrier for screen-reader users at the same time. And an
 * image shipped without width and height attributes lets the page reflow as it
 * loads, which is Cumulative Layout Shift, a Core Web Vital Google measures
 * directly.
 *
 * Alt coverage and missing dimensions come free from the crawl. File weight
 * does not: the crawled HTML has the img tags but not the bytes behind them, so
 * this makes a bounded HEAD pass over the distinct image URLs to read their
 * sizes. Distinct is the word that keeps it cheap. One logo on 581 pages is one
 * request, not 581.
 */

import { crawlSite, writeReport, toPath } from "./crawl";

// An empty alt ("") is a deliberate "decorative, skip me" and is correct. Only
// a missing alt attribute is the oversight worth reporting.
const HEAD_CONCURRENCY = 8;
const HEAD_TIMEOUT_MS = 15000;
// Above this an image is heavy enough to hurt load time on a mid-range phone on
// a Pakistani mobile connection, which is most of this site's audience.
const HEAVY_BYTES = 200 * 1024;
const VERY_HEAVY_BYTES = 500 * 1024;
// Below this a dated format is not worth converting. Flag icons and the logo are
// a couple of KB each; a WebP of them saves nothing and would only be noise in
// the report. A JPEG worth reformatting is one carrying a real photo.
const DATED_MIN_BYTES = 30 * 1024;
const OWN_HOST = "titansabroad.org";
// Reading the size of more than this many distinct images is not worth the time;
// the heaviest offenders repeat across the template and surface early anyway.
const MAX_HEAD = 600;
const MAX_REPORTED = 30;

// Formats that a modern site should have moved off. Serving these where WebP or
// AVIF would do is usually a two-thirds size cut for free.
const DATED_FORMAT = /\.(?:jpe?g|png|gif|bmp|tiff?)(?:$|\?)/i;
const NEXT_GEN = /\.(?:webp|avif)(?:$|\?)/i;

function extOf(url: string): string {
  const m = url.split("?")[0].match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "(none)";
}

// Own-CDN images show as a bare path. Anything hotlinked from another server
// keeps its host, so a 5 MB photo pulled from a university's own site is
// obviously not ours to compress in place and reads as the different problem it
// is: a dependency on a server we do not control.
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.endsWith(OWN_HOST) ? u.pathname : `${u.hostname}${u.pathname}`;
  } catch {
    return url;
  }
}

function isOwn(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(OWN_HOST);
  } catch {
    return false;
  }
}

async function headSize(url: string): Promise<number | null> {
  try {
    let res = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; titansabroad-seo-agent)" },
    });
    // Some CDNs refuse HEAD. Fall back to a ranged GET that asks for one byte,
    // which still returns the full size in Content-Range.
    if (!res.ok || res.headers.get("content-length") === null) {
      res = await fetch(url, {
        method: "GET",
        headers: {
          Range: "bytes=0-0",
          "User-Agent": "Mozilla/5.0 (compatible; titansabroad-seo-agent)",
        },
        signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
      });
      const range = res.headers.get("content-range");
      const total = range?.match(/\/(\d+)\s*$/)?.[1];
      if (total) return parseInt(total, 10);
    }
    const len = res.headers.get("content-length");
    return len ? parseInt(len, 10) : null;
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await fn(items[idx]);
      }
    })
  );
  return results;
}

const kb = (n: number) => `${Math.round(n / 1024)} KB`;

async function main() {
  const pages = (await crawlSite()).filter((p) => p.status === 200);

  // Alt and dimension coverage, counted per image occurrence across pages.
  let total = 0;
  let missingAlt = 0;
  let emptyAlt = 0;
  let missingDims = 0;
  const missingAltByPage = new Map<string, number>();
  const missingDimsByPage = new Map<string, number>();
  const uniqueSrc = new Map<string, { pages: Set<string>; ext: string }>();

  for (const page of pages) {
    const path = toPath(page.url);
    for (const img of page.images) {
      total++;
      if (img.alt === null) {
        missingAlt++;
        missingAltByPage.set(path, (missingAltByPage.get(path) ?? 0) + 1);
      } else if (img.alt === "") {
        emptyAlt++;
      }
      if (!img.dims) {
        missingDims++;
        missingDimsByPage.set(path, (missingDimsByPage.get(path) ?? 0) + 1);
      }
      // Only same-origin and CDN images we control are worth weighing. Skip
      // obvious third-party embeds we cannot optimise anyway.
      const rec = uniqueSrc.get(img.src) ?? { pages: new Set<string>(), ext: extOf(img.src) };
      rec.pages.add(path);
      uniqueSrc.set(img.src, rec);
    }
  }

  // Weigh the distinct images, heaviest-first bias by checking the most-reused
  // ones first so a truncated pass still catches the template offenders.
  const distinct = [...uniqueSrc.entries()]
    .sort((a, b) => b[1].pages.size - a[1].pages.size)
    .slice(0, MAX_HEAD);
  console.log(`Weighing ${distinct.length} distinct images (of ${uniqueSrc.size})...`);

  const sizes = await mapLimit(distinct, HEAD_CONCURRENCY, async ([src]) => headSize(src));

  type Heavy = { src: string; bytes: number; onPages: number; ext: string; own: boolean };
  const heavy: Heavy[] = [];
  const datedFormat: Array<{ src: string; onPages: number; ext: string; bytes: number }> = [];
  for (let i = 0; i < distinct.length; i++) {
    const [src, rec] = distinct[i];
    const bytes = sizes[i];
    if (bytes !== null && bytes >= HEAVY_BYTES) {
      heavy.push({ src, bytes, onPages: rec.pages.size, ext: rec.ext, own: isOwn(src) });
    }
    // Only flag a dated format once it is big enough to be worth reformatting.
    // Without a measured size we cannot tell a photo from an icon, so an
    // unmeasured image is left out rather than guessed at.
    if (DATED_FORMAT.test(src) && !NEXT_GEN.test(src) && bytes !== null && bytes >= DATED_MIN_BYTES) {
      datedFormat.push({ src, onPages: rec.pages.size, ext: rec.ext, bytes });
    }
  }
  heavy.sort((a, b) => b.bytes - a.bytes);
  datedFormat.sort((a, b) => b.bytes - a.bytes);
  const hotlinked = heavy.filter((h) => !h.own);

  const altPages = [...missingAltByPage.entries()].sort((a, b) => b[1] - a[1]);
  const dimsPages = [...missingDimsByPage.entries()].sort((a, b) => b[1] - a[1]);

  const date = new Date().toISOString().split("T")[0];
  let report = `# Image SEO: ${date}\n\n`;
  report += `**Pages checked:** ${pages.length}\n`;
  report += `**Image references:** ${total} (${uniqueSrc.size} distinct URLs)\n`;
  report += `**Missing an alt attribute:** ${missingAlt}\n`;
  report += `**Empty alt (decorative, fine):** ${emptyAlt}\n`;
  report += `**Missing width/height (layout shift risk):** ${missingDims}\n`;
  report += `**Heavy images found (of ${distinct.length} weighed):** ${heavy.length}`;
  report += hotlinked.length > 0 ? ` (${hotlinked.length} hotlinked from other servers)\n` : `\n`;
  report += `**Dated formats over ${kb(DATED_MIN_BYTES)} where WebP/AVIF would be smaller:** ${datedFormat.length}\n\n`;

  const findings = missingAlt + missingDims + heavy.length + datedFormat.length;
  if (findings === 0) {
    report += `Every image has an alt attribute and dimensions, and none of the ${distinct.length} `;
    report += `weighed are heavy or in a dated format. Nothing to do.\n\n---\n\n`;
    writeReport("image-seo", report);
    console.log("No image issues.");
    return;
  }

  report += `Alt text and dimensions are read straight from the markup. File weight is measured `;
  report += `by requesting each distinct image once, so a logo on every page counts as one image, `;
  report += `not ${pages.length}.\n\n`;

  if (heavy.length > 0) {
    report += `## Heavy Images (${heavy.length})\n\n`;
    report += `On a phone connection the weight is felt directly in load time. Anything over `;
    report += `${kb(VERY_HEAVY_BYTES)} is worth resizing or converting before anything else here. A `;
    report += `host shown in the path means the image is hotlinked from another server, so it cannot `;
    report += `be compressed in place; the fix there is to copy a resized version onto our own CDN.\n\n`;
    report += `| Size | On pages | Format | Image |\n|---|---|---|---|\n`;
    for (const h of heavy.slice(0, MAX_REPORTED)) {
      const flag = h.bytes >= VERY_HEAVY_BYTES ? " **!!**" : "";
      report += `| ${kb(h.bytes)}${flag} | ${h.onPages} | ${h.ext} | ${shortUrl(h.src)} |\n`;
    }
    report += `\n`;
  }

  if (altPages.length > 0) {
    report += `## Pages With Images Missing Alt Text (${altPages.length})\n\n`;
    report += `A missing alt is a lost ranking signal and an accessibility gap. An intentionally `;
    report += `decorative image should have alt="" rather than no attribute, which is why the `;
    report += `${emptyAlt} empty ones above are not counted as problems.\n\n`;
    report += `| Page | Images without alt |\n|---|---|\n`;
    for (const [path, count] of altPages.slice(0, MAX_REPORTED)) {
      report += `| ${path} | ${count} |\n`;
    }
    if (altPages.length > MAX_REPORTED) report += `\n*${altPages.length - MAX_REPORTED} more pages.*\n`;
    report += `\n`;
  }

  if (dimsPages.length > 0) {
    report += `## Pages With Images Missing Dimensions (${dimsPages.length})\n\n`;
    report += `Images without width and height let the layout jump as they load, which is `;
    report += `Cumulative Layout Shift. If these render through the Next.js Image component the `;
    report += `dimensions may be set another way, so confirm against a live CLS reading before acting.\n\n`;
    report += `| Page | Images without dimensions |\n|---|---|\n`;
    for (const [path, count] of dimsPages.slice(0, MAX_REPORTED)) {
      report += `| ${path} | ${count} |\n`;
    }
    if (dimsPages.length > MAX_REPORTED) report += `\n*${dimsPages.length - MAX_REPORTED} more pages.*\n`;
    report += `\n`;
  }

  if (datedFormat.length > 0) {
    report += `## Dated Image Formats (${datedFormat.length})\n\n`;
    report += `JPEG and PNG where WebP or AVIF would typically be half to a third of the size at `;
    report += `the same quality. Highest-reuse first, since converting those pays off across the `;
    report += `most pages.\n\n`;
    report += `| Size | On pages | Format | Image |\n|---|---|---|---|\n`;
    for (const d of datedFormat.slice(0, MAX_REPORTED)) {
      report += `| ${kb(d.bytes)} | ${d.onPages} | ${d.ext} | ${shortUrl(d.src)} |\n`;
    }
    if (datedFormat.length > MAX_REPORTED) report += `\n*${datedFormat.length - MAX_REPORTED} more.*\n`;
    report += `\n`;
  }

  report += `---\n\n`;
  writeReport("image-seo", report);
  console.log(
    `Missing alt: ${missingAlt} | Missing dims: ${missingDims} | Heavy: ${heavy.length} | Dated format: ${datedFormat.length}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
