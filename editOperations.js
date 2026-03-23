import { exec as execCb } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCb);

const SENSITIVE_PATH_REGEXES = [
  /^\.git(\/|$)/i,
  /(^|\/)\.env(\.|$|\/)/i,
  /(^|\/).*\.pem$/i,
  /(^|\/).*credentials(\.|$|\/)/i,
];

/**
 * @param {string} workDir
 * @param {string} relativePath
 * @returns {{ absolutePath: string; normalizedPath: string }}
 */
function resolveSafePath(workDir, relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    throw new Error("path must be a non-empty string");
  }

  const unixPath = relativePath.replaceAll("\\", "/").trim();
  if (path.isAbsolute(unixPath)) {
    throw new Error(`Absolute paths are not allowed: ${relativePath}`);
  }

  const normalizedPath = path.posix.normalize(unixPath);
  if (
    normalizedPath === ".." ||
    normalizedPath.startsWith("../") ||
    normalizedPath.includes("/../")
  ) {
    throw new Error(`Path traversal is not allowed: ${relativePath}`);
  }

  if (SENSITIVE_PATH_REGEXES.some((re) => re.test(normalizedPath))) {
    throw new Error(`Editing sensitive path is not allowed: ${relativePath}`);
  }

  const absolutePath = path.resolve(workDir, normalizedPath);
  const rel = path.relative(workDir, absolutePath);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Resolved path escapes workDir: ${relativePath}`);
  }

  return { absolutePath, normalizedPath };
}

/**
 * @param {string} workDir
 * @param {string} operationPath
 * @param {string} content
 * @returns {Promise<{ path: string }>}
 */
async function writeFileOperation(workDir, operationPath, content) {
  const { absolutePath, normalizedPath } = resolveSafePath(workDir, operationPath);
  const parentDir = path.dirname(absolutePath);
  await fs.mkdir(parentDir, { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
  return { path: normalizedPath };
}

/**
 * @param {string} source
 * @param {string} search
 * @param {string} replace
 * @returns {{ output: string; matches: number }}
 */
function replaceAllMatches(source, search, replace) {
  if (search === "") {
    throw new Error("search must be non-empty");
  }
  let matches = 0;
  let cursor = 0;
  let output = "";

  while (cursor < source.length) {
    const idx = source.indexOf(search, cursor);
    if (idx === -1) {
      output += source.slice(cursor);
      break;
    }
    matches += 1;
    output += source.slice(cursor, idx);
    output += replace;
    cursor = idx + search.length;
  }

  return { output, matches };
}

/**
 * @param {string} workDir
 * @param {string} operationPath
 * @param {string} search
 * @param {string} replace
 * @param {number | undefined} expectedMatches
 * @returns {Promise<{ path: string; matches: number }>}
 */
async function replaceInFileOperation(
  workDir,
  operationPath,
  search,
  replace,
  expectedMatches,
) {
  const { absolutePath, normalizedPath } = resolveSafePath(workDir, operationPath);
  const source = await fs.readFile(absolutePath, "utf8");
  const { output, matches } = replaceAllMatches(source, search, replace);

  if (typeof expectedMatches === "number" && matches !== expectedMatches) {
    throw new Error(
      `replace_in_file expected ${expectedMatches} matches, found ${matches}`,
    );
  }

  if (matches === 0) {
    throw new Error("replace_in_file found no matches");
  }

  await fs.writeFile(absolutePath, output, "utf8");
  return { path: normalizedPath, matches };
}

/**
 * @param {string} workDir
 * @param {string} operationPath
 * @returns {Promise<{ path: string; existed: boolean }>}
 */
async function deleteFileOperation(workDir, operationPath) {
  const { absolutePath, normalizedPath } = resolveSafePath(workDir, operationPath);
  let existed = true;
  try {
    await fs.unlink(absolutePath);
  } catch (err) {
    const isMissing = err instanceof Error && "code" in err && err.code === "ENOENT";
    if (isMissing) {
      existed = false;
    } else {
      throw err;
    }
  }
  return { path: normalizedPath, existed };
}

/**
 * @param {string} patchText
 * @returns {string[]}
 */
function extractPatchPaths(patchText) {
  const paths = new Set();
  const lines = patchText.split("\n");

  for (const line of lines) {
    if (!line.startsWith("+++ ") && !line.startsWith("--- ")) {
      continue;
    }

    const raw = line.slice(4).trim();
    if (
      raw === "/dev/null" ||
      raw === "a/dev/null" ||
      raw === "b/dev/null" ||
      raw === ""
    ) {
      continue;
    }

    const stripped = raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
    const pathWithoutTimestamp = stripped.split("\t")[0];
    const unixPath = pathWithoutTimestamp.replaceAll("\\", "/");
    paths.add(unixPath);
  }

  return [...paths];
}

/**
 * @param {string} workDir
 * @param {string} patch
 * @returns {Promise<{ paths: string[] }>}
 */
async function applyPatchOperation(workDir, patch) {
  if (typeof patch !== "string" || patch.trim() === "") {
    throw new Error("apply_patch requires non-empty patch text");
  }

  const patchPaths = extractPatchPaths(patch);
  for (const patchPath of patchPaths) {
    resolveSafePath(workDir, patchPath);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "neurolink-patch-"));
  const patchFile = path.join(tempDir, "change.patch");
  await fs.writeFile(patchFile, patch, "utf8");

  try {
    await exec(`patch -p1 --batch --forward --dry-run -i "${patchFile}"`, {
      cwd: workDir,
    });
    await exec(`patch -p1 --batch --forward -i "${patchFile}"`, {
      cwd: workDir,
    });
  } catch (err) {
    const output =
      err instanceof Error && "stderr" in err
        ? String(err.stderr || err.message)
        : err instanceof Error
          ? err.message
          : "unknown patch failure";
    throw new Error(`apply_patch failed: ${output.trim()}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  return { paths: patchPaths };
}

/**
 * @typedef {{
 *   id?: string;
 *   type: "write_file" | "replace_in_file" | "delete_file" | "apply_patch";
 *   path?: string;
 *   content?: string;
 *   search?: string;
 *   replace?: string;
 *   expectedMatches?: number;
 *   patch?: string;
 * }} EditOperation
 */

/**
 * @param {string} workDir
 * @param {unknown[]} edits
 * @returns {Promise<{ editResults: Array<Record<string, unknown>>; failedEditId?: string }>}
 */
export async function applyEdits(workDir, edits) {
  /** @type {Array<Record<string, unknown>>} */
  const editResults = [];

  for (let i = 0; i < edits.length; i += 1) {
    const rawEdit = edits[i];
    /** @type {EditOperation} */
    const edit =
      rawEdit && typeof rawEdit === "object" ? /** @type {EditOperation} */ (rawEdit) : {};
    const editId = typeof edit.id === "string" && edit.id.trim() ? edit.id : `edit-${i + 1}`;

    try {
      if (edit.type === "write_file") {
        const pathValue = typeof edit.path === "string" ? edit.path : "";
        const contentValue = typeof edit.content === "string" ? edit.content : "";
        const out = await writeFileOperation(workDir, pathValue, contentValue);
        editResults.push({
          id: editId,
          type: edit.type,
          success: true,
          ...out,
        });
        continue;
      }

      if (edit.type === "replace_in_file") {
        const pathValue = typeof edit.path === "string" ? edit.path : "";
        const searchValue = typeof edit.search === "string" ? edit.search : "";
        const replaceValue = typeof edit.replace === "string" ? edit.replace : "";
        const expectedMatches =
          typeof edit.expectedMatches === "number" ? edit.expectedMatches : undefined;

        const out = await replaceInFileOperation(
          workDir,
          pathValue,
          searchValue,
          replaceValue,
          expectedMatches,
        );
        editResults.push({
          id: editId,
          type: edit.type,
          success: true,
          ...out,
        });
        continue;
      }

      if (edit.type === "delete_file") {
        const pathValue = typeof edit.path === "string" ? edit.path : "";
        const out = await deleteFileOperation(workDir, pathValue);
        editResults.push({
          id: editId,
          type: edit.type,
          success: true,
          ...out,
        });
        continue;
      }

      if (edit.type === "apply_patch") {
        const patchValue = typeof edit.patch === "string" ? edit.patch : "";
        const out = await applyPatchOperation(workDir, patchValue);
        editResults.push({
          id: editId,
          type: edit.type,
          success: true,
          ...out,
        });
        continue;
      }

      throw new Error(`Unsupported edit operation type: ${String(edit.type || "")}`);
    } catch (err) {
      editResults.push({
        id: editId,
        type: edit.type || "unknown",
        success: false,
        error: err instanceof Error ? err.message : "Unknown edit error",
      });
      return { editResults, failedEditId: editId };
    }
  }

  return { editResults };
}
