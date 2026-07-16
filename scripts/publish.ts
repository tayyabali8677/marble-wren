import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env" });
loadEnv({ path: ".env.local", override: true });

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

type ScholarshipStatus = "open" | "closed" | "upcoming" | "to-be-confirmed";
type FundingType = "fully-funded" | "partial" | "varies";

interface Scholarship {
  slug: string;
  name: string;
  country: string;
  flag?: string;
  type: "international" | "national";
  fundingType: FundingType;
  status: ScholarshipStatus;
  featured?: boolean;
  description: string;
  overview: string[];
  officialWebsite: string;
  seoTitle: string;
  seoDescription: string;
  [key: string]: unknown;
}

const REQUIRED_FIELDS: (keyof Scholarship)[] = [
  "slug", "name", "country", "type", "fundingType", "provider",
  "description", "overview", "officialWebsite", "seoTitle", "seoDescription",
];

function validate(s: Partial<Scholarship>, index: number): string[] {
  return REQUIRED_FIELDS
    .filter((f) => {
      const v = s[f];
      return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
    })
    .map((f) => `entry[${index}] (slug=${s.slug ?? "?"}): missing required field "${f}"`);
}

function toAppStatus(status: ScholarshipStatus): "open" | "closed" | "upcoming" | "unknown" {
  return status === "to-be-confirmed" ? "unknown" : status;
}

function toRow(s: Scholarship, listed: boolean) {
  const { slug, name, country, flag, type, fundingType, status, featured, ...rest } = s;
  const appStatus = toAppStatus(status);
  return {
    slug,
    name,
    country,
    flag: flag ?? "",
    type,
    funding_type: fundingType,
    application_status: appStatus,
    featured: featured ?? false,
    status: "published" as const,
    listed,
    data: { ...rest, applicationStatus: appStatus },
  };
}

async function main() {
  const [, , batchPath, ...flags] = process.argv;
  const dryRun = flags.includes("--dry-run");
  const unlisted = flags.includes("--unlisted");

  if (!batchPath) {
    console.error("Usage: npx tsx scripts/publish.ts <batch.json> [--dry-run] [--unlisted]");
    process.exit(1);
  }

  const entries: Scholarship[] = JSON.parse(readFileSync(batchPath, "utf-8"));
  const allErrors = entries.flatMap((s, i) => validate(s, i));
  if (allErrors.length) {
    console.error("Validation failed:");
    allErrors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }

  const rows = entries.map((s) => toRow(s, !unlisted));
  console.log(`Loaded ${rows.length} scholarship(s) from ${batchPath}:`);
  rows.forEach((r) => console.log(`  - ${r.slug}  (${r.country}, listed=${r.listed})`));

  if (dryRun) {
    console.log("\n--dry-run set — no writes made.");
    return;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in environment.");
    process.exit(1);
  }

  const supabase = createClient(url, key);
  const { data, error } = await supabase
    .from("scholarships")
    .upsert(rows, { onConflict: "slug" })
    .select("slug");

  if (error) {
    console.error("Supabase upsert failed:", error.message);
    process.exit(1);
  }

  console.log(`\nPublished ${data?.length ?? 0} scholarship(s) (listed=${!unlisted}).`);
}

main();
