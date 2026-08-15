/**
 * Fetches the live page and reduces it to readable text.
 *
 * The gap agent needs this to answer the question the whole exercise turns on:
 * does this page already cover the query? Without it the agent writes answers
 * for things the page says perfectly well already.
 *
 * Because the FAQ block is server rendered into the HTML, previously published
 * answers show up here too, so the agent also sees its own past work.
 */

const MAX_CHARS = 6000;
const TIMEOUT_MS = 15000;

export async function fetchPageText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; titansabroad-seo-agent)" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      console.warn(`  Could not fetch ${url}: HTTP ${res.status}`);
      return null;
    }

    const html = await res.text();

    const text = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#\d+;/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  } catch (err: any) {
    console.warn(`  Could not fetch ${url}: ${err.message}`);
    return null;
  }
}
