import { getCuratedNewsFeed } from "@/lib/newsIngestion";

jest.mock("next/server", () => ({
  NextResponse: {
    json(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return {
        status: init?.status ?? 200,
        headers: init?.headers ?? {},
        json: async () => data,
      };
    },
  },
}));

jest.mock("@/lib/newsIngestion", () => ({
  getCuratedNewsFeed: jest.fn(),
}));

const mockedGetCuratedNewsFeed = getCuratedNewsFeed as jest.MockedFunction<typeof getCuratedNewsFeed>;
let GET: typeof import("@/app/api/news/route").GET;

describe("GET /api/news", () => {
  beforeAll(async () => {
    ({ GET } = await import("@/app/api/news/route"));
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it("returns curated news payload", async () => {
    mockedGetCuratedNewsFeed.mockResolvedValue({
      asOfIso: "2026-05-08T10:00:00.000Z",
      itemCount: 1,
      items: [
        {
          id: "1",
          title: "Title",
          summary: "Summary",
          sourceName: "Source",
          url: "https://example.com/news",
          publishedAtIso: "2026-05-08T09:00:00.000Z",
          categories: ["germany"],
          relevanceScore: 90,
        },
      ],
    });

    const response = await GET({ url: "http://localhost:3000/api/news?limit=5" } as Request);
    expect(response.status).toBe(200);
    expect(mockedGetCuratedNewsFeed).toHaveBeenCalledWith(5);
    expect((await response.json()).itemCount).toBe(1);
  });

  it("returns 400 for invalid query", async () => {
    const response = await GET({ url: "http://localhost:3000/api/news?limit=200" } as Request);
    expect(response.status).toBe(400);
  });

  it("returns 502 on ingestion failure", async () => {
    mockedGetCuratedNewsFeed.mockRejectedValue(new Error("boom"));
    const response = await GET({ url: "http://localhost:3000/api/news" } as Request);
    expect(response.status).toBe(502);
  });
});
