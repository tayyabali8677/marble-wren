/**
 * Agent 22: accessibility audit.
 *
 * Vitals (Agent 6) already covers performance; nothing covers whether a page
 * is usable by someone on a screen reader or keyboard. This checks the three
 * things a plain fetch can actually see: a missing lang attribute (a screen
 * reader mispronounces the whole page without one), images with no alt text
 * (WCAG 1.1.1, not just an SEO nicety), and link text that gives a screen
 * reader user tabbing through a link list nothing to go on ("click here",
 * "read more").
 *
 * True contrast-ratio, ARIA-role, and focus-order checks need a rendered DOM,
 * which this fetch-based crawl does not have. Those would need a headless
 * browser (axe-core via Playwright) and are out of scope here. H1 structure
 * is already covered by title-meta-audit, so it is not repeated.
 */

import { crawlSite, writeReport, toPath, decodeEntities, type CrawledPage } from "./crawl";

const MAX_REPORTED = 25;

const VAGUE_LINK_TEXT = new Set([
  "click here", "here", "read more", "more", "learn more", "this page",
  "link", "click", "more info", "more information", "details", "see more",
  "continue reading", "this", "go", "download",
]);

type ImageFinding = { path: string; src: string };
type LinkFinding = { path: string; text: string; href: string };

async function main() {
  const pages = (await crawlSite()).filter((p) => p.status === 200);

  const missingLang = pages.filter((p) => !p.lang);

  const missingAlt: ImageFinding[] = [];
  for (const page of pages) {
    for (const img of page.images) {
      if (img.alt === null) missingAlt.push({ path: toPath(page.url), src: img.src });
    }
  }

  const vagueLinks: LinkFinding[] = [];
  for (const page of pages) {
    for (const a of page.anchors) {
      const text = decodeEntities(a.text).replace(/\s+/g, " ").trim().toLowerCase();
      if (text && VAGUE_LINK_TEXT.has(text)) {
        vagueLinks.push({ path: toPath(page.url), text: decodeEntities(a.text).trim(), href: a.href });
      }
    }
  }

  const date = new Date().toISOString().split("T")[0];
  let report = `# Accessibility Audit: ${date}\n\n`;
  report += `**Pages checked:** ${pages.length}\n`;
  report += `**Missing an html lang attribute:** ${missingLang.length}\n`;
  report += `**Images with no alt attribute:** ${missingAlt.length}\n`;
  report += `**Links with vague text:** ${vagueLinks.length}\n\n`;

  report += `This covers what a plain fetch can see: the lang attribute, alt text, `;
  report += `and link wording. Contrast ratios, ARIA roles, and focus order need a `;
  report += `rendered page and are not checked here.\n\n`;

  if (missingLang.length) {
    report += `## Missing Html Lang Attribute (${missingLang.length})\n\n`;
    report += `Without this a screen reader guesses the page's language, and often guesses wrong, `;
    report += `which mispronounces every word on the page.\n\n`;
    report += `| Page |\n|---|\n`;
    for (const p of missingLang.slice(0, MAX_REPORTED)) report += `| ${toPath(p.url)} |\n`;
    if (missingLang.length > MAX_REPORTED) report += `\n*${missingLang.length - MAX_REPORTED} more.*\n`;
    report += `\n`;
  }

  if (missingAlt.length) {
    report += `## Images With No Alt Attribute (${missingAlt.length})\n\n`;
    report += `A missing attribute is an oversight, unlike an empty alt="" which deliberately marks an `;
    report += `image as decorative. A screen reader reads the filename aloud instead.\n\n`;
    report += `| Page | Image |\n|---|---|\n`;
    for (const f of missingAlt.slice(0, MAX_REPORTED)) {
      const filename = f.src.split("/").pop()?.slice(0, 60) || f.src;
      // URLs are percent-encoded for `(`/`)` so they don't break the markdown-link syntax
      // the report is parsed with; decode before using for exact-string matching against
      // source files. Brackets in the filename are encoded too so the link text can't
      // prematurely close the `[...]` span.
      const safeHref = f.src.replace(/\(/g, "%28").replace(/\)/g, "%29");
      const safeFilename = filename.replace(/\[/g, "%5B").replace(/\]/g, "%5D");
      report += `| ${f.path} | [${safeFilename}](${safeHref}) |\n`;
    }
    if (missingAlt.length > MAX_REPORTED) report += `\n*${missingAlt.length - MAX_REPORTED} more.*\n`;
    report += `\n`;
  }

  if (vagueLinks.length) {
    report += `## Links With Vague Text (${vagueLinks.length})\n\n`;
    report += `A screen reader user often tabs through a page's links in a list, out of context. `;
    report += `"Click here" tells them nothing there; the link text should say where it goes.\n\n`;
    report += `| Page | Text | Destination |\n|---|---|---|\n`;
    for (const f of vagueLinks.slice(0, MAX_REPORTED)) {
      report += `| ${f.path} | "${f.text.slice(0, 40)}" | ${toPath(f.href)} |\n`;
    }
    if (vagueLinks.length > MAX_REPORTED) report += `\n*${vagueLinks.length - MAX_REPORTED} more.*\n`;
    report += `\n`;
  }

  if (!missingLang.length && !missingAlt.length && !vagueLinks.length) {
    report += `Every page declares a language, every image has an alt attribute, and no link text `;
    report += `matched a known vague phrase.\n\n`;
  }

  report += `---\n\n`;
  writeReport("accessibility-audit", report);
  console.log(
    `No lang: ${missingLang.length} | No alt: ${missingAlt.length} | Vague links: ${vagueLinks.length}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
