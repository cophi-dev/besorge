import { buildXPostIntentUrl } from "@/lib/xIntent";

describe("buildXPostIntentUrl", () => {
  it("encodes text, url, and optional via", () => {
    const url = buildXPostIntentUrl({
      text: "Hello & test",
      url: "https://example.com/path?q=1",
      via: "@acme",
    });
    expect(url.startsWith("https://twitter.com/intent/tweet?")).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("text")).toBe("Hello & test");
    expect(parsed.searchParams.get("url")).toBe("https://example.com/path?q=1");
    expect(parsed.searchParams.get("via")).toBe("acme");
  });

  it("strips @ from via", () => {
    const url = buildXPostIntentUrl({
      text: "x",
      url: "https://a.de",
      via: "handle",
    });
    expect(url).toContain("via=handle");
  });
});
