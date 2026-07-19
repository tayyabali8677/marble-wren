/**
 * Ticker Updater — queries live scholarship counts from Supabase and updates
 * the "auto" items in the site_settings ticker strip so it always reflects
 * current numbers. Runs after publish and status-check steps.
 *
 * Auto items are identified by an `auto_key` field on the ticker item object.
 * If they don't exist yet in the DB, they are appended. Static items are untouched.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env" });
loadEnv({ path: ".env.local", override: true });

import { createClient } from "@supabase/supabase-js";

interface TickerItem {
  icon: string;
  text: string;
  href: string;
  active?: boolean;
  auto_key?: string;
}

const AUTO_ITEMS: TickerItem[] = [
  {
    auto_key: "scholarships_total",
    icon: "🎓",
    text: "245+ Scholarships Listed",
    href: "/scholarships",
    active: true,
  },
  {
    auto_key: "scholarships_open",
    icon: "✅",
    text: "27 Open Now",
    href: "/scholarships",
    active: true,
  },
  {
    auto_key: "scholarships_fully_funded",
    icon: "💰",
    text: "108 Fully Funded",
    href: "/scholarships",
    active: true,
  },
  {
    auto_key: "scholarships_countries",
    icon: "🌍",
    text: "50+ Countries Covered",
    href: "/scholarships/international",
    active: true,
  },
];

async function main() {
  const supaUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/^﻿/, "").trim();
  const supaKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").replace(/^﻿/, "").trim();
  if (!supaUrl || !supaKey) {
    console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const supabase = createClient(supaUrl, supaKey);

  // Query scholarship counts
  const { data: allRows } = await supabase
    .from("scholarships")
    .select("application_status, funding_type, country")
    .eq("status", "published")
    .eq("listed", true);

  if (!allRows) {
    console.error("Failed to fetch scholarship counts");
    process.exit(1);
  }

  const total = allRows.length;
  const openCount = allRows.filter((r) => r.application_status === "open").length;
  const fullyFunded = allRows.filter((r) => r.funding_type === "fully-funded").length;
  const countries = new Set(allRows.map((r) => r.country).filter(Boolean)).size;

  console.log(`Counts — total: ${total}, open: ${openCount}, fully funded: ${fullyFunded}, countries: ${countries}`);

  // Build updated auto item texts
  const updatedAutoItems: TickerItem[] = AUTO_ITEMS.map((item) => {
    switch (item.auto_key) {
      case "scholarships_total":
        return { ...item, text: `${total}+ Scholarships Listed` };
      case "scholarships_open":
        return { ...item, text: `${openCount} Open Now` };
      case "scholarships_fully_funded":
        return { ...item, text: `${fullyFunded} Fully Funded` };
      case "scholarships_countries":
        return { ...item, text: `${countries}+ Countries Covered` };
      default:
        return item;
    }
  });

  // Load current ticker items from DB
  const { data: settingRow } = await supabase
    .from("site_settings")
    .select("value")
    .eq("key", "ticker_items")
    .single();

  const current: TickerItem[] = Array.isArray(settingRow?.value) ? settingRow.value : [];

  // Merge: update existing auto items, append new ones, keep all static items
  const staticItems = current.filter((it) => !it.auto_key);
  const existingAutoKeys = new Set(current.filter((it) => it.auto_key).map((it) => it.auto_key));

  const mergedAutoItems = updatedAutoItems.map((updated) => {
    const existing = current.find((it) => it.auto_key === updated.auto_key);
    if (existing) {
      // Preserve active toggle from existing but update text
      return { ...updated, active: existing.active ?? true };
    }
    return updated;
  });

  // Keep order: static items first (as admin arranged them), then auto items
  // But if static items already exist alongside auto items, interleave by original position
  let merged: TickerItem[];
  if (current.length === 0) {
    // First time — put auto items at the front
    merged = [...mergedAutoItems, ...staticItems];
  } else {
    // Replace auto items in-place, append new ones at end
    const result: TickerItem[] = current.map((it) => {
      if (!it.auto_key) return it;
      const updated = updatedAutoItems.find((u) => u.auto_key === it.auto_key);
      return updated ? { ...updated, active: it.active ?? true } : it;
    });
    // Append any auto items that weren't in the list yet
    for (const auto of updatedAutoItems) {
      if (!existingAutoKeys.has(auto.auto_key)) {
        result.push(auto);
      }
    }
    merged = result;
  }

  // Save back
  const { error } = await supabase
    .from("site_settings")
    .upsert({ key: "ticker_items", value: merged }, { onConflict: "key" });

  if (error) {
    console.error("Failed to save ticker items:", error.message);
    process.exit(1);
  }

  console.log(`Ticker updated — ${merged.length} items (${mergedAutoItems.length} auto, ${staticItems.length} static).`);
  mergedAutoItems.forEach((it) => console.log(`  [auto] ${it.icon} ${it.text}`));
}

main();
