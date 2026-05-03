# Product intent — Tesla BESS Sales Engineer (Hamburg)

This app is a **portfolio / interview demo** aligned with the Hamburg **Sales Engineer / Electrical Engineer, BESS** role: technical Megapack sizing, indicative DE-market economics, site context on a Germany-centric map, and a **PDF proposal** that mirrors the live financial model.

## Job mapping

| Responsibility (posting) | Feature |
|--------------------------|---------|
| Technical BESS expert; customer fit | [MegapackConfigurator.tsx](../components/MegapackConfigurator.tsx) — power, energy, footprint, weight, RTE |
| Translate requirements; documentation | [GenerateProposalButton.tsx](../components/GenerateProposalButton.tsx) — PDF with configuration, assumptions, exclusions |
| Financial / market models; tariffs & regulation (awareness) | [FinancialDashboard.tsx](../components/FinancialDashboard.tsx) + [lib/bessEconomics.ts](../lib/bessEconomics.ts) — illustrative scenarios, not legal/tariff data |
| Preliminary design / site | [MegapackMap.tsx](../components/MegapackMap.tsx) — WGS84 markers; appendix in PDF |
| Sales cycle consistency | Shared [`computeEconomics`](lib/bessEconomics.ts) + [`useProjectStore`](lib/projectStore.ts) so UI and PDF stay aligned |

## Model disclaimer

Economics are **indicative pre-sales** only (see footnotes in UI and PDF). Throughput uses **nameplate MWh × full-cycle equivalents/day × 365 × RTE** — a simplified narrative model, not a dispatch optimization or investment recommendation.

## State model

- **`liveConfiguration`**: current configurator preview.
- **`selectedConfigurations`**: blocks added via “Add to Project”; finance aggregates these when non-empty.
- **`economicsAssumptions`**: user inputs validated via zod (`parseEconomicsAssumptions`).
- **`sitePlacements`**: map markers with optional `linkedLabel` from the live preview.
