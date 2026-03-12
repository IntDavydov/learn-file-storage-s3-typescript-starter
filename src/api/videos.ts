import { db, type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import {
  dbVideoToSignedVideo,
  getAmazonURL,
  getAssetPath,
  getVideoAspectRation,
  processVideoForFastStart,
  safeDelete,
  uploadToS3,
  uuidValidator,
} from "./assets";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { respondWithJSON } from "./json";
import path from "node:path";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  // get video file from multipart/form-data
  const { file, video, videoId, userId } = await parseUploadVideoRequest(
    req,
    cfg,
  );

  const filename = getAssetPath(file.type); // 32ranndomBytes.mp4
  const tempFilePath = path.join("/tmp", filename); // /tmp/32ranndomBytes.mp4

  await Bun.write(tempFilePath, file); // lazy temp on local disk

  const fastStartPath = await processVideoForFastStart(tempFilePath); // /tmp/32ranndomBytes.faststart.mp4
  const aspectRatio = await getVideoAspectRation(fastStartPath);

  const s3Path = `${aspectRatio}/${filename}`;
  await uploadToS3(cfg, s3Path, fastStartPath, file.type);

  video.videoURL = s3Path; // used on generatePresignedURL
  updateVideo(db, video);

  const copy = video.videoURL ? dbVideoToSignedVideo(cfg, video) : video;

  Promise.all([safeDelete(tempFilePath), safeDelete(fastStartPath)]);

  return respondWithJSON(201, copy);
}

async function parseUploadVideoRequest(
  req: BunRequest,
  cfg: ApiConfig,
): Promise<{ file: File; video: Video; videoId: string; userId: string }> {
  const formData = await req.formData();
  const file = formData.get("video");

  if (!file || !(file instanceof File)) {
    throw new BadRequestError("Video file is required");
  }

  const MAX_UPLOAD_SIZE = 1 << 30; // 1GB
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video file is too large");
  }

  if (file.type !== "video/mp4") {
    throw new BadRequestError("Video file must be an MP4");
  }

  const { videoId } = req.params as { videoId?: string };
  if (!videoId || !uuidValidator(videoId)) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userId = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(db, videoId);
  if (video?.userID !== userId) {
    throw new UserForbiddenError("You are not the owner of this video");
  }

  return { file, video, videoId, userId };
}

// TODO: split handlerUploadVideo into smaller functions
