/**
 * Status Check — visits each published scholarship's official website and
 * asks Gemini whether applications are currently open, upcoming, or unknown.
 * Updates only the application_status column in Supabase for changed records,
 * then pings the revalidate endpoint so the site reflects changes immediately.
 *
 * Usage:
 *   npx tsx scripts/status-check.ts              # check all
 *   npx tsx scripts/status-check.ts --dry-run    # print changes, no writes
 *   npx tsx scripts/status-check.ts --limit 20   # check first N (for testing)
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env" });
loadEnv({ path: ".env.local", override: true });

import { createClient } from "@supabase/supabase-js";

type AppStatus = "open" | "upcoming" | "to-be-confirmed";

interface ScholarshipRow {
  slug: string;
  name: string;
  application_status: string;
  data: { officialWebsite?: string; openingMonth?: string };
}

interface StatusResult {
  slug: string;
  name: string;
  oldStatus: string;
  newStatus: AppStatus;
  reason: string;
}

/* ── Config ──────────────────────────────────────────────── */

const MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
const API_KEYS: string[] = (
  process.env.GEMINI_API_KEYS
    ? process.env.GEMINI_API_KEYS.split(",").map((k) => k.trim()).filter(Boolean)
    : process.env.GEMINI_API_KEY
    ? [process.env.GEMINI_API_KEY]
    : []
);
let keyIndex = 0;

function nextKey(): string | null {
  if (!API_KEYS.length) return null;
  const k = API_KEYS[keyIndex];
  keyIndex = (keyIndex + 1) % API_KEYS.length;
  return k;
}

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/* ── Fetch page text ─────────────────────────────────────── */

async function fetchDirect(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": CHROME_UA, "Accept": "text/html,*/*;q=0.8" },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("text/html")) return null;
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 60000);
  } catch {
    return null;
  }
}

async function fetchViaJina(url: string): Promise<string | null> {
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { "Accept": "text/plain", "User-Agent": CHROME_UA },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.length > 100 ? text.slice(0, 60000) : null;
  } catch {
    return null;
  }
}

async function getPageText(url: string): Promise<string | null> {
  const direct = await fetchDirect(url);
  if (direct && direct.length > 300) return direct;
  return fetchViaJina(url);
}

/* ── Gemini status check ─────────────────────────────────── */

const CURRENT_YEAR = new Date().getFullYear();

async function checkStatus(
  slug: string,
  name: string,
  pageText: string
): Promise<{ status: AppStatus; reason: string } | null> {
  const apiKey = nextKey();
  if (!apiKey) return null;

  const prompt = `You are checking whether a scholarship is currently accepting applications.

Scholarship name: ${name}
Current year: ${CURRENT_YEAR}

Read the page text below and answer with a JSON object:
{
  "status": "open" | "upcoming" | "to-be-confirmed",
  "reason": string (one sentence)
}

RULES:
- "open": page explicitly says applications are open RIGHT NOW for ${CURRENT_YEAR} or ${CURRENT_YEAR + 1} cycle, with an active deadline in the future.
- "upcoming": page mentions a future opening date for ${CURRENT_YEAR} or ${CURRENT_YEAR + 1} that has not yet passed.
- "to-be-confirmed": anything else — page is unclear, deadline has passed, no date mentioned, site is down, or information is about a past cycle.
- NEVER return "closed". Use "to-be-confirmed" instead.
- Base your answer ONLY on dates and text on this specific page.
- If the page is an error, redirect, or nearly empty, return "to-be-confirmed".

Output ONLY the JSON object. No markdown.

PAGE TEXT:
"""
${pageText.slice(0, 40000)}
"""`;

  for (let attempt = 0; attempt < API_KEYS.length; attempt++) {
    const key = attempt === 0 ? apiKey : nextKey()!;
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
          }),
          signal: AbortSignal.timeout(30000),
        }
      );

      if (res.status === 429) {
        console.warn(`  [${slug}] 429 on key ${keyIndex}, trying next...`);
        continue;
      }
      if (!res.ok) {
        console.error(`  [${slug}] Gemini ${res.status}`);
        return null;
      }

      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) return null;

      const parsed = JSON.parse(text) as { status: AppStatus; reason: string };
      if (!["open", "upcoming", "to-be-confirmed"].includes(parsed.status)) {
        parsed.status = "to-be-confirmed";
      }
      return parsed;
    } catch {
      continue;
    }
  }

  return null;
}

/* ── Main ────────────────────────────────────────────────── */

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitArg = args.find((a) => a.startsWith("--limit=") || a === "--limit");
  const limit = limitArg
    ? parseInt(limitArg.includes("=") ? limitArg.split("=")[1] : args[args.indexOf("--limit") + 1], 10)
    : Infinity;

  if (!API_KEYS.length) {
    console.error("Set GEMINI_API_KEYS or GEMINI_API_KEY");
    process.exit(1);
  }

  const supaUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/^﻿/, "").trim();
  const supaKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").replace(/^﻿/, "").trim();
  if (!supaUrl || !supaKey) {
    console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const supabase = createClient(supaUrl, supaKey);

  // Fetch all published scholarships with their current status and official website
  const { data: rows, error } = await supabase
    .from("scholarships")
    .select("slug, name, application_status, data")
    .eq("status", "published")
    .order("name");

  if (error || !rows) {
    console.error("Failed to fetch scholarships:", error?.message);
    process.exit(1);
  }

  const scholarships = (rows as ScholarshipRow[]).filter(
    (r) => r.data?.officialWebsite && !r.data.officialWebsite.includes("To be confirmed")
  );

  console.log(`Found ${scholarships.length} scholarships with official websites.`);
  const toCheck = scholarships.slice(0, isFinite(limit) ? limit : scholarships.length);
  console.log(`Checking ${toCheck.length} scholarship(s)${dryRun ? " (dry run)" : ""}...\n`);

  const changes: StatusResult[] = [];
  let checked = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of toCheck) {
    const url = row.data.officialWebsite!;
    process.stdout.write(`[${checked + 1}/${toCheck.length}] ${row.slug} ... `);

    const pageText = await getPageText(url);
    if (!pageText) {
      console.log("SKIP (could not fetch page)");
      skipped++;
      checked++;
      await delay(1000);
      continue;
    }

    const result = await checkStatus(row.slug, row.name, pageText);
    if (!result) {
      console.log("SKIP (Gemini failed)");
      failed++;
      checked++;
      await delay(1500);
      continue;
    }

    const changed = result.status !== row.application_status;
    console.log(
      `${changed ? "CHANGE" : "same"} ${row.application_status} → ${result.status}  (${result.reason})`
    );

    if (changed) {
      changes.push({
        slug: row.slug,
        name: row.name,
        oldStatus: row.application_status,
        newStatus: result.status,
        reason: result.reason,
      });
    }

    checked++;
    await delay(1500);
  }

  console.log(`\n── Summary ──────────────────────────────`);
  console.log(`Checked: ${checked}  |  Changed: ${changes.length}  |  Skipped: ${skipped}  |  Failed: ${failed}`);

  if (!changes.length) {
    console.log("No status changes — nothing to write.");
    return;
  }

  console.log("\nChanges:");
  changes.forEach((c) => {
    console.log(`  ${c.slug}: ${c.oldStatus} → ${c.newStatus}  (${c.reason})`);
  });

  if (dryRun) {
    console.log("\n--dry-run set — Supabase not updated.");
    return;
  }

  // Write changes to Supabase in batches of 10
  let updated = 0;
  for (const change of changes) {
    const { error: uErr } = await supabase
      .from("scholarships")
      .update({ application_status: change.newStatus })
      .eq("slug", change.slug);

    if (uErr) {
      console.error(`  FAILED to update ${change.slug}: ${uErr.message}`);
    } else {
      updated++;
    }
  }

  console.log(`\nUpdated ${updated}/${changes.length} record(s) in Supabase.`);

  // Ping revalidate
  const revalidateUrl = (process.env.REVALIDATE_URL ?? "").replace(/^﻿/, "").trim();
  const revalidateSecret = (process.env.REVALIDATE_SECRET ?? "").replace(/^﻿/, "").trim();
  if (revalidateUrl && revalidateSecret && updated > 0) {
    try {
      const r = await fetch(revalidateUrl, {
        method: "POST",
        headers: { "x-revalidate-token": revalidateSecret },
      });
      const body = await r.json();
      console.log(`Revalidation: ${r.status} — ${JSON.stringify(body)}`);
    } catch (e) {
      console.warn(`Revalidation ping failed (non-fatal): ${(e as Error).message}`);
    }
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main();
