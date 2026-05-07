import { render, screen } from "@testing-library/react";

import NewsPage from "@/app/news/page";
import { LanguageContext } from "@/components/language-context";

jest.mock("@/components/NewsPreviewSection", () => ({
  __esModule: true,
  default: () => <div data-testid="news-preview-section">News preview</div>,
}));

describe("News page", () => {
  it("renders title and embedded preview section", () => {
    render(
      <LanguageContext.Provider value={{ language: "en", setLanguage: jest.fn() }}>
        <NewsPage />
      </LanguageContext.Provider>
    );

    expect(screen.getByRole("heading", { name: /BESS Market Updates/i })).toBeInTheDocument();
    expect(screen.getByTestId("news-preview-section")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Back to briefing/i })).toHaveAttribute("href", "/");
  });
});
