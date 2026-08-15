import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/^﻿/, "").trim(),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").replace(/^﻿/, "").trim()
);

async function main() {
  // Test anon read
  const anonSb = createClient(
    (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/^﻿/, "").trim(),
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").replace(/^﻿/, "").trim()
  );

  const { data, error } = await anonSb
    .from("site_settings")
    .select("value")
    .eq("key", "ticker_items")
    .single();

  console.log("Anon read result:", error?.message ?? "success");
  console.log("Data:", data ? `${JSON.stringify(data).slice(0, 100)}...` : "null");

  if (error) {
    console.log("\nAnon read is blocked. Adding SELECT policy...");
    const { error: policyErr } = await sb.rpc("exec_sql", {
      sql: `
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE tablename = 'site_settings' AND policyname = 'anon_read_site_settings'
          ) THEN
            CREATE POLICY anon_read_site_settings ON site_settings
              FOR SELECT TO anon USING (true);
          END IF;
        END $$;
      `
    });
    if (policyErr) {
      console.log("RPC failed:", policyErr.message);
      console.log("Try adding this policy manually in Supabase dashboard:");
      console.log("  Table: site_settings");
      console.log("  Operation: SELECT");
      console.log("  Role: anon");
      console.log("  USING: true");
    } else {
      console.log("Policy added.");
    }
  }
}

main();
