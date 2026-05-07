import { getCuratedNewsFeed } from "@/lib/newsIngestion";

const makeRss = (items: string[]) => `<?xml version="1.0"?><rss><channel>${items.join("")}</channel></rss>`;

const makeItem = (params: { title: string; link: string; pubDate: string; description: string }) =>
  `<item><title><![CDATA[${params.title}]]></title><link>${params.link}</link><pubDate>${params.pubDate}</pubDate><description><![CDATA[${params.description}]]></description></item>`;

describe("getCuratedNewsFeed", () => {
  const originalEnv = process.env;

  afterEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv };
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  });

  it("falls back to heuristic categorization when AI key is missing", async () => {
    process.env.AI_API_KEY = "";
    process.env.XAI_API_KEY = "";

    const rssBody = makeRss([
      makeItem({
        title: "Tesla Megapack project in Germany reaches milestone",
        link: "https://example.com/a",
        pubDate: "Wed, 08 May 2026 10:00:00 GMT",
        description: "New utility-scale battery deployment milestone in Hamburg.",
      }),
    ]);

    (globalThis as { fetch: typeof fetch }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => rssBody,
    }) as unknown as typeof fetch;

    const result = await getCuratedNewsFeed(5);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].categories).toContain("tesla_megapack");
    expect(result.items[0].categories).toContain("germany");
    expect(result.items[0].categories).toContain("industry_milestone");
  });

  it("deduplicates duplicate entries from sources", async () => {
    const rssBody = makeRss([
      makeItem({
        title: "Germany battery storage regulation update",
        link: "https://example.com/shared",
        pubDate: "Wed, 08 May 2026 10:00:00 GMT",
        description: "Regulatory reform for storage assets.",
      }),
      makeItem({
        title: "Germany battery storage regulation update",
        link: "https://example.com/shared",
        pubDate: "Wed, 08 May 2026 10:00:00 GMT",
        description: "Duplicate item.",
      }),
    ]);

    (globalThis as { fetch: typeof fetch }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => rssBody,
    }) as unknown as typeof fetch;

    const result = await getCuratedNewsFeed(10);
    const shared = result.items.filter((item) => item.url === "https://example.com/shared");
    expect(shared).toHaveLength(1);
  });
});
