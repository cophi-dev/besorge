import { parse } from "csv-parse";
import yauzl from "yauzl";

import { createLogger } from "@/lib/debug";
import { GERMANY_BESS_PROJECTS, type GermanyBessProject } from "@/lib/germanyBessProjects";
import { readMastrRepoSnapshotFile, type MastrRepoSnapshotFile } from "@/lib/mastrRepoSnapshot";
import { readMastrSnapshotDisk, writeMastrSnapshotDisk } from "@/lib/mastrSnapshotDiskCache";

const log = createLogger("mastr-zenodo");

const STORAGE_RAW_ZIP_URLS = [
  "https://zenodo.org/records/14843222/files/bnetza_mastr_storage_raw.csv.zip?download=1",
  "https://zenodo.org/api/records/14843222/files/bnetza_mastr_storage_raw.csv.zip/content",
] as const;
const CACHE_TTL_MS = 1000 * 60 * 60 * 12;
/** Parsing the full Zenodo ZIP can exceed hosting limits — override via MASTR_BUILD_TIMEOUT_MS (ms). */
const BUILD_TIMEOUT_MS = (() => {
  const parsed = Number(process.env.MASTR_BUILD_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90_000;
})();
const STALE_MEMORY_CACHE_MS = 60_000;
/** Matches map filter: curated fallback only exposes sites above this size. */
const MIN_VISIBLE_MAP_POWER_MW = 10;
/** Keep tiny systems in national aggregates; map pins are filtered separately. */
const MIN_REGISTRY_POWER_MW = 0.001;
/** `Bruttoleistung` CSV values are kilowatts. */
const KW_PER_MW = 1000;
/** Map pins: ≥10 MW keeps Leaflet usable; sub-10 MW rolls into `smallProjectsSummary` without geocoding. */
const MAP_MARKER_MIN_POWER_MW = 10;
const MAX_REGISTRY_POWER_MW = 2_000;
const HEATMAP_GRID_DEGREES = 0.2;

type SmallProjectsSummary = {
  count: number;
  powerMw: number;
  energyMwh: number;
};

export type SmallProjectHeatCell = {
  lat: number;
  lng: number;
  count: number;
  powerMw: number;
  energyMwh: number;
};

export type MastrProjectsResult = {
  source: "mastr_zenodo" | "fallback";
  projects: GermanyBessProject[];
  smallProjectsSummary: SmallProjectsSummary;
  smallProjectsHeatmap: SmallProjectHeatCell[];
  fallbackReason?: string;
  cache?: {
    fromDisk: boolean;
    ageMs: number;
    /** e.g. stale cache after timeout */
    note?: string;
    /** Committed JSON under data/ — safe to cache for CACHE_TTL_MS without re-read. */
    bundledRepo?: boolean;
  };
};

let cachedResult: MastrProjectsResult | null = null;
let cachedAtMs = 0;
let blockingLoad: Promise<MastrProjectsResult> | null = null;
let backgroundRefresh: Promise<void> | null = null;

const toNumber = (value: string | undefined) => {
  if (!value) {
    return 0;
  }
  const normalized = value.replace(",", ".").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeBundeslandKey = (value: string) =>
  value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, "")
    .replace(/-/g, "");

const BUNDESLAND_CENTROIDS: Record<string, [number, number]> = (() => {
  const coords: Record<string, [number, number]> = {};
  const add = (displayName: string, position: [number, number]) => {
    coords[normalizeBundeslandKey(displayName)] = position;
  };
  add("Baden-Württemberg", [48.6616, 9.3501]);
  add("Bayern", [48.7904, 11.4979]);
  add("Berlin", [52.52, 13.405]);
  add("Brandenburg", [52.4125, 12.5316]);
  add("Bremen", [53.0793, 8.8017]);
  add("Hamburg", [53.5511, 9.9937]);
  add("Hessen", [50.6521, 9.1624]);
  add("Mecklenburg-Vorpommern", [53.6127, 12.4296]);
  add("Niedersachsen", [52.6367, 9.8451]);
  add("Nordrhein-Westfalen", [51.4332, 7.6616]);
  add("Rheinland-Pfalz", [49.9129, 7.4497]);
  add("Saarland", [49.3964, 7.0229]);
  add("Sachsen", [51.1045, 13.2017]);
  add("Sachsen-Anhalt", [51.9503, 11.6923]);
  add("Schleswig-Holstein", [54.2194, 9.6961]);
  add("Thüringen", [50.9848, 11.0299]);
  return coords;
})();

/** Drops coordinates outside Continental Germany (fixes registry outliers). */
const DE_BOUNDS = { minLat: 47.27, maxLat: 55.06, minLng: 5.87, maxLng: 15.04 };

const coordsInGermanyRough = (lat: number, lng: number) =>
  lat >= DE_BOUNDS.minLat &&
  lat <= DE_BOUNDS.maxLat &&
  lng >= DE_BOUNDS.minLng &&
  lng <= DE_BOUNDS.maxLng;

const normalizeTruthyJa = (value: string | undefined) => {
  const v = `${value ?? ""}`.trim().toLowerCase();
  return v === "ja" || v === "yes" || v === "true" || v === "1";
};

/**
 * `storage_raw` conflates electrochemical grids and pumped hydro. We only *exclude* obvious pumped/hydro —
 * MaStR often leaves Batterietechnologie empty even for batteries.
 */
const rowPassesBessOrientedFilters = (row: Record<string, string>) => {
  if (normalizeTruthyJa(row.Pumpspeichertechnologie)) {
    return false;
  }
  const blob = `${row.Technologie ?? ""} ${row.Name ?? ""}`.toLowerCase();
  if (
    blob.includes("pumpspeicher") ||
    blob.includes("wasserkraft") ||
    blob.includes("wasserkraftwerk") ||
    blob.includes("wasserspeicher")
  ) {
    return false;
  }
  const capacityKWh = toNumber(row.NutzbareSpeicherkapazitaet);
  const powerKw = toNumber(row.Bruttoleistung);
  if (capacityKWh > 0 && powerKw > 0) {
    const hours = capacityKWh / powerKw;
    /** Large cyclic reservoirs are multi-hour/month-scale vs grid BESS (~0.25–12h reporting). */
    if (powerKw >= 100 * KW_PER_MW && hours >= 18) {
      return false;
    }
  }
  return true;
};

const coordForStorageRow = (
  row: Record<string, string>
): { lat: number; lng: number; coordinateQuality: "exact" | "bundesland_approx" } => {
  const lat = toNumber(row.Breitengrad);
  const lng = toNumber(row.Laengengrad);
  if (lat !== 0 && lng !== 0) {
    return { lat, lng, coordinateQuality: "exact" };
  }
  const rawLand = row.Bundesland?.trim() ?? "";
  const centroid = BUNDESLAND_CENTROIDS[normalizeBundeslandKey(rawLand)];
  if (!centroid) {
    return { lat: 0, lng: 0, coordinateQuality: "bundesland_approx" };
  }
  const id = row.EinheitMastrNummer ?? "";
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = Math.imul(31, hash) + id.charCodeAt(i);
  }
  const jitterLat = (((hash % 200) + 200) % 200 - 100) * 0.02;
  const jitterLngHash = hash ^ (hash >>> 16);
  const jitterLng = (((jitterLngHash % 200) + 200) % 200 - 100) * 0.02;
  return {
    lat: centroid[0] + jitterLat,
    lng: centroid[1] + jitterLng,
    coordinateQuality: "bundesland_approx",
  };
};

const heatCellKey = (lat: number, lng: number) =>
  `${Math.floor(lat / HEATMAP_GRID_DEGREES)}:${Math.floor(lng / HEATMAP_GRID_DEGREES)}`;

const heatCellCenter = (lat: number, lng: number): [number, number] => [
  Math.floor(lat / HEATMAP_GRID_DEGREES) * HEATMAP_GRID_DEGREES + HEATMAP_GRID_DEGREES / 2,
  Math.floor(lng / HEATMAP_GRID_DEGREES) * HEATMAP_GRID_DEGREES + HEATMAP_GRID_DEGREES / 2,
];

const readCsvFromZipBuffer = async (
  zipBuffer: Buffer,
  onRow: (row: Record<string, string>) => void
) => {
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (zipError, zipFile) => {
      if (zipError || !zipFile) {
        reject(zipError ?? new Error("Unable to open zip buffer"));
        return;
      }

      const closeWithError = (error: Error) => {
        zipFile.close();
        reject(error);
      };

      zipFile.readEntry();
      zipFile.on("entry", (entry) => {
        if (!entry.fileName.endsWith(".csv")) {
          zipFile.readEntry();
          return;
        }

        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            closeWithError(streamError ?? new Error("Unable to open zip entry stream"));
            return;
          }

          const parser = parse({
            columns: true,
            skip_empty_lines: true,
            trim: true,
          });

          parser.on("readable", () => {
            let record: Record<string, string> | null;
            while ((record = parser.read() as Record<string, string> | null) !== null) {
              onRow(record);
            }
          });
          parser.on("error", (error) => closeWithError(error));
          parser.on("end", () => {
            zipFile.close();
            resolve();
          });

          stream.pipe(parser);
        });
      });
      zipFile.on("error", (error) => closeWithError(error));
    });
  });
};

const fetchZenodoZip = async (signal: AbortSignal): Promise<ArrayBuffer> => {
  let lastStatus = 0;
  for (const url of STORAGE_RAW_ZIP_URLS) {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "*/*" },
      cache: "no-store",
      signal,
    });
    lastStatus = response.status;
    if (response.ok) {
      return response.arrayBuffer();
    }
    log("zenodo URL failed %o", {
      url,
      status: response.status,
      statusText: response.statusText,
    });
  }
  throw new Error(`MaStR download failed with status ${lastStatus}`);
};

/** Live Zenodo ZIP → parse (minutes + large download). Use `npm run data:mastr` for a bundled file. */
export const loadMastrProjectsFromZenodo = async (
  signal: AbortSignal
): Promise<MastrProjectsResult> => {
  const zipArrayBuffer = await fetchZenodoZip(signal);
  const projects: GermanyBessProject[] = [];
  const smallHeatCells = new Map<string, SmallProjectHeatCell>();
  const smallProjectsSummary: SmallProjectsSummary = {
    count: 0,
    powerMw: 0,
    energyMwh: 0,
  };

  await readCsvFromZipBuffer(Buffer.from(zipArrayBuffer), (row) => {
    if (row.Land !== "Deutschland") {
      return;
    }
    if (row.EinheitBetriebsstatus !== "In Betrieb") {
      return;
    }
    if (!rowPassesBessOrientedFilters(row)) {
      return;
    }

    const powerKw = toNumber(row.Bruttoleistung);
    const powerMw = powerKw / KW_PER_MW;
    if (powerMw < MIN_REGISTRY_POWER_MW || powerMw > MAX_REGISTRY_POWER_MW) {
      return;
    }
    const reportedEnergyKwh = toNumber(row.NutzbareSpeicherkapazitaet);
    const reportedEnergyMwh = reportedEnergyKwh / KW_PER_MW;
    const energyMwh = reportedEnergyMwh > 0 ? reportedEnergyMwh : powerMw * 2;

    if (powerMw < MAP_MARKER_MIN_POWER_MW) {
      smallProjectsSummary.count += 1;
      smallProjectsSummary.powerMw += powerMw;
      smallProjectsSummary.energyMwh += energyMwh;
      const { lat, lng, coordinateQuality } = coordForStorageRow(row);
      if (lat === 0 || lng === 0 || !coordsInGermanyRough(lat, lng)) {
        return;
      }
      // Avoid border artifacts from jittered Bundesland centroids in the heat layer.
      if (coordinateQuality === "bundesland_approx") {
        return;
      }
      const key = heatCellKey(lat, lng);
      const existing = smallHeatCells.get(key);
      if (existing) {
        existing.count += 1;
        existing.powerMw += powerMw;
        existing.energyMwh += energyMwh;
      } else {
        const [cellLat, cellLng] = heatCellCenter(lat, lng);
        smallHeatCells.set(key, {
          lat: cellLat,
          lng: cellLng,
          count: 1,
          powerMw,
          energyMwh,
        });
      }
      return;
    }
    const { lat, lng, coordinateQuality } = coordForStorageRow(row);
    if (lat === 0 || lng === 0) {
      return;
    }
    if (!coordsInGermanyRough(lat, lng)) {
      return;
    }

    projects.push({
      id: row.EinheitMastrNummer || `mastr-${projects.length + 1}`,
      name: row.Name || "MaStR battery unit",
      operator: row.Anlagenbetreiber || "Unknown operator",
      city: row.Gemeinde || row.Ort || "Germany",
      lat,
      lng,
      powerMw,
      energyMwh,
      energySource: reportedEnergyMwh > 0 ? "reported" : "estimated",
      coordinateQuality,
      status: "operational",
    });
  });

  return {
    source: "mastr_zenodo",
    projects,
    smallProjectsSummary,
    smallProjectsHeatmap: [...smallHeatCells.values()],
  };
};

const snapshotFileToResult = (file: MastrRepoSnapshotFile): MastrProjectsResult => ({
  source: file.source,
  projects: file.projects,
  smallProjectsSummary: file.smallProjectsSummary,
  smallProjectsHeatmap: file.smallProjectsHeatmap ?? [],
  fallbackReason: file.fallbackReason,
  cache: {
    fromDisk: true,
    ageMs: 0,
    bundledRepo: true,
    note: file.generatedAtIso
      ? `Bundled snapshot (${file.generatedAtIso})`
      : "Bundled snapshot (data/mastr-bess-de.snapshot.json.gz)",
  },
});

const buildCuratedFallback = (message: string): MastrProjectsResult => ({
  source: "fallback",
  projects: GERMANY_BESS_PROJECTS.filter((project) => project.powerMw > MIN_VISIBLE_MAP_POWER_MW),
  smallProjectsSummary: GERMANY_BESS_PROJECTS.filter(
    (project) => project.powerMw > 0 && project.powerMw <= MIN_VISIBLE_MAP_POWER_MW
  ).reduce(
    (summary, project) => {
      summary.count += 1;
      summary.powerMw += project.powerMw;
      summary.energyMwh += project.energyMwh;
      return summary;
    },
    { count: 0, powerMw: 0, energyMwh: 0 }
  ),
  smallProjectsHeatmap: [],
  fallbackReason: message,
});

const wrapDiskPayload = (
  payload: MastrProjectsResult,
  savedAtMs: number,
  note?: string
): MastrProjectsResult => ({
  ...payload,
  cache: {
    fromDisk: true,
    ageMs: Date.now() - savedAtMs,
    note,
  },
});

const persistZenodoSnapshot = async (result: MastrProjectsResult) => {
  if (result.source === "mastr_zenodo") {
    await writeMastrSnapshotDisk(result);
  }
};

const startBackgroundRefresh = () => {
  if (backgroundRefresh) {
    return;
  }
  backgroundRefresh = (async () => {
    try {
      const ac = new AbortController();
      const timeoutId = setTimeout(() => ac.abort(), BUILD_TIMEOUT_MS);
      const result = await loadMastrProjectsFromZenodo(ac.signal);
      clearTimeout(timeoutId);
      await persistZenodoSnapshot(result);
      cachedResult = result;
      cachedAtMs = Date.now();
    } catch (error) {
      log("background MaStR refresh failed %o", { error });
    } finally {
      backgroundRefresh = null;
    }
  })();
};

/** Opt-in live pull from Zenodo (~200MB + long parse). Default is bundled `data/mastr-bess-de.snapshot.json`. */
const MASTR_LIVE_ZENODO = process.env.MASTR_LIVE_ZENODO === "1";

const loadMastrFromZenodoCachedPipeline = async (): Promise<MastrProjectsResult> => {
  const diskEnvelope = await readMastrSnapshotDisk();

  if (diskEnvelope && Date.now() - diskEnvelope.savedAtMs < CACHE_TTL_MS) {
    const fresh = wrapDiskPayload(diskEnvelope.payload, diskEnvelope.savedAtMs);
    cachedResult = fresh;
    cachedAtMs = diskEnvelope.savedAtMs;
    return fresh;
  }

  if (
    diskEnvelope &&
    diskEnvelope.payload.source === "mastr_zenodo" &&
    diskEnvelope.payload.projects.length > 0
  ) {
    startBackgroundRefresh();
    const wrapped = wrapDiskPayload(
      diskEnvelope.payload,
      diskEnvelope.savedAtMs,
      "Serving on-disk MaStR snapshot while refreshing in the background."
    );
    cachedResult = wrapped;
    cachedAtMs = Date.now();
    return wrapped;
  }

  if (blockingLoad) {
    return blockingLoad;
  }

  const ac = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(), BUILD_TIMEOUT_MS);
  blockingLoad = loadMastrProjectsFromZenodo(ac.signal)
    .then(async (result) => {
      clearTimeout(timeoutId);
      await persistZenodoSnapshot(result);
      cachedResult = result;
      cachedAtMs = Date.now();
      return result;
    })
    .catch((error) => {
      clearTimeout(timeoutId);
      log("failed loading MaStR snapshot %o", { error });
      if (
        diskEnvelope?.payload.source === "mastr_zenodo" &&
        diskEnvelope.payload.projects.length > 0
      ) {
        const wrapped = wrapDiskPayload(
          diskEnvelope.payload,
          diskEnvelope.savedAtMs,
          `Live build failed; using on-disk cache. (${error instanceof Error ? error.message : "error"})`
        );
        cachedResult = wrapped;
        cachedAtMs = Date.now();
        return wrapped;
      }
      const fallback = buildCuratedFallback(
        error instanceof Error ? error.message : "Unknown MaStR fetch error"
      );
      cachedResult = fallback;
      cachedAtMs = Date.now();
      return fallback;
    })
    .finally(() => {
      blockingLoad = null;
    });

  return blockingLoad;
};

export const getMastrProjectsSnapshot = async (): Promise<MastrProjectsResult> => {
  if (cachedResult) {
    const ageMs = Date.now() - cachedAtMs;
    if (cachedResult.cache?.bundledRepo && ageMs < CACHE_TTL_MS) {
      return cachedResult;
    }
    if (cachedResult.cache?.note && !cachedResult.cache.bundledRepo) {
      if (ageMs < STALE_MEMORY_CACHE_MS) {
        return cachedResult;
      }
    } else if (!cachedResult.cache?.note && ageMs < CACHE_TTL_MS) {
      return cachedResult;
    }
  }

  const repoFile = await readMastrRepoSnapshotFile();
  if (repoFile && repoFile.projects.length > 0) {
    const fromRepo = snapshotFileToResult(repoFile);
    cachedResult = fromRepo;
    cachedAtMs = Date.now();
    return fromRepo;
  }

  if (!MASTR_LIVE_ZENODO) {
    const fb = buildCuratedFallback(
      "No bundled MaStR gzip snapshot (or it is empty). Run `npm run data:mastr`, or set MASTR_LIVE_ZENODO=1 for a live Zenodo pull."
    );
    cachedResult = fb;
    cachedAtMs = Date.now();
    return fb;
  }

  return loadMastrFromZenodoCachedPipeline();
};
