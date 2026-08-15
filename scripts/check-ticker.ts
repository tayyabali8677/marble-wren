import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/^﻿/, "").trim(),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").replace(/^﻿/, "").trim()
);
const { data, error } = await sb.from("site_settings").select("*").eq("key", "ticker_items").single();
console.log("error:", error?.message ?? "none");
console.log("data:", JSON.stringify(data?.value, null, 2));
