import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";

import BessAssessmentCenter from "@/components/BessAssessmentCenter";
import { LanguageContext } from "@/components/language-context";

const renderWithLanguage = (ui: ReactElement, language: "en" | "de" = "en") =>
  render(
    <LanguageContext.Provider value={{ language, setLanguage: jest.fn() }}>{ui}</LanguageContext.Provider>
  );

const mockAssessmentPayload = {
  verdict: "beneficial_now" as const,
  score: 88,
  confidence: 71,
  timeHorizon: "now" as const,
  shortTermSignal: "Short-term signal",
  structuralSignal: "Structural signal",
  scoreBreakdown: {
    volatility: 80,
    adequacy: 77,
    policyAndRegulation: 55,
    marketPressure: 68,
  },
  confidenceDrivers: ["Driver confidence"],
  confidenceLimitations: ["Limitation one"],
  keyDrivers: ["Driver 1"],
  risks: ["Risk 1"],
  recommendedNextActions: ["Action 1"],
  horizonOutlook: {
    now: { recommendation: "Do now", rationale: "Because now." },
    next12m: { recommendation: "Do in 12m", rationale: "Because 12m." },
    next36m: { recommendation: "Do in 36m", rationale: "Because 36m." },
  },
  dataGapsImpact: "Data gaps impact text",
  analystSummary:
    "BESSForge currently reads this window as beneficial now, with recent solar support and constructive near-term recharge conditions.",
  fullAnalysisSummary:
    "Recent renewable patterns and forward profile keep short-term arbitrage windows constructive while maintaining execution discipline.",
  asOf: "2026-05-06T10:00:00.000Z",
};

describe("BessAssessmentCenter", () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it("renders assessment content on success", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => mockAssessmentPayload,
    }) as typeof fetch;

    renderWithLanguage(<BessAssessmentCenter />);

    await waitFor(() => expect(screen.getByText(/Verdict:\s*Beneficial now/i)).toBeInTheDocument());
    expect(screen.getByLabelText("Score gauge 88 out of 100")).toBeInTheDocument();
    expect(screen.getByText(/Confidence 71%/i)).toBeInTheDocument();
    expect(screen.getByText(mockAssessmentPayload.analystSummary)).toBeInTheDocument();
    expect(screen.getByText(/Horizon outlook/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /View full analysis/i })).toBeInTheDocument();
  });

  it("minimal variant hides horizon and full-analysis controls", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...mockAssessmentPayload, score: 62 }),
    }) as typeof fetch;

    renderWithLanguage(<BessAssessmentCenter variant="minimal" />);

    await waitFor(() => expect(screen.getByText(/Verdict:\s*Beneficial now/i)).toBeInTheDocument());
    expect(screen.queryByText(/Horizon outlook/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /View full analysis/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Based on your dispatch simulation/i)).toBeInTheDocument();
  });

  it("renders error state", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ message: "failed" }),
    }) as typeof fetch;

    renderWithLanguage(<BessAssessmentCenter />);
    await waitFor(() => expect(screen.getByText(/Could not run assessment/i)).toBeInTheDocument());
  });
});
