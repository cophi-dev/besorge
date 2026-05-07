import { render, screen, waitFor } from "@testing-library/react";

import NewsPreviewSection from "@/components/NewsPreviewSection";
import { LanguageContext } from "@/components/language-context";

const renderWithLanguage = (language: "en" | "de" = "en") =>
  render(
    <LanguageContext.Provider value={{ language, setLanguage: jest.fn() }}>
      <NewsPreviewSection />
    </LanguageContext.Provider>
  );

describe("NewsPreviewSection", () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it("renders loaded items", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        asOfIso: "2026-05-08T10:00:00.000Z",
        itemCount: 1,
        items: [
          {
            id: "n1",
            title: "Germany BESS regulation updated",
            summary: "A concise summary.",
            sourceName: "News Source",
            url: "https://example.com/item",
            publishedAtIso: "2026-05-08T08:00:00.000Z",
            categories: ["germany", "regulation"],
            relevanceScore: 88,
          },
        ],
      }),
    }) as typeof fetch;

    renderWithLanguage();
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Germany BESS regulation updated/i })).toBeInTheDocument()
    );
    expect(screen.getByText(/A concise summary/i)).toBeInTheDocument();
  });

  it("renders error state", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ message: "failed" }),
    }) as typeof fetch;

    renderWithLanguage("de");
    await waitFor(() =>
      expect(screen.getByText(/Newsfeed ist gerade nicht erreichbar/i)).toBeInTheDocument()
    );
  });
});
