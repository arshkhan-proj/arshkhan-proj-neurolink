/**
 * Apply a unified diff to a working directory using git apply.
 *
 * Flow:
 *   1. Validate the diff string
 *   2. Extract file paths from the diff and check for security violations
 *   3. git init the workDir (so git apply works)
 *   4. git apply the diff (atomic — all hunks apply or none do)
 *   5. rm -rf .git (leave workDir as a plain directory)
 */

import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

const SENSITIVE_PATHS = [
  /^\.git(\/|$)/i,
  /(^|\/)\.env(\.|$|\/)/i,
  /(^|\/).*\.pem$/i,
  /(^|\/).*credentials(\.|$|\/)/i,
];

/**
 * Validate that a path from the diff doesn't escape workDir or touch sensitive files.
 * @param {string} workDir
 * @param {string} filePath
 */
function assertSafePath(workDir, filePath) {
  if (!filePath || typeof filePath !== "string") {
    throw new Error("Empty path in diff");
  }

  const normalized = filePath.replaceAll("\\", "/").trim();

  if (path.isAbsolute(normalized)) {
    throw new Error(`Absolute path not allowed: ${filePath}`);
  }

  const posix = path.posix.normalize(normalized);
  if (posix === ".." || posix.startsWith("../")) {
    throw new Error(`Path traversal not allowed: ${filePath}`);
  }

  if (SENSITIVE_PATHS.some((re) => re.test(posix))) {
    throw new Error(`Sensitive path not allowed: ${filePath}`);
  }

  const abs = path.resolve(workDir, posix);
  const rel = path.relative(workDir, abs);
  if (rel.startsWith("..")) {
    throw new Error(`Path escapes workDir: ${filePath}`);
  }
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

/**
 * Extract file paths from a unified diff.
 * Handles standard `--- a/file` / `+++ b/file` and `/dev/null` for new/deleted files.
 * @param {string} diff
 * @returns {string[]}
 */
function extractPaths(diff) {
  const paths = new Set();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+++ ") && !line.startsWith("--- ")) continue;

    const raw = line.slice(4).trim();
    if (!raw || raw === "/dev/null" || raw === "a/dev/null" || raw === "b/dev/null") {
      continue;
    }

    // Strip a/ or b/ prefix
    const stripped = raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
    // Strip optional timestamp after tab (some diff formats include it)
    const clean = stripped.split("\t")[0].replaceAll("\\", "/");
    if (clean) paths.add(clean);
  }
  return [...paths];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply a unified diff string to workDir.
 *
 * @param {string} workDir  Absolute path to the working directory
 * @param {string} diff     Unified diff content
 * @returns {Promise<{ paths: string[] }>}  List of affected file paths
 */
export async function applyDiff(workDir, diff) {
  if (!diff || typeof diff !== "string" || !diff.trim()) {
    throw new Error("diff must be a non-empty string");
  }

  // --- validate every path in the diff ---
  const paths = extractPaths(diff);
  for (const p of paths) {
    assertSafePath(workDir, p);
  }

  // --- write diff to temp file ---
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neurolink-diff-"));
  const diffFile = path.join(tmpDir, "changes.diff");
  await fs.writeFile(diffFile, diff, "utf8");

  try {
    // --- init git (needed for git apply, removed after) ---
    await execFile("git", ["init", "--quiet"], { cwd: workDir });

    // --- apply (atomic: all hunks or none) ---
    try {
      await execFile("git", ["apply", "--verbose", diffFile], { cwd: workDir });
    } catch (err) {
      const detail = err.stderr || err.message || "Unknown error";
      throw new Error(`diff apply failed: ${detail.trim()}`);
    }
  } finally {
    // --- clean up: remove .git so workDir stays a plain directory ---
    await fs.rm(path.join(workDir, ".git"), { recursive: true, force: true });
    // --- clean up temp diff file ---
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  return { paths };
}
