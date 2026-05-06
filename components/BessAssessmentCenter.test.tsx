import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import BessAssessmentCenter from "@/components/BessAssessmentCenter";

describe("BessAssessmentCenter", () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it("renders assessment content on success", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        verdict: "beneficial_now",
        score: 88,
        confidence: 71,
        timeHorizon: "now",
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
          now: { recommendation: "Do now", rationale: "Because now" },
          next12m: { recommendation: "Do in 12m", rationale: "Because 12m" },
          next36m: { recommendation: "Do in 36m", rationale: "Because 36m" },
        },
        dataGapsImpact: "Data gaps impact text",
        asOf: "2026-05-06T10:00:00.000Z",
      }),
    }) as typeof fetch;

    render(<BessAssessmentCenter />);
    expect(screen.getByText("Running assessment...")).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByText(/Verdict:\s*Beneficial now/i)).toBeInTheDocument()
    );
    expect(screen.getByLabelText("Score gauge 88 out of 100")).toBeInTheDocument();
    expect(screen.getByText(/Confidence 71%/i)).toBeInTheDocument();
    expect(screen.getByText("Key Drivers (last 7 days)")).toBeInTheDocument();
    expect(screen.getByLabelText("Volatility impact 80")).toBeInTheDocument();
    expect(screen.getByText("Immediate signal")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /let's talk about it/i })).toBeInTheDocument();
  });

  it("opens ai chat when talk button is clicked", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        verdict: "beneficial_now",
        score: 60,
        confidence: 60,
        timeHorizon: "now",
        shortTermSignal: "signal",
        structuralSignal: "signal",
        scoreBreakdown: {
          volatility: 60,
          adequacy: 60,
          policyAndRegulation: 60,
          marketPressure: 60,
        },
        confidenceDrivers: ["driver"],
        confidenceLimitations: ["limitation"],
        keyDrivers: ["driver"],
        risks: ["risk"],
        recommendedNextActions: ["action"],
        horizonOutlook: {
          now: { recommendation: "now", rationale: "now" },
          next12m: { recommendation: "12m", rationale: "12m" },
          next36m: { recommendation: "36m", rationale: "36m" },
        },
        dataGapsImpact: "impact",
        asOf: "2026-05-06T10:00:00.000Z",
      }),
    }) as typeof fetch;

    const dispatchSpy = jest.spyOn(window, "dispatchEvent");
    render(<BessAssessmentCenter />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /let's talk about it/i })).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /let's talk about it/i }));
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "bessforge:open-ai-chat" }));
    expect(window.location.hash).toBe("#ai-chat");
  });

  it("renders error state", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ message: "failed" }),
    }) as typeof fetch;

    render(<BessAssessmentCenter />);
    await waitFor(() =>
      expect(screen.getByText(/Could not run assessment/i)).toBeInTheDocument()
    );
  });
});
