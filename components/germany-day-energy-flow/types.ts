import type { BriefingStoryWindow } from "@/lib/briefingStoryWindow";
import type { ChartFleetSocSnapshot } from "@/lib/chartFleetSocSnapshot";
import type { GermanyDispatchSlotsResponse } from "@/lib/energyChartsApi";

export type SelectorMode = "day" | "week" | "month" | "custom";

export type ChartRow = GermanyDispatchSlotsResponse["slots"][number] & {
  timeLabel: string;
  netBalanceMw: number;
  netAfterPracticalBessMw: number;
  observedCrossBorderMw: number | null;
  simulatedCrossBorderMw: number | null;
  observedImportMw: number;
  observedExportSignedMw: number;
  simulatedImportMw: number;
  simulatedExportSignedMw: number;
  curtailmentDisplayMw: number;
  inferredFleetSocPct: number;
  estimatedFleetSocPct: number;
  simulatedPracticalSocPct: number;
  practicalChargeSignedMw: number;
  practicalChargeMw: number;
  practicalDischargeMw: number;
  fleetChargeSignedMw: number;
  fleetChargeMw: number;
  fleetDischargeMw: number;
};

export type GermanyDayEnergyFlowProps = {
  fleetCapacityGwh?: number | null;
  fleetPowerGw?: number | null;
  language: "en" | "de";
  isRefreshing?: boolean;
  lastUpdatedIso?: string | null;
  onRefresh?: () => void;
  onShare?: () => void;
  shareBusy?: boolean;
  onChartFleetSocSnapshot?: (snapshot: ChartFleetSocSnapshot | null) => void;
  simulationAiInsight?: string | null;
  initialEnergyFlow?: GermanyDispatchSlotsResponse | null;
  initialBerlinDateKey?: string | null;
  seedStoryWindow?: BriefingStoryWindow | null;
  /** @deprecated Use `seedStoryWindow` — kept for tests that only pass a day. */
  seedDateKey?: string | null;
  onStoryWindowUrlChange?: (window: BriefingStoryWindow) => void;
  onBriefingStoryWindowChange?: (window: BriefingStoryWindow) => void;
  briefingStoryWindow?: BriefingStoryWindow | null;
  briefingStoryRefreshNonce?: number;
  initialSimulatedNet?: boolean;
  onSimulatedModeChange?: (simulated: boolean) => void;
};

export type BorderTradeTotals = {
  observedImportEnergyMwh: number;
  observedExportEnergyMwh: number;
  simulatedImportEnergyMwh: number;
  simulatedExportEnergyMwh: number;
  importDeltaEnergyMwh: number;
  exportDeltaEnergyMwh: number;
};

export type ObservedStressMetricTone = "surplus" | "deficit" | "warning" | "neutral";

export type ObservedStressMetricItem = {
  label: string;
  value: string;
  detail?: string;
  tone?: ObservedStressMetricTone;
};
