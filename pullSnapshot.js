import { GetObjectCommand } from "@aws-sdk/client-s3";
import { createWriteStream, mkdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import { pipeline } from "node:stream";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import path from "node:path";
import os from "node:os";
import {
  resolveProvider,
  storageKey,
  s3,
  s3Bucket,
  gcs,
  gcsBucketName,
  removeFile,
} from "./snapshotStorage.js";

const pipe = promisify(pipeline);
const execFile = promisify(execFileCb);

const SNAPSHOT_ROOT = path.join(os.tmpdir(), "neurolink-snapshots");

/**
 * Download and extract a snapshot tarball from S3 or GCS.
 *
 * @param {string} snapshotId  e.g. "lighthouse-snapshot-abc123.tar.gz"
 * @param {string | undefined} repoName
 * @returns {Promise<string>} absolute path to the extracted directory
 */
export async function pullSnapshot(snapshotId, repoName) {
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

  // --- download ---
  const provider = resolveProvider();
  const key = storageKey(snapshotId, repoName);
  const writeStream = createWriteStream(archivePath);

  try {
    if (provider === "gcs") {
      const readStream = gcs()
        .bucket(gcsBucketName())
        .file(key)
        .createReadStream();
      await pipe(readStream, writeStream);
    } else {
      const response = await s3().send(
        new GetObjectCommand({ Bucket: s3Bucket(), Key: key }),
      );
      if (!response.Body) {
        throw new Error(`Empty S3 response for s3://${s3Bucket()}/${key}`);
      }
      await pipe(/** @type {NodeJS.ReadableStream} */ (response.Body), writeStream);
    }

    // --- extract (no shell — immune to injection) ---
    await execFile("tar", ["-xzf", archivePath, "-C", snapshotDir]);
  } finally {
    // Always clean up the archive — we only need the extracted dir.
    await removeFile(archivePath);
  }

  return snapshotDir;
}
