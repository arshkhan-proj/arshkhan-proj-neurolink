/**
 * GCS storage helpers for snapshot pulls.
 */

import { Storage } from "@google-cloud/storage";

const { GCP_BUCKET_NAME, GCP_BUCKET_NAME_RELEASE, GCS_BASE_PATH, GCS_EXTRA_PATH } = process.env;

// ---------------------------------------------------------------------------
// Bucket
// ---------------------------------------------------------------------------

/** @returns {string} */
export function bucketName() {
  const name =
    (GCP_BUCKET_NAME_RELEASE && GCP_BUCKET_NAME_RELEASE.trim()) ||
    (GCP_BUCKET_NAME && GCP_BUCKET_NAME.trim()) ||
    "";
  if (!name) throw new Error("GCP_BUCKET_NAME_RELEASE or GCP_BUCKET_NAME must be set");
  return name;
}

// ---------------------------------------------------------------------------
// Storage key helpers
// ---------------------------------------------------------------------------

/** @param {string} snapshotId */
export function storageKey(snapshotId) {
  if (!GCS_BASE_PATH || !GCS_EXTRA_PATH) throw new Error("GCS_BASE_PATH and GCS_EXTRA_PATH must be set");
  return `${GCS_BASE_PATH}/${GCS_EXTRA_PATH}/snapshots/${snapshotId}`.replace(/\/+/g, "/");
}

/** @returns {string} */
export function snapshotsPrefix() {
  if (!GCS_BASE_PATH || !GCS_EXTRA_PATH) throw new Error("GCS_BASE_PATH and GCS_EXTRA_PATH must be set");
  return `${GCS_BASE_PATH}/${GCS_EXTRA_PATH}/snapshots/`.replace(/\/+/g, "/");
}

// ---------------------------------------------------------------------------
// Snapshot resolution — always returns the latest snapshot for a repo
// ---------------------------------------------------------------------------

/**
 * Resolve the latest beta snapshot id for a given repo.
 *
 * Naming convention: {repoName}-snapshot-{commitHash}.tar.gz
 * Always picks the most recently uploaded one.
 *
 * @param {{ repoName: string }} params
 * @returns {Promise<string>} snapshotId e.g. "lighthouse-snapshot-abc123.tar.gz"
 */
export async function resolveSnapshotId({ repoName }) {
  if (!repoName || typeof repoName !== "string" || repoName.trim() === "") {
    throw new Error("repoName is required");
  }

  const prefix = snapshotsPrefix();
  const namePrefix = `${prefix}${repoName.trim()}-snapshot-`;

  const [files] = await gcs().bucket(bucketName()).getFiles({ prefix: namePrefix });
  const candidates = files.filter((f) => f.name.endsWith(".tar.gz"));

  if (candidates.length === 0) {
    throw new Error(`No snapshots found for repo '${repoName}'`);
  }

  // Pick the most recently uploaded snapshot.
  const sorted = [...candidates].sort((a, b) => {
    const at = Date.parse(a.metadata?.updated || a.metadata?.timeCreated || "0");
    const bt = Date.parse(b.metadata?.updated || b.metadata?.timeCreated || "0");
    return bt - at;
  });

  return sorted[0].name.slice(prefix.length);
}

// ---------------------------------------------------------------------------
// Lazy GCS client
// ---------------------------------------------------------------------------

/** @type {Storage | null} */
let _gcs = null;

/** @returns {Storage} */
export function gcs() {
  if (!_gcs) _gcs = new Storage();
  return _gcs;
}
