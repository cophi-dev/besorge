import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { BriefingDailyStory } from "@/components/briefing/BriefingDailyStory";

const goodPayload = {
  dateBerlin: "2026-05-09",
  language: "en" as const,
  source: "llm" as const,
  retrievedAtIso: "2026-05-09T18:00:00.000Z",
  context: {
    netStructuralBalanceGwh: -47.1,
    pointFractionOfDay: 0.85,
    samplePoints: 82,
    fleet: { powerGw: 18.3, capacityGwh: 27.9 },
    simulated: {
      practicalCapacityGwh: 18.4,
      balancedPowerMw: 9200,
      gridImpactReductionPct: 31.2,
      absorbedSurplusShare: 0.47,
      servedDeficitShare: 0.22,
    },
  },
  story: {
    headline: "Evening ramp dragged the system into deficit while midday solar covered the day.",
    narrative:
      "Generation trailed load by 47.1 GWh today. Solar carried lunch with a comfortable surplus, but the 18:00–21:00 ramp pulled the system into a deep deficit.",
    counterfactual:
      "A right-sized 18.4 GWh / 9.2 GW BESS would have flattened ~31% of the grid imbalance.",
    dataAsOfNote: "Based on the first 85% of today's quarter-hours.",
  },
};

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("BriefingDailyStory", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.resetAllMocks();
  });

  it("shows a skeleton while loading", () => {
    global.fetch = jest.fn().mockReturnValue(new Promise(() => {})) as unknown as typeof fetch;

    const { container } = render(
      <BriefingDailyStory language="en" dateKey="2026-05-09" />
    );

    expect(container.querySelector('section[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByText(/Drafting today's analyst note/i)).toBeInTheDocument();
  });

  it("renders the LLM story on success", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => goodPayload,
    }) as unknown as typeof fetch;

    render(<BriefingDailyStory language="en" dateKey="2026-05-09" />);

    await waitFor(() =>
      expect(screen.getByText(goodPayload.story.headline)).toBeInTheDocument()
    );
    expect(screen.getByText(goodPayload.story.narrative)).toBeInTheDocument();
    expect(screen.getByText(goodPayload.story.counterfactual)).toBeInTheDocument();
    expect(screen.getByText(/Aether analyst \(LLM\)/i)).toBeInTheDocument();
    expect(screen.getByText(goodPayload.story.dataAsOfNote!)).toBeInTheDocument();
  });

  it("flags the deterministic fallback in the footer", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...goodPayload, source: "fallback_numeric" }),
    }) as unknown as typeof fetch;

    render(<BriefingDailyStory language="en" dateKey="2026-05-09" />);
    await waitFor(() =>
      expect(
        screen.getByText(/Aether analyst \(deterministic — model offline\)/i)
      ).toBeInTheDocument()
    );
  });

  it("renders DE strings when language=de", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...goodPayload, language: "de" }),
    }) as unknown as typeof fetch;

    render(<BriefingDailyStory language="de" dateKey="2026-05-09" />);

    // Wait for a label that only renders post-load (the kicker is always
    // visible, so it's not a reliable load-completion signal).
    await waitFor(() =>
      expect(
        screen.getByText(/Was ein optimaler BESS bewirkt hätte/i)
      ).toBeInTheDocument()
    );
    expect(screen.getByText(/Story des Tages/i)).toBeInTheDocument();
  });

  it("shows error state and recovers when retried", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => goodPayload });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<BriefingDailyStory language="en" dateKey="2026-05-09" />);

    await waitFor(() =>
      expect(
        screen.getByText(/Could not draft today's analyst note/i)
      ).toBeInTheDocument()
    );

    const retry = screen.getByRole("button", { name: /Retry/i });
    fireEvent.click(retry);

    await waitFor(() =>
      expect(screen.getByText(goodPayload.story.headline)).toBeInTheDocument()
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("re-fetches when refreshNonce changes", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => goodPayload,
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { rerender } = render(
      <BriefingDailyStory language="en" dateKey="2026-05-09" refreshNonce={0} />
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(
      <BriefingDailyStory language="en" dateKey="2026-05-09" refreshNonce={1} />
    );
    await flushAsync();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("aborts in-flight request when the date changes", async () => {
    const abortSpy = jest.fn();
    let capturedSignal: AbortSignal | null = null;
    global.fetch = jest.fn((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? null;
      capturedSignal?.addEventListener("abort", abortSpy);
      return new Promise(() => {});
    }) as unknown as typeof fetch;

    const { rerender } = render(
      <BriefingDailyStory language="en" dateKey="2026-05-09" />
    );
    rerender(<BriefingDailyStory language="en" dateKey="2026-05-08" />);

    await waitFor(() => expect(abortSpy).toHaveBeenCalled());
  });
});
