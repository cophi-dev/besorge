import {
  applyBriefingStoryWindowToSearchParams,
  energyFlowSelectorStateFromStoryWindow,
  parseBriefingStoryWindowFromSearchParams,
} from "@/lib/briefingStoryWindow";

describe("parseBriefingStoryWindowFromSearchParams", () => {
  it("prefers week over date when both are present", () => {
    const params = new URLSearchParams("date=2026-05-11&week=2026-W20");
    expect(parseBriefingStoryWindowFromSearchParams(params)?.type).toBe("week");
  });

  it("parses custom range", () => {
    const params = new URLSearchParams("start=2026-05-01&end=2026-05-07");
    expect(parseBriefingStoryWindowFromSearchParams(params)).toEqual({
      type: "custom",
      start: "2026-05-01",
      end: "2026-05-07",
    });
  });
});

describe("applyBriefingStoryWindowToSearchParams", () => {
  it("sets only week and clears date", () => {
    const params = new URLSearchParams("date=2026-05-11&sim=1");
    applyBriefingStoryWindowToSearchParams({ type: "week", weekKey: "2026-W20" }, params);
    expect(params.get("week")).toBe("2026-W20");
    expect(params.has("date")).toBe(false);
    expect(params.get("sim")).toBe("1");
  });
});

describe("energyFlowSelectorStateFromStoryWindow", () => {
  it("maps week window to week selector mode", () => {
    const state = energyFlowSelectorStateFromStoryWindow(
      { type: "week", weekKey: "2026-W20" },
      "2026-05-18"
    );
    expect(state.mode).toBe("week");
    expect(state.selectedWeek).toBe("2026-W20");
    expect(state.selectedDate).toBe("2026-05-11");
  });
});
