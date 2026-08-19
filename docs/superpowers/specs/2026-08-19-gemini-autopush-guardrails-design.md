# Gemini Auto-Push Guardrails — Design

**Date:** 2026-08-19
**Status:** Approved, ready for implementation planning

## Problem

The nightly SEO pipeline (`scripts/seo/notify.ts`) opens a "SEO digest: N decisions needed" GitHub issue every morning, listing ~30 categories of diagnostic findings. Every one of them today requires manual review, even the mechanical, low-judgment ones (duplicate titles, missing alt text, sitemap entries pointing at the wrong URL).

One category already has an autonomous path: `seo-gap-agent.ts` drafts FAQ answers with Gemini and auto-commits them straight to `titans-abroad` via `publish-site.ts`, gated by a regex-based risky-claim filter, an entity blocklist, and per-run caps (`MAX_FAQS_PER_RUN=10`, `MAX_LINKS_PER_RUN=20`).

This design extends that same pattern — Gemini drafts, a guardrail decides, a direct commit ships it — to three more categories, chosen because they're either purely mechanical (no factual judgment) or because a workable verification gate exists for them.

## Categories in scope

### 1. Mechanical fixes (titles, meta descriptions, alt text)

**Scope is narrower than "duplicate titles/alt text" in general.** A codebase check (2026-08-19) found:

- Scholarship, university, and blog **detail pages** (`app/scholarships/[slug]/page.tsx`, `app/mbbs-in-china/moe-listed/[slug]/page.tsx`, etc.) pull title/meta from `generateMetadata()` reading a single field (`seoTitle`/`seoDescription`) off a central data array (`data/scholarships/*.ts`, `data/universities/*.ts`). Photo alt text on these same pages comes from a `photos[].alt` field in the same arrays. **These are in scope** — a fix is a single field edit in one existing data file.
- ~36 static hub/category pages (`app/about/page.tsx`, `app/mbbs-in-russia/page.tsx`, etc.) hardcode `export const metadata = {...}` directly in the page file. **Out of scope** — fixing these means editing arbitrary `.tsx` source, a fundamentally different (and riskier) kind of change than a data-array edit.
- Canonical tags don't exist anywhere in the codebase (`alternates: { canonical: ... }` — zero matches). **Out of scope for the recurring agent.** This needs a one-time, human-built implementation (a shared metadata helper called from each page), not a nightly auto-fix, since there's no existing pattern to slot a generated value into.
- Logo/component alt text is hardcoded in components (`Logo.tsx`, `ReviewCard.tsx`, etc.), and image width/height isn't stored in the data layer at all. **Out of scope** — both require arbitrary component/JSX edits.
- `<html lang="en">` in `app/layout.tsx` is a single static, always-correct line. Not an actual open issue; no agent needed.

### 2. Fee-range / contradicting-number corrections

Corrects claims like "Georgia scholarships: $2,000–$8,000" when the real range (per GSC/crawl data) is wider. High risk because a wrong correction is a false factual claim on a real page, not just cosmetic.

**Gate:** a new fetch/scrape step searches for the scholarship/university's official source pages and extracts the fee figure. The correction is only applied if the **same value appears on 2+ independent sources**. If only one source is found, or sources disagree, the finding is held back and reported instead — same fallback behavior as the existing risky-claim filter.

### 3. Sitemap entry corrections

Corrects sitemap entries pointing at a URL that doesn't match the live page (e.g. `/success-stories` listed but the page now serves at `/student-reviews`).

**Scope is deliberately narrow:** only the sitemap generator/data is edited to point at the correct, live URL. The agent never touches `next.config.js` redirects, route files, or page structure — it changes what search engines are told, not the site's actual routing behavior.

## Architecture

Three new standalone scripts, each mirroring the existing `seo-gap-agent.ts` shape — no shared orchestrator, consistent with how the other ~25 diagnostic agents are structured as independent workflow steps:

- `scripts/seo/mechanical-fix-agent.ts`
- `scripts/seo/fee-verify-agent.ts`
- `scripts/seo/sitemap-fix-agent.ts`

Each runs as its own step in `.github/workflows/seo-nightly.yml`, after its corresponding diagnostic agent (title-meta-audit, fact-drift, canonical-audit respectively), and follows the same flow:

1. Read today's diagnostic report for its category.
2. For each candidate finding, run the category's guardrail check.
3. If it passes, call Gemini to draft the fix (reusing the existing `callGemini()` JSON-mode helper from `seo-gap-agent.ts`, extracted into a shared module if not already reusable).
4. If it passes, commit directly via `publishToSite()` (extended to accept new target files: `data/scholarships/*.ts`, `data/universities/*.ts`, `data/blog/*.ts`, `data/sitemap-entries.ts` or equivalent).
5. Log the outcome (pushed / held-back-with-reason / reverted) for the digest.

## Guardrails

- **Master kill switch:** `SEO_AUTOPUBLISH` (existing, unchanged) — off disables all auto-push, including these new categories.
- **Per-category flags**, each defaulting to **off**: `SEO_AUTOPUSH_MECHANICAL`, `SEO_AUTOPUSH_FEECHECK`, `SEO_AUTOPUSH_SITEMAP`. Turned on individually once trusted.
- **Per-run caps**, matching the existing style: `MAX_MECHANICAL_FIXES_PER_RUN=10`, `MAX_FEE_FIXES_PER_RUN=10`, `MAX_SITEMAP_FIXES_PER_RUN=20`.
- **Fee corrections additionally require** the 2-independent-source agreement check described above.
- **Mechanical and sitemap fixes** never write outside their designated data files — the agent scripts take an explicit allowlist of writable file paths, not a general "edit the repo" capability.

## Post-push verification and rollback

After each commit lands on `main` (which triggers a Vercel deploy):

1. Poll until the new deploy is live (or timeout after N minutes).
2. Fetch the changed URL(s) and confirm a 200 status.
3. Confirm the expected new value (title, alt text, fee figure, sitemap target) actually appears in the rendered HTML.
4. If either check fails, commit a revert of the fix and mark it in the digest as "auto-pushed then reverted" rather than leaving a wrong or broken page live.

## Digest reporting

`notify.ts` gains a new top section, "Auto-pushed overnight," listing each fix that was committed, its category, and how it was verified (mirrors the existing "Published overnight" FAQ section).

Findings held back by a guardrail (single-source fee claim, out-of-scope static page, disagreement between sources) continue to appear in their existing decision sections, now annotated with the specific reason they weren't auto-pushed (e.g. "only 1 source found, needs 2").

## Explicitly out of scope (for this design)

- Static hub-page title/meta fixes (requires arbitrary `.tsx` edits)
- Canonical tag implementation (new infrastructure, one-time build task)
- Logo/component alt text, image width/height (arbitrary component edits)
- Any category not listed above (Core Web Vitals, backlinks, competitors, etc. — not content fixes, nothing to push)
- PR-based review flow — this design is direct-commit-only per explicit decision; no PR gate for any category, including fee corrections
