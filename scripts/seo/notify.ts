/**
 * Nightly digest delivery.
 *
 * Opens a GitHub issue with the night's findings and assigns it to the repo
 * owner, which means GitHub emails it out. That is deliberate: it needs no new
 * credential, no SMTP server, and no bot token, so there is nothing extra to
 * keep alive. If TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set it also sends
 * a short Telegram message.
 *
 * The digest carries only what needs a decision. Full detail stays in the
 * committed report.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const REPO = process.env.GITHUB_REPOSITORY || "tayyabali123/marble-wren";
const OWNER = REPO.split("/")[0];

type Section = { title: string; body: string; needsDecision: boolean };

function readReport(name: string): string | null {
  const path = join(process.cwd(), "reports", name);
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

/** Pulls a "## Heading" block out of a report. */
function section(report: string | null, heading: string): string | null {
  if (!report) return null;
  const start = report.indexOf(`## ${heading}`);
  if (start === -1) return null;
  const rest = report.slice(start);
  const next = rest.indexOf("\n## ", 3);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/**
 * Keeps a section readable in an email. A 289-row table is a report, not a
 * digest, so long sections are cut off with a pointer to the full file.
 */
function clamp(text: string, maxLines = 18): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const dropped = lines.length - maxLines;
  return `${lines.slice(0, maxLines).join("\n")}\n\n*${dropped} more rows in the full report.*`;
}

function countAfter(text: string | null, pattern: RegExp): number {
  const m = text?.match(pattern);
  return m ? parseInt(m[1], 10) : 0;
}

async function createIssue(title: string, body: string): Promise<string | null> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn("GITHUB_TOKEN not set, skipping issue creation.");
    return null;
  }

  const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, body, assignees: [OWNER], labels: ["seo-digest"] }),
  });

  if (!res.ok) {
    console.error(`Issue creation failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return null;
  }

  const issue = (await res.json()) as any;
  console.log(`Opened issue #${issue.number}: ${issue.html_url}`);
  return issue.html_url;
}

async function sendTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true }),
  });

  if (!res.ok) console.error(`Telegram send failed: ${res.status}`);
  else console.log("Telegram digest sent.");
}

async function main() {
  const date = new Date().toISOString().split("T")[0];

  const gap = readReport(`seo-gap-${date}.md`);
  const zeroClick = readReport(`zero-click-${date}.md`);
  const indexing = readReport(`indexing-${date}.md`);
  const linkHealth = readReport(`link-health-${date}.md`);
  const thinContent = readReport(`thin-content-${date}.md`);
  const schema = readReport(`schema-audit-${date}.md`);
  const vitals = readReport(`vitals-${date}.md`);
  const ctr = readReport(`ctr-outliers-${date}.md`);

  const all = [gap, zeroClick, indexing, linkHealth, thinContent, schema, vitals, ctr];
  if (all.every((r) => !r)) {
    console.log("No reports for today, nothing to send.");
    return;
  }

  const sections: Section[] = [];

  const published = section(gap, "Auto-Published");
  if (published) {
    sections.push({
      title: "Published overnight",
      body: published,
      needsDecision: published.includes("held back"),
    });
  }

  const conflicts = section(gap, "Keyword Cannibalization");
  if (conflicts && !conflicts.includes("No conflicts found")) {
    sections.push({ title: "Cannibalization", body: conflicts, needsDecision: true });
  }

  const notIndexed = section(indexing, "Not Indexed");
  if (notIndexed) {
    sections.push({ title: "Not indexed", body: notIndexed, needsDecision: true });
  }

  const underperforming = section(zeroClick, "Underperforming");
  if (underperforming) {
    sections.push({ title: "Zero clicks despite impressions", body: underperforming, needsDecision: true });
  }

  const noData = section(zeroClick, "No Search Console Data");
  if (noData) {
    sections.push({ title: "Never appeared in search", body: noData, needsDecision: true });
  }

  // Anything below is only present when the agent actually found something, so
  // a quiet night produces a short digest rather than a wall of "0 found".
  const dead = section(linkHealth, "Pages Not Returning 200");
  if (dead) sections.push({ title: "Dead pages", body: dead, needsDecision: true });

  const redirects = section(linkHealth, "Sitemap URLs That Redirect");
  if (redirects) sections.push({ title: "Sitemap redirects", body: redirects, needsDecision: true });

  const brokenLinks = section(linkHealth, "Broken Internal Links");
  if (brokenLinks) sections.push({ title: "Broken links", body: brokenLinks, needsDecision: true });

  const placeholder = section(thinContent, "Placeholder Text Live");
  if (placeholder) sections.push({ title: "Placeholder text live", body: placeholder, needsDecision: true });

  const thin = section(thinContent, "Thin Pages");
  if (thin) sections.push({ title: "Thin pages", body: thin, needsDecision: false });

  const brokenSchema = section(schema, "Broken JSON-LD");
  if (brokenSchema) sections.push({ title: "Broken structured data", body: brokenSchema, needsDecision: true });

  const incompleteSchema = section(schema, "Missing Required Properties");
  if (incompleteSchema) {
    sections.push({ title: "Incomplete structured data", body: incompleteSchema, needsDecision: true });
  }

  const poorVitals = section(vitals, "Poor Metrics");
  if (poorVitals) sections.push({ title: "Core Web Vitals", body: poorVitals, needsDecision: true });

  // The CTR report has one heading per page, so there is no single section to
  // lift. The count from the header is enough for a digest.
  const outliers = countAfter(ctr, /\*\*Underperforming:\*\* (\d+)/);
  if (outliers > 0) {
    sections.push({
      title: "CTR outliers",
      body: `## CTR outliers\n\n${outliers} first-page queries earn far fewer clicks than their position normally does. Title and description rewrites are listed per page in the full report.`,
      needsDecision: true,
    });
  }

  const decisions = sections.filter((s) => s.needsDecision).length;

  let body = `Nightly SEO run for ${date}.\n\n`;
  body += decisions === 0
    ? `Nothing needs your decision today.\n\n`
    : `**${decisions} ${decisions === 1 ? "item needs" : "items need"} your decision.**\n\n`;

  for (const s of sections) {
    body += `${clamp(s.body)}\n\n`;
  }

  body += `---\n\nFull reports: [\`reports/\`](https://github.com/${REPO}/tree/master/reports)\n`;

  const title = decisions === 0
    ? `SEO digest ${date}: all clear`
    : `SEO digest ${date}: ${decisions} ${decisions === 1 ? "decision" : "decisions"} needed`;

  const url = await createIssue(title, body);

  const summary = [
    `*SEO digest ${date}*`,
    decisions === 0 ? "Nothing needs your decision." : `${decisions} items need your decision.`,
    countAfter(published, /Pushed \*\*(\d+)\*\*/) > 0 ? `Published ${countAfter(published, /Pushed \*\*(\d+)\*\*/)} FAQ answers.` : "",
    url ? url : "",
  ].filter(Boolean).join("\n");

  await sendTelegram(summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
