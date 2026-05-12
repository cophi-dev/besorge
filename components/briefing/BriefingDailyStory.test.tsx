import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { BriefingDailyStory } from "@/components/briefing/BriefingDailyStory";

const goodPayload = {
  dateBerlin: "2026-05-09",
  language: "en" as const,
  source: "llm" as const,
  retrievedAtIso: "2026-05-09T18:00:00.000Z",
  context: {
    netStructuralBalanceGwh: -47.1,
    curtailedEnergyGwh: 3.4,
    curtailmentSlotFractionOfSampled: 1,
    curtailmentStatus: "loaded",
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
    dayShape: {
      structuralNetGwhByWindow: {
        dayCoreGwh: -10.8,
        eveningRampGwh: -22,
        overnightBaseGwh: -14.3,
      },
      renewableNetStructuralBalanceGwh: -38.9,
      renewableSlotFractionOfSampled: 0.94,
      peakSurplusHourBerlin: 13,
      peakDeficitHourBerlin: 19,
    },
    isMultiDayWindow: false,
    rangeStartBerlin: "2026-05-09",
    rangeEndBerlin: "2026-05-09",
  },
  story: {
    headline: "Evening ramp dragged the system into deficit while midday solar covered the day.",
    insights: [
      "Evening ramp hours carry the toughest structural imbalance at −22.0 GWh across published quarters.",
      "Renewable generation minus load, only where renewable MW exists, sits near −38.9 GWh with data in roughly 94% of sampled slots.",
      "Surplus concentration near Berlin local hour 13 contrasts with deepest deficit leaning on hour 19 in the published sample.",
    ],
    narrative:
      "Generation trails load alongside the sharper window contrast spelled out above; −47.1 GWh nets the day's structural imbalance.",
    counterfactual:
      "A right-sized 18.4 GWh / 9.2 GW BESS would have cut summed absolute structural imbalance by ~31%. It would also absorb ~47% of gross charge opportunity and meet ~22% of gross deficit energy from storage.",
    dataAsOfNote: "Based on the first 85% of today's quarter-hours.",
  },
};

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const dayWindow = { type: "day" as const, date: "2026-05-09" };

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
      <BriefingDailyStory language="en" storyWindow={dayWindow} />
    );

    expect(container.querySelector('section[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByText(/Drafting today's analyst note/i)).toBeInTheDocument();
  });

  it("renders the LLM story on success", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => goodPayload,
    }) as unknown as typeof fetch;

    const { container } = render(<BriefingDailyStory language="en" storyWindow={dayWindow} />);

    await waitFor(() =>
      expect(screen.getByText(goodPayload.story.headline)).toBeInTheDocument()
    );
    expect(screen.getByRole("group", { name: /today's signals/i })).toBeInTheDocument();
    expect(screen.getByText(/Day core \(10–16\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Renewables minus load/i)).toBeInTheDocument();
    expect(screen.getByText(/Peak hours/i)).toBeInTheDocument();
    expect(screen.getByText(/Fleet context/i)).toBeInTheDocument();
    expect(screen.getByText(goodPayload.story.insights[0])).toBeInTheDocument();
    expect(screen.getByText(goodPayload.story.narrative)).toBeInTheDocument();
    expect(screen.getByText(goodPayload.story.counterfactual)).toBeInTheDocument();
    expect(screen.getByText(/BESSForge analyst \(LLM\)/i)).toBeInTheDocument();
    expect(screen.getByText(goodPayload.story.dataAsOfNote!)).toBeInTheDocument();
    expect(screen.getByText(/Net balance/i)).toBeInTheDocument();
    expect(screen.getByText(/Data snapshot/i)).toBeInTheDocument();
    expect(screen.getByText(/Modeled BESS/i)).toBeInTheDocument();
    expect(screen.getByText(/9\.2 GW balanced/)).toBeInTheDocument();
    expect(container.textContent ?? "").toMatch(/absorbed \(charge opportunity\)/i);
    expect(container.textContent ?? "").toMatch(/served \(gross deficit\)/i);
    expect(container.textContent ?? "").toMatch(/imbalance smoothing/i);
    expect(container.textContent ?? "").toMatch(/curtailment/i);
    expect(container.textContent ?? "").toMatch(/3\.4 GWh/i);
    expect(screen.getByText(/same published quarter-hours as the signals above/i)).toBeInTheDocument();
    expect(container.textContent ?? "").toMatch(/47%/);
    expect(container.textContent ?? "").toMatch(/22%/);
  });

  it("flags the deterministic fallback in the footer", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...goodPayload, source: "fallback_numeric" }),
    }) as unknown as typeof fetch;

    render(<BriefingDailyStory language="en" storyWindow={dayWindow} />);
    await waitFor(() =>
      expect(
        screen.getByText(/BESSForge analyst \(deterministic — model offline\)/i)
      ).toBeInTheDocument()
    );
  });

  it("renders DE strings when language=de", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...goodPayload, language: "de" }),
    }) as unknown as typeof fetch;

    render(<BriefingDailyStory language="de" storyWindow={dayWindow} />);

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

    render(<BriefingDailyStory language="en" storyWindow={dayWindow} />);

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
      <BriefingDailyStory language="en" storyWindow={dayWindow} refreshNonce={0} />
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(
      <BriefingDailyStory language="en" storyWindow={dayWindow} refreshNonce={1} />
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
      <BriefingDailyStory language="en" storyWindow={dayWindow} />
    );
    rerender(
      <BriefingDailyStory language="en" storyWindow={{ type: "day", date: "2026-05-08" }} />
    );

    await waitFor(() => expect(abortSpy).toHaveBeenCalled());
  });

  it("requests week= for ISO week story windows", async () => {
    const fetchMock = jest.fn().mockReturnValue(new Promise(() => {}));
    global.fetch = fetchMock as unknown as typeof fetch;

    render(
      <BriefingDailyStory language="en" storyWindow={{ type: "week", weekKey: "2026-W19" }} />
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
      const url = String((fetchMock as jest.Mock).mock.calls[0][0]);
      expect(url).toContain("week=2026-W19");
      expect(url).not.toContain("date=");
    });
  });

  it("shows the window reading note for multi-day stories", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...goodPayload,
        dateBerlin: "2026-05-04–2026-05-10",
        context: {
          ...goodPayload.context,
          isMultiDayWindow: true,
          rangeStartBerlin: "2026-05-04",
          rangeEndBerlin: "2026-05-10",
        },
      }),
    }) as unknown as typeof fetch;

    const { container } = render(
      <BriefingDailyStory language="en" storyWindow={{ type: "week", weekKey: "2026-W19" }} />
    );

    await waitFor(() =>
      expect(screen.getByText(/How to read this window/i)).toBeInTheDocument()
    );
    expect(container.textContent ?? "").toContain("2026-05-04");
    expect(container.textContent ?? "").toContain("2026-05-10");
  });
});
