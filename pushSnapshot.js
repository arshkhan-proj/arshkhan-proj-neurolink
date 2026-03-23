import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createReadStream, mkdirSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  resolveProvider,
  storageKey,
  s3,
  s3Bucket,
  gcs,
  gcsBucketName,
  removeFile,
} from "./snapshotStorage.js";

const execFile = promisify(execFileCb);

const UPLOAD_ROOT = path.join(os.tmpdir(), "neurolink-snapshots-upload");

/**
 * @param {string} value
 * @returns {string}
 */
function sanitize(value) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/-+/g, "-");
}

/**
 * @typedef {{
 *   workDir: string;
 *   repoName?: string;
 *   parentSnapshotId?: string;
 * }} PushSnapshotOptions
 */

/**
 * Package workDir as a tarball and upload to S3 or GCS.
 *
 * @param {PushSnapshotOptions} options
 * @returns {Promise<{ snapshotId: string; provider: "gcs" | "s3"; key: string }>}
 */
export async function pushSnapshot(options) {
  const { workDir, repoName, parentSnapshotId } = options;

  if (!workDir || typeof workDir !== "string") {
    throw new Error("workDir must be a non-empty string");
  }

  const provider = resolveProvider();

  // Short, collision-resistant ID: repo-snapshot-<timestamp>-<8 hex chars>.tar.gz
  const repo =
    typeof repoName === "string" && repoName.trim()
      ? sanitize(repoName.trim())
      : "repo";
  const shortRand = crypto.randomBytes(4).toString("hex");
  const snapshotId = `${repo}-snapshot-${Date.now()}-${shortRand}.tar.gz`;

  mkdirSync(UPLOAD_ROOT, { recursive: true });
  const archivePath = path.join(UPLOAD_ROOT, snapshotId);

  try {
    // No shell — immune to injection via workDir.
    await execFile("tar", ["-czf", archivePath, "-C", workDir, "."]);

    const key = storageKey(snapshotId, repoName);

    if (provider === "gcs") {
      await gcs().bucket(gcsBucketName()).upload(archivePath, {
        destination: key,
        gzip: false,
        contentType: "application/gzip",
      });
      return { snapshotId, provider: "gcs", key, parentSnapshotId: parentSnapshotId || null };
    }

    await s3().send(
      new PutObjectCommand({
        Bucket: s3Bucket(),
        Key: key,
        Body: createReadStream(archivePath),
        ContentType: "application/gzip",
      }),
    );
    return { snapshotId, provider: "s3", key, parentSnapshotId: parentSnapshotId || null };
  } finally {
    // Always clean up the local archive.
    await removeFile(archivePath);
  }
}
