import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/^﻿/, "").trim(),
  (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").replace(/^﻿/, "").trim()
);

async function main() {
  const { data, error } = await sb.from("site_settings").select("value").eq("key", "ticker_items").single();
  if (error) { console.log("Error:", error.message); return; }
  const items = data?.value as { icon: string; text: string; active?: boolean; auto_key?: string }[];
  console.log(`Total items: ${items?.length}`);
  items?.forEach((it, i) => console.log(`  [${i + 1}] ${it.icon} "${it.text}" active=${it.active ?? true} auto=${it.auto_key ?? "-"}`));
}

main();
