import { TwitterApi } from "twitter-api-v2";

import { createLogger } from "@/lib/debug";

const log = createLogger("post-morning-x");

/**
 * OAuth 1.0a user tokens — required for posting tweets with media (X API v1.1 upload + v2 tweet).
 */
export function createTwitterRwClient(): TwitterApi {
  const appKey = process.env.TWITTER_API_KEY ?? process.env.X_API_KEY;
  const appSecret = process.env.TWITTER_API_SECRET ?? process.env.X_API_SECRET;
  const accessToken = process.env.TWITTER_ACCESS_TOKEN ?? process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.TWITTER_ACCESS_SECRET ?? process.env.X_ACCESS_SECRET;
  if (!appKey || !appSecret || !accessToken || !accessSecret) {
    throw new Error(
      "Missing app key/secret and user access token/secret (set TWITTER_* or X_* env vars)"
    );
  }
  return new TwitterApi({
    appKey,
    appSecret,
    accessToken,
    accessSecret,
  });
}

export async function postTweetPng(params: { text: string; imagePath: string }): Promise<{ id: string }> {
  const client = createTwitterRwClient().readWrite;
  const mediaId = await client.v1.uploadMedia(params.imagePath, { mimeType: "image/png" });
  const posted = await client.v2.tweet({
    text: params.text,
    media: { media_ids: [mediaId] },
  });
  const id = posted.data?.id;
  if (typeof id !== "string") {
    log("unexpected tweet response %o", posted);
    throw new Error("Tweet post did not return an id");
  }
  log("posted tweet id=%s", id);
  return { id };
}
