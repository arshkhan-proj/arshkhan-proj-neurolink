import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
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
} = process.env;

if (!S3_BUCKET || !S3_BASE_PATH || !S3_EXTRA_PATH) {
  throw new Error(
    "S3_BUCKET, S3_BASE_PATH, and S3_EXTRA_PATH must be set in the environment",
  );
}

const s3 = new S3Client({ region: AWS_REGION });

/**
 * Download and extract a snapshot tarball from S3.
 * Returns the local directory path containing the extracted snapshot.
 *
 * @param {string} snapshotId e.g. lighthouse-snapshot-<git-commit>.tar.gz
 * @returns {Promise<string>} local directory to use as workDir
 */
export async function pullSnapshot(snapshotId) {
  if (!snapshotId || typeof snapshotId !== "string") {
    throw new Error("snapshotId must be a non-empty string");
  }

  const prefix = `${S3_BASE_PATH}/${S3_EXTRA_PATH}/snapshots/`.replace(
    /\/+/g,
    "/",
  );
  const key = `${prefix}${snapshotId}`;

  const tmpRoot = path.join(os.tmpdir(), "neurolink-snapshots");
  mkdirSync(tmpRoot, { recursive: true });

  const safeId = snapshotId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const snapshotDir = path.join(tmpRoot, safeId);
  const archivePath = `${snapshotDir}.tar.gz`;
  mkdirSync(snapshotDir, { recursive: true });

  // 1. Download tarball from S3
  const cmd = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
  });

  const response = await s3.send(cmd);
  if (!response.Body) {
    throw new Error(`Empty S3 response for s3://${S3_BUCKET}/${key}`);
  }

  const writeStream = createWriteStream(archivePath);
  const bodyStream =
    /** @type {NodeJS.ReadableStream} */ (response.Body);
  await pipe(bodyStream, writeStream);

  // 2. Extract into snapshotDir (requires tar in the environment)
  await exec(`tar -xzf "${archivePath}" -C "${snapshotDir}"`);

  // 3. Return the directory to use as workDir
  return snapshotDir;
}

