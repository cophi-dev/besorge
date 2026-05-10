import { inferFleetModeFromChartTail } from "@/lib/chartFleetSocSnapshot";

const baseLast = {
  estimatedFleetSocPct: 50,
  simulatedPracticalSocPct: 50,
  netBalanceMw: 0,
  practicalChargeMw: 0,
  practicalDischargeMw: 0,
  fleetChargeMw: 0,
  fleetDischargeMw: 0,
};

describe("inferFleetModeFromChartTail", () => {
  it("uses fleet SoC step when the fleet-capacity view is active", () => {
    const mode = inferFleetModeFromChartTail({
      showSimulatedNet: false,
      last: { ...baseLast, estimatedFleetSocPct: 62 },
      previous: { ...baseLast, estimatedFleetSocPct: 58 },
    });
    expect(mode).toBe("charging");
  });

  it("falls back to net balance on the first slot of the series", () => {
    const mode = inferFleetModeFromChartTail({
      showSimulatedNet: false,
      last: { ...baseLast, estimatedFleetSocPct: 80, netBalanceMw: 3_000 },
      previous: null,
    });
    expect(mode).toBe("charging");
  });

  it("uses practical dispatch MW when practical SoC is flat", () => {
    const mode = inferFleetModeFromChartTail({
      showSimulatedNet: true,
      last: {
        ...baseLast,
        simulatedPracticalSocPct: 55,
        practicalChargeMw: 120,
        practicalDischargeMw: 5,
      },
      previous: {
        ...baseLast,
        simulatedPracticalSocPct: 55,
        practicalChargeMw: 0,
        practicalDischargeMw: 0,
      },
    });
    expect(mode).toBe("charging");
  });

  it("uses fleet dispatch MW when estimated fleet SoC is flat", () => {
    const mode = inferFleetModeFromChartTail({
      showSimulatedNet: false,
      last: {
        ...baseLast,
        estimatedFleetSocPct: 51,
        fleetChargeMw: 90,
        fleetDischargeMw: 2,
      },
      previous: {
        ...baseLast,
        estimatedFleetSocPct: 51,
        fleetChargeMw: 0,
        fleetDischargeMw: 0,
      },
    });
    expect(mode).toBe("charging");
  });
});
