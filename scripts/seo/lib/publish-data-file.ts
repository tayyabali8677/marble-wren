import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SITE_REPO = "tayyabali123/titans-abroad";
const SITE_BRANCH = process.env.SITE_BRANCH || "main";
const BOT_NAME = "tayyabali123";
const BOT_EMAIL = "muhammadtayyabali868@gmail.com";

export function isAllowed(file: string, allowedFiles: string[]): boolean {
  if (file.includes("..")) return false;
  return allowedFiles.includes(file);
}

export type ReplaceResult = { ok: true; text: string } | { ok: false; reason: "not found" | "not unique" };

export function applyExactReplace(src: string, find: string, replace: string): ReplaceResult {
  const occurrences = src.split(find).length - 1;
  if (occurrences === 0) return { ok: false, reason: "not found" };
  if (occurrences > 1) return { ok: false, reason: "not unique" };
  return { ok: true, text: src.replace(find, replace) };
}

export type DataFileEdit = {
  file: string;
  find: string;
  replace: string;
  description: string;
};

export type DataFilePublishResult = {
  applied: DataFileEdit[];
  skipped: Array<{ edit: DataFileEdit; reason: string }>;
  commitSha?: string;
  repoDir?: string;
  reason?: string;
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

export async function publishDataFileEdits(
  edits: DataFileEdit[],
  allowedFiles: string[],
  commitMessage: string
): Promise<DataFilePublishResult> {
  const empty: DataFilePublishResult = { applied: [], skipped: [] };

  if ((process.env.SEO_AUTOPUBLISH || "").toLowerCase() === "off") {
    return { ...empty, reason: "SEO_AUTOPUBLISH=off" };
  }
  const token = process.env.SITE_REPO_TOKEN;
  if (!token) {
    return { ...empty, reason: "SITE_REPO_TOKEN not set" };
  }
  if (edits.length === 0) {
    return { ...empty, reason: "nothing to publish" };
  }

  const applied: DataFileEdit[] = [];
  const skipped: Array<{ edit: DataFileEdit; reason: string }> = [];
  const disallowed = edits.filter((e) => !isAllowed(e.file, allowedFiles));
  for (const edit of disallowed) skipped.push({ edit, reason: "file not in allowlist" });
  const candidates = edits.filter((e) => isAllowed(e.file, allowedFiles));
  if (candidates.length === 0) {
    return { applied, skipped, reason: "no candidates passed the allowlist" };
  }

  const workdir = mkdtempSync(join(tmpdir(), "site-edit-"));
  const repoUrl = `https://x-access-token:${token}@github.com/${SITE_REPO}.git`;
  git(workdir, ["clone", "--depth", "1", "--branch", SITE_BRANCH, repoUrl, "site"]);
  const repo = join(workdir, "site");

  const changedFiles = new Set<string>();
  for (const edit of candidates) {
    const filePath = join(repo, edit.file);
    if (!existsSync(filePath)) {
      skipped.push({ edit, reason: "file does not exist in repo" });
      continue;
    }
    const src = readFileSync(filePath, "utf-8");
    const result = applyExactReplace(src, edit.find, edit.replace);
    if (!result.ok) {
      skipped.push({ edit, reason: result.reason });
      continue;
    }
    writeFileSync(filePath, result.text, "utf-8");
    changedFiles.add(edit.file);
    applied.push(edit);
  }

  if (applied.length === 0) {
    return { applied, skipped, reason: "no edits applied" };
  }

  git(repo, ["config", "user.name", BOT_NAME]);
  git(repo, ["config", "user.email", BOT_EMAIL]);
  git(repo, ["add", ...changedFiles]);
  git(repo, ["commit", "-m", commitMessage]);
  git(repo, ["push", "origin", SITE_BRANCH]);
  const commitSha = git(repo, ["rev-parse", "HEAD"]).trim();

  return { applied, skipped, commitSha, repoDir: repo };
}

export async function revertCommit(repoDir: string, commitSha: string): Promise<void> {
  git(repoDir, ["config", "user.name", BOT_NAME]);
  git(repoDir, ["config", "user.email", BOT_EMAIL]);
  git(repoDir, ["revert", "--no-edit", commitSha]);
  git(repoDir, ["push", "origin", SITE_BRANCH]);
}
