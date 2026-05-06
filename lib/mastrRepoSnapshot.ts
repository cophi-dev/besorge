import { readFile } from "fs/promises";
import path from "path";
import { gunzipSync } from "zlib";
import { z } from "zod";

const DATA_DIR = path.join(process.cwd(), "data");
/** Committed artifact — small on disk (gzip). Prefer this in git over the raw JSON. */
const REPO_SNAPSHOT_GZ_PATH = path.join(DATA_DIR, "mastr-bess-de.snapshot.json.gz");
const REPO_SNAPSHOT_JSON_PATH = path.join(DATA_DIR, "mastr-bess-de.snapshot.json");

const smallProjectsSummarySchema = z.object({
  count: z.number(),
  powerMw: z.number(),
  energyMwh: z.number(),
});

const smallProjectHeatCellSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  count: z.number(),
  powerMw: z.number(),
  energyMwh: z.number(),
});

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  operator: z.string(),
  city: z.string(),
  lat: z.number(),
  lng: z.number(),
  powerMw: z.number(),
  energyMwh: z.number(),
  energySource: z.enum(["reported", "estimated"]),
  coordinateQuality: z.enum(["exact", "bundesland_approx"]).optional(),
  status: z.enum(["operational", "construction", "announced"]),
});

const repoSnapshotFileSchema = z.object({
  generatedAtIso: z.string().optional(),
  zenodoRecord: z.string().optional(),
  source: z.enum(["mastr_zenodo", "fallback"]),
  projects: z.array(projectSchema),
  smallProjectsSummary: smallProjectsSummarySchema,
  smallProjectsHeatmap: z.array(smallProjectHeatCellSchema).optional(),
  fallbackReason: z.string().optional(),
});

export type MastrRepoSnapshotFile = z.infer<typeof repoSnapshotFileSchema>;

export const getMastrRepoSnapshotPaths = () => ({
  gzip: REPO_SNAPSHOT_GZ_PATH,
  json: REPO_SNAPSHOT_JSON_PATH,
});

/** Prefer the gz path (what ships in git). */
export const getMastrRepoSnapshotPath = () => REPO_SNAPSHOT_GZ_PATH;

export const readMastrRepoSnapshotFile = async (): Promise<MastrRepoSnapshotFile | null> => {
  let rawUtf8: string;
  try {
    const gzipped = await readFile(REPO_SNAPSHOT_GZ_PATH);
    rawUtf8 = gunzipSync(gzipped).toString("utf8");
  } catch {
    try {
      rawUtf8 = await readFile(REPO_SNAPSHOT_JSON_PATH, "utf8");
    } catch {
      return null;
    }
  }

  try {
    const parsed = JSON.parse(rawUtf8) as unknown;
    return repoSnapshotFileSchema.parse(parsed);
  } catch {
    return null;
  }
};
