export type SitemapEntry = {
  url: string;
  lastmod?: string;
};

// Handles both a sitemap index (nested <sitemap><loc>) and a flat sitemap
// (<url><loc>). Returns deduped entries, keeping the newest lastmod seen.
export async function fetchSitemapEntries(sitemapUrl: string): Promise<SitemapEntry[]> {
  const res = await fetch(sitemapUrl);
  if (!res.ok) throw new Error(`Failed to fetch sitemap: ${res.status}`);
  const xml = await res.text();

  const entries: SitemapEntry[] = [];

  const sitemapMatches = [...xml.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/g)];
  if (sitemapMatches.length > 0) {
    for (const block of sitemapMatches) {
      const loc = block[1].match(/<loc>(.*?)<\/loc>/)?.[1]?.trim();
      if (!loc) continue;
      const subRes = await fetch(loc);
      if (!subRes.ok) continue;
      entries.push(...parseUrlBlocks(await subRes.text()));
    }
  } else {
    entries.push(...parseUrlBlocks(xml));
  }

  const byUrl = new Map<string, SitemapEntry>();
  for (const e of entries) {
    const prev = byUrl.get(e.url);
    if (!prev || (e.lastmod && (!prev.lastmod || e.lastmod > prev.lastmod))) {
      byUrl.set(e.url, e);
    }
  }
  return [...byUrl.values()];
}

function parseUrlBlocks(xml: string): SitemapEntry[] {
  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)]
    .map((block): SitemapEntry | null => {
      const url = block[1].match(/<loc>(.*?)<\/loc>/)?.[1]?.trim();
      const lastmod = block[1].match(/<lastmod>(.*?)<\/lastmod>/)?.[1]?.trim();
      return url ? { url, lastmod } : null;
    })
    .filter((e): e is SitemapEntry => e !== null);
}
