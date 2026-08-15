// Keyword cannibalization: two or more of our own pages competing for the same
// query. Google has to pick one, and the split signal usually costs us both.

export type QueryPageRow = {
  keys?: string[] | null;
  clicks?: number | null;
  impressions?: number | null;
  position?: number | null;
};

export type Competitor = {
  page: string;
  clicks: number;
  impressions: number;
  position: number;
};

export type Conflict = {
  query: string;
  totalImpressions: number;
  primary: Competitor;
  others: Competitor[];
};

// A page needs this many impressions on a query before we call it a genuine
// competitor rather than incidental noise.
const MIN_IMPRESSIONS_PER_PAGE = 3;
// Below this the second page is not really competing, just occasionally shown.
const MIN_SHARE = 0.15;

export type ConflictScan = {
  conflicts: Conflict[];
  // Queries served by more than one page before any threshold is applied.
  // Kept so a zero result can be told apart from a broken detector.
  multiPageQueries: number;
};

export function scanConflicts(rows: QueryPageRow[]): ConflictScan {
  const pagesPerQuery = new Map<string, Set<string>>();
  for (const row of rows) {
    const query = row.keys?.[0];
    const page = row.keys?.[1];
    if (!query || !page) continue;
    const set = pagesPerQuery.get(query) ?? new Set<string>();
    set.add(page);
    pagesPerQuery.set(query, set);
  }
  const multiPageQueries = [...pagesPerQuery.values()].filter((s) => s.size > 1).length;

  return { conflicts: findConflicts(rows), multiPageQueries };
}

export function findConflicts(rows: QueryPageRow[]): Conflict[] {
  const byQuery = new Map<string, Competitor[]>();

  for (const row of rows) {
    const query = row.keys?.[0];
    const page = row.keys?.[1];
    if (!query || !page) continue;

    const impressions = row.impressions ?? 0;
    if (impressions < MIN_IMPRESSIONS_PER_PAGE) continue;

    const list = byQuery.get(query) ?? [];
    list.push({
      page,
      clicks: row.clicks ?? 0,
      impressions,
      position: row.position ?? 0,
    });
    byQuery.set(query, list);
  }

  const conflicts: Conflict[] = [];

  for (const [query, pages] of byQuery) {
    if (pages.length < 2) continue;

    const totalImpressions = pages.reduce((s, p) => s + p.impressions, 0);

    // Keep only pages holding a meaningful share of the query's impressions.
    const contenders = pages.filter((p) => p.impressions / totalImpressions >= MIN_SHARE);
    if (contenders.length < 2) continue;

    // The page to consolidate onto: most clicks wins, best average position
    // breaks the tie. Clicks first because a page that already converts the
    // query is the one Google and searchers both agree on.
    const ranked = [...contenders].sort((a, b) => {
      if (b.clicks !== a.clicks) return b.clicks - a.clicks;
      return a.position - b.position;
    });

    conflicts.push({
      query,
      totalImpressions,
      primary: ranked[0],
      others: ranked.slice(1),
    });
  }

  return conflicts.sort((a, b) => b.totalImpressions - a.totalImpressions);
}

export function renderConflicts(scan: ConflictScan): string {
  const { conflicts, multiPageQueries } = scan;

  if (conflicts.length === 0) {
    let out = `## Keyword Cannibalization\n\nNo conflicts found. `;
    out += `${multiPageQueries} ${multiPageQueries === 1 ? "query is" : "queries are"} served by more than one page, `;
    out += `but none has a second page holding at least ${Math.round(MIN_SHARE * 100)}% of the impressions `;
    out += `with ${MIN_IMPRESSIONS_PER_PAGE}+ of its own.\n\n---\n\n`;
    return out;
  }

  let out = `## Keyword Cannibalization (${conflicts.length})\n\n`;
  out += `Out of ${multiPageQueries} queries served by more than one page, these are genuine contests.\n\n`;
  out += `Queries where more than one of our pages is competing. Pick the primary page, then point an internal `;
  out += `link at it from each of the others using the query itself as the anchor text.\n\n`;

  for (const c of conflicts.slice(0, 20)) {
    out += `### "${c.query}"\n\n`;
    out += `**Total impressions:** ${c.totalImpressions} across ${c.others.length + 1} pages\n\n`;
    out += `| Role | Page | Position | Impressions | Clicks |\n`;
    out += `|------|------|----------|-------------|--------|\n`;
    out += `| Primary | ${c.primary.page} | ${c.primary.position.toFixed(1)} | ${c.primary.impressions} | ${c.primary.clicks} |\n`;
    for (const o of c.others) {
      out += `| Link to primary | ${o.page} | ${o.position.toFixed(1)} | ${o.impressions} | ${o.clicks} |\n`;
    }
    out += `\n**Action:** add an internal link from ${c.others.length === 1 ? "the page" : "each page"} above to `;
    out += `${c.primary.page} with anchor text "${c.query}".\n\n`;
  }

  out += `---\n\n`;
  return out;
}
