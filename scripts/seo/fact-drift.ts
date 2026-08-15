/**
 * Agent 12: fact drift.
 *
 * Every other agent asks whether a page ranks. This one asks whether it is
 * telling the truth, which for a site advising people on medical degrees is the
 * more serious question. It exists because three real defects shipped: a fee
 * range that understated the top of the actual range by half, a claim that only
 * MOE-listed universities hold PMDC recognition when the site's own data says
 * otherwise, and a template token that reached production telling readers to
 * check a list at "__PMDC/PMC_URL__".
 *
 * It works from the crawl, not the source, so it compares the site against
 * itself: the same number stated two ways on two pages, or a summary claim that
 * disagrees with the detail pages underneath it. That makes it heuristic. It
 * finds contradictions, not falsehoods, and a contradiction still needs a human
 * to decide which side is wrong.
 */

import { crawlSite, writeReport, toPath, type CrawledPage } from "./crawl";

/** Anything here reaching production means a template was never filled in. */
const PLACEHOLDER_PATTERNS: Array<[string, RegExp]> = [
  ["Unsubstituted token", /__[A-Z][A-Z0-9_/]*__/g],
  ["Unrendered variable", /\{\{\s*[a-zA-Z_.]+\s*\}\}/g],
  ["Editorial marker", /\b(?:TODO|TBD|FIXME|XXX)\b/g],
  ["Filler text", /\blorem ipsum\b/gi],
  ["Unfilled bracket", /\[(?:insert|your|add)\s[^\]]{2,40}\]/gi],
];

/**
 * Claims that should agree with themselves everywhere they appear. Each capture
 * group is the number; the label groups them.
 *
 * A bare "N universities in China" is deliberately not here. It matches
 * "ranked among the top 27 universities in China" just as happily as a count of
 * our own, and a check that cries wolf gets ignored along with the real ones.
 * Only phrasings that cannot be a ranking are listed.
 */
const COUNT_CLAIMS: Array<[string, RegExp]> = [
  ["MOE-listed universities", /(\d{1,3})\s+MOE[- ]listed universities/gi],
  ["PMDC/PMC approved universities", /(\d{1,3})\s+PMDC(?:\/PMC)?[- ]approved universities/gi],
];

/** Country sections, so a summary range can be checked against its own pages. */
const COUNTRIES: Array<[string, string]> = [
  ["China", "/mbbs-in-china/"],
  ["Russia", "/mbbs-in-russia/"],
  ["Georgia", "/mbbs-in-georgia/"],
];

// How close a country name has to sit to a figure before the figure is treated
// as being about that country.
const PROXIMITY = 200;

// A dollar figure counts as an annual fee only when "year" is nearby, which
// keeps one-off charges and six-year totals out of the range.
const ANNUAL_FEE = /\$\s?(\d{1,3}(?:,\d{3})+|\d{4,6})(?=[^$]{0,40}?(?:per year|a year|\/\s?yr|annual))/gi;
const RANGE_CLAIM = /\$\s?(\d{1,3}(?:,\d{3})+|\d{4,6})\s*(?:-|to|–)\s*\$\s?(\d{1,3}(?:,\d{3})+|\d{4,6})\s*(?:\/\s?yr|per year|a year|annual)/gi;

const money = (n: number) => `$${n.toLocaleString("en-US")}`;
const num = (s: string) => parseInt(s.replace(/,/g, ""), 10);

function findAll(text: string, re: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  const local = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (let m = local.exec(text); m; m = local.exec(text)) out.push(m);
  return out;
}

function context(text: string, index: number, length: number): string {
  const snippet = text.slice(Math.max(0, index - 60), index + length + 60).replace(/\s+/g, " ").trim();
  return snippet.length > 160 ? `${snippet.slice(0, 160)}...` : snippet;
}

async function main() {
  const pages = (await crawlSite()).filter((p) => p.status === 200);

  // 1. Template leftovers.
  const placeholders: Array<{ path: string; label: string; found: string; snippet: string }> = [];
  for (const page of pages) {
    for (const [label, re] of PLACEHOLDER_PATTERNS) {
      for (const m of findAll(page.text, re)) {
        placeholders.push({
          path: toPath(page.url),
          label,
          found: m[0],
          snippet: context(page.text, m.index, m[0].length),
        });
      }
    }
  }

  // 2. The same count stated differently in different places.
  const counts = new Map<string, Map<number, string[]>>();
  for (const page of pages) {
    for (const [label, re] of COUNT_CLAIMS) {
      for (const m of findAll(page.text, re)) {
        const value = num(m[1]);
        const byValue = counts.get(label) ?? new Map<number, string[]>();
        const paths = byValue.get(value) ?? [];
        if (!paths.includes(toPath(page.url))) paths.push(toPath(page.url));
        byValue.set(value, paths);
        counts.set(label, byValue);
      }
    }
  }
  const contradictions = [...counts].filter(([, byValue]) => byValue.size > 1);

  // 3. Summary fee ranges against the detail pages they summarise.
  type RangeFinding = {
    country: string;
    path: string;
    claimed: [number, number];
    observed: [number, number];
    sampled: number;
  };
  const rangeFindings: RangeFinding[] = [];

  for (const [country, prefix] of COUNTRIES) {
    const detailPages = pages.filter((p) => toPath(p.url).startsWith(prefix) && toPath(p.url) !== prefix);
    const fees = detailPages.flatMap((p) => findAll(p.text, ANNUAL_FEE).map((m) => num(m[1])))
      .filter((n) => n >= 500 && n <= 100000);
    if (fees.length < 3) continue;

    const observed: [number, number] = [Math.min(...fees), Math.max(...fees)];

    for (const page of pages) {
      for (const m of findAll(page.text, RANGE_CLAIM)) {
        // The page mentioning a country is not enough. The homepage names all
        // of them, so attributing every range on it to each in turn compares
        // China's fees against Georgia's. Only the country named beside the
        // figure counts, and if more than one is nearby the claim is ambiguous
        // and gets skipped rather than guessed at.
        const nearby = page.text.slice(Math.max(0, m.index - PROXIMITY), m.index + m[0].length + PROXIMITY);
        const named = COUNTRIES.filter(([c]) => nearby.includes(c)).map(([c]) => c);
        if (named.length !== 1 || named[0] !== country) continue;

        const claimed: [number, number] = [num(m[1]), num(m[2])];
        // Only flag a claim that is narrower than reality. A range wider than
        // what we publish is cautious, not wrong.
        const understatesTop = claimed[1] < observed[1] * 0.9;
        const overstatesFloor = claimed[0] > observed[0] * 1.1;
        if (understatesTop || overstatesFloor) {
          rangeFindings.push({ country, path: toPath(page.url), claimed, observed, sampled: fees.length });
        }
      }
    }
  }

  const date = new Date().toISOString().split("T")[0];
  const total = placeholders.length + contradictions.length + rangeFindings.length;

  let report = `# Fact Drift: ${date}\n\n`;
  report += `**Pages checked:** ${pages.length}\n`;
  report += `**Template leftovers:** ${placeholders.length}\n`;
  report += `**Contradicting counts:** ${contradictions.length}\n`;
  report += `**Fee ranges disagreeing with their own detail pages:** ${rangeFindings.length}\n\n`;

  if (total === 0) {
    report += `The site does not contradict itself on anything this agent knows how to check. `;
    report += `That is not the same as being correct, only consistent.\n\n---\n\n`;
    writeReport("fact-drift", report);
    console.log("No drift found.");
    return;
  }

  if (placeholders.length > 0) {
    report += `## Template Leftovers Live (${placeholders.length})\n\n`;
    report += `Unfilled template text reached production. Readers see it verbatim.\n\n`;
    for (const p of placeholders.slice(0, 30)) {
      report += `- **${p.path}** \`${p.found}\` (${p.label})\n`;
      report += `  > ${p.snippet}\n`;
    }
    report += `\n`;
  }

  if (contradictions.length > 0) {
    report += `## Contradicting Counts (${contradictions.length})\n\n`;
    report += `The same fact stated with different numbers on different pages. One of them is wrong.\n\n`;
    for (const [label, byValue] of contradictions) {
      report += `### ${label}\n\n`;
      for (const [value, paths] of [...byValue].sort((a, b) => b[1].length - a[1].length)) {
        report += `- **${value}** on ${paths.length} ${paths.length === 1 ? "page" : "pages"}: ${paths.slice(0, 6).join(", ")}`;
        report += paths.length > 6 ? ` and ${paths.length - 6} more\n` : `\n`;
      }
      report += `\n`;
    }
  }

  if (rangeFindings.length > 0) {
    report += `## Fee Ranges Narrower Than Reality (${rangeFindings.length})\n\n`;
    report += `A summary range that does not cover the fees on the pages beneath it. Someone `;
    report += `budgeting from the summary will be short.\n\n`;
    report += `| Page | Country | Claimed | Actually spans | Fees sampled |\n|---|---|---|---|---|\n`;
    for (const f of rangeFindings.slice(0, 20)) {
      report += `| ${f.path} | ${f.country} | ${money(f.claimed[0])} to ${money(f.claimed[1])} | `;
      report += `${money(f.observed[0])} to ${money(f.observed[1])} | ${f.sampled} |\n`;
    }
    report += `\n`;
  }

  report += `---\n\n`;
  writeReport("fact-drift", report);
  console.log(`Placeholders: ${placeholders.length} | Contradictions: ${contradictions.length} | Fee ranges: ${rangeFindings.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
