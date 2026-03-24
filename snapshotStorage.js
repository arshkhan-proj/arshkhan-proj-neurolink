/**
 * GCS storage helpers for snapshot pulls.
 */

import { Storage } from "@google-cloud/storage";

const { GCP_BUCKET_NAME, GCP_BUCKET_NAME_RELEASE, GCS_BASE_PATH, GCS_EXTRA_PATH } =
  process.env;

// ---------------------------------------------------------------------------
// Bucket
// ---------------------------------------------------------------------------

/** @returns {string} */
export function bucketName() {
  const name =
    (GCP_BUCKET_NAME_RELEASE && GCP_BUCKET_NAME_RELEASE.trim()) ||
    (GCP_BUCKET_NAME && GCP_BUCKET_NAME.trim()) ||
    "";
  if (!name) {
    throw new Error("GCP_BUCKET_NAME_RELEASE or GCP_BUCKET_NAME must be set");
  }
  return name;
}

// ---------------------------------------------------------------------------
// Storage key
// ---------------------------------------------------------------------------

/** @param {string} snapshotId */
export function storageKey(snapshotId) {
  if (!GCS_BASE_PATH || !GCS_EXTRA_PATH) {
    throw new Error("GCS_BASE_PATH and GCS_EXTRA_PATH must be set");
  }
  return `${GCS_BASE_PATH}/${GCS_EXTRA_PATH}/snapshots/${snapshotId}`.replace(/\/+/g, "/");
}

// ---------------------------------------------------------------------------
// Lazy client (created once, reused)
// ---------------------------------------------------------------------------

/** @type {Storage | null} */
let _gcs = null;

/** @returns {Storage} */
export function gcs() {
  if (!_gcs) _gcs = new Storage();
  return _gcs;
}
