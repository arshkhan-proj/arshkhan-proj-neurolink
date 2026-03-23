/**
 * Shared storage helpers for snapshot pull/push.
 *
 * Single source of truth for:
 *  - provider detection (GCS vs S3)
 *  - storage key construction
 *  - lazy client creation
 *  - temp-file cleanup
 */

import { S3Client } from "@aws-sdk/client-s3";
import { Storage } from "@google-cloud/storage";
import { promises as fs } from "node:fs";

// ---------------------------------------------------------------------------
// Env vars (read once at import time)
// ---------------------------------------------------------------------------
const {
  S3_BUCKET,
  S3_BASE_PATH,
  S3_EXTRA_PATH,
  AWS_REGION = "ap-south-1",
  GCP_BUCKET_NAME,
  GCP_BUCKET_NAME_RELEASE,
  GCS_BASE_PATH,
  GCS_EXTRA_PATH,
} = process.env;

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

function gcsBucket() {
  return (
    (GCP_BUCKET_NAME_RELEASE && GCP_BUCKET_NAME_RELEASE.trim()) ||
    (GCP_BUCKET_NAME && GCP_BUCKET_NAME.trim()) ||
    ""
  );
}

/**
 * Resolve which cloud provider to use for snapshots.
 * @returns {"gcs" | "s3"}
 */
export function resolveProvider() {
  const explicit = process.env.SNAPSHOT_STORAGE_PROVIDER?.toLowerCase().trim();
  if (explicit === "gcp" || explicit === "gcs") return "gcs";
  if (explicit === "aws" || explicit === "s3") return "s3";

  if (gcsBucket() && GCS_BASE_PATH && GCS_EXTRA_PATH) return "gcs";
  if (S3_BUCKET && S3_BASE_PATH && S3_EXTRA_PATH) return "s3";

  throw new Error(
    "Snapshot storage not configured. Set GCP_BUCKET_NAME_RELEASE/GCS_BASE_PATH/GCS_EXTRA_PATH or S3_BUCKET/S3_BASE_PATH/S3_EXTRA_PATH.",
  );
}

// ---------------------------------------------------------------------------
// Storage key
// ---------------------------------------------------------------------------

/**
 * Build the object key for a snapshot in cloud storage.
 * @param {string} snapshotId
 * @param {string | undefined} repoName
 */
export function storageKey(snapshotId, repoName) {
  const provider = resolveProvider();

  const basePath =
    provider === "gcs"
      ? GCS_BASE_PATH
      : typeof repoName === "string" && repoName.trim()
        ? repoName.trim()
        : S3_BASE_PATH;

  const extraPath = provider === "gcs" ? GCS_EXTRA_PATH : S3_EXTRA_PATH;

  // collapse double slashes
  const prefix = `${basePath}/${extraPath}/snapshots/`.replace(/\/+/g, "/");
  return `${prefix}${snapshotId}`;
}

// ---------------------------------------------------------------------------
// Lazy clients (created once, reused)
// ---------------------------------------------------------------------------

/** @type {S3Client | null} */
let _s3 = null;
/** @type {Storage | null} */
let _gcs = null;

/** @returns {S3Client} */
export function s3() {
  if (!_s3) _s3 = new S3Client({ region: AWS_REGION });
  return _s3;
}

/** @returns {Storage} */
export function gcs() {
  if (!_gcs) _gcs = new Storage();
  return _gcs;
}

/** @returns {string} */
export function s3Bucket() {
  if (!S3_BUCKET) throw new Error("S3_BUCKET must be set");
  return S3_BUCKET;
}

/** @returns {string} */
export function gcsBucketName() {
  const name = gcsBucket();
  if (!name) throw new Error("GCP_BUCKET_NAME_RELEASE must be set");
  return name;
}

// ---------------------------------------------------------------------------
// Cleanup helper
// ---------------------------------------------------------------------------

/**
 * Best-effort delete of a file. Swallows errors.
 * @param {string} filePath
 */
export async function removeFile(filePath) {
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore — temp file may already be gone
  }
}
