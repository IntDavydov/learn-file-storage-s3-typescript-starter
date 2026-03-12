import { existsSync, mkdirSync } from "fs";
import path from "node:path";
import type { ApiConfig } from "../config";
import { randomBytes } from "node:crypto";
import { type Video } from "../db/videos";
import { BadRequestError } from "./errors";

export function getAssetPath(mediaType: string): string {
  const base = randomBytes(32);
  const id = base.toString("base64url");
  const ext = mediaTypeToExt(mediaType);

  return `${id}${ext}`;
}

export function ensureAssetsDir(cfg: ApiConfig) {
  if (!existsSync(cfg.assetsRoot)) {
    mkdirSync(cfg.assetsRoot, { recursive: true });
  }
}

export function mediaTypeToExt(mediaType: string): string {
  const parts = mediaType.split("/");
  if (parts.length !== 2) {
    return ".bin";
  }
  return "." + parts[1];
}

export function getAssetDiskPath(cfg: ApiConfig, assetPath: string): string {
  return path.join(cfg.assetsRoot, assetPath);
}

export function getAssetURL(cfg: ApiConfig, assetPath: string): string {
  return `http://localhost:${cfg.port}/${assetPath}`;
}

export function getAmazonURL(cfg: ApiConfig, assetPath: string): string {
  return `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${assetPath}`;
}

export function uuidValidator(uuid: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    uuid,
  );
}

export async function getVideoAspectRation(filePath: string): Promise<string> {
  const proc = Bun.spawn(
    // lazily executing ffprobe
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const stderrText = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`ffprobe failed: ${stderrText}`);
  }

  const stdoutText = await new Response(proc.stdout).text();

  const { width, height } = parseAspectRatio(stdoutText);
  const aspectRatio = classifyAspectRatio(width, height);

  return aspectRatio;
}

function parseAspectRatio(stdoutText: string): {
  width: number;
  height: number;
} {
  try {
    const data = JSON.parse(stdoutText);
    const streams = data.streams?.[0];

    if (!streams || !streams.width || !streams.height) {
      throw new Error("Invalid video stream data");
    }

    const { width, height } = streams;

    return { width, height };
  } catch (error) {
    console.error("Error parsing aspect ratio:", error);
    throw error;
  }
}

function classifyAspectRatio(width: number, height: number): string {
  const ratio = width / height;

  // Portrait tolerance (around 9:16 = 0.5625)
  if (ratio >= 0.5 && ratio <= 0.65) {
    return "portrait";
  }

  // Landscape tolerance (around 16:9 = 1.777)
  if (ratio >= 1.6 && ratio <= 2.0) {
    return "landscape";
  }

  // Square tolerance (around 1:1 = 1.0)
  if (ratio >= 0.9 && ratio <= 1.1) {
    return "square";
  }

  return "other";
}

export async function processVideoForFastStart(
  inputFilePath: string,
): Promise<string> {
  const outputFilePath = inputFilePath.replace(".mp4", ".faststart.mp4");

  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-i",
      inputFilePath,
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      outputFilePath,
    ],
    {
      stderr: "pipe",
    },
  );

  const stderrText = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`ffmpeg failed with exit code ${exitCode}: ${stderrText}`);
  }

  return outputFilePath;
}

export async function safeDelete(filePath: string): Promise<void> {
  try {
    await Bun.file(filePath).delete();
  } catch (error) {
    console.error(`Error deleting file ${filePath}:`, error);
  }
}

export async function uploadToS3(
  cfg: ApiConfig,
  s3Path: string, // /{aspectRatio}/{32randomBytes}.mp4
  fastStartPath: string,
  mimeType: string,
): Promise<void> {
  try {
    const s3File = cfg.s3Client.file(s3Path); // lazy reference to S3 object with given path
    const tempFileReference = Bun.file(fastStartPath); // lazy read return Blob

    await s3File.write(tempFileReference, {
      type: mimeType,
    });

    console.log(`Successfully moved file to S3 at key: ${s3Path}`);
  } catch (error) {
    console.error("Error uploading file:", error);
    throw new Error("Failed to upload file");
  }
}

export function generatePresignedURL(
  cfg: ApiConfig,
  s3Path: string,
  expiresIn: number,
): string {
  return cfg.s3Client.presign(s3Path, { expiresIn });
}

export function dbVideoToSignedVideo(cfg: ApiConfig, video: Video): Video {
  if (!video.videoURL) {
    throw new BadRequestError("Video URL is required");
  }

  const copy = { ...video }; // WARNING: shallow copy
  copy.videoURL = generatePresignedURL(cfg, video.videoURL, 3600);
  console.log("copy of the video", copy);
  return copy;
} // Question: Do I need to create copy of video to make function pure?
