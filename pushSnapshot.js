import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { Storage } from "@google-cloud/storage";
import { createReadStream, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

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

  if (provider === "gcp" || provider === "gcs") return "gcs";
  if (provider === "aws" || provider === "s3") return "s3";

  const hasGcsConfig = !!(
    getGcsBucketName() &&
    GCS_BASE_PATH &&
    GCS_EXTRA_PATH
  );
  const hasS3Config = !!(S3_BUCKET && S3_BASE_PATH && S3_EXTRA_PATH);

  if (hasGcsConfig) return "gcs";
  if (hasS3Config) return "s3";
  return "unknown";
};

const sanitizeSegment = (value) =>
  value.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/-+/g, "-");

/**
 * @typedef {{
 *   workDir: string;
 *   repoName?: string;
 *   parentSnapshotId?: string;
 * }} PushSnapshotOptions
 */

/**
 * Package current workspace and push a full tar.gz snapshot to configured storage.
 *
 * @param {PushSnapshotOptions} options
 * @returns {Promise<{snapshotId: string; provider: "gcs" | "s3"; key: string}>}
 */
export async function pushSnapshot(options) {
  const { workDir, repoName, parentSnapshotId } = options;

  if (!workDir || typeof workDir !== "string") {
    throw new Error("workDir must be a non-empty string");
  }

  const provider = resolveSnapshotProvider();
  if (provider === "unknown") {
    throw new Error(
      "Snapshot storage provider not configured for push. Set GCP_BUCKET_NAME_RELEASE/GCS_BASE_PATH/GCS_EXTRA_PATH (preferred) or S3_BUCKET/S3_BASE_PATH/S3_EXTRA_PATH.",
    );
  }

  if (provider === "gcs") {
    if (!getGcsBucketName() || !GCS_BASE_PATH || !GCS_EXTRA_PATH) {
      throw new Error(
        "Missing GCS configuration. Set GCP_BUCKET_NAME_RELEASE (preferred), GCS_BASE_PATH, and GCS_EXTRA_PATH.",
      );
    }
  } else if (!S3_BUCKET || !S3_BASE_PATH || !S3_EXTRA_PATH) {
    throw new Error(
      "Missing S3 configuration. Set S3_BUCKET, S3_BASE_PATH, and S3_EXTRA_PATH.",
    );
  }

  const repoSegment =
    typeof repoName === "string" && repoName.trim() !== ""
      ? sanitizeSegment(repoName.trim())
      : "repo";
  const parentSegment =
    typeof parentSnapshotId === "string" && parentSnapshotId.trim() !== ""
      ? sanitizeSegment(parentSnapshotId.replace(/\.tar\.gz$/i, ""))
      : "manual";
  const snapshotId = `${repoSegment}-snapshot-${Date.now()}-${parentSegment}.tar.gz`;

  const tmpRoot = path.join(os.tmpdir(), "neurolink-snapshots-upload");
  mkdirSync(tmpRoot, { recursive: true });
  const archivePath = path.join(tmpRoot, snapshotId);

  await exec(`tar -czf "${archivePath}" -C "${workDir}" .`);

  const effectiveBasePath =
    provider === "gcs"
      ? GCS_BASE_PATH
      : typeof repoName === "string" && repoName.trim() !== ""
        ? repoName.trim()
        : S3_BASE_PATH;
  const extraPath = provider === "gcs" ? GCS_EXTRA_PATH : S3_EXTRA_PATH;
  const prefix = normalizeKeyPrefix(
    `${effectiveBasePath}/${extraPath}/snapshots/`,
  );
  const key = `${prefix}${snapshotId}`;

  if (provider === "gcs") {
    const bucketName = getGcsBucketName();
    if (!bucketName) {
      throw new Error("GCP_BUCKET_NAME_RELEASE must be set for GCS pushes");
    }

    const storage = new Storage();
    await storage.bucket(bucketName).upload(archivePath, {
      destination: key,
      gzip: false,
      contentType: "application/gzip",
    });
    return { snapshotId, provider: "gcs", key };
  }

  if (!S3_BUCKET) {
    throw new Error("S3_BUCKET must be set for S3 pushes");
  }
  const s3 = new S3Client({ region: AWS_REGION });
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: createReadStream(archivePath),
      ContentType: "application/gzip",
    }),
  );

  return { snapshotId, provider: "s3", key };
}
