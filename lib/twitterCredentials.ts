/**
 * OAuth 1.0a app + user tokens for posting with media (X API v1.1 upload + v2 tweet).
 * Accepts names commonly used in the X Developer Portal and CI secret stores.
 */
export type TwitterOauth1Credentials = {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
};

function pickDefined(...candidates: (string | undefined)[]): string | undefined {
  for (const value of candidates) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return undefined;
}

export function getTwitterOauth1FromEnv(): TwitterOauth1Credentials | null {
  const appKey = pickDefined(
    process.env.TWITTER_API_KEY,
    process.env.X_API_KEY,
    process.env.TWITTER_CONSUMER_KEY,
    process.env.TWITTER_CLIENT_ID
  );
  const appSecret = pickDefined(
    process.env.TWITTER_API_SECRET,
    process.env.X_API_SECRET,
    process.env.TWITTER_API_KEY_SECRET,
    process.env.TWITTER_CONSUMER_SECRET,
    process.env.TWITTER_CLIENT_SECRET
  );
  const accessToken = pickDefined(process.env.TWITTER_ACCESS_TOKEN, process.env.X_ACCESS_TOKEN);
  const accessSecret = pickDefined(
    process.env.TWITTER_ACCESS_SECRET,
    process.env.X_ACCESS_TOKEN_SECRET
  );
  if (!appKey || !appSecret || !accessToken || !accessSecret) {
    return null;
  }
  return { appKey, appSecret, accessToken, accessSecret };
}

const ENV_HINT =
  "Set OAuth 1.0a user context: TWITTER_API_KEY + TWITTER_API_SECRET + TWITTER_ACCESS_TOKEN + TWITTER_ACCESS_SECRET " +
  "(aliases: X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET, or TWITTER_CONSUMER_KEY + TWITTER_CONSUMER_SECRET).";

export function requireTwitterOauth1FromEnv(): TwitterOauth1Credentials {
  const credentials = getTwitterOauth1FromEnv();
  if (credentials === null) {
    throw new Error(`Missing X posting credentials. ${ENV_HINT}`);
  }
  return credentials;
}
