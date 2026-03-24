import { createWriteStream, mkdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import { pipeline } from "node:stream";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { storageKey, gcs, bucketName } from "./snapshotStorage.js";

const pipe = promisify(pipeline);
const execFile = promisify(execFileCb);

const SNAPSHOT_ROOT = path.join(os.tmpdir(), "neurolink-snapshots");
const PULL_TIMEOUT_MS = Number(process.env.CHECK_RUNNER_PULL_TIMEOUT_MS || 300_000); // 5 min

/** Reject if promise doesn't resolve within ms. */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Download and extract a snapshot tarball from GCS.
 *
 * @param {string} snapshotId  e.g. "lighthouse-snapshot-abc123.tar.gz"
 * @returns {Promise<string>} absolute path to the extracted directory
 */
export async function pullSnapshot(snapshotId) {
  if (!snapshotId || typeof snapshotId !== "string") {
    throw new Error("snapshotId must be a non-empty string");
  }

  mkdirSync(SNAPSHOT_ROOT, { recursive: true });

  const safeId = snapshotId.replace(/\.tar\.gz$/i, "").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const snapshotDir = path.join(SNAPSHOT_ROOT, safeId);
  const archivePath = path.join(SNAPSHOT_ROOT, `${safeId}.tar.gz`);

  // Wipe any previous extraction so stale files can't leak through.
  await fs.rm(snapshotDir, { recursive: true, force: true });
  mkdirSync(snapshotDir, { recursive: true });

  const key = storageKey(snapshotId);
  const writeStream = createWriteStream(archivePath);

  try {
    const readStream = gcs().bucket(bucketName()).file(key).createReadStream();
    await withTimeout(pipe(readStream, writeStream), PULL_TIMEOUT_MS, "Snapshot download");
    await withTimeout(execFile("tar", ["-xzf", archivePath, "-C", snapshotDir]), PULL_TIMEOUT_MS, "Snapshot extraction");
  } finally {
    try { await fs.unlink(archivePath); } catch { /* best effort */ }
  }

  return snapshotDir;
}
