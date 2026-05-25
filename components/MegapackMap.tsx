"use client";

import "leaflet/dist/leaflet.css";

import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { MapContainer, Marker, Rectangle, TileLayer, Tooltip, useMap, ZoomControl } from "react-leaflet";

import type { GermanyBessProject } from "@/lib/germanyBessProjects";
import { Skeleton } from "@/components/ui/skeleton";
const DEFAULT_CENTER: [number, number] = [53.5511, 9.9937];
const DEFAULT_ZOOM = 6;

type Rgb = [number, number, number];

const HEAT_COLOR_STOPS: Array<{ at: number; color: Rgb }> = [
  { at: 0, color: [12, 34, 94] },
  { at: 0.18, color: [29, 78, 216] },
  { at: 0.38, color: [8, 145, 178] },
  { at: 0.56, color: [34, 197, 94] },
  { at: 0.74, color: [250, 204, 21] },
  { at: 0.9, color: [249, 115, 22] },
  { at: 1, color: [220, 38, 38] },
];

const knownProjectIcon = L.divIcon({
  className: "known-bess-marker",
  html: `
    <div style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:9999px;background:radial-gradient(circle at 30% 24%, #fde68a 0%, #f59e0b 48%, #b45309 100%);border:2px solid rgba(255,255,255,0.98);box-shadow:0 10px 20px rgba(15,23,42,0.35);backdrop-filter:blur(1.5px);">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="4" y="7" width="13.2" height="10" rx="2.1" fill="#1f2937"/>
        <rect x="17.8" y="10.4" width="1.8" height="3.2" rx="0.6" fill="#1f2937"/>
        <rect x="6.1" y="9.2" width="2.2" height="5.6" rx="0.8" fill="#f8fafc"/>
        <rect x="9.3" y="9.2" width="2.2" height="5.6" rx="0.8" fill="#f8fafc"/>
        <rect x="12.5" y="9.2" width="2.2" height="5.6" rx="0.8" fill="#f8fafc"/>
      </svg>
    </div>
  `,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
});

const CAPACITY_FORMATTER = new Intl.NumberFormat("de-DE", {
  maximumFractionDigits: 2,
});
const POWER_GW_DIVISOR = 1_000;
const CURATED_MAP_MIN_MW = 10;
const MASTR_MAP_MARKER_MIN_MW = 10;
const MAP_PROJECTS_FETCH_MS = 45_000;
const HEATMAP_GRID_DEGREES = 0.2;

const lerp = (start: number, end: number, t: number) => start + (end - start) * t;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

const heatColorForIntensity = (intensity: number) => {
  const clamped = Math.max(0, Math.min(1, intensity));
  for (let index = 0; index < HEAT_COLOR_STOPS.length - 1; index += 1) {
    const start = HEAT_COLOR_STOPS[index];
    const end = HEAT_COLOR_STOPS[index + 1];
    if (clamped >= start.at && clamped <= end.at) {
      const localT = (clamped - start.at) / (end.at - start.at || 1);
      const eased = easeOutCubic(localT);
      return `rgb(${Math.round(lerp(start.color[0], end.color[0], eased))}, ${Math.round(
        lerp(start.color[1], end.color[1], eased)
      )}, ${Math.round(lerp(start.color[2], end.color[2], eased))})`;
    }
  }
  const fallback = HEAT_COLOR_STOPS[HEAT_COLOR_STOPS.length - 1].color;
  return `rgb(${fallback[0]}, ${fallback[1]}, ${fallback[2]})`;
};

// Coarse Germany outline for client-side clipping of gradient cells.
const GERMANY_POLYGON: Array<[number, number]> = [
  [54.9, 8.0],
  [54.6, 8.6],
  [54.5, 10.2],
  [54.7, 12.0],
  [54.4, 13.7],
  [53.7, 14.2],
  [52.9, 14.6],
  [51.8, 14.7],
  [50.9, 14.2],
  [50.2, 12.9],
  [49.5, 12.5],
  [48.9, 13.0],
  [47.7, 12.4],
  [47.5, 10.5],
  [47.6, 9.6],
  [47.6, 8.4],
  [48.2, 7.6],
  [49.0, 7.6],
  [49.6, 6.3],
  [50.3, 6.0],
  [50.9, 6.2],
  [51.4, 6.1],
  [51.7, 6.6],
  [52.3, 7.1],
  [53.0, 7.1],
  [53.6, 7.0],
  [54.2, 7.6],
  [54.9, 8.0],
];

const isPointInPolygon = (lat: number, lng: number, polygon: Array<[number, number]>) => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [latI, lngI] = polygon[i];
    const [latJ, lngJ] = polygon[j];
    const intersects =
      lngI > lng !== lngJ > lng &&
      lat < ((latJ - latI) * (lng - lngI)) / (lngJ - lngI + Number.EPSILON) + latI;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
};

const formatAdaptivePower = (powerMw: number) => {
  if (powerMw >= POWER_GW_DIVISOR) {
    return `${CAPACITY_FORMATTER.format(powerMw / POWER_GW_DIVISOR)} GW`;
  }
  return `${CAPACITY_FORMATTER.format(powerMw)} MW`;
};

const formatAdaptiveEnergy = (energyMwh: number) => {
  if (energyMwh >= POWER_GW_DIVISOR) {
    return `${CAPACITY_FORMATTER.format(energyMwh / POWER_GW_DIVISOR)} GWh`;
  }
  return `${CAPACITY_FORMATTER.format(energyMwh)} MWh`;
};

function MapSizeInvalidator({ resizeSignal }: { resizeSignal: number }) {
  const map = useMap();

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      map.invalidateSize(true);
    }, 120);
    return () => window.clearTimeout(timeoutId);
  }, [map, resizeSignal]);

  return null;
}

export default function MegapackMap({ compact = false }: { compact?: boolean }) {
  const [showCommercialProjects, setShowCommercialProjects] = useState(true);
  const [showResidentialDensity, setShowResidentialDensity] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [mapResizeSignal, setMapResizeSignal] = useState(0);
  const [knownProjects, setKnownProjects] = useState<GermanyBessProject[]>([]);
  const [knownProjectsSource, setKnownProjectsSource] = useState<"mastr_zenodo" | "fallback" | null>(null);
  const [knownProjectsCacheNote, setKnownProjectsCacheNote] = useState<string | null>(null);
  const [knownProjectsFallbackReason, setKnownProjectsFallbackReason] = useState<string | null>(null);
  const [knownProjectsError, setKnownProjectsError] = useState<string | null>(null);
  const [knownProjectsLoading, setKnownProjectsLoading] = useState(true);
  const [smallProjectsSummary, setSmallProjectsSummary] = useState({
    count: 0,
    powerMw: 0,
    energyMwh: 0,
  });
  const [smallProjectsHeatmap, setSmallProjectsHeatmap] = useState<
    Array<{ lat: number; lng: number; count: number; powerMw: number; energyMwh: number }>
  >([]);
  const [nationalInstalledEnergyGwh, setNationalInstalledEnergyGwh] = useState<number | null>(null);
  const [nationalInstalledPowerGw, setNationalInstalledPowerGw] = useState<number | null>(null);
  const mapWrapperRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const visibleKnownProjects = useMemo(() => knownProjects, [knownProjects]);
  const mapVisibleMinMw =
    knownProjectsSource === "mastr_zenodo" ? MASTR_MAP_MARKER_MIN_MW : CURATED_MAP_MIN_MW;
  const aggregatedBucketLabel =
    knownProjectsSource === "mastr_zenodo" ? "<10 MW MaStR units" : "Hidden smaller sites (0-10 MW)";
  const maxHeatCellPowerMw = useMemo(
    () => smallProjectsHeatmap.reduce((max, cell) => Math.max(max, cell.powerMw), 0),
    [smallProjectsHeatmap]
  );
  const gradientCells = useMemo(
    () =>
      smallProjectsHeatmap.filter((cell) => isPointInPolygon(cell.lat, cell.lng, GERMANY_POLYGON)),
    [smallProjectsHeatmap]
  );

  useEffect(() => {
    return () => {
      try {
        mapInstanceRef.current?.remove();
      } finally {
        mapInstanceRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), MAP_PROJECTS_FETCH_MS);

    const loadKnownProjects = async () => {
      try {
        const response = await fetch("/api/map/bess-projects/de", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(`Request failed: ${response.status}`);
        }
        const payload = (await response.json()) as {
          source: "mastr_zenodo" | "fallback";
          projects: GermanyBessProject[];
          smallProjectsSummary?: { count: number; powerMw: number; energyMwh: number };
          smallProjectsHeatmap?: Array<{
            lat: number;
            lng: number;
            count: number;
            powerMw: number;
            energyMwh: number;
          }>;
          fallbackReason?: string;
          cache?: { fromDisk?: boolean; note?: string; ageMs?: number };
        };
        if (!controller.signal.aborted) {
          setKnownProjects(payload.projects);
          setKnownProjectsSource(payload.source);
          setKnownProjectsCacheNote(payload.cache?.note ?? null);
          setKnownProjectsFallbackReason(payload.fallbackReason ?? null);
          setSmallProjectsSummary(
            payload.smallProjectsSummary ?? { count: 0, powerMw: 0, energyMwh: 0 }
          );
          setSmallProjectsHeatmap(payload.smallProjectsHeatmap ?? []);
          setKnownProjectsError(null);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setKnownProjectsError(error instanceof Error ? error.message : "Unknown error");
        }
      } finally {
        if (!controller.signal.aborted) {
          setKnownProjectsLoading(false);
        }
      }
    };

    void loadKnownProjects();

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const loadNationalCapacity = async () => {
      try {
        const response = await fetch("/api/market/de", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) {
          return;
        }
        const payload = (await response.json()) as {
          bess?: { installedCapacityGwh?: number; installedPowerGw?: number };
        };
        const capacityGwh = payload.bess?.installedCapacityGwh;
        const powerGw = payload.bess?.installedPowerGw;
        if (!controller.signal.aborted && typeof capacityGwh === "number" && Number.isFinite(capacityGwh)) {
          setNationalInstalledEnergyGwh(capacityGwh);
        }
        if (!controller.signal.aborted && typeof powerGw === "number" && Number.isFinite(powerGw)) {
          setNationalInstalledPowerGw(powerGw);
        }
      } catch {
        // Keep rendering map layer even if national reference cannot be loaded.
      }
    };
    loadNationalCapacity();
    return () => controller.abort();
  }, []);

  const handleToggleFullscreen = async () => {
    const wrapperElement = mapWrapperRef.current;
    if (!wrapperElement) {
      return;
    }

    try {
      if (document.fullscreenElement === wrapperElement) {
        await document.exitFullscreen();
        return;
      }
      await wrapperElement.requestFullscreen();
    } catch {
      // Ignore browser-specific fullscreen failures and keep map interactive.
    }
  };

  useEffect(() => {
    const onFullscreenChange = () => {
      const fullscreenActive = document.fullscreenElement === mapWrapperRef.current;
      setIsFullscreen(fullscreenActive);
      setMapResizeSignal((current) => current + 1);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  return (
    <section className={compact ? "rounded-2xl border border-slate-300/45 bg-white/70 p-4 dark:border-slate-500/35 dark:bg-slate-900/40" : "glass-card rounded-2xl p-6"}>
      {!compact ? (
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-blue-600 dark:text-blue-300">
            Site and deployment context
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-900 dark:text-white">
            Interactive Germany and Hamburg map
          </h2>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            Explore utility-scale and residential BESS density across Germany with an interactive
            geographic layer.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCommercialProjects((current) => !current)}
          className="rounded-full border border-slate-300/60 bg-white/70 px-4 py-2 text-xs font-medium text-slate-700 transition hover:border-amber-400 hover:text-amber-700 dark:border-slate-500/35 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-amber-300 dark:hover:text-amber-200"
        >
          {showCommercialProjects ? "Hide" : "Show"} commercial BESS projects
        </button>
        <button
          type="button"
          onClick={() => setShowResidentialDensity((current) => !current)}
          className="rounded-full border border-slate-300/60 bg-white/70 px-4 py-2 text-xs font-medium text-slate-700 transition hover:border-cyan-500 hover:text-cyan-700 dark:border-slate-500/35 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-cyan-300 dark:hover:text-cyan-200"
        >
          {showResidentialDensity ? "Hide" : "Show"} residential density
        </button>
        <button
          type="button"
          onClick={() => void handleToggleFullscreen()}
          className="rounded-full border border-slate-300/60 bg-white/70 px-4 py-2 text-xs font-medium text-slate-700 transition hover:border-indigo-400 hover:text-indigo-700 dark:border-slate-500/35 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:border-indigo-300 dark:hover:text-indigo-200"
        >
          {isFullscreen ? "Exit fullscreen" : "Fullscreen map"}
        </button>
      </div>
      ) : null}

      <div
        ref={mapWrapperRef}
        className={`overflow-hidden rounded-xl border border-slate-300/60 bg-slate-950 dark:border-slate-500/30 ${isFullscreen ? "h-screen w-screen rounded-none border-none" : ""}`}
      >
        <MapContainer
          ref={mapInstanceRef}
          center={DEFAULT_CENTER}
          zoom={DEFAULT_ZOOM}
          className={isFullscreen ? "h-screen w-screen" : compact ? "h-[min(58vw,280px)] min-h-[220px] w-full sm:h-[340px] md:h-[460px]" : "h-[min(72vw,460px)] min-h-[260px] w-full sm:h-[460px]"}
          scrollWheelZoom={!compact}
          doubleClickZoom={!compact}
        >
          <ZoomControl position="bottomright" />
          <MapSizeInvalidator resizeSignal={mapResizeSignal} />
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {showResidentialDensity && knownProjectsSource === "mastr_zenodo"
            ? gradientCells.map((cell, index) => {
                const intensity =
                  maxHeatCellPowerMw > 0 ? Math.sqrt(cell.powerMw / maxHeatCellPowerMw) : 0;
                const color = heatColorForIntensity(intensity);
                const half = HEATMAP_GRID_DEGREES / 2;
                return (
                  <Rectangle
                    key={`small-cell-${index}-${cell.lat}-${cell.lng}`}
                    bounds={[
                      [cell.lat - half, cell.lng - half],
                      [cell.lat + half, cell.lng + half],
                    ]}
                    pathOptions={{
                      stroke: intensity > 0.35,
                      color: "rgba(255,255,255,0.28)",
                      weight: 0.7,
                      fillColor: color,
                      fillOpacity: 0.2 + intensity * 0.74,
                    }}
                  >
                    <Tooltip direction="top" offset={[0, -8]} opacity={1}>
                      {aggregatedBucketLabel}
                      <br />
                      {cell.count.toLocaleString("de-DE")} units
                      <br />
                      {formatAdaptivePower(cell.powerMw)} / {formatAdaptiveEnergy(cell.energyMwh)}
                    </Tooltip>
                  </Rectangle>
                );
              })
            : null}
          {showCommercialProjects
            ? visibleKnownProjects.map((project) => (
                <Marker key={project.id} icon={knownProjectIcon} position={[project.lat, project.lng]}>
                  <Tooltip direction="top" offset={[0, -12]} opacity={1}>
                    {project.name} — {project.city}
                    <br />
                    {project.operator} |{" "}
                    {project.powerMw > 0
                      ? formatAdaptivePower(project.powerMw)
                      : "Power n/a"}
                    {" / "}
                    {project.energyMwh > 0
                      ? `${formatAdaptiveEnergy(project.energyMwh)}${project.energySource === "estimated" ? " (est. 2h)" : ""}`
                      : "Energy n/a"}
                    <br />
                    {project.coordinateQuality === "bundesland_approx" ? (
                      <>
                        Location: approximate (Bundesland centroid)
                        <br />
                      </>
                    ) : null}
                    Status: {project.status}
                  </Tooltip>
                </Marker>
              ))
            : null}
        </MapContainer>
      </div>
      {showResidentialDensity && knownProjectsSource === "mastr_zenodo" ? (
        <div className="mt-2 rounded-lg border border-slate-300/60 bg-white/75 px-3 py-2 text-xs text-slate-700 dark:border-slate-500/30 dark:bg-slate-900/60 dark:text-slate-200">
          <p className="font-medium">Small-unit density (&lt;10 MW) legend</p>
          <div
            className="mt-1 h-2 w-full rounded"
            style={{
              background:
                "linear-gradient(90deg, rgb(12,34,94) 0%, rgb(29,78,216) 18%, rgb(8,145,178) 38%, rgb(34,197,94) 56%, rgb(250,204,21) 74%, rgb(249,115,22) 90%, rgb(220,38,38) 100%)",
            }}
          />
          <div className="mt-1 flex items-center justify-between text-[11px] text-slate-600 dark:text-slate-300">
            <span>Low density</span>
            <span>High density</span>
          </div>
        </div>
      ) : null}

      {!compact && (showCommercialProjects || showResidentialDensity) ? (
        <div className="mt-4 rounded-xl border border-amber-400/35 bg-amber-500/10 p-4 text-sm text-slate-700 dark:text-slate-200">
          <p className="text-[11px] uppercase tracking-[0.1em] text-amber-700/85 dark:text-amber-300/85">
            DE BESS map (
            {knownProjectsSource === "mastr_zenodo"
              ? "MaStR extract"
              : knownProjectsSource === "fallback"
                ? "curated fallback"
                : "live layer"}
            )
          </p>
          <div className="mt-3 grid gap-2 lg:grid-cols-2">
            <div className="rounded-lg border border-amber-400/40 bg-white/70 p-3 dark:bg-slate-900/50">
              <p className="text-[11px] uppercase tracking-[0.08em] text-slate-600/85 dark:text-slate-300/85">
                National benchmark (Energy-Charts)
              </p>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-300">Installed capacity</p>
                  <p className="text-3xl font-extrabold text-slate-900 dark:text-white">
                    {nationalInstalledEnergyGwh !== null
                      ? `${CAPACITY_FORMATTER.format(nationalInstalledEnergyGwh)} GWh`
                      : "n/a"}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-300">Installed power</p>
                  <p className="text-3xl font-extrabold text-slate-900 dark:text-white">
                    {nationalInstalledPowerGw !== null
                      ? `${CAPACITY_FORMATTER.format(nationalInstalledPowerGw)} GW`
                      : "n/a"}
                  </p>
                </div>
              </div>
            </div>
            <div className="rounded-lg border border-amber-400/40 bg-white/70 p-3 dark:bg-slate-900/50">
              <p className="text-[11px] uppercase tracking-[0.08em] text-slate-600/85 dark:text-slate-300/85">
                Map layer (MaStR geolocation)
              </p>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-300">
                    Small-unit heat layer (&lt;10 MW)
                  </p>
                  <p className="text-3xl font-extrabold text-slate-900 dark:text-white">
                    {smallProjectsSummary.count.toLocaleString("de-DE")}
                  </p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-300">
                    geolocated units in heat layer
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-300">
                    Utility-scale sites (≥{mapVisibleMinMw} MW)
                  </p>
                  <p className="text-3xl font-extrabold text-slate-900 dark:text-white">
                    {visibleKnownProjects.length.toLocaleString("de-DE")}
                  </p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-300">
                    geolocated utility-scale sites
                  </p>
                </div>
              </div>
            </div>
          </div>
          <div className="mt-3 rounded-lg border border-amber-300/30 bg-white/55 p-3 dark:bg-slate-900/35">
            <p className="text-[10px] uppercase tracking-[0.08em] text-slate-500/90 dark:text-slate-300/85">
              Source note
            </p>
            <p className="mt-1 text-xl font-semibold text-slate-900 dark:text-white">
              Capacity and power from Energy-Charts
            </p>
            <p className="text-xs text-slate-600 dark:text-slate-300">
              MaStR provides location context only (heatmap and pins).
            </p>
          </div>
          <div className="mt-1 text-xs text-slate-600 dark:text-slate-300">
            {knownProjectsLoading ? (
              <div className="space-y-1">
                <Skeleton className="h-3 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
            ) : (
              <p>
                Data source:{" "}
                {knownProjectsSource === "mastr_zenodo"
                  ? "Bundled MaStR snapshot"
                  : knownProjectsSource === "fallback"
                    ? "Fallback curated list"
                    : knownProjectsError
                      ? "Unavailable (request timed out or network error)"
                      : "Unknown"}
              </p>
            )}
          </div>
          {knownProjectsCacheNote ? (
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">Cache: {knownProjectsCacheNote}</p>
          ) : null}
          {knownProjectsSource === "fallback" && knownProjectsFallbackReason ? (
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
              Fallback reason: {knownProjectsFallbackReason}
            </p>
          ) : null}
          {knownProjectsError ? (
            <p className="mt-1 text-xs text-red-700 dark:text-red-200">
              Could not refresh live project layer: {knownProjectsError}
            </p>
          ) : null}
        </div>
      ) : null}

    </section>
  );
}
