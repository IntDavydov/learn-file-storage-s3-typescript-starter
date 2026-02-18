import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import { db, type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";
import { getAssetDiskPath, getAssetURL, mediaTypeToExt } from "./assets";
import { randomBytes } from "node:crypto";

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  // TODO: implement the upload here
  const formData = await req.formData(); // multipart/form-data
  const file = formData.get("thumbnail"); // get field type of FormDataEntry

  if (!(file instanceof File)) throw new BadRequestError("Wrong file type");

  const MAX_UPLOAD_SIZE = 10 << 20;
  if (file.size > MAX_UPLOAD_SIZE)
    throw new BadRequestError("Upload size excided");

  const mediaType = file.type;

  if (mediaType !== "image/jpeg" && mediaType !== "image/png")
    throw new BadRequestError("wrong image type, must be: .jpeg/.png");

  const data = await file.arrayBuffer();

  console.log(mediaType);

  const video = getVideo(db, videoId);
  if (!video) throw new UserForbiddenError("Not authorized");

  const ext = mediaTypeToExt(mediaType);
  console.log("random bytes: ", randomBytes(2));
  const filename = `${randomBytes(32).toString("base64url")}${ext}`;

  const assetDiskPath = getAssetDiskPath(cfg, filename);
  Bun.write(assetDiskPath, data);

  const filePath = getAssetURL(cfg, assetDiskPath);
  video.thumbnailURL = filePath;

  updateVideo(db, video);

  return respondWithJSON(200, JSON.stringify(video));
}
