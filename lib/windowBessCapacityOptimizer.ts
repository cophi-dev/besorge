import {
  CAPACITY_CREDIBILITY_ABSOLUTE_GWH,
  CAPACITY_CREDIBILITY_RATIO_THRESHOLD,
} from "@/lib/indicativeEconomicsDisplay";
import {
  computeLogicalBessRecommendation,
  computeOptimalSurplusDeficitCapacityMwh,
  computePracticalDailyCycleCapacityMwh,
  type OptimalCapacitySlotInput,
} from "@/lib/optimalBessCapacity";

export type WindowCapacityOptimizationResult = {
  capacityMwh: number;
  benefitScore: number;
  upperBoundMwh: number;
  /** True when the best score sits at the search ceiling (diminishing returns not yet reached). */
  hitUpperBound: boolean;
};

export function resolveWindowCapacitySearchUpperBoundMwh(
  slots: OptimalCapacitySlotInput[],
  referenceCapacityMwh: number | null | undefined
): number {
  const continuous = computeOptimalSurplusDeficitCapacityMwh(slots).optimalCapacityMwh;
  const practical = computePracticalDailyCycleCapacityMwh(slots).practicalCapacityMwh;
  const reference =
    referenceCapacityMwh !== null &&
    referenceCapacityMwh !== undefined &&
    referenceCapacityMwh > 0
      ? referenceCapacityMwh
      : practical > 0
        ? practical
        : continuous;

  const fromRatio = reference > 0 ? reference * CAPACITY_CREDIBILITY_RATIO_THRESHOLD : continuous;
  const absoluteCapMwh = CAPACITY_CREDIBILITY_ABSOLUTE_GWH * 1_000;
  const structuralCeiling = continuous > 0 ? continuous * 1.02 : fromRatio;

  return Math.max(
    reference > 0 ? reference : 1,
    Math.min(structuralCeiling, fromRatio, absoluteCapMwh)
  );
}

export function buildWindowCapacityCandidatesMwh(
  slots: OptimalCapacitySlotInput[],
  upperBoundMwh: number,
  extraAnchorsMwh: number[] = []
): number[] {
  const practical = computePracticalDailyCycleCapacityMwh(slots).practicalCapacityMwh;
  const recommendation = computeLogicalBessRecommendation(slots);
  const anchors = [
    practical,
    recommendation.dailyEnergyP95Mwh,
    recommendation.continuousWindowRequiredEnergyMwh,
    ...recommendation.tiers.map((tier) => tier.recommendedEnergyMwh),
    ...extraAnchorsMwh,
    upperBoundMwh,
  ].filter((value) => value > 0 && Number.isFinite(value));

  if (anchors.length === 0) {
    return upperBoundMwh > 0 ? [upperBoundMwh] : [];
  }

  const minAnchor = Math.min(...anchors);
  const maxAnchor = Math.max(minAnchor, upperBoundMwh);
  const candidateSet = new Set<number>();

  for (let step = 0; step <= 28; step += 1) {
    candidateSet.add(minAnchor + ((maxAnchor - minAnchor) * step) / 28);
  }
  for (const anchor of anchors) {
    candidateSet.add(Math.min(anchor, maxAnchor));
  }

  return [...candidateSet]
    .filter((capacity) => capacity > 0 && capacity <= maxAnchor + 1e-6)
    .sort((a, b) => a - b);
}

export function findBenefitMaximizingCapacityMwh(
  candidatesMwh: number[],
  scoreAtCapacity: (capacityMwh: number) => number | null
): WindowCapacityOptimizationResult | null {
  if (candidatesMwh.length === 0) {
    return null;
  }

  let bestCapacityMwh = candidatesMwh[0]!;
  let bestScore = -Infinity;
  let sawFiniteScore = false;

  for (const capacityMwh of candidatesMwh) {
    const score = scoreAtCapacity(capacityMwh);
    if (score === null || !Number.isFinite(score)) {
      continue;
    }
    sawFiniteScore = true;
    if (score > bestScore + 1e-6 || (Math.abs(score - bestScore) <= 1e-6 && capacityMwh < bestCapacityMwh)) {
      bestScore = score;
      bestCapacityMwh = capacityMwh;
    }
  }

  if (!sawFiniteScore) {
    return null;
  }

  const upperBoundMwh = candidatesMwh[candidatesMwh.length - 1] ?? bestCapacityMwh;
  return {
    capacityMwh: bestCapacityMwh,
    benefitScore: bestScore,
    upperBoundMwh,
    hitUpperBound: Math.abs(bestCapacityMwh - upperBoundMwh) <= Math.max(1, upperBoundMwh * 0.01),
  };
}

export function optimizeWindowBessCapacityMwh(
  slots: OptimalCapacitySlotInput[],
  options: {
    referenceCapacityMwh: number | null | undefined;
    extraAnchorsMwh?: number[];
    scoreAtCapacity: (capacityMwh: number) => number | null;
  }
): WindowCapacityOptimizationResult | null {
  const upperBoundMwh = resolveWindowCapacitySearchUpperBoundMwh(slots, options.referenceCapacityMwh);
  const candidatesMwh = buildWindowCapacityCandidatesMwh(
    slots,
    upperBoundMwh,
    options.extraAnchorsMwh ?? []
  );
  return findBenefitMaximizingCapacityMwh(candidatesMwh, options.scoreAtCapacity);
}
