import {
  buildWindowCapacityCandidatesMwh,
  findBenefitMaximizingCapacityMwh,
  resolveWindowCapacitySearchUpperBoundMwh,
} from "@/lib/windowBessCapacityOptimizer";
import type { OptimalCapacitySlotInput } from "@/lib/optimalBessCapacity";

function slot(hour: number, netMw: number): OptimalCapacitySlotInput {
  const load = 100;
  return {
    timestampIso: `2026-05-25T${String(hour).padStart(2, "0")}:00:00.000Z`,
    totalGenerationMw: load + netMw,
    loadMw: load,
    curtailmentMw: null,
  };
}

describe("windowBessCapacityOptimizer", () => {
  const slots: OptimalCapacitySlotInput[] = [
    slot(10, 50),
    slot(11, 50),
    slot(12, -30),
    slot(13, -30),
  ];

  it("caps search upper bound using reference credibility ratio", () => {
    const upper = resolveWindowCapacitySearchUpperBoundMwh(slots, 40_000);
    expect(upper).toBeLessThanOrEqual(40_000 * 2.5 + 1e-6);
    expect(upper).toBeGreaterThan(0);
  });

  it("returns monotonic candidate grid including anchors", () => {
    const upper = resolveWindowCapacitySearchUpperBoundMwh(slots, 10_000);
    const candidates = buildWindowCapacityCandidatesMwh(slots, upper, [5_000]);
    expect(candidates.length).toBeGreaterThan(10);
    expect(candidates[0]).toBeLessThanOrEqual(candidates[candidates.length - 1]!);
    expect(candidates.some((value) => Math.abs(value - 5_000) < 1)).toBe(true);
  });

  it("prefers lower capacity on equal benefit scores", () => {
    const result = findBenefitMaximizingCapacityMwh([100, 200, 300], (capacityMwh) => {
      if (capacityMwh === 300) {
        return 5;
      }
      return 10;
    });
    expect(result?.capacityMwh).toBe(100);
    expect(result?.benefitScore).toBe(10);
  });

  it("picks the highest score when benefits differ", () => {
    const result = findBenefitMaximizingCapacityMwh([100, 200, 300], (capacityMwh) => capacityMwh / 10);
    expect(result?.capacityMwh).toBe(300);
    expect(result?.benefitScore).toBe(30);
  });
});
