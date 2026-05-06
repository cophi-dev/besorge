import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

import type { GermanyBessProject } from "@/lib/germanyBessProjects";
import type { SmallProjectHeatCell } from "@/lib/mastrZenodoProjects";

export type MastrSnapshotDiskPayload = {
  source: "mastr_zenodo" | "fallback";
  projects: GermanyBessProject[];
  smallProjectsSummary: {
    count: number;
    powerMw: number;
    energyMwh: number;
  };
  smallProjectsHeatmap: SmallProjectHeatCell[];
  fallbackReason?: string;
};

export type MastrSnapshotDiskEnvelope = {
  savedAtMs: number;
  payload: MastrSnapshotDiskPayload;
};

const CACHE_DIR = path.join(process.cwd(), ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "mastr-bess-snapshot.json");

export const getMastrSnapshotCachePath = () => CACHE_FILE;

export const readMastrSnapshotDisk = async (): Promise<MastrSnapshotDiskEnvelope | null> => {
  try {
    const raw = await readFile(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as MastrSnapshotDiskEnvelope;
    if (
      typeof parsed.savedAtMs !== "number" ||
      !parsed.payload ||
      !Array.isArray(parsed.payload.projects)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const writeMastrSnapshotDisk = async (payload: MastrSnapshotDiskPayload): Promise<void> => {
  await mkdir(CACHE_DIR, { recursive: true });
  const envelope: MastrSnapshotDiskEnvelope = {
    savedAtMs: Date.now(),
    payload,
  };
  await writeFile(CACHE_FILE, `${JSON.stringify(envelope)}\n`, "utf8");
};
