/**
 * Canonical public origin for OG URLs, share links, and X intents.
 * Set `NEXT_PUBLIC_SITE_URL` in production (e.g. https://besorge.vercel.app).
 */
export function getPublicSiteOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (raw) {
    try {
      return new URL(raw).origin;
    } catch {
      /* fall through */
    }
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return "http://127.0.0.1:3000";
}
