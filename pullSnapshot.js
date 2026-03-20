import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Storage } from "@google-cloud/storage";
import { createWriteStream, mkdirSync } from "node:fs";
import { pipeline } from "node:stream";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { exec as execCb } from "node:child_process";

const pipe = promisify(pipeline);
const exec = promisify(execCb);

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

const getGcsBucketName = () =>
  (GCP_BUCKET_NAME_RELEASE && GCP_BUCKET_NAME_RELEASE.trim()) ||
  (GCP_BUCKET_NAME && GCP_BUCKET_NAME.trim()) ||
  "";

const normalizeKeyPrefix = (p) => p.replace(/\/+/g, "/");

const resolveSnapshotProvider = () => {
  const provider = process.env.SNAPSHOT_STORAGE_PROVIDER?.toLowerCase().trim();

  // Explicit override always wins.
  if (provider === "gcp" || provider === "gcs") {
    return "gcs";
  }
  if (provider === "aws" || provider === "s3") {
    return "s3";
  }

  // Auto-detect: prefer GCS when configured, otherwise fall back to S3.
  const hasGcsConfig = !!(
    getGcsBucketName() &&
    GCS_BASE_PATH &&
    GCS_EXTRA_PATH
  );
  const hasS3Config = !!(S3_BUCKET && S3_BASE_PATH && S3_EXTRA_PATH);

  if (hasGcsConfig) {
    return "gcs";
  }
  if (hasS3Config) {
    return "s3";
  }

  return "unknown";
};

/**
 * Download and extract a snapshot tarball from either S3 (AWS) or GCS (GCP).
 * Returns the local directory path containing the extracted snapshot.
 *
 * @param {string} snapshotId e.g. <repo>-snapshot-<git-commit>.tar.gz
 * @param {string | undefined} repoName name of the repo (used as base path), e.g. "lighthouse"
 * @returns {Promise<string>} local directory to use as workDir
 */
export async function pullSnapshot(snapshotId, repoName) {
  if (!snapshotId || typeof snapshotId !== "string") {
    throw new Error("snapshotId must be a non-empty string");
  }

  const tmpRoot = path.join(os.tmpdir(), "neurolink-snapshots");
  mkdirSync(tmpRoot, { recursive: true });

  const safeId = snapshotId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const snapshotDir = path.join(tmpRoot, safeId);
  const archivePath = `${snapshotDir}.tar.gz`;
  mkdirSync(snapshotDir, { recursive: true });

  const provider = resolveSnapshotProvider();
  if (provider === "unknown") {
    throw new Error(
      "Snapshot storage provider not configured. Set GCP_BUCKET_NAME_RELEASE/GCS_BASE_PATH/GCS_EXTRA_PATH (preferred) or S3_BUCKET/S3_BASE_PATH/S3_EXTRA_PATH.",
    );
  }

  if (provider === "gcs") {
    if (!getGcsBucketName() || !GCS_BASE_PATH || !GCS_EXTRA_PATH) {
      throw new Error(
        "Missing GCS configuration. Set GCP_BUCKET_NAME_RELEASE (preferred), GCS_BASE_PATH, and GCS_EXTRA_PATH.",
      );
    }
  } else {
    if (!S3_BUCKET || !S3_BASE_PATH || !S3_EXTRA_PATH) {
      throw new Error(
        "Missing S3 configuration. Set S3_BUCKET, S3_BASE_PATH, and S3_EXTRA_PATH.",
      );
    }
  }

  const effectiveBasePath =
    provider === "gcs"
      ? GCS_BASE_PATH // Keep key path consistent with Jenkins: <GCS_BASE_PATH>/<GCS_EXTRA_PATH>/snapshots/<snapshotId>
      : typeof repoName === "string" && repoName.trim() !== ""
        ? repoName.trim()
        : S3_BASE_PATH;

  const extraPath = provider === "gcs" ? GCS_EXTRA_PATH : S3_EXTRA_PATH;
  const prefix = normalizeKeyPrefix(
    `${effectiveBasePath}/${extraPath}/snapshots/`,
  );
  const key = `${prefix}${snapshotId}`;

  const writeStream = createWriteStream(archivePath);

  if (provider === "gcs") {
    const gcsBucketName = getGcsBucketName();
    if (!gcsBucketName) {
      throw new Error("GCP_BUCKET_NAME_RELEASE must be set for GCS pulls");
    }

    const storage = new Storage();
    const readStream = storage
      .bucket(gcsBucketName)
      .file(key)
      .createReadStream();
    await pipe(readStream, writeStream);
  } else {
    if (!S3_BUCKET) {
      throw new Error("S3_BUCKET must be set for S3 pulls");
    }

    const s3 = new S3Client({ region: AWS_REGION });
    const cmd = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
    });

    const response = await s3.send(cmd);
    if (!response.Body) {
      throw new Error(`Empty S3 response for s3://${S3_BUCKET}/${key}`);
    }

    const bodyStream = /** @type {NodeJS.ReadableStream} */ (response.Body);
    await pipe(bodyStream, writeStream);
  }

  // 2. Extract into snapshotDir (requires tar in the environment)
  await exec(`tar -xzf "${archivePath}" -C "${snapshotDir}"`);

  // 3. Return the directory to use as workDir
  return snapshotDir;
}
