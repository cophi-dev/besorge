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

## Daily Energy Balance KPI Definitions

- **Primary KPI — Daily total net balance:** `Σ(total generation − load)` across all available 15-minute points for the Berlin day. Displayed as `+X,X GWh surplus` or `−X,X GWh deficit`. This is the factual system balance and includes conventional generation plus import-backed coverage.
- **Gross structural surplus energy:** sum of `(generation − load) × ¼ h` over quarter-hours where structural net is positive (only the surplus side; not the same as the day’s net balance).
- **Curtailed energy / charge opportunity add-on:** when authenticated Netztransparenz curtailment data is available, quarter-hour `curtailmentMw × ¼ h` is treated as extra battery charging opportunity on top of the published Energy-Charts structural surplus. It does **not** rewrite the published `generation − load` net trace.
- **Gross structural deficit energy (simulation / coverage):** sum of `|generation − load| × ¼ h` over quarter-hours where structural net is negative.
- **Modeled absorbed charge-opportunity share / served deficit share:** under the greedy lossless walk at the recommended **energy** and **balanced power** cap, the fraction of total charge opportunity charged and the fraction of gross structural deficit energy met from storage. Charge opportunity equals gross structural surplus plus curtailed energy when that authenticated Zusatzreihe is available. **Starting SoC** for the day matches the Germany chart: stitched from simulated prior calendar days when those feeds load (same as `computeStitchedPracticalInitialSocMwh`), otherwise empty. Hero briefing and chart KPIs use this same walk so headline percentages match what the simulated trace implies.
- **Grid imbalance damping (Σ|slot|):** `1 − Σ|adjusted net MWh per slot| / Σ|raw net MWh per slot|` after applying the same greedy BESS model (including the same initial SoC stitch where applicable); not the average of the two gross-energy shares.
- **Scope:** hero “daily story” figures use the full Berlin calendar day from [`buildMorningBriefingContext`](lib/morningBriefingContext.ts); Germany-chart KPI strips use the chart’s selected time window (`MethodologySection` on the homepage).
- **Observed uncaptured structural surplus (fleet, live series):** Sum over quarter-hours with positive structural surplus `(domestic generation excluding the battery stack − load) × ¼ h`, minus `min(that surplus, −battery MW × ¼ h)` when the Energy-Charts battery series is negative (treated as fleet charging). Reported on the home quick stats from `/api/market/de`, not from the dispatch simulator.
- **Secondary KPI — Renewable deficit:** `Σ(renewable generation − load)` across the same available 15-minute points. This remains relevant for BESS charging logic because it indicates how much daytime charging can be attributed to renewable energy alone.
- **Daily story intra-day bands (Berlin clock, sampled slots only):** *Day core* 10–16, *evening ramp* 17–21, *overnight / early base* 22–09 (see `morningBriefingContext` hour constants); peak surplus/deficit Berlin hours summarize hourly structural totals from those same quarters.
- **Estimated evening fleet SoC:** rule-based band from live renewable share and recent solar-rich days (`high`, `moderate`, `low`, `unknown`) to avoid opaque black-box inference.
- **Effective evening gap (SoC-adjusted):** `max(0; gross evening gap − installed power × SoC midpoint)`. This is the dispatch-relevant residual gap after estimated fleet discharge headroom.
