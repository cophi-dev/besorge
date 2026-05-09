/**
 * Build an X / Twitter web intent URL (works in mobile and desktop browsers).
 * @see https://developer.x.com/en/docs/x-for-websites/tweet-button/guides/web-intent
 */
export function buildXPostIntentUrl(params: {
  /** Visible tweet body (avoid duplicating the full URL if you pass `url`). */
  text: string;
  /** Canonical page URL — shown as a card and tracked separately from `text`. */
  url: string;
  /** Optional @handle without @ — adds attribution via `via` (legacy intent param). */
  via?: string;
  /** Optional hashtags without #, comma-separated */
  hashtags?: string[];
}): string {
  const u = new URL("https://twitter.com/intent/tweet");
  u.searchParams.set("text", params.text);
  u.searchParams.set("url", params.url);
  if (params.via) {
    u.searchParams.set("via", params.via.replace(/^@/, ""));
  }
  if (params.hashtags?.length) {
    u.searchParams.set("hashtags", params.hashtags.join(","));
  }
  return u.toString();
}
