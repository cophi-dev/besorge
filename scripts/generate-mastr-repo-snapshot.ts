import { mkdir, unlink, writeFile } from "fs/promises";
import path from "path";
import { gzipSync } from "zlib";

import { getMastrRepoSnapshotPaths } from "@/lib/mastrRepoSnapshot";
import { loadMastrProjectsFromZenodo } from "@/lib/mastrZenodoProjects";

const main = async () => {
  const { gzip: gzPath, json: jsonPath } = getMastrRepoSnapshotPaths();
  await mkdir(path.dirname(gzPath), { recursive: true });
  const minutes = Number(process.env.MASTR_GENERATE_TIMEOUT_MIN ?? 45);
  const signal = AbortSignal.timeout(Math.max(5, minutes) * 60_000);
  const result = await loadMastrProjectsFromZenodo(signal);
  const envelope = {
    generatedAtIso: new Date().toISOString(),
    zenodoRecord: "14843222",
    source: result.source,
    projects: result.projects,
    smallProjectsSummary: result.smallProjectsSummary,
    smallProjectsHeatmap: result.smallProjectsHeatmap,
  };
  const jsonLine = `${JSON.stringify(envelope)}\n`;
  await writeFile(jsonPath, jsonLine, "utf8");
  await writeFile(gzPath, gzipSync(Buffer.from(jsonLine, "utf8")));
  await unlink(jsonPath);

  console.log(
    `Wrote ${result.projects.length} projects to ${path.relative(process.cwd(), gzPath)} (source=${result.source})`
  );
};

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
